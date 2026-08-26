/**
 * Azure Function: config (متعدّد الأوضاع)
 * - بلا معامل: حالة فترة الرفع (يستخدمها النموذج).
 * - ?action=admin: كل السجلات للوحة استقبال الطلاب (محمية بقائمة بيضاء).
 * - ?action=file&blob=...: تمرير مرفق واحد بأمان (محمي بقائمة بيضاء).
 */
const { TableClient } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");

const REG_START = new Date("2026-01-01T00:00:00+03:00");
const REG_END   = new Date("2030-12-31T23:59:59+03:00");

// ===== القائمة البيضاء: البُرد المسموح لها بفتح اللوحة =====
// أضف بريد كل مسؤول كما يظهر في /.auth/me
const ALLOWED_ADMINS = [
  "oshl@hotmail.com"
];

function getAdminEmail(req) {
  let email = "";
  const header = req.headers["x-ms-client-principal"];
  if (header) {
    try {
      const d = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      email = (d.userDetails || "").toLowerCase();
    } catch (e) {}
  }
  return email;
}
function isAdmin(email) {
  return email && ALLOWED_ADMINS.map(e => e.toLowerCase()).indexOf(email) !== -1;
}

module.exports = async function (context, req) {
  const respond = (status, body) => {
    context.res = { status, headers: { "Content-Type": "application/json" }, body };
  };

  try {
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;

    // ===== وضع تمرير مرفق واحد =====
    if (req.query && req.query.action === "file") {
      if (!isAdmin(getAdminEmail(req))) return respond(403, { ok: false, error: "غير مصرّح." });
      const blobPath = req.query.blob || "";
      if (!blobPath) return respond(400, { ok: false, error: "مسار الملف مفقود." });
      const svc = BlobServiceClient.fromConnectionString(conn);
      const container = svc.getContainerClient("documents");
      const blob = container.getBlockBlobClient(blobPath);
      const dl = await blob.download();
      const chunks = [];
      for await (const c of dl.readableStreamBody) chunks.push(c);
      const buffer = Buffer.concat(chunks);
      const fname = blobPath.split("/").pop() || "document";
      context.res = {
        status: 200,
        headers: {
          "Content-Type": dl.contentType || "application/octet-stream",
          "Content-Disposition": 'inline; filename="' + encodeURIComponent(fname) + '"'
        },
        body: buffer,
        isRaw: true
      };
      return;
    }

    // ===== وضع لوحة استقبال الطلاب =====
    if (req.query && req.query.action === "admin") {
      const email = getAdminEmail(req);
      if (!isAdmin(email)) return respond(403, { ok: false, error: "غير مصرّح لك بالوصول إلى هذه اللوحة." });
      if (!conn) return respond(500, { ok: false, error: "النظام غير مهيّأ." });

      const requests = TableClient.fromConnectionString(conn, "Requests");
      await requests.createTable().catch(function(){});
      const rows = [];
      for await (const e of requests.listEntities()) {
        rows.push({
          requestNo: e.RequestNo || "", submittedAt: e.SubmittedAt || "",
          schoolName: e.SchoolName || "", ministryNo: e.MinistryNo || "",
          studentName: e.StudentName || "", civilId: e.CivilId || e.rowKey || "",
          gender: e.Gender || "", grade: e.Grade || "",
          subjects: e.Subjects || "", papersCount: e.PapersCount != null ? e.PapersCount : "",
          documents: e.Documents || ""
        });
      }
      rows.sort((a, b) => (a.requestNo || "").localeCompare(b.requestNo || ""));
      return respond(200, { ok: true, count: rows.length, rows, admin: email });
    }

    // ===== وضع حالة فترة الرفع (الافتراضي) =====
    const now = new Date();
    const open = now >= REG_START && now <= REG_END;
    let state = "open";
    if (now < REG_START) state = "before";
    else if (now > REG_END) state = "after";

    return respond(200, {
      open, state,
      startISO: REG_START.toISOString(), endISO: REG_END.toISOString()
    });
  } catch (err) {
    context.log.error(err);
    return respond(500, { ok: false, error: "خطأ: " + (err.message || err) });
  }
};
