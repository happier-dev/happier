import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { redactObservationInputPaths } from './specs/observationRedaction.js';
import { WebhookNotificationChannelV1Schema } from '../account/settings/notificationChannels.js';

export const NOTIFICATION_CONFIGURATION_ACTION_IDS = [
  'notifications.webhooks.list', 'notifications.webhooks.add', 'notifications.webhooks.update',
  'notifications.webhooks.remove', 'notifications.webhooks.signingSecret.set', 'notifications.webhooks.signingSecret.clear',
] as const;
export type NotificationConfigurationActionId = typeof NOTIFICATION_CONFIGURATION_ACTION_IDS[number];
export function isNotificationConfigurationActionId(value: string): value is NotificationConfigurationActionId {
  return (NOTIFICATION_CONFIGURATION_ACTION_IDS as readonly string[]).includes(value);
}

const ChannelIdSchema = lazyZodSchema(() => z.string().trim().min(1));
const WebhookUrlSchema = lazyZodSchema(() => z.string().trim().pipe(WebhookNotificationChannelV1Schema.shape.url));
const TopicsPatchSchema = lazyZodSchema(() => z.object({
  ready: z.boolean().optional(), permissionRequest: z.boolean().optional(), userActionRequest: z.boolean().optional(),
}).strict());
const PatchSchema = lazyZodSchema(() => z.object({
  url: WebhookUrlSchema.optional(), enabled: z.boolean().optional(), topics: TopicsPatchSchema.optional(),
  readyIncludeMessageText: z.boolean().optional(), requestIncludeMessageText: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0));
const ChannelTargetSchema = lazyZodSchema(() => z.object({ channelId: ChannelIdSchema }).strict());
export const NotificationConfigurationActionInputSchemas = {
  'notifications.webhooks.list': z.object({}).strict(),
  'notifications.webhooks.add': z.object({ url: WebhookUrlSchema }).strict(),
  'notifications.webhooks.update': ChannelTargetSchema.extend({ patch: PatchSchema }).strict(),
  'notifications.webhooks.remove': ChannelTargetSchema,
  'notifications.webhooks.signingSecret.set': ChannelTargetSchema.extend({ secret: z.string().trim().min(1) }).strict(),
  'notifications.webhooks.signingSecret.clear': ChannelTargetSchema,
} as const;
const MutationOutputSchema = lazyZodSchema(() => z.object({ channelId: ChannelIdSchema }).strict());
export const NotificationConfigurationActionOutputSchemas = {
  'notifications.webhooks.list': z.object({ items: z.array(z.object({
    channelId: ChannelIdSchema, url: WebhookUrlSchema, enabled: z.boolean(), signingSecretConfigured: z.boolean(),
    topics: z.object({ ready: z.boolean(), permissionRequest: z.boolean(), userActionRequest: z.boolean() }).strict(),
    readyIncludeMessageText: z.boolean(), requestIncludeMessageText: z.boolean(),
  }).strict()) }).strict(),
  'notifications.webhooks.add': MutationOutputSchema,
  'notifications.webhooks.update': MutationOutputSchema,
  'notifications.webhooks.remove': MutationOutputSchema,
  'notifications.webhooks.signingSecret.set': MutationOutputSchema,
  'notifications.webhooks.signingSecret.clear': MutationOutputSchema,
} as const;

export const NOTIFICATION_CONFIGURATION_ACTION_SPECS = NOTIFICATION_CONFIGURATION_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
  id, title: {
    'notifications.webhooks.list': 'List notification webhooks', 'notifications.webhooks.add': 'Add notification webhook',
    'notifications.webhooks.update': 'Configure notification webhook', 'notifications.webhooks.remove': 'Remove notification webhook',
    'notifications.webhooks.signingSecret.set': 'Set notification webhook signing secret',
    'notifications.webhooks.signingSecret.clear': 'Clear notification webhook signing secret',
  }[id],
  description: 'Configure notification webhooks through the captured Account settings owner. Signing secret values are write-only.',
  safety: id === 'notifications.webhooks.list' ? 'safe' : 'danger',
  sideEffectClass: id === 'notifications.webhooks.list' ? 'read' : 'danger',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  bindings: { mcpToolName: id.replace(/[.]/g, '_').replace('signingSecret', 'signing_secret') },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: NotificationConfigurationActionInputSchemas[id], outputSchema: NotificationConfigurationActionOutputSchemas[id],
  inputHints: { fields: [
    ...(id === 'notifications.webhooks.list' || id === 'notifications.webhooks.add' ? [] : [
      { path: 'channelId', title: 'Webhook id', widget: 'text' as const, required: true },
    ]),
    ...(id === 'notifications.webhooks.add' ? [{ path: 'url', title: 'Webhook URL', widget: 'text' as const, required: true }] : []),
    ...(id === 'notifications.webhooks.update' ? [{ path: 'patch', title: 'Webhook configuration', widget: 'json' as const, required: true }] : []),
    ...(id === 'notifications.webhooks.signingSecret.set' ? [{ path: 'secret', title: 'Signing secret', widget: 'secret' as const, required: true }] : []),
  ] },
  ...(id === 'notifications.webhooks.signingSecret.set' ? {
    projectObservationInput: redactObservationInputPaths('secret'), approvalInputCustody: 'live_only' as const,
  } : {}),
}));
