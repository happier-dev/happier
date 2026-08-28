CREATE TABLE "review_comment_publication_correlations" (
    "publication_correlation_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "comment_id" TEXT,
    "target_key" TEXT NOT NULL,
    "target_json" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "review_comment_publication_correlations_pkey" PRIMARY KEY ("publication_correlation_id")
);

CREATE UNIQUE INDEX "review_comment_publication_target_key"
ON "review_comment_publication_correlations"("account_id", "comment_id", "target_key");

ALTER TABLE "review_comment_publication_correlations"
ADD CONSTRAINT "review_comment_publication_correlations_account_id_fkey"
FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comment_publication_correlations"
ADD CONSTRAINT "review_comment_publication_correlations_comment_id_fkey"
FOREIGN KEY ("comment_id") REFERENCES "review_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
