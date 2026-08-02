-- Durable explicit-stop intent: the disconnect that completes a stop can land on a
-- different server instance than the RPC that accepted it.

ALTER TABLE "Session" ADD COLUMN "stopRequestedAt" TIMESTAMP(3);
