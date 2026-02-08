-- Add claim-secret gating to terminal auth requests.
ALTER TABLE "TerminalAuthRequest" ADD COLUMN "claimSecretHash" TEXT;
ALTER TABLE "TerminalAuthRequest" ADD COLUMN "claimedAt" DATETIME;

