-- FINAL: MySQL has no partial indexes; retain the corresponding order keys.
CREATE INDEX `Session_listing_hosted_activity_idx`
ON `Session` (`currentStorageState`, `meaningfulActivityAt` DESC, `id` DESC);

CREATE INDEX `Session_listing_state_snapshot_idx`
ON `Session` (`currentStorageState`, `materializedThroughSourceAt` DESC, `id` DESC);

CREATE INDEX `Session_listing_hosted_created_idx`
ON `Session` (`currentStorageState`, `meaningfulActivityAt`, `createdAt` DESC, `id` DESC);

CREATE INDEX `Session_listing_incomplete_created_idx`
ON `Session` (`createdAt` DESC, `id` DESC);
