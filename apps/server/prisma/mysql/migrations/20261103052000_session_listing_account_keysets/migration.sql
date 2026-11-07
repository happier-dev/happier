-- FINAL: replace global listing keys with Account-ordered keys after the
-- compiled scope is split into owned/other keyset reads. The earlier applied
-- 20261103043300 migration is immutable. All four replacements are EXPLAIN-proven.
DROP INDEX `Session_listing_hosted_activity_idx` ON `Session`;
DROP INDEX `Session_listing_state_snapshot_idx` ON `Session`;
DROP INDEX `Session_listing_hosted_created_idx` ON `Session`;
DROP INDEX `Session_listing_incomplete_created_idx` ON `Session`;

CREATE INDEX `Session_listing_hosted_activity_idx`
ON `Session` (`accountId`, `currentStorageState`, `meaningfulActivityAt` DESC, `id` DESC);

CREATE INDEX `Session_listing_state_snapshot_idx`
ON `Session` (`accountId`, `currentStorageState`, `materializedThroughSourceAt` DESC, `id` DESC);

CREATE INDEX `Session_listing_hosted_created_idx`
ON `Session` (`accountId`, `currentStorageState`, `meaningfulActivityAt`, `createdAt` DESC, `id` DESC);

CREATE INDEX `Session_listing_incomplete_created_idx`
ON `Session` (`accountId`, `createdAt` DESC, `id` DESC);
