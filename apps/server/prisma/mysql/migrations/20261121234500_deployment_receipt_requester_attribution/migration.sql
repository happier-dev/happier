-- DropForeignKey
ALTER TABLE `Deployment` DROP FOREIGN KEY `Deployment_requestedByAccountId_fkey`;

-- AlterTable
ALTER TABLE `Deployment` MODIFY `requestedByAccountId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Deployment_requestedByAccountId_state_idx` ON `Deployment`(`requestedByAccountId`, `state`);

-- AddForeignKey
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_requestedByAccountId_fkey` FOREIGN KEY (`requestedByAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
