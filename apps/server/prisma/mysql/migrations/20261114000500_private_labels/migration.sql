-- Private labels are opaque client-owned envelopes and can exceed VARCHAR limits.

-- AlterTable
ALTER TABLE `AccountApiToken` MODIFY `label` LONGTEXT NOT NULL;
ALTER TABLE `AccountHomeDirectoryEntry` MODIFY `label` LONGTEXT NOT NULL;
-- Preserve the Team foreign key's supporting index when removing nameKey.
CREATE INDEX `TeamGroup_teamId_fkey` ON `TeamGroup`(`teamId`);
ALTER TABLE `TeamGroup`
    DROP INDEX `TeamGroup_teamId_nameKey_key`,
    DROP COLUMN `nameKey`,
    MODIFY `name` LONGTEXT NOT NULL;
