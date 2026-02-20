-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "encryptionMode" TEXT NOT NULL DEFAULT 'e2ee';
ALTER TABLE "Account" ADD COLUMN     "encryptionModeUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "encryptionMode" TEXT NOT NULL DEFAULT 'e2ee';

