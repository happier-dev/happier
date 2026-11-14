-- Private labels are opaque client-owned envelopes. PostgreSQL already stores
-- Account labels as TEXT; remove the obsolete server-readable group-name key.

-- DropIndex
DROP INDEX "TeamGroup_teamId_nameKey_key";

-- AlterTable
ALTER TABLE "TeamGroup" DROP COLUMN "nameKey";
