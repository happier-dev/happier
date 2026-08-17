ALTER TABLE "SessionTurn" ADD COLUMN "transcriptAnchorProjectionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SessionTurn" ADD COLUMN "transcriptAnchorMinSeq" INTEGER;
ALTER TABLE "SessionTurn" ADD COLUMN "transcriptAnchorMaxSeq" INTEGER;

CREATE INDEX "SessionTurn_transcript_anchor_range_idx"
    ON "SessionTurn"("sessionId", "transcriptAnchorProjectionVersion", "transcriptAnchorMaxSeq", "transcriptAnchorMinSeq");
