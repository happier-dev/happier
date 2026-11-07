-- Nullable routing metadata is captured only for new admissions; existing Runs remain unclassified.
ALTER TABLE "AutomationRun" ADD COLUMN "originDiscussionId" TEXT;

CREATE INDEX "AutomationRun_originDiscussion_created_id_idx" ON "AutomationRun"("originDiscussionId", "createdAt" DESC, "id" DESC);
