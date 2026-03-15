-- AlterTable
ALTER TABLE `SessionMessage` ADD COLUMN `sidechainId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `SessionMessage_sessionId_sidechainId_seq_idx` ON `SessionMessage`(`sessionId`, `sidechainId`, `seq`);

