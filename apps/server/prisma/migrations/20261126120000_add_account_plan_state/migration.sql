-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "plan" TEXT,
ADD COLUMN     "planEndsAt" TIMESTAMP(3),
ADD COLUMN     "planRenews" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "planSource" TEXT,
ADD COLUMN     "supporterRing" BOOLEAN NOT NULL DEFAULT false;
