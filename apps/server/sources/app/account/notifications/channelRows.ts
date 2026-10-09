import {
  NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, NotificationChannelCatalogContentV1Schema,
  NotificationChannelCatalogMutationV1Schema, StoredNotificationChannelCatalogContentV1Schema,
  assertNotificationChannelCatalogContentForModeV1, hasUnrepresentedNotificationChannelSavedSecretReferencesV1,
  openNotificationChannelCatalogContentV1, NotificationChannelCatalogMutationResponseV1Schema,
  listNotificationChannelSavedSecretRefsV1, type NotificationChannelCatalogMutationV1,
  type NotificationChannelCatalogReadContentV1,
} from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { writeAccountSettingsInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import { mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx,
  type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { inTx, type Tx } from '@/storage/inTx';
import type { z } from 'zod';

export const notificationChannelCatalogRowDomain = {
  label: 'Notification channel catalog',
  parseStoredEnvelope(value) {
    const parsed = StoredNotificationChannelCatalogContentV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  parseCandidateEnvelope(value) {
    const parsed = NotificationChannelCatalogContentV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  parseMigrationStoredEnvelope(value): NotificationChannelCatalogReadContentV1 | null {
    const content = StoredNotificationChannelCatalogContentV1Schema.safeParse(value);
    if (!content.success) return null;
    const envelope = content.data.t === 'plain' ? { t: content.data.t, v: content.data.v } : { t: content.data.t, c: content.data.c };
    if (hasUnrepresentedNotificationChannelSavedSecretReferencesV1(value, envelope)) return null;
    if (content.data.t === 'encrypted') return { t: 'encrypted', c: content.data.c };
    const opened = openNotificationChannelCatalogContentV1({ content: value, mode: 'plain', material: null });
    return opened.status === 'opened' ? { t: 'plain', v: opened.record } : null;
  },
  assertEnvelopeForMode: assertNotificationChannelCatalogContentForModeV1,
} satisfies ReservedAccountScopedKvRowDomain<NotificationChannelCatalogReadContentV1>;

export async function readNotificationChannelCatalogInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
  const row = await readReservedAccountScopedKvRowInTx(tx, { ...input,
    physicalKey: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, domain: notificationChannelCatalogRowDomain });
  return row.status === 'present' ? { status: 'present' as const, revision: row.revision, content: row.envelope } : row;
}

export function markNotificationChannelCatalogRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
  return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1,
    hint: { notificationChannels: true, revision: input.revision } });
}

function canonicalUniqueSharedReferences(refs: readonly string[]): boolean {
  if (new Set(refs).size !== refs.length) return false;
  try { return refs.every(ref => parseSavedSecretRefV1(ref).kind === 'shared_resource'); }
  catch { return false; }
}

function sameReferenceInventory(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(ref => right.includes(ref));
}

/** A complete row revision protects membership and every opaque E2EE reference claim. */
export async function validateNotificationChannelReferenceCensusInTx(tx: Tx, input: Readonly<{
  accountId: string; capture?: Readonly<{ revision: number | 'absent'; resourceRefs: readonly string[] }>;
}>) {
  const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
  if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
  if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
  const row = await readReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
    physicalKey: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, domain: input.capture
      ? { ...notificationChannelCatalogRowDomain, parseStoredEnvelope: notificationChannelCatalogRowDomain.parseMigrationStoredEnvelope }
      : notificationChannelCatalogRowDomain });
  if (row.status !== 'present' && row.status !== 'deleted' && row.status !== 'absent') return row;
  const capture = input.capture;
  if (row.status === 'absent' && capture === undefined) return { status: 'ready' as const, resourceRefs: [] as string[] };
  if (!capture || !canonicalUniqueSharedReferences(capture.resourceRefs)
    || capture.revision !== (row.status === 'absent' ? 'absent' : row.revision)) return { status: 'references-conflict' as const };
  if (row.status !== 'present') return capture.resourceRefs.length === 0
    ? { status: 'ready' as const, resourceRefs: [] as string[] } : { status: 'references-conflict' as const };
  if (row.envelope.t === 'encrypted') return { status: 'ready' as const, resourceRefs: [...capture.resourceRefs] };
  const opened = openNotificationChannelCatalogContentV1({ content: row.envelope, mode: 'plain', material: null });
  if (opened.status !== 'opened') return { status: 'invalid-stored-content' as const };
  const resourceRefs = listNotificationChannelSavedSecretRefsV1(opened.record);
  if (!canonicalUniqueSharedReferences(resourceRefs) || !sameReferenceInventory(resourceRefs, capture.resourceRefs))
    return { status: 'references-conflict' as const };
  return { status: 'ready' as const, resourceRefs };
}

