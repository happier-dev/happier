ALTER TABLE `SessionAppearance`
ADD COLUMN `displayCleared` BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN `presentationDbValue` LONGTEXT NULL;
