import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { BrowserHttpUrlV1Schema } from '../url.js';
import { LocalServicePreviewServiceTargetV1Schema, refineLocalServicePreviewServiceBindingV1 } from '../../local/services/preview/v1.js';

export const BrowserTargetDisplayV1Schema = lazyZodSchema(() => z.strictObject({
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    addressLabel: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    folderLabel: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    iconToken: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))),
    tone: z.optional(z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent'])),
  }));
export type BrowserTargetDisplayV1 = z.infer<typeof BrowserTargetDisplayV1Schema>;

const BrowserTargetBaseV1Schema = lazyZodSchema(() => z.strictObject({
    targetId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    display: z.optional(BrowserTargetDisplayV1Schema),
  }));

export const BrowserLocalServicePreviewTargetV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserTargetBaseV1Schema, {
  kind: z.literal('localServicePreview'),
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
})).check(z.superRefine(refineLocalServicePreviewServiceBindingV1)));
export type BrowserLocalServicePreviewTargetV1 = z.infer<typeof BrowserLocalServicePreviewTargetV1Schema>;

export const BrowserHostedPluginWebTargetV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserTargetBaseV1Schema, {
  kind: z.literal('hostedPluginWeb'),
  pluginId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  contributionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
})));
export type BrowserHostedPluginWebTargetV1 = z.infer<typeof BrowserHostedPluginWebTargetV1Schema>;

export const BrowserExternalUrlTargetV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserTargetBaseV1Schema, {
  kind: z.literal('externalUrl'),
  url: BrowserHttpUrlV1Schema,
})));
export type BrowserExternalUrlTargetV1 = z.infer<typeof BrowserExternalUrlTargetV1Schema>;

export const BrowserStreamedTargetV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserTargetBaseV1Schema, {
  kind: z.literal('streamedBrowser'),
  targetId: z.string().check(z.trim(), z.minLength(1)),
  streamId: z.string().check(z.trim(), z.minLength(1)),
  // Existing saved targets predate daemon identity. New discovery preserves the
  // whole tuple so workspace presentation never invents the semantic view owner.
  daemonView: z.optional(z.strictObject({
    browserSessionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    viewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  })),
})));
export type BrowserStreamedTargetV1 = z.infer<typeof BrowserStreamedTargetV1Schema>;

export const BrowserSimulatorPreviewTargetV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserTargetBaseV1Schema, {
  kind: z.literal('simulatorPreview'),
  deviceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  sourceId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
})));
export type BrowserSimulatorPreviewTargetV1 = z.infer<typeof BrowserSimulatorPreviewTargetV1Schema>;

export const BrowserViewTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BrowserLocalServicePreviewTargetV1Schema,
  BrowserHostedPluginWebTargetV1Schema,
  BrowserExternalUrlTargetV1Schema,
  BrowserStreamedTargetV1Schema,
  BrowserSimulatorPreviewTargetV1Schema,
]));
export type BrowserViewTargetV1 = z.infer<typeof BrowserViewTargetV1Schema>;

export const BrowserViewTargetKindV1Schema = lazyZodSchema(() => z.enum([
  'localServicePreview',
  'hostedPluginWeb',
  'externalUrl',
  'streamedBrowser',
  'simulatorPreview',
]));
export type BrowserViewTargetKindV1 = z.infer<typeof BrowserViewTargetKindV1Schema>;

export const BrowserTargetSuggestionSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('localServiceInventory'), serviceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('previewResource'), previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('hostedPluginWeb'), pluginId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)), contributionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('externalUrl'), url: BrowserHttpUrlV1Schema }),
  z.strictObject({ kind: z.literal('recentTarget'), targetId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
]));
export type BrowserTargetSuggestionSourceV1 = z.infer<typeof BrowserTargetSuggestionSourceV1Schema>;

export const BrowserTargetSuggestionV1Schema = lazyZodSchema(() => z.strictObject({
    suggestionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    source: BrowserTargetSuggestionSourceV1Schema,
    target: BrowserViewTargetV1Schema,
    display: BrowserTargetDisplayV1Schema,
    lastSeenAt: z.number().check(z.int(), z.nonnegative()),
    disabledReason: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  }));
export type BrowserTargetSuggestionV1 = z.infer<typeof BrowserTargetSuggestionV1Schema>;
