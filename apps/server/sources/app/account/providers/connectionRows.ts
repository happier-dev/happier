import {
  PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, ProviderConnectionsContentV1Schema, StoredProviderConnectionsContentV1Schema,
  assertProviderConnectionsContentForModeV1, listProviderConnectionsCatalogSavedSecretRefsV1, parseProviderConnectionsMigrationContentV1,
  type ProviderConnectionsRowMutationV1, type StoredProviderConnectionsContentV1,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import type { Tx } from '@/storage/inTx';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx,
  type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';
import { validateSavedSecretResourceReferencesInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';

export const providerConnectionsRowDomain: ReservedAccountScopedKvRowDomain<StoredProviderConnectionsContentV1> = {
  label: 'Provider connections catalog',
  parseStoredEnvelope(value) { const parsed = StoredProviderConnectionsContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
  parseCandidateEnvelope(value) { const parsed = ProviderConnectionsContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
  assertEnvelopeForMode: assertProviderConnectionsContentForModeV1,
};

export function markProviderConnectionsRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
  return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
    hint: { providerConnections: true, revision: input.revision } });
}

export async function readProviderConnectionsRowInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
  const row = await readReservedAccountScopedKvRowInTx(tx, { ...input,
    physicalKey: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, domain: providerConnectionsRowDomain });
  return row.status === 'present' ? { status: 'present' as const, revision: row.revision, content: row.envelope } : row;
}

/** Mode, source CAS, references and catalog CAS remain inside the same existing transaction. */
export async function mutateProviderConnectionsRowInTx(tx: Tx, input: ProviderConnectionsRowMutationV1 & Readonly<{
  accountId: string; authentication?: TeamOperationAuthenticationContext;
}>) {
  const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
  if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
  if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
  if (input.content !== null) {
    try { assertProviderConnectionsContentForModeV1(input.content, fence.account.currentness.encryptionMode); }
    catch { return { status: 'account-mode-mismatch' as const }; }
  }
  if (input.expectedRevision === 'absent') {
    if (input.sourceSettingsVersion === undefined || input.content === null) throw new Error('Provider catalog initialization requires captured source currentness');
    const source = await tx.account.findUniqueOrThrow({ where: { id: input.accountId }, select: { settingsVersion: true } });
    if (source.settingsVersion !== input.sourceSettingsVersion) return { status: 'settings-conflict' as const, revision: source.settingsVersion };
  } else if (input.sourceSettingsVersion !== undefined) throw new Error('Only catalog initialization admits a source Settings version');

  const current = await readProviderConnectionsRowInTx(tx, { accountId: input.accountId });
  if (current.status !== 'present' && current.status !== 'absent' && current.status !== 'deleted') return current;
  if (current.status === 'present' && parseProviderConnectionsMigrationContentV1(current.content) === null) {
    return { status: 'invalid-stored-content' as const };
  }
  const declared = [...new Set(input.referencedSavedSecretIds)].sort();
  if (input.content?.t === 'plain') {
    const actual = [...new Set(listProviderConnectionsCatalogSavedSecretRefsV1(input.content.v).map(ref => ref.secretId))].sort();
    if (actual.length !== declared.length || actual.some((ref, index) => ref !== declared[index])) return { status: 'invalid-reference' as const };
  } else if (input.content === null && declared.length > 0) return { status: 'invalid-reference' as const };
  if (!await validateSavedSecretResourceReferencesInTx(tx, { accountId: input.accountId, authentication: input.authentication,
    references: declared, savedSecretRevisions: input.savedSecretRevisions })) return { status: 'invalid-reference' as const };

  return mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
    expectedRevision: input.expectedRevision, envelope: input.content, domain: providerConnectionsRowDomain,
    markChanged: ({ tx: changeTx, revision }) => markProviderConnectionsRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
}
