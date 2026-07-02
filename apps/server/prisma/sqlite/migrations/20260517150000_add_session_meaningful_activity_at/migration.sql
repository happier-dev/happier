-- Add a server-readable activity projection for list ordering/grouping without hydrating transcripts.
ALTER TABLE "Session" ADD COLUMN "meaningfulActivityAt" DATETIME;

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
    "Session"."createdAt"
)
WHERE "meaningfulActivityAt" IS NULL;

CREATE INDEX "Session_accountId_meaningfulActivityAt_id_idx"
ON "Session"("accountId", "meaningfulActivityAt", "id");
