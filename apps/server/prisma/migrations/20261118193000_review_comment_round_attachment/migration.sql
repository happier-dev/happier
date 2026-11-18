ALTER TABLE "review_comments" ADD COLUMN "round_ordinal" INTEGER;
CREATE INDEX "review_comments_review_id_round_ordinal_idx" ON "review_comments" ("review_id", "round_ordinal");
