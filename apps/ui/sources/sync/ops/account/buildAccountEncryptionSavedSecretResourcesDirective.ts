import type { SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import {
  openSavedSecretResourceStoredContentV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import type { AccountEncryptionMigrateSavedSecretResourcesDirectiveV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

import { getRandomBytes } from '@/platform/cryptoRandom';
import { sealOwnerSavedSecretResourceEnvelope } from '@/sync/encryption/savedSecretOwnerEnvelope';

type HealthyMaterial = Extract<
  SavedSecretResourceMaterialV1,
  { resourceId: string }
>;

/**
 * Reseals every Saved Secret the Account owns with no grants to other people
 * into the migration's target mode (F1, ORCH 10-31). The server holds the same
 * census and refuses the switch unless exactly these resources are resealed,
 * so a resource that cannot be opened here fails the migration rather than
 * being left behind. Shared resources keep their mode; their next write
 * re-seals them under the Account mode.
 */
export async function buildAccountEncryptionSavedSecretResourcesDirective(
  params: Readonly<{
    accountId: string;
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    resources: readonly SavedSecretResourceMaterialV1[];
    /** Opens the owner's source envelope; only consulted for E2EE resources. */
    openSourceDataKey: (encryptedDataKey: string) => Promise<Uint8Array | null>;
    /** The target Account content public key; required when converting into E2EE. */
    targetContentPublicKey: Uint8Array | null;
  }>,
): Promise<
  AccountEncryptionMigrateSavedSecretResourcesDirectiveV1 | undefined
> {
  const owned = params.resources.filter(
    (row): row is HealthyMaterial =>
      'resourceId' in row &&
      row.entry.relationship === 'owner' &&
      row.encryptionMode === params.fromMode &&
      row.entry.audience !== null &&
      row.entry.audience.accounts.length === 0 &&
      row.entry.audience.teams.length === 0 &&
      row.entry.audience.groups.length === 0,
  );
  if (owned.length === 0) return undefined;
  const items: AccountEncryptionMigrateSavedSecretResourcesDirectiveV1['items'][number][] =
    [];
  for (const row of owned) {
    if (!row.storedContent || row.entry.revision === null)
      throw new Error('saved_secret_migration_unavailable');
    let sourceDataKey: Uint8Array | null = null;
    let targetDataKey: Uint8Array | null = null;
    try {
      if (row.encryptionMode === 'e2ee') {
        sourceDataKey = row.recipientEnvelope
          ? await params.openSourceDataKey(
              row.recipientEnvelope.encryptedDataKey,
            )
          : null;
        if (!sourceDataKey)
          throw new Error('saved_secret_migration_unavailable');
      }
      const content =
        row.encryptionMode === 'plain'
          ? openSavedSecretResourceStoredContentV1({
              resourceId: row.resourceId,
              mode: 'plain',
              storedContent: row.storedContent,
            })
          : openSavedSecretResourceStoredContentV1({
              resourceId: row.resourceId,
              mode: 'e2ee',
              storedContent: row.storedContent,
              resourceDataKey: sourceDataKey!,
            });
      if (!content) throw new Error('saved_secret_migration_unavailable');
      if (params.toMode === 'plain') {
        items.push({
          resourceId: row.resourceId,
          expectedRevision: row.entry.revision,
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId: row.resourceId,
            mode: 'plain',
            content,
          }),
        });
        continue;
      }
      if (!params.targetContentPublicKey)
        throw new Error('saved_secret_migration_unavailable');
      targetDataKey = getRandomBytes(32);
      items.push({
        resourceId: row.resourceId,
        expectedRevision: row.entry.revision,
        storedContent: sealSavedSecretResourceStoredContentV1({
          resourceId: row.resourceId,
          mode: 'e2ee',
          resourceDataKey: targetDataKey,
          content,
          randomBytes: getRandomBytes,
        }),
        ownerKeyEnvelope: sealOwnerSavedSecretResourceEnvelope(
          params.accountId,
          targetDataKey,
          params.targetContentPublicKey,
        ),
      });
    } finally {
      sourceDataKey?.fill(0);
      targetDataKey?.fill(0);
    }
  }
  return { items };
}
