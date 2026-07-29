ALTER TABLE `Session`
    ADD COLUMN `currentStorageState` VARCHAR(191) NOT NULL DEFAULT 'hosted',
    ADD COLUMN `acceptedThroughServerSeq` INTEGER NULL,
    ADD COLUMN `materializationPublicationId` VARCHAR(191) NULL,
    ADD COLUMN `materializedThroughSourceAt` BIGINT NULL,
    ADD COLUMN `publishedThroughServerSeq` INTEGER NULL;
