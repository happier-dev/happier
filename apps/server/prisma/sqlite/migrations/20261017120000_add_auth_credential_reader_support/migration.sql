-- AlterTable
ALTER TABLE "TerminalAuthRequest" ADD COLUMN "supportsTokenOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AuthPairingSession" ADD COLUMN "supportsCredentialVariants" BOOLEAN NOT NULL DEFAULT false;
