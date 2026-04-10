ALTER TABLE "UsageEvent" ADD COLUMN "invoiceCostUsd" REAL NOT NULL DEFAULT 0;
ALTER TABLE "UsageEvent" ADD COLUMN "billingContext" TEXT;
ALTER TABLE "UsageEvent" ADD COLUMN "costSource" TEXT;
