import {
  REMOTE_HOST_ACCOUNT_KV_KEY_V1, RemoteHostCatalogContentV1Schema, RemoteHostCatalogRowMutationV1Schema,
  StoredRemoteHostCatalogContentV1Schema, assertRemoteHostCatalogContentForModeV1,
  readRemoteHostCatalogRecordV1, readRetainedRemoteHostCatalogV1,
  type RemoteHostCatalogRowMutationV1, type StoredRemoteHostCatalogContentV1,
} from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { formatSharedSavedSecretRefV1, parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { openPlainAccountSettingsDbValue, PlainAccountSettingsStorageUnavailableError } from '@/app/encryption/accountSettingsStorage';
import { mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx,
  type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { Tx } from '@/storage/inTx';

export const remoteHostRowDomain: ReservedAccountScopedKvRowDomain<StoredRemoteHostCatalogContentV1> = {
  label: 'Remote host catalog',
  parseStoredEnvelope(value) {
    const parsed = StoredRemoteHostCatalogContentV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  parseCandidateEnvelope(value) {
    const parsed = RemoteHostCatalogContentV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  parseMigrationStoredEnvelope(value) {
    const parsed = StoredRemoteHostCatalogContentV1Schema.safeParse(value);
    if (!parsed.success) return null;
    if (parsed.data.t === 'encrypted') return parsed.data;
    const record = readRemoteHostCatalogRecordV1(parsed.data.v);
    return record.status === 'ready' ? { t: 'plain', v: { v: 1, hosts: record.hosts } } : null;
  },
  assertEnvelopeForMode: assertRemoteHostCatalogContentForModeV1,
};

export function markRemoteHostCatalogRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
  return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: REMOTE_HOST_ACCOUNT_KV_KEY_V1,
    hint: { remoteHosts: true, revision: input.revision } });
}

export async function readRemoteHostCatalogRowInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
  const row = await readReservedAccountScopedKvRowInTx(tx, { ...input,
    physicalKey: REMOTE_HOST_ACCOUNT_KV_KEY_V1, domain: remoteHostRowDomain });
  return row.status === 'present' ? { status: 'present' as const, revision: row.revision, content: row.envelope } : row;
}

function canonicalUniqueReferences(refs: readonly string[]): boolean {
  if (new Set(refs).size !== refs.length) return false;
  try { return refs.every(ref => parseSavedSecretRefV1(ref).kind === 'shared_resource'); }
  catch { return false; }
}

function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(ref => right.includes(ref));
}

/** The row revision protects the complete opened inventory, including opaque client claims. */
export async function validateRemoteHostReferenceCensusInTx(tx: Tx, input: Readonly<{
  accountId: string; capture?: Readonly<{ revision: number | 'absent'; resourceRefs: readonly string[] }>;
}>) {
  const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
  if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
  if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
  const row = await readRemoteHostCatalogRowInTx(tx, input);
  if (row.status !== 'present' && row.status !== 'absent' && row.status !== 'deleted') return row;
  const capture = input.capture;
  if (capture === undefined) return row.status === 'absent'
    ? { status: 'ready' as const, resourceRefs: [] as string[] }
    : { status: 'references-invalid' as const };
  if (!canonicalUniqueReferences(capture.resourceRefs)) return { status: 'references-invalid' as const };
  if (capture.revision !== (row.status === 'absent' ? 'absent' : row.revision)) return { status: 'references-conflict' as const };
  if (row.status !== 'present') return capture.resourceRefs.length === 0
    ? { status: 'ready' as const, resourceRefs: [] as string[] }
    : { status: 'references-conflict' as const };
  if (row.content.t === 'encrypted') return { status: 'ready' as const, resourceRefs: [...capture.resourceRefs] };
  const record = readRemoteHostCatalogRecordV1(row.content.v);
  if (record.status !== 'ready') return { status: 'invalid-stored-content' as const };
  const resourceRefs = [...new Set(record.hosts.flatMap(host =>
    [host.ssh.passwordSecretRef, host.ssh.identityPrivateKeySecretRef].filter((ref): ref is string => typeof ref === 'string')))];
  if (!sameReferences(resourceRefs, capture.resourceRefs)) return { status: 'references-conflict' as const };
  return { status: 'ready' as const, resourceRefs, remoteHostRecords: record.hosts };
}

