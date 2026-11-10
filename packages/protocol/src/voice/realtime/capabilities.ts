import { z } from '../../zodRuntimePolicy.js';

import {
  VoiceProviderIdSchema,
  VoiceProviderSettingsJsonValueV1Schema,
} from './providerSettings.js';

export const VoiceReadinessRoleSchema = z.enum([
  'dictation_stt',
  'conversation_stt',
  'conversation_tts',
  'vad',
  'endpointing',
  'realtime_conversation',
  'turn_control',
]);
export type VoiceReadinessRole = z.infer<typeof VoiceReadinessRoleSchema>;

export const VoiceReadinessRequirementSchema = z.enum([
  'server_feature',
  'execution_machine',
  'credential',
  'endpoint',
  'runtime',
  'model',
]);
export type VoiceReadinessRequirement = z.infer<typeof VoiceReadinessRequirementSchema>;

export const VoiceRuntimePlatformSchema = z.enum([
  'web',
  'ios',
  'android',
  'macos',
  'windows',
  'linux',
]);
export type VoiceRuntimePlatform = z.infer<typeof VoiceRuntimePlatformSchema>;

function uniqueValues<T extends string>(schema: z.ZodMiniType<T>, maximum: number) {
  return z.array(schema).check(z.minLength(1), z.maxLength(maximum), z.superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Expected unique values' });
    }
  }));
}

const VoiceReadinessRequirementsSchema = z.array(VoiceReadinessRequirementSchema).check(z.maxLength(VoiceReadinessRequirementSchema.options.length), z.superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Expected unique requirements' });
    }
  }));

export const VoiceProviderSelectionOptionV1Schema = z.strictObject({
  id: z.string().check(z.minLength(1), z.maxLength(64), z.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)),
  modeId: z.nullable(z.string().check(z.minLength(1), z.maxLength(64), z.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u))),
  order: z.number().check(z.int(), z.minimum(-10_000), z.maximum(10_000)),
  titleKey: z.string().check(z.minLength(1), z.maxLength(256)),
  subtitleKey: z.string().check(z.minLength(1), z.maxLength(256)),
  configPatch: z.optional(z.record(z.string().check(z.minLength(1), z.maxLength(128)), VoiceProviderSettingsJsonValueV1Schema)),
});
export type VoiceProviderSelectionOptionV1 = z.infer<typeof VoiceProviderSelectionOptionV1Schema>;

const VoiceBundledUiDescriptorBaseV1Schema = z.strictObject({
  pluginId: z.string().check(z.minLength(1), z.maxLength(128)),
  providerId: VoiceProviderIdSchema,
  settingsSectionId: z.string().check(z.minLength(1), z.maxLength(128)),
  roles: uniqueValues(VoiceReadinessRoleSchema, VoiceReadinessRoleSchema.options.length),
  requirements: VoiceReadinessRequirementsSchema,
  requirementsByMode: z.optional(z.record(
    z.string().check(z.minLength(1), z.maxLength(64), z.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)),
    VoiceReadinessRequirementsSchema,
  )),
  supportedPlatforms: z.optional(uniqueValues(VoiceRuntimePlatformSchema, VoiceRuntimePlatformSchema.options.length)),
  selectionOptions: z.optional(z.array(VoiceProviderSelectionOptionV1Schema).check(z.maxLength(16), z.superRefine((options, context) => {
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      context.addIssue({ code: 'custom', message: 'Expected unique selection option ids' });
    }
  }))),
});

export const VoiceConversationProviderDescriptorV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceBundledUiDescriptorBaseV1Schema, {
  kind: z.literal('voice.conversation-provider.v1'),
}));
export type VoiceConversationProviderDescriptorV1 = z.infer<typeof VoiceConversationProviderDescriptorV1Schema>;

export const VoiceSpeechEngineDescriptorV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceBundledUiDescriptorBaseV1Schema, {
  kind: z.literal('voice.speech-engine.v1'),
  role: z.enum(['stt', 'tts', 'both']),
}));
export type VoiceSpeechEngineDescriptorV1 = z.infer<typeof VoiceSpeechEngineDescriptorV1Schema>;

export const VoiceTurnSupportDescriptorV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceBundledUiDescriptorBaseV1Schema, {
  kind: z.literal('voice.turn-support.v1'),
}));
export type VoiceTurnSupportDescriptorV1 = z.infer<typeof VoiceTurnSupportDescriptorV1Schema>;

/** Pure build-time facts. Executable settings/runtime factories remain bundled UI code. */
export const VoiceBundledUiDescriptorV1Schema = z.discriminatedUnion('kind', [
  VoiceConversationProviderDescriptorV1Schema,
  VoiceSpeechEngineDescriptorV1Schema,
  VoiceTurnSupportDescriptorV1Schema,
]);
export type VoiceBundledUiDescriptorV1 = z.infer<typeof VoiceBundledUiDescriptorV1Schema>;
