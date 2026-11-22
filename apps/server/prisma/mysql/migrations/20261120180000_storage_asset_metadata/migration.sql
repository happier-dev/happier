ALTER TABLE `DiscussionAttachment` ADD COLUMN `removedByAccountId` VARCHAR(191) NULL;
ALTER TABLE `UploadedFile` ADD COLUMN `storedSizeBytes` BIGINT NULL;
