ALTER TABLE "Session" ADD COLUMN "pendingActivationRequestId" TEXT;
ALTER TABLE "Session" ADD COLUMN "pendingActivationRequestedAt" DATETIME;
ALTER TABLE "Session" ADD COLUMN "pendingActivationStatus" TEXT;
ALTER TABLE "Session" ADD COLUMN "pendingActivationFailureCode" TEXT;
