import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { PushNotificationTestResultSchema } from '../push/pushNotificationTest.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { redactObservationInputPaths } from './specs/observationRedaction.js';
import { WebhookNotificationChannelV1Schema } from '../account/settings/notificationChannels.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS } from './notificationConfigurationActionIds.js';
export { NOTIFICATION_CONFIGURATION_ACTION_IDS, isNotificationConfigurationActionId,
  type NotificationConfigurationActionId } from './notificationConfigurationActionIds.js';

const ChannelIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const WebhookUrlSchema = lazyZodSchema(() => z.pipe(z.string().check(z.trim()), WebhookNotificationChannelV1Schema.shape.url));
const TopicsPatchSchema = lazyZodSchema(() => z.strictObject({
  ready: z.optional(z.boolean()), permissionRequest: z.optional(z.boolean()), userActionRequest: z.optional(z.boolean()),
  connectedServiceAccountSwitch: z.optional(z.boolean()), connectedServiceQuotaBlocked: z.optional(z.boolean()),
  connectedServiceQuotaRecovered: z.optional(z.boolean()),
}).check(z.refine(value => Object.values(value).some(field => field !== undefined))));
const ChannelPatchSchema = lazyZodSchema(() => z.strictObject({
  enabled: z.optional(z.boolean()), topics: z.optional(TopicsPatchSchema),
  readyIncludeMessageText: z.optional(z.boolean()), requestIncludeMessageText: z.optional(z.boolean()),
}));
export type NotificationChannelConfigurationPatch = z.infer<typeof ChannelPatchSchema>;
const PatchSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ChannelPatchSchema, { url: z.optional(WebhookUrlSchema) })).check(z.refine(value => Object.values(value).some(field => field !== undefined))));
const ExpoPushPatchSchema = lazyZodSchema(() => ChannelPatchSchema.check(z.refine(value => Object.values(value).some(field => field !== undefined))));
const ChannelTargetSchema = lazyZodSchema(() => z.strictObject({ channelId: ChannelIdSchema }));
export const WebhookNotificationTestResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('delivered') }),
  z.strictObject({ status: z.literal('refused'), reason: z.enum([
    'channel_not_found', 'catalog_unavailable', 'signing_secret_unavailable', 'destination_rejected', 'http_rejected',
  ]), httpStatus: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))) }),
  z.strictObject({ status: z.literal('unreachable'), reason: z.string().check(z.minLength(1)) }),
]));
export type WebhookNotificationTestResult = z.infer<typeof WebhookNotificationTestResultSchema>;
export const NotificationConfigurationActionInputSchemas = {
  'notifications.webhooks.list': z.strictObject({}),
  'notifications.webhooks.add': z.strictObject({ url: WebhookUrlSchema }),
  'notifications.webhooks.update': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ChannelTargetSchema, { patch: PatchSchema }))),
  'notifications.webhooks.remove': ChannelTargetSchema,
  'notifications.webhooks.test': ChannelTargetSchema,
  'notifications.webhooks.signingSecret.set': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ChannelTargetSchema, { secret: z.string().check(z.minLength(1)) }))),
  'notifications.webhooks.signingSecret.clear': ChannelTargetSchema,
  'notifications.expoPush.update': z.strictObject({ patch: ExpoPushPatchSchema }),
  'notifications.sounds.preview': z.strictObject({}),
  'notifications.push.test': z.strictObject({ tokenId: ChannelIdSchema }),
  'notifications.desktop.permission.read': z.strictObject({}),
  'notifications.desktop.permission.request': z.strictObject({}),
  'notifications.push.tokens.list': z.strictObject({}),
  'notifications.push.tokens.remove': z.strictObject({ tokenId: ChannelIdSchema }),
  'notifications.push.permission.read': z.strictObject({}),
  'notifications.push.permission.request': z.strictObject({ purpose: z.optional(z.literal('local_notifications')) }),
  'notifications.push.register': z.strictObject({}),
} as const;
const MutationOutputSchema = lazyZodSchema(() => z.strictObject({ channelId: ChannelIdSchema }));
const PushTokenRegistrationDiagnosticsSchema = lazyZodSchema(() => z.strictObject({ tokenId: ChannelIdSchema,
  fingerprint: z.string(), isCurrentDevice: z.boolean(), clientServerUrl: z.nullable(z.string()),
  createdAt: z.number(), updatedAt: z.number() }));
