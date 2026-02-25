const express = require('express');
const path = require('path');
const mongoose = require("mongoose");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const bodyParser = require("body-parser");
require("dotenv").config();

const ENABLE_APP_LOGS = true;
const appLogger = {
    info: (...args) => {
        if (ENABLE_APP_LOGS) {
            console.log(...args);
        }
    },
    warn: (...args) => {
        if (ENABLE_APP_LOGS) {
            console.warn(...args);
        }
    },
    error: (...args) => {
        if (ENABLE_APP_LOGS) {
            console.error(...args);
        }
    },
};

// Initialize App
const app = express();
const PORT = process.env.PORT || 3000;

// Import Model
const Donation = require("./models/Donation");

// 1. Middleware & Settings
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Important: Body-parser for handling PayU POST requests
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 2. MongoDB Connection
mongoose
    .connect(process.env.MONGO_URI)
    .then(() => appLogger.info("MongoDB Connected"))
    .catch((err) => appLogger.error("MongoDB Connection Error:", err));

/* =========================
    VIEW ROUTES
========================= */
app.get('/', (req, res) => {
    res.render('index', { title: 'Bridge of Hopes | Empowering Children' });
});

app.get('/about', (req, res) => {
    res.render('about', { title: 'About Us - Bridge of Hopes' });
});

app.get('/donate', (req, res) => {
    res.render('donate', { title: 'Support Our Cause' });
});

app.get('/what_we_do', (req, res) => {
    res.render('what_we_do', { title: 'What We Do - Bridge of Hopes' });
});

app.use((req, res, next) => {
    res.setHeader('X-Tunnel-Skip-Anti-Phishing-Page', 'true');
    next();
});

function buildDonateResultUrl({ paymentStatus, txnid, amount, type, name, email, gatewayTxnId, paymentMode, bankRef, message }) {
    const params = new URLSearchParams({
        paymentStatus: paymentStatus || "",
        txnid: txnid || "",
        amount: amount ? String(amount) : "",
        type: type || "once",
        name: name || "",
        email: email || "",
        gatewayTxnId: gatewayTxnId || "",
        paymentMode: paymentMode || "",
        bankRef: bankRef || "",
        message: message || "",
        paidAt: new Date().toISOString(),
    });

    return `/donate?${params.toString()}`;
}
/* =========================
    PAYMENT LOGIC (PayU)
========================= */

// Initiate Donation

