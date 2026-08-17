ALTER TABLE `AccountPluginRelease`
    ADD COLUMN `packageAssetArchive` JSON NULL,
    ADD COLUMN `packageAssetArtifactId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `AccountPluginRelease_packageAssetArtifactId_key`
ON `AccountPluginRelease`(`packageAssetArtifactId`);

ALTER TABLE `AccountPluginRelease`
    ADD CONSTRAINT `AccountPluginRelease_packageAssetArtifactId_fkey`
    FOREIGN KEY (`packageAssetArtifactId`) REFERENCES `Artifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
