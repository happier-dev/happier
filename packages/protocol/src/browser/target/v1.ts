import { z } from 'zod';

import { BrowserHttpUrlV1Schema } from '../url.js';

export const BrowserTargetDisplayV1Schema = z
  .object({
    title: z.string().trim().min(1).max(256),
    addressLabel: z.string().trim().min(1).max(256).optional(),
    folderLabel: z.string().trim().min(1).max(256).optional(),
    iconToken: z.string().trim().min(1).max(64).optional(),
    tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent']).optional(),
  })
  .strict();
export type BrowserTargetDisplayV1 = z.infer<typeof BrowserTargetDisplayV1Schema>;

const BrowserTargetBaseV1Schema = z
  .object({
    targetId: z.string().trim().min(1).max(256),
    display: BrowserTargetDisplayV1Schema.optional(),
  })
  .strict();

export const BrowserLocalServicePreviewTargetV1Schema = BrowserTargetBaseV1Schema.extend({
  kind: z.literal('localServicePreview'),
  sessionId: z.string().trim().min(1).max(256),
  machineId: z.string().trim().min(1).max(256),
}).strict();
export type BrowserLocalServicePreviewTargetV1 = z.infer<typeof BrowserLocalServicePreviewTargetV1Schema>;

export const BrowserHostedPluginWebTargetV1Schema = BrowserTargetBaseV1Schema.extend({
  kind: z.literal('hostedPluginWeb'),
  pluginId: z.string().trim().min(1).max(256),
  contributionId: z.string().trim().min(1).max(256),
}).strict();
export type BrowserHostedPluginWebTargetV1 = z.infer<typeof BrowserHostedPluginWebTargetV1Schema>;

export const BrowserExternalUrlTargetV1Schema = BrowserTargetBaseV1Schema.extend({
  kind: z.literal('externalUrl'),
  url: BrowserHttpUrlV1Schema,
}).strict();
export type BrowserExternalUrlTargetV1 = z.infer<typeof BrowserExternalUrlTargetV1Schema>;

export const BrowserStreamedTargetV1Schema = BrowserTargetBaseV1Schema.extend({
  kind: z.literal('streamedBrowser'),
  streamId: z.string().trim().min(1).max(256),
}).strict();
export type BrowserStreamedTargetV1 = z.infer<typeof BrowserStreamedTargetV1Schema>;

export const BrowserSimulatorPreviewTargetV1Schema = BrowserTargetBaseV1Schema.extend({
  kind: z.literal('simulatorPreview'),
  deviceId: z.string().trim().min(1).max(256),
  sourceId: z.string().trim().min(1).max(256).optional(),
}).strict();
export type BrowserSimulatorPreviewTargetV1 = z.infer<typeof BrowserSimulatorPreviewTargetV1Schema>;

export const BrowserViewTargetV1Schema = z.discriminatedUnion('kind', [
  BrowserLocalServicePreviewTargetV1Schema,
  BrowserHostedPluginWebTargetV1Schema,
  BrowserExternalUrlTargetV1Schema,
  BrowserStreamedTargetV1Schema,
  BrowserSimulatorPreviewTargetV1Schema,
]);
export type BrowserViewTargetV1 = z.infer<typeof BrowserViewTargetV1Schema>;

export const BrowserViewTargetKindV1Schema = z.enum([
  'localServicePreview',
  'hostedPluginWeb',
  'externalUrl',
  'streamedBrowser',
  'simulatorPreview',
]);
export type BrowserViewTargetKindV1 = z.infer<typeof BrowserViewTargetKindV1Schema>;

export const BrowserTargetSuggestionSourceV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('localServiceInventory'), serviceId: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('previewResource'), previewId: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('hostedPluginWeb'), pluginId: z.string().trim().min(1).max(256), contributionId: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('externalUrl'), url: BrowserHttpUrlV1Schema }).strict(),
  z.object({ kind: z.literal('recentTarget'), targetId: z.string().trim().min(1).max(256) }).strict(),
]);
export type BrowserTargetSuggestionSourceV1 = z.infer<typeof BrowserTargetSuggestionSourceV1Schema>;

export const BrowserTargetSuggestionV1Schema = z
  .object({
    suggestionId: z.string().trim().min(1).max(256),
    source: BrowserTargetSuggestionSourceV1Schema,
    target: BrowserViewTargetV1Schema,
    display: BrowserTargetDisplayV1Schema,
    lastSeenAt: z.number().int().nonnegative(),
    disabledReason: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type BrowserTargetSuggestionV1 = z.infer<typeof BrowserTargetSuggestionV1Schema>;
