-- Nullable coverage preserves retained rows and mixed-version clients as unknown.
ALTER TABLE `Session` ADD COLUMN `usageTimingV1` JSON NULL;
ALTER TABLE `SessionMessage` ADD COLUMN `usageTimingV1` JSON NULL;
ALTER TABLE `SessionPendingMessage` ADD COLUMN `usageTimingV1` JSON NULL;
