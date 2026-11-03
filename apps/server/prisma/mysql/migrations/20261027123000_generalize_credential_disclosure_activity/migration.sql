ALTER TABLE `TeamCredentialActivityEvent`
    MODIFY `teamId` VARCHAR(191) NULL,
    ADD COLUMN `subjectKind` VARCHAR(191) NOT NULL DEFAULT 'team_credential',
    ADD COLUMN `ownerAccountId` VARCHAR(191) NULL,
    ADD COLUMN `resourceRevision` INTEGER NULL,
    ADD COLUMN `deviceId` VARCHAR(191) NULL,
    ADD COLUMN `outcome` VARCHAR(191) NULL,
    ADD COLUMN `copyOutcome` VARCHAR(191) NULL,
    ADD COLUMN `copyRequestedAt` DATETIME(3) NULL;

ALTER TABLE `TeamCredentialActivityEvent` ADD CONSTRAINT `TeamCredentialActivityEvent_ownerAccountId_fkey`
    FOREIGN KEY (`ownerAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX `CredentialActivity_owner_resource_cursor_idx`
    ON `TeamCredentialActivityEvent`(`ownerAccountId`, `resourceId`, `createdAt`, `id`);
