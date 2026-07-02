ALTER TABLE `Session`
    ADD COLUMN `pendingRequestObservedAt` DATETIME(3) NULL,
    ADD COLUMN `latestReadyEventSeq` INTEGER NULL,
    ADD COLUMN `latestReadyEventAt` DATETIME(3) NULL,
    ADD COLUMN `thinking` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `thinkingAt` DATETIME(3) NULL;
