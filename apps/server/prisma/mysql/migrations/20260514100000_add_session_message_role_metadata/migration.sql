-- AlterTable
ALTER TABLE `SessionMessage` ADD COLUMN `messageRole` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `SessionPendingMessage` ADD COLUMN `messageRole` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `SessionMessage_sessionId_messageRole_seq_idx` ON `SessionMessage`(`sessionId`, `messageRole`, `seq`);

-- CreateIndex
CREATE INDEX `SessionMessage_sessionId_sidechainId_messageRole_seq_idx` ON `SessionMessage`(`sessionId`, `sidechainId`, `messageRole`, `seq`);