export type PushTokenRegistrationDiagnostics = z.infer<typeof PushTokenRegistrationDiagnosticsSchema>;
export const NotificationConfigurationActionOutputSchemas = {
  'notifications.webhooks.list': z.strictObject({ items: z.array(z.strictObject({
    channelId: ChannelIdSchema, url: WebhookUrlSchema, enabled: z.boolean(), signingSecretConfigured: z.boolean(),
    topics: z.strictObject({ ready: z.boolean(), permissionRequest: z.boolean(), userActionRequest: z.boolean() }),
    readyIncludeMessageText: z.boolean(), requestIncludeMessageText: z.boolean(),
  })) }),
  'notifications.webhooks.add': MutationOutputSchema,
  'notifications.webhooks.update': MutationOutputSchema,
  'notifications.webhooks.remove': MutationOutputSchema,
  'notifications.webhooks.test': WebhookNotificationTestResultSchema,
  'notifications.webhooks.signingSecret.set': MutationOutputSchema,
  'notifications.webhooks.signingSecret.clear': MutationOutputSchema,
  'notifications.expoPush.update': MutationOutputSchema,
  'notifications.sounds.preview': z.strictObject({ notificationId: ChannelIdSchema }),
  'notifications.push.test': PushNotificationTestResultSchema,
  'notifications.desktop.permission.read': z.strictObject({ status: z.enum(['granted', 'notGranted']) }),
  'notifications.desktop.permission.request': z.strictObject({ status: z.enum(['granted', 'notGranted']) }),
  'notifications.push.tokens.list': z.strictObject({ tokens: z.array(PushTokenRegistrationDiagnosticsSchema) }),
  'notifications.push.tokens.remove': z.strictObject({ tokenId: ChannelIdSchema, removed: z.literal(true) }),
  'notifications.push.permission.read': z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ready'), permission: z.strictObject({ status: z.enum(['unsupported', 'granted', 'denied', 'undetermined']),
      granted: z.boolean(), canAskAgain: z.boolean() }) }),
    z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['runtime_unavailable', 'runtime_timeout']) }),
  ]),
  'notifications.push.permission.request': z.strictObject({ decision: z.enum(['prime', 'open_system_settings', 'skip_push_disabled',
    'skip_unsupported', 'skip_already_granted', 'skip_already_declined', 'skip_cannot_ask_again', 'skip_runtime_unavailable']),
    granted: z.boolean() }),
  'notifications.push.register': z.strictObject({ status: z.literal('reconciled') }),
} as const;

