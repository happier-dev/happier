ALTER TABLE "Discussion" ADD COLUMN "roundOutcomeV1" JSONB;
ALTER TABLE "Discussion" ADD COLUMN "openCommentCount" INTEGER NOT NULL DEFAULT 0;

-- Root identity is already server-visible; never open authored content to backfill.
UPDATE "Discussion" d SET "openCommentCount" = (
    SELECT COUNT(*) FROM "DiscussionMessage" m
    WHERE m."discussionId" = d."id" AND m."replyTargetV1"->>'kind' = 'doc_passage'
        AND m."replyTargetV1"->'doc'->'ref'->>'artifactId' = d."anchorV1"->'doc'->'ref'->>'artifactId'
) WHERE d."anchorV1"->>'kind' = 'doc';
