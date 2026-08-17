ALTER TABLE `Session`
    ADD COLUMN `publisherGeneration` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `publisherGenerationLastActiveAt` DATETIME(3) NULL;
