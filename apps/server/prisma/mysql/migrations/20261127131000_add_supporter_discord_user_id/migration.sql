ALTER TABLE `SupporterRecord` ADD COLUMN `discordUserId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `SupporterRecord_discordUserId_key` ON `SupporterRecord`(`discordUserId`);
