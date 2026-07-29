import { z } from 'zod';

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

function uniqueValues<T extends string>(schema: z.ZodType<T>, maximum: number) {
  return z.array(schema).min(1).max(maximum).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Expected unique values' });
    }
  });
}

const VoiceReadinessRequirementsSchema = z.array(VoiceReadinessRequirementSchema)
  .max(VoiceReadinessRequirementSchema.options.length)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Expected unique requirements' });
    }
  });

export const VoiceProviderSelectionOptionV1Schema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
  modeId: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u).nullable(),
  order: z.number().int().min(-10_000).max(10_000),
  titleKey: z.string().min(1).max(256),
  subtitleKey: z.string().min(1).max(256),
  configPatch: z.record(z.string().min(1).max(128), VoiceProviderSettingsJsonValueV1Schema).optional(),
}).strict();
export type VoiceProviderSelectionOptionV1 = z.infer<typeof VoiceProviderSelectionOptionV1Schema>;

const VoiceBundledUiDescriptorBaseV1Schema = z.object({
  pluginId: z.string().min(1).max(128),
  providerId: VoiceProviderIdSchema,
  settingsSectionId: z.string().min(1).max(128),
  roles: uniqueValues(VoiceReadinessRoleSchema, VoiceReadinessRoleSchema.options.length),
  requirements: VoiceReadinessRequirementsSchema,
  requirementsByMode: z.record(
    z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
    VoiceReadinessRequirementsSchema,
  ).optional(),
  supportedPlatforms: uniqueValues(VoiceRuntimePlatformSchema, VoiceRuntimePlatformSchema.options.length).optional(),
  selectionOptions: z.array(VoiceProviderSelectionOptionV1Schema).max(16).superRefine((options, context) => {
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      context.addIssue({ code: 'custom', message: 'Expected unique selection option ids' });
    }
  }).optional(),
}).strict();

export const VoiceConversationProviderDescriptorV1Schema = VoiceBundledUiDescriptorBaseV1Schema.extend({
  kind: z.literal('voice.conversation-provider.v1'),
}).strict();
export type VoiceConversationProviderDescriptorV1 = z.infer<typeof VoiceConversationProviderDescriptorV1Schema>;

export const VoiceSpeechEngineDescriptorV1Schema = VoiceBundledUiDescriptorBaseV1Schema.extend({
  kind: z.literal('voice.speech-engine.v1'),
  role: z.enum(['stt', 'tts', 'both']),
}).strict();
export type VoiceSpeechEngineDescriptorV1 = z.infer<typeof VoiceSpeechEngineDescriptorV1Schema>;

export const VoiceTurnSupportDescriptorV1Schema = VoiceBundledUiDescriptorBaseV1Schema.extend({
  kind: z.literal('voice.turn-support.v1'),
}).strict();
export type VoiceTurnSupportDescriptorV1 = z.infer<typeof VoiceTurnSupportDescriptorV1Schema>;

/** Pure build-time facts. Executable settings/runtime factories remain bundled UI code. */
export const VoiceBundledUiDescriptorV1Schema = z.discriminatedUnion('kind', [
  VoiceConversationProviderDescriptorV1Schema,
  VoiceSpeechEngineDescriptorV1Schema,
  VoiceTurnSupportDescriptorV1Schema,
]);
export type VoiceBundledUiDescriptorV1 = z.infer<typeof VoiceBundledUiDescriptorV1Schema>;