function createNotificationConfigurationActionSpecs() {
  return NOTIFICATION_CONFIGURATION_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
  ...({
    'notifications.webhooks.add': { confirmVerb: { key: 'common.add', fallback: 'Add' } },
    'notifications.webhooks.test': { confirmVerb: { key: 'common.send', fallback: 'Send' } },
    'notifications.webhooks.update': { confirmVerb: { key: 'common.update', fallback: 'Update' } },
    'notifications.webhooks.remove': { confirmVerb: { key: 'common.remove', fallback: 'Remove' }, irreversible: true },
    'notifications.webhooks.signingSecret.set': { confirmVerb: { key: 'common.save', fallback: 'Save' } },
    'notifications.webhooks.signingSecret.clear': { confirmVerb: { key: 'common.remove', fallback: 'Remove' }, irreversible: true },
    'notifications.expoPush.update': { confirmVerb: { key: 'common.update', fallback: 'Update' } },
    'notifications.push.tokens.remove': { confirmVerb: { key: 'common.remove', fallback: 'Remove' } },
  } as Partial<Record<typeof id, Pick<PreNormalizedActionSpec, 'confirmVerb' | 'irreversible'>>>)[id],
  id, approvalPolicy: { uiConfirmation: 'policy',
    ...(id === 'notifications.desktop.permission.request' || id === 'notifications.push.permission.request' || id === 'notifications.webhooks.test'
      ? { agentDefault: 'authority' as const, requiredSurfaces: ['agent', 'mcp', 'plugin', 'api'] as const } : {}),
  }, approval: { result: 'required' }, title: {
    'notifications.webhooks.list': 'List notification webhooks', 'notifications.webhooks.add': 'Add notification webhook',
    'notifications.webhooks.update': 'Configure notification webhook', 'notifications.webhooks.remove': 'Remove notification webhook',
    'notifications.webhooks.test': 'Send a webhook test',
    'notifications.webhooks.signingSecret.set': 'Set notification webhook signing secret',
    'notifications.webhooks.signingSecret.clear': 'Clear notification webhook signing secret',
    'notifications.expoPush.update': 'Configure built-in push notifications',
    'notifications.sounds.preview': 'Preview notification sound',
    'notifications.push.test': 'Send a remote push test',
    'notifications.desktop.permission.read': 'Read desktop notification permission',
    'notifications.desktop.permission.request': 'Request desktop notification permission',
    'notifications.push.tokens.list': 'List push notification registrations',
    'notifications.push.tokens.remove': 'Remove push notification registration',
    'notifications.push.permission.read': 'Read native push notification permission',
    'notifications.push.permission.request': 'Request native push notification permission',
    'notifications.push.register': 'Reconcile this device’s push registrations',
  }[id],
  description: id === 'notifications.expoPush.update'
    ? 'Update the existing built-in Expo push endpoint and its corresponding Account attention preferences together. Topic and preview delivery still intersect global topic and privacy rules; absent or deleted endpoints are not recreated.'
    : id === 'notifications.webhooks.test' ? 'Send one fixed diagnostic payload to a configured channel through the Account daemon’s existing signed webhook delivery. Reports receiver acceptance, refusal or unreachability. Does not change notification preferences or validate automatic delivery policy. Ask first by default; retry only on another invocation.'
    : id === 'notifications.push.test' ? 'Submit one fixed diagnostic notification to an addressed push registration on the captured Account Home using its ordinary remote push transport. Service acceptance does not confirm phone receipt or display and does not validate mute, quiet-hour or enrollment policy.'
    : id === 'notifications.sounds.preview' ? 'Preview the captured Account sound preset using this device’s current sound preference: a bundled sound on desktop, or a local notification on native mobile clients. Desktop playback follows operating-system volume and mute.'
    : id.startsWith('notifications.desktop.') ? 'Read or request this desktop’s operating-system notification permission. Automation asks first by default; the OS still owns the permission decision.'
    : id.startsWith('notifications.push.tokens.') ? 'Read or remove the addressed captured Account push registration. Native token material is resolved privately and is never an Action operand or receipt.'
    : id === 'notifications.push.register' ? 'Run the existing device-wide push reconciler for all locally credentialed Homes. Reconciled means the recovery attempt settled; unsupported, denied and unreachable registrations retain the reconciler’s existing skip behavior.'
    : id.startsWith('notifications.push.permission.') ? 'Read or request this device’s native push permission through the existing OS access and priming flow. The local_notifications purpose requests device permission independently of remote push consent without changing that consent. Automation asks first by default; the OS still owns the permission decision.'
    : 'Configure notification webhooks through the captured Account notification catalog. Signing secret values are write-only.',
  safety: id === 'notifications.webhooks.list' || id === 'notifications.push.tokens.list' || id.startsWith('notifications.desktop.')
    || id.startsWith('notifications.push.permission.') || id === 'notifications.push.register' || id === 'notifications.sounds.preview' || id === 'notifications.push.test' ? 'safe' : 'danger',
  sideEffectClass: id === 'notifications.webhooks.list' || id === 'notifications.push.tokens.list' || id === 'notifications.desktop.permission.read'
    || id === 'notifications.push.permission.read' ? 'read'
    : id === 'notifications.desktop.permission.request' || id === 'notifications.push.permission.request' || id === 'notifications.push.register'
      || id === 'notifications.sounds.preview' || id === 'notifications.push.test' ? 'write' : 'danger',
  requiredAuthority: 'account_automation', executionPlacement: id === 'notifications.webhooks.test' ? 'account' : 'client', placements: [],
  bindings: { mcpToolName: id.replace(/[.]/g, '_').replace('signingSecret', 'signing_secret'),
    voiceClientToolName: id.replace(/[.]/g, '_').replace('signingSecret', 'signing_secret') },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.').map(segment =>
    segment.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)), visibility: 'canonical' }] },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: NotificationConfigurationActionInputSchemas[id], outputSchema: NotificationConfigurationActionOutputSchemas[id],
  inputHints: { fields: [
    ...(!id.startsWith('notifications.webhooks.') || id === 'notifications.webhooks.list' || id === 'notifications.webhooks.add' ? [] : [
      { path: 'channelId', title: 'Webhook id', widget: 'text' as const, required: true },
    ]),
    ...(id === 'notifications.webhooks.add' ? [{ path: 'url', title: 'Webhook URL', widget: 'text' as const, required: true }] : []),
    ...(id === 'notifications.webhooks.update' ? [{ path: 'patch', title: 'Webhook configuration', widget: 'json' as const, required: true }] : []),
    ...(id === 'notifications.expoPush.update' ? [{ path: 'patch', title: 'Push endpoint and Account attention preferences', widget: 'json' as const, required: true }] : []),
    ...(id === 'notifications.push.tokens.remove' || id === 'notifications.push.test' ? [{ path: 'tokenId', title: 'Push registration id', widget: 'text' as const, required: true }] : []),
    ...(id === 'notifications.webhooks.signingSecret.set' ? [{ path: 'secret', title: 'Signing secret', widget: 'secret' as const, required: true }] : []),
  ] },
  ...(id === 'notifications.webhooks.signingSecret.set' ? {
    projectObservationInput: redactObservationInputPaths('secret'), approvalInputCustody: 'live_only' as const,
  } : {}),
  ...(id === 'notifications.push.tokens.list' ? { projectObservationOutput: (value: unknown) => {
    const result = NotificationConfigurationActionOutputSchemas['notifications.push.tokens.list'].safeParse(value);
    return result.success ? { tokens: result.data.tokens.map(row => ({ ...row,
      clientServerUrl: row.clientServerUrl === null ? null : '[redacted]' })) } : {};
  } } : {}),
}));
}

export const NOTIFICATION_CONFIGURATION_ACTION_SPECS: ReturnType<typeof createNotificationConfigurationActionSpecs> = lazyActionSpecArray(createNotificationConfigurationActionSpecs);
