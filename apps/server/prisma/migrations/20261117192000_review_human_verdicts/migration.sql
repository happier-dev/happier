CREATE TABLE "ReviewRequestedReviewer" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "roundOrdinal" INTEGER NOT NULL,
    "principalKey" TEXT NOT NULL,
    "principal" JSONB NOT NULL,
    "required" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("id"),
    CONSTRAINT "ReviewRequestedReviewer_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Artifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReviewRequestedReviewerAccount" (
    "requestId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    PRIMARY KEY ("requestId", "accountId"),
    CONSTRAINT "ReviewRequestedReviewerAccount_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ReviewRequestedReviewer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewRequestedReviewerAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReviewVerdict" (
    "reviewId" TEXT NOT NULL,
    "roundOrdinal" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "content" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("reviewId", "roundOrdinal", "accountId"),
    CONSTRAINT "ReviewVerdict_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Artifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewVerdict_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReviewRequestedReviewer_reviewId_roundOrdinal_principalKey_key" ON "ReviewRequestedReviewer" ("reviewId", "roundOrdinal", "principalKey");

CREATE INDEX "ReviewRequestedReviewer_reviewId_roundOrdinal_idx" ON "ReviewRequestedReviewer" ("reviewId", "roundOrdinal");

CREATE INDEX "ReviewRequestedReviewerAccount_accountId_requestId_idx" ON "ReviewRequestedReviewerAccount" ("accountId", "requestId");

CREATE INDEX "ReviewVerdict_accountId_reviewId_idx" ON "ReviewVerdict" ("accountId", "reviewId");
