-- AlterTable
ALTER TABLE "SessionTurn"
    ADD COLUMN "transcriptAnchorProjectionVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "transcriptAnchorMinSeq" INTEGER,
    ADD COLUMN "transcriptAnchorMaxSeq" INTEGER;

-- CreateIndex
CREATE INDEX "SessionTurn_transcript_anchor_range_idx"
    ON "SessionTurn"("sessionId", "transcriptAnchorProjectionVersion", "transcriptAnchorMaxSeq", "transcriptAnchorMinSeq");
