import { z } from 'zod';
import tweetnacl from 'tweetnacl';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, isAccountScopedBlobCiphertextForKind,
  type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { ExpoPushNotificationChannelV1Schema, WebhookNotificationChannelV1Schema, NotificationChannelTopicsStrictV1Schema, DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
  deriveExpoPushNotificationChannelFromLegacySettings, type NotificationChannelV1 } from './notificationChannels.js';
import { NotificationsSettingsV1Schema } from './accountSettings.js';
import { listSavedSecretReferenceCarrierPathsV1 } from './savedSecretReferenceV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { listSecretStringCarrierPathsV1 } from '../../crypto/settingsSecretStringSchemasV1.js';
import {
  ExpoPushNotificationChannelRecordV1Schema,
  WebhookNotificationChannelRecordV1Schema,
  NotificationChannelRecordV1Schema,
  NotificationChannelCatalogRecordV1Schema,
  StoredNotificationChannelCatalogRecordV1Schema,
  NotificationChannelCatalogContentV1Schema,
  StoredNotificationChannelCatalogContentV1Schema,
  NotificationChannelCatalogFailureV1Schema,
  NotificationChannelCatalogReadResponseV1Schema,
  NotificationChannelCatalogMutationV1Schema,
  NotificationChannelCatalogMutationResponseV1Schema,
  AccountEncryptionMigrateNotificationChannelsDirectiveV1Schema,
  AccountEncryptionMigrateNotificationChannelsResultV1Schema,
  type NotificationChannelRecordV1,
  type WebhookNotificationChannelRecordV1,
  type NotificationChannelCatalogRecordV1,
  type NotificationChannelCatalogContentV1,
  type NotificationChannelCatalogReadContentV1,
  type NotificationChannelCatalogReadResponseV1,
  type NotificationChannelCatalogMutationV1,
  type AccountEncryptionMigrateNotificationChannelsDirectiveV1,
  type AccountEncryptionMigrateNotificationChannelsResultV1,
} from './notificationChannelSchemasV1.js';
export {
  ExpoPushNotificationChannelRecordV1Schema,
  WebhookNotificationChannelRecordV1Schema,
  NotificationChannelRecordV1Schema,
  NotificationChannelCatalogRecordV1Schema,
  StoredNotificationChannelCatalogRecordV1Schema,
  NotificationChannelCatalogContentV1Schema,
  StoredNotificationChannelCatalogContentV1Schema,
  NotificationChannelCatalogFailureV1Schema,
  NotificationChannelCatalogReadResponseV1Schema,
  NotificationChannelCatalogMutationV1Schema,
  NotificationChannelCatalogMutationResponseV1Schema,
  AccountEncryptionMigrateNotificationChannelsDirectiveV1Schema,
  AccountEncryptionMigrateNotificationChannelsResultV1Schema,
} from './notificationChannelSchemasV1.js';
export type {
  NotificationChannelRecordV1,
  WebhookNotificationChannelRecordV1,
  NotificationChannelCatalogRecordV1,
  NotificationChannelCatalogContentV1,
  NotificationChannelCatalogReadContentV1,
  NotificationChannelCatalogReadResponseV1,
  NotificationChannelCatalogMutationV1,
  AccountEncryptionMigrateNotificationChannelsDirectiveV1,
  AccountEncryptionMigrateNotificationChannelsResultV1,
} from './notificationChannelSchemasV1.js';

export const NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 = '@happier/account/notification-channels/v1/catalog' as const;
export const NOTIFICATION_CHANNELS_ROUTE_V1 = '/v1/account/entity-rows/notification-channels' as const;
export const NOTIFICATION_CHANNELS_CIPHER_KIND_V1 = 'account_notification_channels' as const;

