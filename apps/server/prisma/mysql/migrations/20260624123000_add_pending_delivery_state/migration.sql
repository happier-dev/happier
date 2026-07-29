-- Final unreleased Pending persistence transition.
ALTER TABLE `Session`
    ADD COLUMN `pendingBlockedCount` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `SessionMessage`
    ADD COLUMN `sourceCreatedAt` DATETIME(3) NULL,
    ADD COLUMN `sourceUpdatedAt` DATETIME(3) NULL,
    ADD COLUMN `transcriptObservationProvenance` JSON NULL,
    ADD COLUMN `deliveryResolution` JSON NULL;

ALTER TABLE `SessionPendingMessage`
    ADD COLUMN `deliveryState` VARCHAR(191) NULL,
    ADD COLUMN `deliveryBlockedReason` VARCHAR(191) NULL,
    ADD COLUMN `requestedAction` JSON NULL,
    ADD COLUMN `providerAction` ENUM('send', 'steer', 'interrupt_and_send') NULL;

UPDATE `SessionPendingMessage`
SET `requestedAction` = JSON_OBJECT('v', 1, 'kind', 'enqueue');

ALTER TABLE `SessionPendingMessage`
    MODIFY `requestedAction` JSON NOT NULL;

CREATE INDEX `SessionPendingMessage_sid_status_dstate_position_idx`
ON `SessionPendingMessage`(`sessionId`, `status`, `deliveryState`, `position`);
