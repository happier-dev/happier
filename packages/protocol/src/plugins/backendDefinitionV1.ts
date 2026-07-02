import { z } from 'zod';

import {
  PluginLooseJsonObjectSchema,
  PluginOptionalStringSchema,
  PluginStringArraySchema,
} from './_shared.js';
import { BackendSurfaceDeclarationV1Schema } from './backendSurfaceDeclarationV1.js';

export const PluginBackendLaunchV1Schema = z.object({
  binaryName: PluginOptionalStringSchema,
  command: PluginOptionalStringSchema,
  args: PluginStringArraySchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  resolutionPolicy: PluginOptionalStringSchema,
}).passthrough();
export type PluginBackendLaunchV1 = z.infer<typeof PluginBackendLaunchV1Schema>;

export const PluginBackendInstallV1Schema = z.object({
  managedInstall: PluginLooseJsonObjectSchema.optional(),
  manualInstall: PluginLooseJsonObjectSchema.optional(),
  sourcePreference: PluginOptionalStringSchema,
}).passthrough();
export type PluginBackendInstallV1 = z.infer<typeof PluginBackendInstallV1Schema>;

export const PluginBackendProbeV1Schema = z.object({
  models: PluginLooseJsonObjectSchema.optional(),
  modes: PluginLooseJsonObjectSchema.optional(),
  configOptions: PluginLooseJsonObjectSchema.optional(),
  authStatus: PluginLooseJsonObjectSchema.optional(),
}).passthrough();
export type PluginBackendProbeV1 = z.infer<typeof PluginBackendProbeV1Schema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizePluginBackendCapabilitiesInput(value: unknown): unknown {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'executionRun') {
      normalized.executionRun = typeof entry === 'boolean' ? { supported: entry } : entry;
      continue;
    }
    if (typeof entry !== 'boolean') {
      normalized[key] = entry;
    }
  }
  return normalized;
}

export const PluginBackendExecutionRunCapabilitiesV1Schema = z.object({
  supported: z.boolean().default(true),
}).passthrough();
export type PluginBackendExecutionRunCapabilitiesV1 = z.infer<typeof PluginBackendExecutionRunCapabilitiesV1Schema>;

export const PluginBackendSessionMediaCapabilitySupportV1Schema = z.object({
  supported: z.boolean().default(false),
}).passthrough();
export type PluginBackendSessionMediaCapabilitySupportV1 = z.infer<typeof PluginBackendSessionMediaCapabilitySupportV1Schema>;

export const PluginBackendSessionMediaOutputCapabilitiesV1Schema = z.object({
  supported: z.boolean().default(false),
  mediaKinds: z.array(z.literal('image')).optional(),
  sources: z.array(z.enum(['provider-generated', 'tool-output', 'acp-content', 'mcp-content'])).optional(),
  storage: z.literal('session-media-file').optional(),
}).passthrough();
export type PluginBackendSessionMediaOutputCapabilitiesV1 = z.infer<typeof PluginBackendSessionMediaOutputCapabilitiesV1Schema>;

export const PluginBackendNativeImageGenerationCapabilitiesV1Schema = z.object({
  supported: z.boolean().default(false),
  mediaKinds: z.array(z.literal('image')).optional(),
  streamingPartials: z.boolean().optional(),
}).passthrough();
export type PluginBackendNativeImageGenerationCapabilitiesV1 = z.infer<typeof PluginBackendNativeImageGenerationCapabilitiesV1Schema>;

export const PluginBackendSessionMediaCapabilitiesV1Schema = z.object({
  acceptsImageInput: PluginBackendSessionMediaCapabilitySupportV1Schema.default({ supported: false }),
  emitsSessionMedia: PluginBackendSessionMediaOutputCapabilitiesV1Schema.default({ supported: false }),
  nativeImageGeneration: PluginBackendNativeImageGenerationCapabilitiesV1Schema.default({ supported: false }),
}).passthrough().default({
  acceptsImageInput: { supported: false },
  emitsSessionMedia: { supported: false },
  nativeImageGeneration: { supported: false },
});
export type PluginBackendSessionMediaCapabilitiesV1 = z.infer<typeof PluginBackendSessionMediaCapabilitiesV1Schema>;

const ContextCompactionPhaseV1Schema = z.enum(['started', 'progress', 'completed', 'failed', 'cancelled']);

export const PluginBackendSessionContextCompactionEventsCapabilitiesV1Schema = z.object({
  supported: z.boolean().default(false),
  phases: z.array(ContextCompactionPhaseV1Schema).optional(),
  tokenCounts: z.boolean().optional(),
  progress: z.boolean().optional(),
}).passthrough().default({ supported: false });
export type PluginBackendSessionContextCompactionEventsCapabilitiesV1 =
  z.infer<typeof PluginBackendSessionContextCompactionEventsCapabilitiesV1Schema>;