/** One complete catalog revision protects this exact reference inventory. */
export function listNotificationChannelSavedSecretRefsV1(record: NotificationChannelCatalogRecordV1): string[] {
  return [...new Set(listNotificationChannelSavedSecretReferenceSlotsV1(record).map(reference => reference.secretId))];
}
/** Exact domain slots also drive the complete SavedSecret census and rewrites. */
export function listNotificationChannelSavedSecretReferenceSlotsV1(record: NotificationChannelCatalogRecordV1):
  readonly Readonly<{ path: string; secretId: string }>[] {
  return record.channels.flatMap((channel, index) => channel.kind === 'webhook' && channel.signingSecretRef !== null
    ? [{ path: `channels[${index}].signingSecretRef`, secretId: channel.signingSecretRef }] : []);
}
export function rewriteNotificationChannelSavedSecretRefsV1(record: NotificationChannelCatalogRecordV1,
  sourceRef: string, targetRef: string): NotificationChannelCatalogRecordV1 {
  let changed = false;
  const channels = record.channels.map(channel => {
    if (channel.kind !== 'webhook' || channel.signingSecretRef !== sourceRef) return channel;
    changed = true;
    return { ...channel, signingSecretRef: targetRef };
  });
  return changed ? { ...record, channels } : record;
}
/** Unknown marked carriers cannot certify a complete reference inventory. */
export function hasUnrepresentedNotificationChannelSavedSecretReferencesV1(raw: unknown, projected: unknown): boolean {
  const admitted = new Set(listSavedSecretReferenceCarrierPathsV1(projected));
  const admittedMaterial = new Set(listSecretStringCarrierPathsV1(projected));
  return listSavedSecretReferenceCarrierPathsV1(raw).some(path => !admitted.has(path))
    || listSecretStringCarrierPathsV1(raw).some(path => !admittedMaterial.has(path));
}

export function assertNotificationChannelCatalogContentForModeV1(content: NotificationChannelCatalogReadContentV1, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain') !== (content.t === 'plain') || content.t === 'encrypted'
    && !isAccountScopedBlobCiphertextForKind({ kind: NOTIFICATION_CHANNELS_CIPHER_KIND_V1, ciphertext: content.c })) throw new Error('account-mode-mismatch');
}
export function openNotificationChannelCatalogContentV1(input: Readonly<{
  content: unknown; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
}>): Readonly<{ status: 'opened'; record: NotificationChannelCatalogRecordV1 }>
| Readonly<{ status: 'partial'; record: NotificationChannelCatalogRecordV1; diagnostics: readonly NotificationChannelCatalogDiagnosticV1[] }> | Readonly<{
  status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content';
}> {
  const content = StoredNotificationChannelCatalogContentV1Schema.safeParse(input.content);
  if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertNotificationChannelCatalogContentForModeV1(content.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  const envelope = content.data.t === 'plain' ? { t: content.data.t, v: content.data.v }
    : { t: content.data.t, c: content.data.c };
  if (hasUnrepresentedNotificationChannelSavedSecretReferencesV1(content.data, envelope))
    return { status: 'unavailable', reason: 'invalid-stored-content' };
  let value: unknown;
  if (content.data.t === 'plain') value = content.data.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    value = openAccountScopedBlobCiphertext({ kind: NOTIFICATION_CHANNELS_CIPHER_KIND_V1, material: input.material, ciphertext: content.data.c })?.value;
  }
  const outer = storedCatalogContainer.safeParse(value);
  if (!outer.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  if (hasUnrepresentedNotificationChannelSavedSecretReferencesV1(value, outer.data))
    return { status: 'unavailable', reason: 'invalid-stored-content' };
  const entries = readChannelEntries(outer.data.channels, entry => StoredNotificationChannelRecordV1Schema.safeParse(entry));
  const record = { v: 1 as const, channels: entries.channels };
  return entries.diagnostics.length ? { status: 'partial', record, diagnostics: entries.diagnostics } : { status: 'opened', record };
}
export function sealNotificationChannelCatalogContentV1(input: Readonly<{
  record: NotificationChannelCatalogRecordV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  randomBytes?: (length: number) => Uint8Array;
}>): NotificationChannelCatalogContentV1 {
  const record = NotificationChannelCatalogRecordV1Schema.parse(input.record);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: record };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: NOTIFICATION_CHANNELS_CIPHER_KIND_V1, material: input.material,
    payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}
export type NotificationChannelCatalogUnavailableReasonV1 = 'loading' | 'account-not-found' | 'account-inconsistent' | 'account-mode-mismatch'
  | 'encryption-material-unavailable' | 'invalid-stored-content' | 'unauthorized' | 'forbidden' | 'unsupported' | 'unreachable'
  | 'scope-retired' | 'cancelled' | 'source-version-conflict' | 'authority-not-confirmed' | 'secret-unavailable';
type NotificationChannelCatalogProjectionV1 = Readonly<{ channels: readonly NotificationChannelRecordV1[];
  diagnostics: readonly NotificationChannelCatalogDiagnosticV1[];
  cleanup?: Readonly<{ status: 'complete' | 'cleanup-pending' }> }>;
