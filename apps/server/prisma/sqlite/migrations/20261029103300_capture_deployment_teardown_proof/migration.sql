-- Historical receipts have no proof and cannot establish complete cleanup.
ALTER TABLE "Deployment" ADD COLUMN "teardownProof" JSONB;
