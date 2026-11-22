-- DropForeignKey
ALTER TABLE `Deployment` DROP FOREIGN KEY `Deployment_contentArtifactId_fkey`;

-- AlterTable
ALTER TABLE `Deployment` MODIFY `contentArtifactId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_contentArtifactId_fkey` FOREIGN KEY (`contentArtifactId`) REFERENCES `Artifact`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