// 1. Initiate Donation
app.post("/donate", async (req, res) => {
    try {
        const { amount, name, email, phone, type } = req.body;
        const donationType = type === "monthly" ? "monthly" : "once";
        const txnid = "DON_" + uuidv4();
        const productinfo = donationType === "monthly" ? "Monthly Donation" : "Donation";
        const key = process.env.PAYU_MERCHANT_KEY;
        const salt = process.env.PAYU_MERCHANT_SALT;
        const configuredPayuUrl = (process.env.PAYU_BASE_URL || "").trim();
        const payuBaseUrl = configuredPayuUrl.endsWith("/_payment")
            ? configuredPayuUrl
            : `${configuredPayuUrl}/_payment`;
        const formattedAmount = parseFloat(amount).toFixed(2);

        if (!name || !email || !amount) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        if (!Number.isFinite(parseFloat(amount)) || parseFloat(amount) <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        if (!key || !salt) {
            return res.status(500).json({ error: "Missing PAYU_MERCHANT_KEY or PAYU_MERCHANT_SALT" });
        }

        if (!process.env.BASE_URL) {
            return res.status(500).json({
                error: "Missing BASE_URL. Set your public callback base URL.",
            });
        }
        if (!process.env.BASE_URL.startsWith("https://")) {
            appLogger.warn("BASE_URL is not HTTPS. PayU callbacks require HTTPS and public access in real flow.");
        }

        const isTestUrl = payuBaseUrl === "https://test.payu.in/_payment";
        const isLiveUrl = payuBaseUrl === "https://secure.payu.in/_payment";
        if (!isTestUrl && !isLiveUrl) {
            return res.status(500).json({
                error: "Invalid PAYU_BASE_URL. Use https://test.payu.in/_payment (test) or https://secure.payu.in/_payment (live)",
            });
        }

        const isLikelyTestKey = typeof key === "string" && key.toLowerCase().includes("test");
        if ((isTestUrl && !isLikelyTestKey) || (isLiveUrl && isLikelyTestKey)) {
            appLogger.warn("Potential PayU mode mismatch: verify merchant key and PAYU_BASE_URL belong to same environment");
        }

        const surl = `${process.env.BASE_URL}/payment/success`;
        const furl = `${process.env.BASE_URL}/payment/failure`;

        // Pattern: key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt
        const udf1 = donationType;
        const udf2 = "";
        const udf3 = "";
        const udf4 = "";
        const udf5 = "";

        const hashString =
            `${key}|${txnid}|${formattedAmount}|${productinfo}|${name}|${email}|` +
            `${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${salt}`;

        const hash = crypto
            .createHash("sha512")
            .update(hashString)
            .digest("hex");

        appLogger.info("Forward hash string:", hashString);
        appLogger.info("Amount sent:", formattedAmount);

        await Donation.create({
            txnid, name, email, phone, amount: formattedAmount,
            status: "pending",
        });

        res.json({
            action: payuBaseUrl,
            params: {
                key, txnid, amount: formattedAmount, productinfo,
                firstname: name, email, phone, surl, furl, hash,
                udf1, udf2, udf3, udf4, udf5,
            },
        });
    } catch (err) {
        appLogger.error("Initiation Error:", err);
        res.status(500).json({ error: "Payment initiation failed" });
    }
});

// 2. Success Handler (PayU POSTs to this)
app.post("/payment/success", async (req, res) => {
    appLogger.info("!!! DATA RECEIVED FROM PAYU !!!");
    appLogger.info("Body:", req.body);
    try {
        const { status, txnid, amount, email, firstname, hash, key, productinfo } = req.body;
        const salt = process.env.PAYU_MERCHANT_SALT;
        const udf1 = req.body.udf1 || "";
        const udf2 = req.body.udf2 || "";
        const udf3 = req.body.udf3 || "";
        const udf4 = req.body.udf4 || "";
        const udf5 = req.body.udf5 || "";

        // Pattern: salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
        const reverseHashString =
            `${salt}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|` +
            `${email}|${firstname}|${productinfo}|${amount}|${txnid}|${key}`;
        const calculatedHash = crypto
            .createHash("sha512")
            .update(reverseHashString)
            .digest("hex");

        appLogger.info("Reverse hash string:", reverseHashString);
        appLogger.info("Hash received:", hash);
        appLogger.info("Amount sent:", amount);

        if (calculatedHash !== hash) {
            appLogger.error("Security Alert: Hash Mismatch!");
            await Donation.findOneAndUpdate(
                { txnid },
                { status: "failed", payuResponse: req.body },
                { new: true }
            );

            const failedUrl = buildDonateResultUrl({
                paymentStatus: "failed",
                txnid,
                amount,
                type: udf1,
                name: firstname,
                email,
                gatewayTxnId: req.body.mihpayid,
                paymentMode: req.body.mode,
                bankRef: req.body.bank_ref_num,
                message: "Payment verification failed. Please contact support if amount was deducted.",
            });

            return res.redirect(303, failedUrl);
        }

        await Donation.findOneAndUpdate({ txnid }, { status: "success", payuResponse: req.body });

        const successUrl = buildDonateResultUrl({
            paymentStatus: "success",
            txnid,
            amount,
            type: udf1,
            name: firstname,
            email,
            gatewayTxnId: req.body.mihpayid,
            paymentMode: req.body.mode,
            bankRef: req.body.bank_ref_num,
            message: "Payment completed successfully. Thank you for your donation.",
        });

        res.redirect(303, successUrl);
    } catch (err) {
        appLogger.error("Success Route Error:", err);
        const failedUrl = buildDonateResultUrl({
            paymentStatus: "failed",
            txnid: req.body?.txnid,
            amount: req.body?.amount,
            type: req.body?.udf1,
            name: req.body?.firstname,
            email: req.body?.email,
            message: "We could not process the payment response. Please try again.",
        });
        res.redirect(303, failedUrl);
    }
});




// Failure Handler
app.post("/payment/failure", async (req, res) => {
    try {
        const { txnid, amount, firstname, email } = req.body;
        await Donation.findOneAndUpdate({ txnid }, { status: "failed", payuResponse: req.body });

        const failedUrl = buildDonateResultUrl({
            paymentStatus: "failed",
            txnid,
            amount,
            type: req.body.udf1,
            name: firstname,
            email,
            gatewayTxnId: req.body.mihpayid,
            paymentMode: req.body.mode,
            bankRef: req.body.bank_ref_num,
            message: "Payment failed or was cancelled. You can retry your donation.",
        });

        res.redirect(303, failedUrl);
    } catch (err) {
        appLogger.error(err);
        const failedUrl = buildDonateResultUrl({
            paymentStatus: "failed",
            txnid: req.body?.txnid,
            amount: req.body?.amount,
            type: req.body?.udf1,
            name: req.body?.firstname,
            email: req.body?.email,
            message: "We could not process the failed payment response. Please try again.",
        });
        res.redirect(303, failedUrl);
    }
});

// 4. Start Server
app.listen(PORT, () => {
    appLogger.info(`Server is running at http://localhost:${PORT}`);
});