import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { ExpoPushNotificationChannelV1Schema, WebhookNotificationChannelV1Schema, NotificationChannelTopicsStrictV1Schema } from './notificationChannels.js';
import { parseSavedSecretRefV1 } from './savedSecretReferenceV1.js';
import { AccountSettingsStoredContentEnvelopeWriteSchema } from './accountSettingsStoredContentEnvelope.js';
import { AccountRemoteAlertPolicyV1Schema } from './accountRemoteAlertPolicySchema.js';

const resourceRef = lazyZodSchema(() => z.string().refine(value => {
  try { return parseSavedSecretRefV1(value).kind === 'shared_resource'; } catch { return false; }
}, { message: 'Signing references must identify a SavedSecret Resource' }));

export const ExpoPushNotificationChannelRecordV1Schema = lazyZodSchema(() => z.strictObject({
  ...ExpoPushNotificationChannelV1Schema.shape, v: z.literal(1), topics: NotificationChannelTopicsStrictV1Schema,
}));

export const WebhookNotificationChannelRecordV1Schema = lazyZodSchema(() => {
  const { signingSecret: _inlineMaterial, ...fields } = WebhookNotificationChannelV1Schema.shape;
  return z.strictObject({ ...fields, v: z.literal(1), topics: NotificationChannelTopicsStrictV1Schema,
    signingSecretRef: resourceRef.nullable() });
});

export const NotificationChannelRecordV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ExpoPushNotificationChannelRecordV1Schema, WebhookNotificationChannelRecordV1Schema,
]));

export type NotificationChannelRecordV1 = z.infer<typeof NotificationChannelRecordV1Schema>;

export type WebhookNotificationChannelRecordV1 = z.infer<typeof WebhookNotificationChannelRecordV1Schema>;

export const NotificationChannelCatalogRecordV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), channels: z.array(NotificationChannelRecordV1Schema),
}).superRefine((record, context) => {
  const ids = new Set<string>();
  for (const [index, channel] of record.channels.entries()) {
    if (ids.has(channel.id)) context.addIssue({ code: 'custom', path: ['channels', index, 'id'], message: 'Duplicate channel identity' });
    ids.add(channel.id);
  }
}));

export type NotificationChannelCatalogRecordV1 = z.infer<typeof NotificationChannelCatalogRecordV1Schema>;

export const StoredNotificationChannelCatalogRecordV1Schema = createStoredReadSchema(NotificationChannelCatalogRecordV1Schema);

export const NotificationChannelCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: NotificationChannelCatalogRecordV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().min(1) }),
]));

export type NotificationChannelCatalogContentV1 = z.infer<typeof NotificationChannelCatalogContentV1Schema>;

/** Opening owns each independent payload entry; transport must not erase readable neighbors. */
export const StoredNotificationChannelCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: z.unknown() }).passthrough(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).passthrough(),
]));

export type NotificationChannelCatalogReadContentV1 = z.infer<typeof StoredNotificationChannelCatalogContentV1Schema>;

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

export const NotificationChannelCatalogFailureV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content']), reason: z.string().optional(),
}));

export const NotificationChannelCatalogReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('present'), revision, content: StoredNotificationChannelCatalogContentV1Schema }),
  z.strictObject({ status: z.literal('absent') }), z.strictObject({ status: z.literal('deleted'), revision }),
  NotificationChannelCatalogFailureV1Schema,
]));

export type NotificationChannelCatalogReadResponseV1 = z.infer<typeof NotificationChannelCatalogReadResponseV1Schema>;

export const NotificationChannelCatalogMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.union([revision, z.literal('absent')]), content: NotificationChannelCatalogContentV1Schema.nullable(),
  sourceSettingsVersion: revision.optional(),
  settingsMutation: z.strictObject({ expectedSettingsVersion: revision,
    content: AccountSettingsStoredContentEnvelopeWriteSchema.nullable(),
    remoteAlertPolicy: AccountRemoteAlertPolicyV1Schema.nullable().optional() }).optional(),
  savedSecretRevisions: z.array(z.strictObject({ resourceRef, revision })).default([]),
}).superRefine((input, context) => {
  if (input.expectedRevision === 'absent' && (input.sourceSettingsVersion === undefined || input.content === null))
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Initialization requires captured source currentness' });
  if (input.sourceSettingsVersion !== undefined && input.expectedRevision !== 'absent')
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission only initializes destination authority' });
  if (input.expectedRevision === 'absent' && input.settingsMutation)
    context.addIssue({ code: 'custom', path: ['settingsMutation'], message: 'Paired finite Settings require an existing destination' });
}));

export type NotificationChannelCatalogMutationV1 = z.infer<typeof NotificationChannelCatalogMutationV1Schema>;

export const NotificationChannelCatalogMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('updated'), revision, cursor: revision, settingsVersion: revision.optional() }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().int().min(-1) }),
  z.strictObject({ status: z.literal('settings-conflict'), revision }),
  z.strictObject({ status: z.literal('references-conflict') }), NotificationChannelCatalogFailureV1Schema,
]));

export const AccountEncryptionMigrateNotificationChannelsDirectiveV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: revision, content: NotificationChannelCatalogContentV1Schema.nullable(),
}));

export type AccountEncryptionMigrateNotificationChannelsDirectiveV1 = z.infer<typeof AccountEncryptionMigrateNotificationChannelsDirectiveV1Schema>;

export const AccountEncryptionMigrateNotificationChannelsResultV1Schema = lazyZodSchema(() => z.strictObject({
  revision, content: NotificationChannelCatalogContentV1Schema.nullable(),
}));

export type AccountEncryptionMigrateNotificationChannelsResultV1 = z.infer<typeof AccountEncryptionMigrateNotificationChannelsResultV1Schema>;
