-- Final unreleased runtime-activity projection.
ALTER TABLE `Session`
    ADD COLUMN `runtimeActivityState` VARCHAR(191) NOT NULL DEFAULT 'unknown',
    ADD COLUMN `runtimeActivityActiveCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `runtimeActivityObservedAt` BIGINT NULL,
    ADD COLUMN `runtimeActivityRevision` BIGINT NOT NULL DEFAULT 0,
    MODIFY COLUMN `active` BOOLEAN NOT NULL DEFAULT false;
