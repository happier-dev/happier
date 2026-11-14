-- Session external identity: the opaque `direct:v1:<sha256>` external-conversation
-- identity, set at most once and distinct from the immutable creation `tag`.
ALTER TABLE `Session` ADD COLUMN `externalIdentityTag` VARCHAR(191) NULL;

-- Backfill: `direct:v1:` creation tags already are the plaintext identity hashes.
-- The new column is all-NULL before this statement and (accountId, tag) is already
-- unique, so the copied (accountId, externalIdentityTag) pairs are unique too.
UPDATE `Session` SET `externalIdentityTag` = `tag` WHERE `tag` LIKE 'direct:v1:%';

-- CreateIndex
CREATE UNIQUE INDEX `Session_accountId_externalIdentityTag_key` ON `Session`(`accountId`, `externalIdentityTag`);
