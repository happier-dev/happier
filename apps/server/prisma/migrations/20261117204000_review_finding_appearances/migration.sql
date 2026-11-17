ALTER TABLE "review_comments" ADD COLUMN "review_id" TEXT REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "review_comments_review_finding_identity_key" ON "review_comments" ("review_id", "finding_identity");
CREATE INDEX "review_comments_review_id_state_updated_at_idx" ON "review_comments" ("review_id", "state", "updated_at");
CREATE TABLE "review_comment_appearances" (
    "review_id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "round_ordinal" INTEGER NOT NULL,
    "source_key" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "machine_id" TEXT,
    "session_id" TEXT,
    PRIMARY KEY ("comment_id", "round_ordinal", "source_key"),
    CONSTRAINT "review_comment_appearances_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "review_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "review_comment_appearances_review_id_round_ordinal_idx" ON "review_comment_appearances" ("review_id", "round_ordinal");
