-- Add a server-readable activity projection for list ordering/grouping without hydrating transcripts.
ALTER TABLE `Session` ADD COLUMN `meaningfulActivityAt` DATETIME(3) NULL;

UPDATE `Session` s
SET `meaningfulActivityAt` = COALESCE(
    (
        SELECT MAX(`createdAt`)
        FROM (
            SELECT `createdAt`
            FROM `SessionMessage`
            WHERE `SessionMessage`.`sessionId` = s.`id`
            UNION ALL
            SELECT `createdAt`
            FROM `SessionPendingMessage`
            WHERE `SessionPendingMessage`.`sessionId` = s.`id`
        ) AS `SessionActivity`
    ),
    s.`createdAt`
)
WHERE s.`meaningfulActivityAt` IS NULL;

CREATE INDEX `Session_accountId_meaningfulActivityAt_id_idx`
ON `Session`(`accountId`, `meaningfulActivityAt`, `id`);
