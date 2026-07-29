-- AlterTable
ALTER TABLE "Session" ADD COLUMN "meaningfulActivityAt" DATETIME;

-- Backfill from durable transcript or pending activity, falling back to session creation.
UPDATE "Session"
SET "meaningfulActivityAt" = COALESCE(
    (
        SELECT MAX("createdAt")
        FROM (
            SELECT "createdAt"
            FROM "SessionMessage"
            WHERE "SessionMessage"."sessionId" = "Session"."id"
            UNION ALL
            SELECT "createdAt"
            FROM "SessionPendingMessage"
            WHERE "SessionPendingMessage"."sessionId" = "Session"."id"
        ) AS "SessionActivity"
    ),
    "createdAt"
);

-- CreateIndex
CREATE INDEX "Session_accountId_meaningfulActivityAt_id_idx" ON "Session"("accountId", "meaningfulActivityAt", "id");
