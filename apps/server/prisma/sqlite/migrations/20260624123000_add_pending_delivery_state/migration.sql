-- Final unreleased Pending persistence transition.
ALTER TABLE "Session"
    ADD COLUMN "pendingBlockedCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SessionMessage" ADD COLUMN "sourceCreatedAt" DATETIME;
ALTER TABLE "SessionMessage" ADD COLUMN "sourceUpdatedAt" DATETIME;
ALTER TABLE "SessionMessage" ADD COLUMN "transcriptObservationProvenance" JSONB
    CHECK ("transcriptObservationProvenance" IS NULL OR json_valid("transcriptObservationProvenance"));
ALTER TABLE "SessionMessage" ADD COLUMN "deliveryResolution" JSONB
    CHECK ("deliveryResolution" IS NULL OR json_valid("deliveryResolution"));

PRAGMA defer_foreign_keys=ON;

CREATE TABLE "new_SessionPendingMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "authorAccountId" TEXT,
    "localId" TEXT NOT NULL,
    "messageRole" TEXT,
    "content" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "deliveryState" TEXT,
    "deliveryBlockedReason" TEXT,
    "requestedAction" JSONB NOT NULL
        CHECK (json_valid("requestedAction") AND json_type("requestedAction") = 'object'),
    "providerAction" TEXT
        CHECK ("providerAction" IS NULL OR "providerAction" IN ('send', 'steer', 'interrupt_and_send')),
    "position" INTEGER NOT NULL,
    "discardedAt" DATETIME,
    "discardedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionPendingMessage_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionPendingMessage_authorAccountId_fkey"
        FOREIGN KEY ("authorAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_SessionPendingMessage" (
    "id", "sessionId", "authorAccountId", "localId", "messageRole", "content", "status",
    "deliveryState", "deliveryBlockedReason", "requestedAction", "providerAction", "position",
    "discardedAt", "discardedReason", "createdAt", "updatedAt"
)
SELECT
    "id", "sessionId", "authorAccountId", "localId", "messageRole", "content", "status",
    NULL, NULL, '{"v":1,"kind":"enqueue"}', NULL, "position",
    "discardedAt", "discardedReason", "createdAt", "updatedAt"
FROM "SessionPendingMessage";

DROP TABLE "SessionPendingMessage";
ALTER TABLE "new_SessionPendingMessage" RENAME TO "SessionPendingMessage";

CREATE UNIQUE INDEX "SessionPendingMessage_sessionId_localId_key"
    ON "SessionPendingMessage"("sessionId", "localId");
CREATE INDEX "SessionPendingMessage_sessionId_status_position_idx"
    ON "SessionPendingMessage"("sessionId", "status", "position");
CREATE INDEX "SessionPendingMessage_sid_status_dstate_position_idx"
    ON "SessionPendingMessage"("sessionId", "status", "deliveryState", "position");
CREATE INDEX "SessionPendingMessage_sessionId_authorAccountId_idx"
    ON "SessionPendingMessage"("sessionId", "authorAccountId");
CREATE INDEX "SessionPendingMessage_sessionId_status_updatedAt_idx"
    ON "SessionPendingMessage"("sessionId", "status", "updatedAt");

PRAGMA defer_foreign_keys=OFF;
