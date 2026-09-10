const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== MegaPay configuration =====
// Get these from MegaPay → Linked Accounts → API Key
const MEGAPAY_API_KEY = "MGPY7yTqg7Ju";
const MEGAPAY_EMAIL = "kipkatambrianc@gmail.com";

const MEGAPAY_STK_URL = "https://megapay.co.ke/backend/v1/initiatestk";
const MEGAPAY_STATUS_URL = "https://megapay.co.ke/backend/v1/transactionstatus";

// ===== In‑memory store =====
const applications = {};
let appCounter = 1;

function findApplicationByTransaction({
  transactionId,
  transactionReference,
  checkoutRequestId,
  merchantRequestId,
  transactionRequestId,
}) {
  for (const id in applications) {
    const app = applications[id];
    if (
      (transactionId && app.transaction_id === transactionId) ||
      (transactionReference &&
        app.external_reference === transactionReference) ||
      (checkoutRequestId && app.checkout_request_id === checkoutRequestId) ||
      (merchantRequestId && app.merchant_request_id === merchantRequestId) ||
      (transactionRequestId &&
        app.transaction_request_id === transactionRequestId)
    ) {
      return app;
    }
  }
  return null;
}

// ===== Helper: call MegaPay STK push =====
async function callMegaPaySTK({ amount, msisdn, reference }) {
  const payload = {
    api_key: MEGAPAY_API_KEY,
    email: MEGAPAY_EMAIL,
    amount: String(amount),
    msisdn: String(msisdn),
    reference: reference || `REF-${Date.now()}`,
  };

  console.log("📞 MegaPay STK request payload:", payload);

  const response = await axios.post(MEGAPAY_STK_URL, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
    validateStatus: () => true, // don't throw on non-2xx, we want the body
  });

  console.log(
    "✅ MegaPay raw STK response:",
    JSON.stringify(response.data, null, 2),
  );
  return { httpStatus: response.status, body: response.data };
}

// ===== 1. Check Eligibility =====
app.post("/api/check-eligibility", (req, res) => {
  const { phoneNumber, idNumber } = req.body;
  if (!phoneNumber || !idNumber) {
    return res
      .status(400)
      .json({ success: false, message: "Phone number and ID are required" });
  }
  return res.json({
    success: true,
    status: "eligible",
    message: "You are eligible for a loan.",
  });
});

// ===== 2. Loan Application & STK Push =====
app.post("/api/loan-application", async (req, res) => {
  try {
    const {
      phoneNumber,
      selectedAmount,
      selectedFee,
      fullName,
      idNumber,
      loanType,
    } = req.body;

    if (!phoneNumber || !selectedAmount || !selectedFee) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    // Sanity check on credentials
    if (!MEGAPAY_API_KEY || !MEGAPAY_EMAIL) {
      return res.status(500).json({
        success: false,
        message:
          "MegaPay credentials not configured. Set MEGAPAY_API_KEY and MEGAPAY_EMAIL.",
      });
    }

    let cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
    if (cleanPhone.startsWith("0")) cleanPhone = "254" + cleanPhone.slice(1);
    if (!cleanPhone.startsWith("254")) cleanPhone = "254" + cleanPhone;

    const appId = `APP-${Date.now()}-${appCounter++}`;
    const externalReference = `Fuliza-${Date.now()}`;

    applications[appId] = {
      id: appId,
      fullName,
      phoneNumber: cleanPhone,
      idNumber,
      loanType,
      selectedAmount,
      selectedFee,
      interest: req.body.interest || Math.round(selectedAmount * 0.1),
      totalRepayment:
        req.body.totalRepayment ||
        selectedAmount + Math.round(selectedAmount * 0.1),
      status: "pending",
      external_reference: externalReference,
      created_at: new Date().toISOString(),
      mpesa_receipt: null,
      transaction_request_id: null,
      transaction_id: null,
      checkout_request_id: null,
      merchant_request_id: null,
    };

    // Call MegaPay
    const { httpStatus, body } = await callMegaPaySTK({
      amount: selectedFee,
      msisdn: cleanPhone,
      reference: externalReference,
    });

    // Extract transaction_request_id using many fallbacks
    const transactionRequestId =
      body?.transaction_request_id ||
      body?.transactionRequestId ||
      body?.TransactionRequestID ||
      body?.TransactionRequestId ||
      body?.data?.transaction_request_id ||
      body?.data?.transactionRequestId ||
      null;

    // Consider success if id is present, OR success field is 200/"200"/true
    const successFlag =
      String(body?.success) === "200" ||
      body?.success === 200 ||
      body?.success === true ||
      String(body?.Success) === "200" ||
      String(body?.status).toLowerCase() === "success";

    if (!transactionRequestId) {
      console.error("❌ MegaPay did NOT return transaction_request_id.");
      console.error("   HTTP status:", httpStatus);
      console.error("   Body:", body);

      const msg =
        body?.massage ||
        body?.message ||
        body?.error ||
        body?.error_message ||
        body?.ResponseDescription ||
        `MegaPay did not return a transaction id (HTTP ${httpStatus})`;

      return res.status(httpStatus >= 400 ? httpStatus : 502).json({
        success: false,
        message: msg,
        raw: body,
      });
    }

    // Even if successFlag is false but we got an id, we still store it — but log a warning
    if (!successFlag) {
      console.warn(
        "⚠️ MegaPay returned an id but success flag was not 200. Body:",
        body,
      );
    }

    applications[appId].transaction_request_id = transactionRequestId;

    return res.status(200).json({
      success: true,
      transaction_id: transactionRequestId,
      payment_status: "pending",
      data: { application_id: appId },
    });
  } catch (error) {
    console.error(
      "❌ MegaPay unexpected error:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      message: error.message || "Payment initiation failed",
      details: error.response?.data || null,
    });
  }
});

