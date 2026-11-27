ALTER TABLE `SupporterRecord` ADD COLUMN `discordUserId` VARCHAR(191) NULL,
    ADD UNIQUE INDEX `SupporterRecord_discordUserId_key`(`discordUserId`);
