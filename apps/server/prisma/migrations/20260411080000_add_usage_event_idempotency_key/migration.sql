ALTER TABLE "UsageEvent" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "UsageEvent_idempotencyKey_key" ON "UsageEvent"("idempotencyKey");
