-- MySQL forbids CHECK on cascading FK columns; extend the existing source-identity triggers.
ALTER TABLE `AccountSessionFollow`
    ADD COLUMN `sourceExecutionRunMachineId` VARCHAR(191) NULL,
    ADD INDEX `AccountSessionFollow_sourceExecutionRunMachineId_idx` (`sourceExecutionRunMachineId`),
    ADD CONSTRAINT `AccountSessionFollow_sourceExecutionRunMachineId_fkey` FOREIGN KEY (`sourceExecutionRunMachineId`) REFERENCES `Machine` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
DROP TRIGGER `AccountSessionFollow_source_identity_insert`;
DROP TRIGGER `AccountSessionFollow_source_identity_update`;
ALTER TABLE `SessionFollowEdge`
    ADD COLUMN `sourceExecutionRunMachineId` VARCHAR(191) NULL,
    ADD INDEX `SessionFollowEdge_executionRunMachineSource_idx` (`sourceExecutionRunMachineId`, `sourceExecutionRunId`),
    ADD CONSTRAINT `SessionFollowEdge_sourceExecutionRunMachineId_fkey` FOREIGN KEY (`sourceExecutionRunMachineId`) REFERENCES `Machine` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
DROP TRIGGER `SessionFollowEdge_source_identity_insert`;
DROP TRIGGER `SessionFollowEdge_source_identity_update`;
CREATE TRIGGER `AccountSessionFollow_source_identity_insert`
BEFORE INSERT ON `AccountSessionFollow`
FOR EACH ROW
BEGIN
    IF NOT (
        (NEW.`sessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND (NEW.`sourceKey` IS NULL OR BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sessionId`))
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND ((NEW.`sourceExecutionRunSessionId` IS NOT NULL AND NEW.`sourceExecutionRunMachineId` IS NULL) OR (NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NOT NULL)) AND NEW.`sourceExecutionRunId` IS NOT NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY LEFT(NEW.`sourceKey`, 14) = BINARY 'execution_run:'
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NOT NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY LEFT(NEW.`sourceKey`, 13) = BINARY 'workflow_run:'
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL)
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AccountSessionFollow source identity mismatch'; END IF;
    IF (NEW.`deliveredDiscussionSeq` IS NOT NULL AND NEW.`deliveredDiscussionSeq` < 0)
        OR (NEW.`deliveredWorkflowRunRevision` IS NOT NULL AND NEW.`deliveredWorkflowRunRevision` < 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AccountSessionFollow source progress invalid';
    END IF;
END;
CREATE TRIGGER `AccountSessionFollow_source_identity_update`
BEFORE UPDATE ON `AccountSessionFollow`
FOR EACH ROW
BEGIN
    IF NOT (
        (NEW.`sessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND (NEW.`sourceKey` IS NULL OR BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sessionId`))
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND ((NEW.`sourceExecutionRunSessionId` IS NOT NULL AND NEW.`sourceExecutionRunMachineId` IS NULL) OR (NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NOT NULL)) AND NEW.`sourceExecutionRunId` IS NOT NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY LEFT(NEW.`sourceKey`, 14) = BINARY 'execution_run:'
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NOT NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY LEFT(NEW.`sourceKey`, 13) = BINARY 'workflow_run:'
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL)
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AccountSessionFollow source identity mismatch'; END IF;
    IF (NEW.`deliveredDiscussionSeq` IS NOT NULL AND NEW.`deliveredDiscussionSeq` < 0)
        OR (NEW.`deliveredWorkflowRunRevision` IS NOT NULL AND NEW.`deliveredWorkflowRunRevision` < 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AccountSessionFollow source progress invalid';
    END IF;
END;
CREATE TRIGGER `SessionFollowEdge_source_identity_insert`
BEFORE INSERT ON `SessionFollowEdge`
FOR EACH ROW
BEGIN
    IF NOT (
        (NEW.`sourceSessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sourceSessionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND ((NEW.`sourceExecutionRunSessionId` IS NOT NULL AND NEW.`sourceExecutionRunMachineId` IS NULL) OR (NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NOT NULL)) AND NEW.`sourceExecutionRunId` IS NOT NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY LEFT(NEW.`sourceKey`, 14) = BINARY 'execution_run:' AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NOT NULL
            AND BINARY LEFT(NEW.`sourceKey`, 13) = BINARY 'workflow_run:' AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL)
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge source identity mismatch'; END IF;
    IF NOT ((NEW.`relation` = 'manager' AND NEW.`sourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` = NEW.`sourceSessionId`)
        OR (NEW.`relation` = 'follower' AND NEW.`managerSourceSessionId` IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge manager relation identity mismatch';
    END IF;
    IF NEW.`deliveredWorkflowRunRevision` IS NOT NULL AND NEW.`deliveredWorkflowRunRevision` < 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge workflow progress invalid';
    END IF;
END;
CREATE TRIGGER `SessionFollowEdge_source_identity_update`
BEFORE UPDATE ON `SessionFollowEdge`
FOR EACH ROW
BEGIN
    IF NOT (
        (NEW.`sourceSessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sourceSessionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND ((NEW.`sourceExecutionRunSessionId` IS NOT NULL AND NEW.`sourceExecutionRunMachineId` IS NULL) OR (NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NOT NULL)) AND NEW.`sourceExecutionRunId` IS NOT NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY LEFT(NEW.`sourceKey`, 14) = BINARY 'execution_run:' AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunMachineId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NOT NULL
            AND BINARY LEFT(NEW.`sourceKey`, 13) = BINARY 'workflow_run:' AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL)
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge source identity mismatch'; END IF;
    IF NOT ((NEW.`relation` = 'manager' AND NEW.`sourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` = NEW.`sourceSessionId`)
        OR (NEW.`relation` = 'follower' AND NEW.`managerSourceSessionId` IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge manager relation identity mismatch';
    END IF;
    IF NEW.`deliveredWorkflowRunRevision` IS NOT NULL AND NEW.`deliveredWorkflowRunRevision` < 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge workflow progress invalid';
    END IF;
END;
