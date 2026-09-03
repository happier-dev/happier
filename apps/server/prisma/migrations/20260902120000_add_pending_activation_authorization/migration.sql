ALTER TABLE "Session"
ADD COLUMN "pendingActivationRequestId" TEXT,
ADD COLUMN "pendingActivationRequestedAt" TIMESTAMP(3),
ADD COLUMN "pendingActivationStatus" TEXT,
ADD COLUMN "pendingActivationFailureCode" TEXT;
