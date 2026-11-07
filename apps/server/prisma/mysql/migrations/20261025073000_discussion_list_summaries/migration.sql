ALTER TABLE `Discussion` ADD COLUMN `roundOutcomeV1` JSON NULL,
    ADD COLUMN `openCommentCount` INTEGER NOT NULL DEFAULT 0;

UPDATE `Discussion` d SET `openCommentCount` = (
    SELECT COUNT(*) FROM `DiscussionMessage` m
    WHERE m.`discussionId` = d.`id` AND JSON_UNQUOTE(JSON_EXTRACT(m.`replyTargetV1`, '$.kind')) = 'doc_passage'
        AND JSON_UNQUOTE(JSON_EXTRACT(m.`replyTargetV1`, '$.doc.ref.artifactId')) = JSON_UNQUOTE(JSON_EXTRACT(d.`anchorV1`, '$.doc.ref.artifactId'))
) WHERE JSON_UNQUOTE(JSON_EXTRACT(d.`anchorV1`, '$.kind')) = 'doc';
