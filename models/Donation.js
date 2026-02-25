const mongoose = require("mongoose");

const donationSchema = new mongoose.Schema(
  {
    txnid: { type: String, required: true, unique: true },
    name: String,
    email: String,
    phone: String,
    amount: Number,
    status: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "pending",
    },
    payuResponse: Object,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Donation", donationSchema);