export async function mutateRemoteHostCatalogRowInTx(tx: Tx, input: RemoteHostCatalogRowMutationV1 & Readonly<{
  accountId: string; authentication?: TeamOperationAuthenticationContext;
}>) {
  const mutation = RemoteHostCatalogRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision, content: input.content,
    ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }),
    referencedSavedSecretRevisions: input.referencedSavedSecretRevisions });
  const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
  if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
  if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
  try { assertRemoteHostCatalogContentForModeV1(mutation.content, fence.account.currentness.encryptionMode); }
  catch { return { status: 'account-mode-mismatch' as const }; }
  const previous = await readRemoteHostCatalogRowInTx(tx, input);
  if (previous.status !== 'present' && previous.status !== 'absent' && previous.status !== 'deleted') return previous;
  const previousRevision = previous.status === 'absent' ? 'absent' : previous.revision;
  if (previousRevision !== mutation.expectedRevision) return { status: 'conflict' as const,
    revision: previousRevision === 'absent' ? -1 : previousRevision };
  if (previous.status === 'present' && previous.content.t === 'plain'
    && readRemoteHostCatalogRecordV1(previous.content.v).status !== 'ready') return { status: 'invalid-stored-content' as const };
  if (mutation.expectedRevision === 'absent') {
    if (fence.account.settingsVersion !== mutation.sourceSettingsVersion)
      return { status: 'settings-conflict' as const, revision: fence.account.settingsVersion };
    if (mutation.content.t === 'plain') {
      try {
        const settings = openPlainAccountSettingsDbValue({ accountId: input.accountId, dbValue: fence.account.settings });
        const raw = settings?.t === 'plain' ? settings.v.remoteHostsV1 : undefined;
        const source = readRetainedRemoteHostCatalogV1(raw === undefined ? [] : raw);
        if (source.status !== 'ready') return { status: 'invalid-stored-content' as const };
        if (source.hosts.length > 0 && !sameReferences(source.hosts.map(host => host.id), mutation.content.v.hosts.map(host => host.id)))
          return { status: 'invalid-stored-content' as const };
        for (const retained of source.hosts) {
          const candidate = mutation.content.v.hosts.find(host => host.id === retained.id);
          for (const [sourceField, referenceField, slot] of [
            ['passwordEnc', 'passwordSecretRef', 'password'],
            ['identityPrivateKeyEnc', 'identityPrivateKeySecretRef', 'identityPrivateKey'],
          ] as const) {
            if (retained.ssh[sourceField] == null) continue;
            const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: input.accountId,
              source: { kind: 'remote-host-ssh-credential', hostId: retained.id, slot } });
            if (candidate?.ssh[referenceField] !== formatSharedSavedSecretRefV1(resourceId))
              return { status: 'references-invalid' as const };
          }
        }
      } catch (error) {
        if (error instanceof PlainAccountSettingsStorageUnavailableError) return { status: 'invalid-stored-content' as const };
        throw error;
      }
    }
  }
  let references: string[];
  try { references = mutation.referencedSavedSecretRevisions.map(capture => formatSharedSavedSecretRefV1(capture.resourceId)); }
  catch { return { status: 'references-invalid' as const }; }
  const actualReferences = mutation.content.t === 'plain' ? [...new Set(mutation.content.v.hosts.flatMap(host =>
    [host.ssh.passwordSecretRef, host.ssh.identityPrivateKeySecretRef].filter((ref): ref is string => typeof ref === 'string')))] : references;
  if (!sameReferences(actualReferences, references)) return { status: 'references-invalid' as const };
  const { validateSavedSecretResourceReferencesInTx } = await import('@/app/account/savedSecrets/savedSecretResourceService');
  if (!await validateSavedSecretResourceReferencesInTx(tx, { accountId: input.accountId, authentication: input.authentication, references,
    savedSecretRevisions: mutation.referencedSavedSecretRevisions.map(capture => ({ resourceId: capture.resourceId, expectedRevision: capture.revision })) }))
    return { status: 'references-invalid' as const };
  return mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: REMOTE_HOST_ACCOUNT_KV_KEY_V1,
    expectedRevision: mutation.expectedRevision, envelope: mutation.content, domain: remoteHostRowDomain,
    markChanged: ({ tx: changeTx, revision }) => markRemoteHostCatalogRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
}
