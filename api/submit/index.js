/**
 * Azure Function: submit
 * منصة رفع أوراق إجابات الطلاب للاختبارات المركزية — الفصل الدراسي الثاني
 * وزارة التعليم — الإدارة العامة للتعليم بمنطقة حائل
 *
 * يستقبل بيانات الطالب/ة + أوراق الإجابة لكل مادة، يتحقق، يحفظ المرفقات،
 * ويُنشئ/يُحدّث سجلّ الطالب (يُدمج المواد الجديدة إن رفع الطالب مواد إضافية لاحقاً).
 *
 * يعتمد على Azure Table Storage (السجلات + العدّاد) و Blob Storage (المرفقات).
 * إعداد الاتصال يُقرأ من متغيّر البيئة: AZURE_STORAGE_CONNECTION_STRING
 */

const { TableClient } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");

// ===== (اختياري) فترة الرفع — مفتوحة افتراضياً =====
const REG_START = new Date("2026-01-01T00:00:00+03:00");
const REG_END   = new Date("2030-12-31T23:59:59+03:00");

// ===== المواد المسموح بها =====
const ALLOWED_SUBJECTS = ["الرياضيات", "العلوم", "اللغة العربية", "اللغة الإنجليزية"];

// ===== قواعد التحقق (مطابقة للواجهة) =====
const RULES = {
  name:       /^\S+(?:\s+\S+){1,}$/,   // اسمان على الأقل
  civilId:    /^[0-9]{10}$/,           // ١٠ أرقام
  ministryNo: /^[0-9]{3,}$/            // أرقام فقط
};

function sanitize(s) {
  return String(s || "").replace(/[^\w.\-\u0600-\u06FF]/g, "_");
}

function validate(d) {
  const e = [];
  if (!d) return ["لا توجد بيانات."];
  if (!d.schoolName || !String(d.schoolName).trim()) e.push("حقل اسم المدرسة مطلوب.");
  if (!d.ministryNo || !RULES.ministryNo.test(String(d.ministryNo).trim())) e.push("الرقم الوزاري مطلوب (أرقام فقط).");
  if (!d.studentName || !RULES.name.test(String(d.studentName).trim())) e.push("حقل اسم الطالب/ة مطلوب.");
  if (!d.civilId || !RULES.civilId.test(String(d.civilId).trim())) e.push("السجل المدني يجب أن يكون ١٠ أرقام.");
  if (!d.gender) e.push("حقل الجنس مطلوب.");
  if (!d.grade) e.push("حقل الصف مطلوب.");

  if (!Array.isArray(d.subjects) || d.subjects.length === 0) {
    e.push("يجب اختيار مادة واحدة على الأقل.");
  } else {
    d.subjects.forEach(function (s) {
      if (!s || ALLOWED_SUBJECTS.indexOf(s.subject) === -1) {
        e.push("مادة غير معروفة: " + (s && s.subject ? s.subject : ""));
      } else if (!Array.isArray(s.files) || s.files.length === 0) {
        e.push("يجب رفع ورقة إجابة لمادة " + s.subject + ".");
      }
    });
  }
  return e;
}