// ===== 3. Check payment status by application =====
app.get("/api/check-payment-status-by-app/:applicationId", async (req, res) => {
  const app = applications[req.params.applicationId];
  if (!app)
    return res
      .status(404)
      .json({ success: false, message: "Application not found" });

  if (app.status === "pending" && app.transaction_request_id) {
    try {
      const r = await axios.post(
        MEGAPAY_STATUS_URL,
        {
          api_key: MEGAPAY_API_KEY,
          email: MEGAPAY_EMAIL,
          transaction_request_id: app.transaction_request_id,
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 20000,
          validateStatus: () => true,
        },
      );

      const result = r.data || {};
      console.log("🔎 MegaPay status response:", result);

      const statusOk =
        String(result.ResultCode) === "200" &&
        String(result.TransactionStatus).toLowerCase() === "completed";

      if (statusOk) {
        app.status = "success";
        app.mpesa_receipt = result.TransactionReceipt || app.mpesa_receipt;
        app.transaction_id = result.TransactionID || app.transaction_id;
      }
    } catch (err) {
      console.warn(
        "⚠️ MegaPay status query failed:",
        err.response?.data || err.message,
      );
    }
  }

  return res.json({
    success: true,
    status: app.status,
    data: { mpesa_receipt_number: app.mpesa_receipt || null },
  });
});

// ===== 4. Webhook / Callback from MegaPay =====
app.post("/api/callback", (req, res) => {
  console.log("📩 MegaPay callback:", new Date().toISOString());
  console.log(JSON.stringify(req.body, null, 2));

  const {
    ResponseCode,
    ResponseDescription,
    MerchantRequestID,
    CheckoutRequestID,
    TransactionID,
    TransactionAmount,
    TransactionReceipt,
    TransactionDate,
    TransactionReference,
    Msisdn,
  } = req.body;

  const app = findApplicationByTransaction({
    transactionId: TransactionID,
    transactionReference: TransactionReference,
    checkoutRequestId: CheckoutRequestID,
    merchantRequestId: MerchantRequestID,
  });

  if (!app) {
    console.warn("⚠️ No matching application for callback");
    return res.status(200).json({ received: true });
  }

  app.status = Number(ResponseCode) === 0 ? "success" : "failed";
  app.mpesa_receipt = TransactionReceipt || app.mpesa_receipt;
  app.transaction_id = TransactionID || app.transaction_id;
  app.checkout_request_id = CheckoutRequestID || app.checkout_request_id;
  app.merchant_request_id = MerchantRequestID || app.merchant_request_id;
  app.callback_data = req.body;

  console.log(`✅ ${app.id} → ${app.status}`);
  return res.status(200).json({ received: true });
});

// ===== 5. Mock check-application-status (unchanged) =====
app.post("/api/check-application-status", (req, res) => {
  const { phoneNumber, idNumber } = req.body;
  const mockApps = [];
  if (phoneNumber.includes("1"))
    mockApps.push({
      application_id: "APP-12345",
      client_name: "Brian Kipkirui",
      phone_number: phoneNumber,
      id_number: idNumber,
      loan_type: "personal",
      loan_amount: 5000,
      total_repayment: 5500,
      status: "approved",
      created_at: new Date().toISOString(),
      payment_date: null,
    });
  if (phoneNumber.includes("2"))
    mockApps.push({
      application_id: "APP-54321",
      client_name: "Brian Kipkirui",
      phone_number: phoneNumber,
      id_number: idNumber,
      loan_type: "business",
      loan_amount: 10000,
      total_repayment: 11000,
      status: "pending",
      created_at: new Date().toISOString(),
      payment_date: null,
    });
  if (phoneNumber.includes("3"))
    mockApps[0] = {
      ...mockApps[0],
      status: "paid",
      payment_date: new Date().toISOString(),
    };
  if (phoneNumber.includes("4"))
    mockApps[0] = { ...mockApps[0], status: "rejected" };
  if (phoneNumber.includes("5"))
    mockApps[0] = { ...mockApps[0], status: "cancelled" };
  if (phoneNumber.includes("6"))
    mockApps[0] = { ...mockApps[0], status: "active" };
  if (mockApps.length === 0)
    return res.status(404).json({
      success: false,
      message: "No applications found for these details",
    });
  return res.json({
    success: true,
    data: {
      client_name: mockApps[0].client_name,
      total_applications: mockApps.length,
      applications: mockApps,
    },
  });
});

// ===== 6. DEBUG: Test MegaPay STK directly =====
// Usage: POST /api/debug/stk-test  { "msisdn": "2547...", "amount": 1 }
app.post("/api/debug/stk-test", async (req, res) => {
  try {
    const { msisdn = "254708374149", amount = 1 } = req.body || {};
    const { httpStatus, body } = await callMegaPaySTK({
      amount,
      msisdn,
      reference: `DEBUG-${Date.now()}`,
    });
    return res.json({
      httpStatus,
      megaPayResponse: body,
      usedKeyPrefix: MEGAPAY_API_KEY.slice(0, 8),
      usedEmail: MEGAPAY_EMAIL,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ===== Static pages =====
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);
app.get("/eligibility", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "eligibility.html")),
);
app.get("/check-status", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "check-status.html")),
);
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀Fuliza server on http://localhost:${PORT}`);
    console.log(`📞 Webhook: ${PUBLIC_URL}/api/callback`);
    console.log(
      `🔑 MegaPay API key: ${MEGAPAY_API_KEY ? MEGAPAY_API_KEY.slice(0, 8) + "..." : "❌ EMPTY"}`,
    );
    console.log(`📧 MegaPay email: ${MEGAPAY_EMAIL || "❌ EMPTY"}`);
  });
}

module.exports = app;
