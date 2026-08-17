ALTER TABLE `SessionSystemRecord`
MODIFY `namespace` VARCHAR(64) NOT NULL,
MODIFY `kind` VARCHAR(64) NOT NULL,
ADD COLUMN `ownerKind` VARCHAR(16) NULL,
ADD COLUMN `pluginId` LONGTEXT NULL,
ADD COLUMN `namespaceAddressKey` BINARY(32) NULL,
ADD COLUMN `recordAddressKey` BINARY(32) NULL,
ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1,
ADD CONSTRAINT `SessionSystemRecord_ownerKind_check`
  CHECK (`ownerKind` IS NULL OR `ownerKind` IN ('host', 'plugin')),
ADD CONSTRAINT `SessionSystemRecord_version_check`
  CHECK (`version` BETWEEN 1 AND 2147483647);