module.exports = async function (context, req) {
  const respond = (status, body) => {
    context.res = { status, headers: { "Content-Type": "application/json" }, body };
  };

  try {
    // 1) التحقق من فترة الرفع (الخادم هو المرجع)
    const now = new Date();
    if (now < REG_START) return respond(200, { ok: false, errors: ["لم تبدأ فترة رفع أوراق الإجابة بعد."] });
    if (now > REG_END)   return respond(200, { ok: false, errors: ["انتهت فترة رفع أوراق الإجابة."] });

    const d = req.body || {};

    // 2) التحقق من صحة البيانات
    const errors = validate(d);
    if (errors.length) return respond(200, { ok: false, errors });

    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!conn) return respond(200, { ok: false, errors: ["النظام غير مهيّأ: مفقود AZURE_STORAGE_CONNECTION_STRING."] });

    const cid = String(d.civilId).trim();

    // إنشاء جداول التخزين إن لم تكن موجودة
    const requests = TableClient.fromConnectionString(conn, "Requests");
    const counters = TableClient.fromConnectionString(conn, "Counters");
    await requests.createTable().catch(() => {});
    await counters.createTable().catch(() => {});

    // 3) رفع المرفقات إلى Blob Storage (منظّمة: السجل المدني / المادة / الملف)
    const blobSvc = BlobServiceClient.fromConnectionString(conn);
    const container = blobSvc.getContainerClient("documents");
    await container.createIfNotExists();

    const newLinks = [];
    const newSubjects = [];
    for (let s = 0; s < d.subjects.length; s++) {
      const subj = d.subjects[s];
      newSubjects.push(subj.subject);
      for (let i = 0; i < subj.files.length; i++) {
        const f = subj.files[i];
        const buf = Buffer.from(f.data, "base64");
        const safeName = `${cid}/${sanitize(subj.subject)}/${Date.now()}_${(i + 1)}_${sanitize(f.name || "ورقة")}`;
        const block = container.getBlockBlobClient(safeName);
        await block.uploadData(buf, { blobHTTPHeaders: { blobContentType: f.mimeType || "application/octet-stream" } });
        newLinks.push(block.url);
      }
    }

    // 4) هل يوجد سجل سابق لنفس السجل المدني؟ (لدمج المواد الإضافية)
    let existing = null;
    try { existing = await requests.getEntity("REQ", cid); } catch (e) { /* غير موجود */ }

    const nowIso = new Date().toISOString();

    if (existing) {
      // دمج: نضيف المواد والأوراق الجديدة للسجل القائم
      const prevSubjects = String(existing.Subjects || "").split("،").map(x => x.trim()).filter(Boolean);
      const mergedSubjects = Array.from(new Set(prevSubjects.concat(newSubjects)));
      const prevDocs = String(existing.Documents || "").split("\n").filter(Boolean);
      const mergedDocs = prevDocs.concat(newLinks);

      await requests.updateEntity({
        partitionKey: "REQ",
        rowKey: cid,
        SchoolName: String(d.schoolName).trim(),
        MinistryNo: String(d.ministryNo).trim(),
        StudentName: String(d.studentName).trim(),
        Gender: d.gender,
        Grade: d.grade,
        Subjects: mergedSubjects.join("، "),
        PapersCount: mergedDocs.length,
        Documents: mergedDocs.join("\n"),
        UpdatedAt: nowIso
      }, "Merge");

      return respond(200, { ok: true, requestNumber: existing.RequestNo || ("م-" + cid) });
    }

    // 5) سجل جديد: توليد رقم العملية عبر عدّاد ذرّي (ETag)
    let seq = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const c = await counters.getEntity("SEQ", "requests").catch(() => null);
        if (!c) {
          seq = 1;
          await counters.createEntity({ partitionKey: "SEQ", rowKey: "requests", value: 1 });
        } else {
          seq = (c.value || 0) + 1;
          await counters.updateEntity({ partitionKey: "SEQ", rowKey: "requests", value: seq }, "Replace", { etag: c.etag });
        }
        break;
      } catch (e) {
        if (attempt === 7) throw e;
      }
    }
    const reqNo = "ف2-" + String(seq).padStart(6, "0");

    await requests.createEntity({
      partitionKey: "REQ",
      rowKey: cid,
      RequestNo: reqNo,
      SubmittedAt: nowIso,
      SchoolName: String(d.schoolName).trim(),
      MinistryNo: String(d.ministryNo).trim(),
      StudentName: String(d.studentName).trim(),
      CivilId: cid,
      Gender: d.gender,
      Grade: d.grade,
      Subjects: newSubjects.join("، "),
      PapersCount: newLinks.length,
      Documents: newLinks.join("\n")
    });

    return respond(200, { ok: true, requestNumber: reqNo });
  } catch (err) {
    context.log.error(err);
    return respond(200, { ok: false, errors: ["حدث خطأ غير متوقع: " + (err.message || err)] });
  }
};