export type NotificationChannelCatalogSnapshotV1 = Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; reason: NotificationChannelCatalogUnavailableReasonV1 }>
  | (NotificationChannelCatalogProjectionV1 & Readonly<{ status: 'ready'; revision: number }>)
  | (NotificationChannelCatalogProjectionV1 & Readonly<{ status: 'partial'; revision: number | 'absent' }>);

/** Sole read-only source adapter for genuine 0.2 channels; callers never derive after activation. */
export function readLegacyNotificationChannelInventoryV1(raw: Readonly<Record<string, unknown>>):
  Readonly<{ status: 'ready'; channels: readonly NotificationChannelV1[] }>
  | Readonly<{ status: 'partial'; channels: readonly NotificationChannelV1[]; diagnostics: readonly NotificationChannelCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' }> {
  if (!Object.hasOwn(raw, 'notificationChannelsV1')) {
    const legacy = storedLegacyNotifications.safeParse(Object.hasOwn(raw, 'notificationsSettingsV1') ? raw.notificationsSettingsV1 : {});
    return legacy.success ? { status: 'ready', channels: [deriveExpoPushNotificationChannelFromLegacySettings(legacy.data)] }
      : { status: 'unavailable', reason: 'invalid-stored-content' };
  }
  if (!Array.isArray(raw.notificationChannelsV1)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const entries = readChannelEntries(raw.notificationChannelsV1, entry => storedLegacyChannel.safeParse(entry));
  if (entries.diagnostics.length === 0) return { status: 'ready', channels: entries.channels };
  return entries.channels.length ? { status: 'partial', ...entries } : { status: 'unavailable', reason: 'invalid-stored-content' };
}

/** Cleanup recognizes the closed predecessor source, including its documented defaults. */
export function isCompleteLegacyNotificationChannelSourceV1(raw: Readonly<Record<string, unknown>>): boolean {
  if (!Object.hasOwn(raw, 'notificationChannelsV1')) return true;
  if (!Array.isArray(raw.notificationChannelsV1) || readLegacyNotificationChannelInventoryV1(raw).status !== 'ready') return false;
  return raw.notificationChannelsV1.every((value: unknown) => {
    const parsed = legacyChannelSource.safeParse(value);
    if (!parsed.success) return false;
    if (parsed.data.kind !== 'webhook' || value === null || typeof value !== 'object' || !Object.hasOwn(value, 'signingSecret')) return true;
    return 'signingSecret' in value && sameStrictJsonValue(value.signingSecret, parsed.data.signingSecret);
  });
}

export type NotificationChannelCatalogDiagnosticV1 = Readonly<{ channelId: string; reason: 'invalid-stored-content' | 'secret-unavailable' }>;
const storedCatalogContainer = lazyZodSchema(() => z.object({ v: z.literal(1), channels: z.array(z.unknown()) }));
const StoredNotificationChannelRecordV1Schema = createStoredReadSchema(NotificationChannelRecordV1Schema);
const storedLegacyNotifications = createStoredReadSchema(NotificationsSettingsV1Schema.unwrap());
const legacyChannelSource = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...ExpoPushNotificationChannelV1Schema.shape,
    topics: NotificationChannelTopicsStrictV1Schema.default(DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1) }),
  z.strictObject({ ...WebhookNotificationChannelV1Schema.shape,
    topics: NotificationChannelTopicsStrictV1Schema.default(DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1) }),
]));
const storedLegacyChannel = createStoredReadSchema(legacyChannelSource);
function readChannelEntries<T extends Readonly<{ id: string }>>(values: readonly unknown[],
  parse: (value: unknown) => Readonly<{ success: true; data: T }> | Readonly<{ success: false }>):
  Readonly<{ channels: T[]; diagnostics: NotificationChannelCatalogDiagnosticV1[] }> {
  const parsed = values.map(parse);
  const counts = new Map<string, number>();
  for (const result of parsed) if (result.success) counts.set(result.data.id, (counts.get(result.data.id) ?? 0) + 1);
  const channels: T[] = [];
  const diagnostics: NotificationChannelCatalogDiagnosticV1[] = [];
  for (const [index, result] of parsed.entries()) {
    if (result.success && counts.get(result.data.id) === 1) {
      channels.push(result.data);
      if (hasUnrepresentedNotificationChannelSavedSecretReferencesV1(values[index], result.data)) {
        diagnostics.push({ channelId: result.data.id, reason: 'invalid-stored-content' });
      }
      continue;
    }
    const raw = values[index];
    const channelId = raw !== null && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim() : `#${index}`;
    diagnostics.push({ channelId, reason: 'invalid-stored-content' });
  }
  return { channels, diagnostics };
}
