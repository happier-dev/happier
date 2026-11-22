-- AlterTable
ALTER TABLE `ReviewMetadata` ADD COLUMN `sourceSessionId` VARCHAR(191) NULL,
    ADD COLUMN `sourceSessionSeq` INTEGER NULL,
    ADD COLUMN `workflowRunId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `ReviewMetadata_workflowRunId_idx` ON `ReviewMetadata`(`workflowRunId`);

-- CreateIndex
CREATE INDEX `ReviewMetadata_sourceSessionId_state_startedAt_artifactId_idx` ON `ReviewMetadata`(`sourceSessionId`, `state`, `startedAt` DESC, `artifactId`);
