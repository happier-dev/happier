-- Session Project classification: an owner-published "no Project" fact, distinct from a
-- null key that is not yet classified (every pre-existing row, including 0.2 data).
ALTER TABLE `Session` ADD COLUMN `projectKeyNone` BOOLEAN NOT NULL DEFAULT false;

-- Project selection reads members by key and unclassified rows by (null, false); known-none rows are skipped.
CREATE INDEX `Session_project_selection_idx` ON `Session`(`accountId`, `projectKey`, `projectKeyNone`);
