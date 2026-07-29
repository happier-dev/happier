-- Final unreleased Pending persistence transition.
ALTER TABLE "Session"
    ADD COLUMN "pendingBlockedCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SessionMessage"
    ADD COLUMN "sourceCreatedAt" TIMESTAMP(3),
    ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3),
    ADD COLUMN "transcriptObservationProvenance" JSONB,
    ADD COLUMN "deliveryResolution" JSONB;

CREATE TYPE "PendingProviderAction" AS ENUM ('send', 'steer', 'interrupt_and_send');

ALTER TABLE "SessionPendingMessage"
    ADD COLUMN "deliveryState" TEXT,
    ADD COLUMN "deliveryBlockedReason" TEXT,
    ADD COLUMN "requestedAction" JSONB,
    ADD COLUMN "providerAction" "PendingProviderAction";

UPDATE "SessionPendingMessage"
SET "requestedAction" = '{"v":1,"kind":"enqueue"}'::jsonb;

ALTER TABLE "SessionPendingMessage"
    ALTER COLUMN "requestedAction" SET NOT NULL;

CREATE INDEX "SessionPendingMessage_sid_status_dstate_position_idx"
ON "SessionPendingMessage"("sessionId", "status", "deliveryState", "position");
