-- AlterTable
ALTER TABLE "AccountChange" ADD COLUMN     "artifactId" TEXT,
ADD COLUMN     "machineId" TEXT,
ADD COLUMN     "sessionId" TEXT;

-- Backfill entity FK columns for existing rows (only when the target entity exists).
UPDATE "AccountChange" ac
SET "sessionId" = ac."entityId"
WHERE ac."sessionId" IS NULL
  AND ac."kind" IN ('session', 'share')
  AND EXISTS (SELECT 1 FROM "Session" s WHERE s."id" = ac."entityId");

UPDATE "AccountChange" ac
SET "machineId" = ac."entityId"
WHERE ac."machineId" IS NULL
  AND ac."kind" = 'machine'
  AND EXISTS (SELECT 1 FROM "Machine" m WHERE m."id" = ac."entityId");

UPDATE "AccountChange" ac
SET "artifactId" = ac."entityId"
WHERE ac."artifactId" IS NULL
  AND ac."kind" = 'artifact'
  AND EXISTS (SELECT 1 FROM "Artifact" a WHERE a."id" = ac."entityId");

-- AddForeignKey
ALTER TABLE "AccountChange" ADD CONSTRAINT "AccountChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountChange" ADD CONSTRAINT "AccountChange_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountChange" ADD CONSTRAINT "AccountChange_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