type MutationInput = NotificationChannelCatalogMutationV1 & Readonly<{
  accountId: string; authentication?: TeamOperationAuthenticationContext;
}>;
type MutationResponse = z.infer<typeof NotificationChannelCatalogMutationResponseV1Schema>;
class NotificationChannelCatalogPairedMutationRejected extends Error {
  constructor(readonly result: MutationResponse) { super('Notification channel paired Settings mutation rejected'); }
}

export async function mutateNotificationChannelCatalogInTx(tx: Tx, input: MutationInput): Promise<MutationResponse> {
  const mutation = NotificationChannelCatalogMutationV1Schema.parse({ expectedRevision: input.expectedRevision, content: input.content,
    ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }),
    ...(input.settingsMutation === undefined ? {} : { settingsMutation: input.settingsMutation }),
    savedSecretRevisions: input.savedSecretRevisions });
  const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
  if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
  if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
  if (mutation.expectedRevision === 'absent' && fence.account.settingsVersion !== mutation.sourceSettingsVersion)
    return { status: 'settings-conflict' as const, revision: fence.account.settingsVersion };
  if (mutation.settingsMutation && fence.account.settingsVersion !== mutation.settingsMutation.expectedSettingsVersion)
    return { status: 'settings-conflict', revision: fence.account.settingsVersion };
  try { if (mutation.content !== null) assertNotificationChannelCatalogContentForModeV1(mutation.content, fence.account.currentness.encryptionMode); }
  catch { return { status: 'account-mode-mismatch' }; }
  const references = mutation.savedSecretRevisions.map(capture => capture.resourceRef);
  if (!canonicalUniqueSharedReferences(references)) return { status: 'references-conflict' as const };
  const actualReferences = mutation.content === null ? [] : mutation.content.t === 'plain'
    ? listNotificationChannelSavedSecretRefsV1(mutation.content.v) : references;
  if (!sameReferenceInventory(actualReferences, references)) return { status: 'references-conflict' as const };
  // The SavedSecret owner alone decides effective use grants and material readiness.
  const { validateSavedSecretResourceReferencesInTx } = await import('@/app/account/savedSecrets/savedSecretResourceService');
  const savedSecretRevisions = mutation.savedSecretRevisions.map(capture => {
    const parsed = parseSavedSecretRefV1(capture.resourceRef);
    if (parsed.kind !== 'shared_resource') throw new Error('Non-resource notification reference');
    return { resourceId: parsed.resourceId, expectedRevision: capture.revision };
  });
  if (!await validateSavedSecretResourceReferencesInTx(tx, { accountId: input.accountId, authentication: input.authentication,
    references, savedSecretRevisions })) return { status: 'references-conflict' as const };
  const result = await mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
    physicalKey: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, expectedRevision: mutation.expectedRevision,
    envelope: mutation.content, domain: { ...notificationChannelCatalogRowDomain,
      // Replacement and tombstones require the same complete credential inventory as migration.
      parseStoredEnvelope: notificationChannelCatalogRowDomain.parseMigrationStoredEnvelope },
    markChanged: ({ tx: changeTx, revision }) => markNotificationChannelCatalogRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
  if (result.status !== 'updated' || !mutation.settingsMutation) return result;
  const settings = await writeAccountSettingsInTx({ tx, accountId: input.accountId,
    expectedVersion: mutation.settingsMutation.expectedSettingsVersion,
    next: { kind: 'v2', content: mutation.settingsMutation.content, remoteAlertPolicy: mutation.settingsMutation.remoteAlertPolicy } });
  if (settings.status !== 'success') throw new NotificationChannelCatalogPairedMutationRejected(settings.status === 'version_mismatch'
    ? { status: 'settings-conflict', revision: settings.currentVersion } : { status: 'invalid-stored-content' });
  return { ...result, settingsVersion: settings.version };
}

export async function mutateNotificationChannelCatalog(input: MutationInput): Promise<MutationResponse> {
  try { return await inTx(tx => mutateNotificationChannelCatalogInTx(tx, input)); }
  catch (error) { if (error instanceof NotificationChannelCatalogPairedMutationRejected) return error.result; throw error; }
}
