ALTER TABLE "Discussion" ADD COLUMN "roundOutcomeV1" JSONB;
ALTER TABLE "Discussion" ADD COLUMN "openCommentCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "Discussion" SET "openCommentCount" = (
    SELECT COUNT(*) FROM "DiscussionMessage" m
    WHERE m."discussionId" = "Discussion"."id" AND json_extract(m."replyTargetV1", '$.kind') = 'doc_passage'
        AND json_extract(m."replyTargetV1", '$.doc.ref.artifactId') = json_extract("Discussion"."anchorV1", '$.doc.ref.artifactId')
) WHERE json_extract("anchorV1", '$.kind') = 'doc';
