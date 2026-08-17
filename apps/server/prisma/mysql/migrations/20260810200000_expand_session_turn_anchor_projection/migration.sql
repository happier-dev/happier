ALTER TABLE `SessionTurn`
    ADD COLUMN `transcriptAnchorProjectionVersion` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `transcriptAnchorMinSeq` INTEGER NULL,
    ADD COLUMN `transcriptAnchorMaxSeq` INTEGER NULL;

CREATE INDEX `SessionTurn_transcript_anchor_range_idx`
    ON `SessionTurn`(`sessionId`, `transcriptAnchorProjectionVersion`, `transcriptAnchorMaxSeq`, `transcriptAnchorMinSeq`);