export const PluginBackendSessionContextCompactionManualTriggerCapabilitiesV1Schema = z.object({
  supported: z.boolean().default(false),
  transport: z.enum(['native-runtime-hook', 'raw-provider-command']).optional(),
  acceptsInstructions: z.boolean().optional(),
}).passthrough().default({ supported: false });
export type PluginBackendSessionContextCompactionManualTriggerCapabilitiesV1 =
  z.infer<typeof PluginBackendSessionContextCompactionManualTriggerCapabilitiesV1Schema>;

export const PluginBackendSessionContextCompactionTranscriptInferenceCapabilitiesV1Schema = z.object({
  supported: z.boolean().default(false),
}).passthrough().default({ supported: false });
export type PluginBackendSessionContextCompactionTranscriptInferenceCapabilitiesV1 =
  z.infer<typeof PluginBackendSessionContextCompactionTranscriptInferenceCapabilitiesV1Schema>;

export const PluginBackendSessionContextCompactionCapabilitiesV1Schema = z.object({
  events: PluginBackendSessionContextCompactionEventsCapabilitiesV1Schema,
  manualTrigger: PluginBackendSessionContextCompactionManualTriggerCapabilitiesV1Schema,
  transcriptInference: PluginBackendSessionContextCompactionTranscriptInferenceCapabilitiesV1Schema,
}).passthrough().default({
  events: { supported: false },
  manualTrigger: { supported: false },
  transcriptInference: { supported: false },
});
export type PluginBackendSessionContextCompactionCapabilitiesV1 =
  z.infer<typeof PluginBackendSessionContextCompactionCapabilitiesV1Schema>;

export const PluginBackendSessionCapabilitiesV1Schema = z.object({
  media: PluginBackendSessionMediaCapabilitiesV1Schema,
  contextCompaction: PluginBackendSessionContextCompactionCapabilitiesV1Schema,
}).passthrough().default({
  media: {
    acceptsImageInput: { supported: false },
    emitsSessionMedia: { supported: false },
    nativeImageGeneration: { supported: false },
  },
  contextCompaction: {
    events: { supported: false },
    manualTrigger: { supported: false },
    transcriptInference: { supported: false },
  },
});
export type PluginBackendSessionCapabilitiesV1 = z.infer<typeof PluginBackendSessionCapabilitiesV1Schema>;

export const PluginBackendCapabilitiesV1Schema = z.preprocess(
  normalizePluginBackendCapabilitiesInput,
  z.object({
    executionRun: PluginBackendExecutionRunCapabilitiesV1Schema.default({ supported: true }),
    session: PluginBackendSessionCapabilitiesV1Schema,
  }).passthrough().default({
    executionRun: { supported: true },
    session: {
      media: {
        acceptsImageInput: { supported: false },
        emitsSessionMedia: { supported: false },
        nativeImageGeneration: { supported: false },
      },
      contextCompaction: {
        events: { supported: false },
        manualTrigger: { supported: false },
        transcriptInference: { supported: false },
      },
    },
  }),
);
export type PluginBackendCapabilitiesV1 = z.infer<typeof PluginBackendCapabilitiesV1Schema>;

export function normalizePluginBackendCapabilitiesV1(input: unknown): PluginBackendCapabilitiesV1 {
  return PluginBackendCapabilitiesV1Schema.parse(input);
}

export const PluginBackendDefinitionV1BaseSchema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  launch: PluginBackendLaunchV1Schema.optional(),
  install: PluginBackendInstallV1Schema.optional(),
  capabilities: PluginBackendCapabilitiesV1Schema,
  surfaceHandlers: z.array(BackendSurfaceDeclarationV1Schema).default([]),
  runtimeOptionsSchema: PluginLooseJsonObjectSchema.optional(),
  probe: PluginBackendProbeV1Schema.optional(),
}).passthrough();

export const PluginBackendDefinitionV1Schema = PluginBackendDefinitionV1BaseSchema.superRefine((value, ctx) => {
  if (hasOwn(value, 'runtimeAdapters')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeAdapters'],
      message: 'Backend surface declarations must use surfaceHandlers; runtimeAdapters is not final SDK vocabulary.',
    });
  }
  if (hasOwn(value, 'runtimeCoreHooks')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeCoreHooks'],
      message: 'Backend surface declarations must use surfaceHandlers; runtimeCoreHooks is not final SDK vocabulary.',
    });
  }
});
export type PluginBackendDefinitionV1 = z.infer<typeof PluginBackendDefinitionV1Schema>;
