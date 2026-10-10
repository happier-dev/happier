ALTER TABLE `SessionMessage` ADD COLUMN `surfaceItemReference` JSON NULL;
ALTER TABLE `PublicSessionShare` ADD COLUMN `networkOff` BOOLEAN NOT NULL DEFAULT false;
