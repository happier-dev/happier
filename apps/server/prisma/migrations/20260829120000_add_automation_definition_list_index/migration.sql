-- CreateIndex
-- Covers the ordinary V3 Automation keyset scan:
-- account + live rows, ordered by updatedAt DESC and id ASC.
CREATE INDEX "Automation_account_deleted_updated_id_idx"
    ON "Automation"("accountId", "deletedAt", "updatedAt" DESC, "id" ASC);
