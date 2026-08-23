ALTER TABLE `Session`
    ADD COLUMN `currentStorageState` VARCHAR(191) NOT NULL DEFAULT 'hosted',
    ADD COLUMN `acceptedThroughServerSeq` INTEGER NULL,
    ADD COLUMN `materializationPublicationId` VARCHAR(191) NULL,
    ADD COLUMN `materializedThroughSourceAt` BIGINT NULL,
    ADD COLUMN `publishedThroughServerSeq` INTEGER NULL;

-- Predecessor direct External Session rows were created before any
-- server-readable publication authority existed, so nothing proves their
-- server transcript is the complete conversation. Inheriting the `hosted`
-- default would make them unbounded and shareable. They fail closed at
-- `legacy_external_unknown` until the owner machine reconciles them; the
-- message count is deliberately not consulted, because a partial import is
-- exactly the row that looks non-empty. Ordinary Sessions keep `hosted`.
-- The binary conversion keeps the prefix byte-exact under MySQL's default
-- accent/case-insensitive collation.
UPDATE `Session`
SET `currentStorageState` = 'legacy_external_unknown'
WHERE CONVERT(`tag` USING BINARY) LIKE _binary'direct:v1:%';
