-- SQLite stores Account labels as unbounded TEXT. Remove the obsolete
-- server-readable group-name key.

-- DropIndex
DROP INDEX "TeamGroup_teamId_nameKey_key";

-- AlterTable
ALTER TABLE "TeamGroup" DROP COLUMN "nameKey";
