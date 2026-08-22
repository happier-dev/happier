import { z } from 'zod';

import {
  PluginLooseJsonObjectSchema,
  PluginOptionalStringSchema,
  PluginStringArraySchema,
} from './_shared.js';
import { BackendSurfaceDeclarationV1Schema } from './backendSurfaceDeclarationV1.js';
import { findBackendExternalSessionSourceReferenceIssues } from './backendExternalSessionSourceReferences.js';
import { ConnectedServiceIdSchema } from '../connect/connectedServiceBindings.js';
import { MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION } from './contributionLimits.js';

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

export const PluginBackendExternalSessionSourceWhenV1Schema = z.object({
  field: z.string().trim().min(1),
  equals: z.string().trim().min(1),
}).strict();
export type PluginBackendExternalSessionSourceWhenV1 =
  z.infer<typeof PluginBackendExternalSessionSourceWhenV1Schema>;

const PluginBackendExternalSessionSourceFieldBaseV1Schema = z.object({
  name: z.string().trim().min(1),
  optional: z.boolean().optional(),
  nullish: z.boolean().optional(),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
}).strict();

export const PluginBackendExternalSessionSourceSchemaFieldV1Schema = z.discriminatedUnion('kind', [
  PluginBackendExternalSessionSourceFieldBaseV1Schema.extend({
    kind: z.literal('literal'),
    value: z.string().trim().min(1),
  }),
  PluginBackendExternalSessionSourceFieldBaseV1Schema.extend({
    kind: z.literal('string'),
  }),
  PluginBackendExternalSessionSourceFieldBaseV1Schema.extend({
    kind: z.literal('enum'),
    values: z.array(z.string().trim().min(1)).min(1),
  }),
  PluginBackendExternalSessionSourceFieldBaseV1Schema.extend({
    kind: z.literal('unknown'),
  }),
]);
export type PluginBackendExternalSessionSourceSchemaFieldV1 =
  z.infer<typeof PluginBackendExternalSessionSourceSchemaFieldV1Schema>;

export const PluginBackendExternalSessionSourceSchemaRefinementV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('requiresWhenEquals'),
    field: z.string().trim().min(1),
    when: PluginBackendExternalSessionSourceWhenV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('forbidsWhenEquals'),
    fields: z.array(z.string().trim().min(1)).min(1),
    when: PluginBackendExternalSessionSourceWhenV1Schema,
  }).strict(),
]);
export type PluginBackendExternalSessionSourceSchemaRefinementV1 =
  z.infer<typeof PluginBackendExternalSessionSourceSchemaRefinementV1Schema>;

export const PluginBackendExternalSessionSourceSchemaV1Schema = z.object({
  fields: z.array(PluginBackendExternalSessionSourceSchemaFieldV1Schema).min(1).refine(
    (fields) => new Set(fields.map((field) => field.name)).size === fields.length,
    'External-session source field names must be unique',
  ),
  refinements: z.array(PluginBackendExternalSessionSourceSchemaRefinementV1Schema).optional(),
}).strict();
export type PluginBackendExternalSessionSourceSchemaV1 =
  z.infer<typeof PluginBackendExternalSessionSourceSchemaV1Schema>;

export const PluginBackendExternalSessionSourceKeySegmentV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('literal'),
    value: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('field'),
    field: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('homeMode'),
    field: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('conditionalField'),
    field: z.string().trim().min(1),
    when: PluginBackendExternalSessionSourceWhenV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('connectedServiceScope'),
    groupField: z.string().trim().min(1),
    profileField: z.string().trim().min(1),
    when: PluginBackendExternalSessionSourceWhenV1Schema,
  }).strict(),
]);
export type PluginBackendExternalSessionSourceKeySegmentV1 =
  z.infer<typeof PluginBackendExternalSessionSourceKeySegmentV1Schema>;

export const PluginBackendExternalSessionSourceKeyV1Schema = z.object({
  segments: z.array(PluginBackendExternalSessionSourceKeySegmentV1Schema).min(1),
}).strict();
export type PluginBackendExternalSessionSourceKeyV1 =
  z.infer<typeof PluginBackendExternalSessionSourceKeyV1Schema>;

const PluginBackendExternalSessionSourceInstanceConstantV1Schema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const PluginBackendExternalSessionSourceInstanceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('default'),
    constants: z.record(z.string().trim().min(1), PluginBackendExternalSessionSourceInstanceConstantV1Schema).default({}),
  }).strict(),
  z.object({
    kind: z.literal('connectedServiceProfiles'),
    serviceId: ConnectedServiceIdSchema,
    constants: z.record(z.string().trim().min(1), PluginBackendExternalSessionSourceInstanceConstantV1Schema).default({}),
    fields: z.object({
      serviceId: z.string().trim().min(1),
      profileId: z.string().trim().min(1),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('agentSetting'),
    settingId: z.string().trim().min(1),
    byServerIdSettingId: z.string().trim().min(1).optional(),
    field: z.string().trim().min(1),
    // How the host turns the raw setting value into the field value; a value the
    // policy rejects yields no source at all rather than a broken one.
    normalization: z.literal('httpOrigin'),
    constants: z.record(z.string().trim().min(1), PluginBackendExternalSessionSourceInstanceConstantV1Schema).default({}),
  }).strict(),
  z.object({
    /**
     * A configured source which replaces the declaration's paired default.
     * Keeping this as a distinct kind lets older hosts drop it while retaining
     * that default, rather than rejecting a known strict instance shape.
     */
    kind: z.literal('agentSettingOverride'),
    settingId: z.string().trim().min(1),
    byServerIdSettingId: z.string().trim().min(1).optional(),
    field: z.string().trim().min(1),
    // Whether a configured source REPLACES the paired default is independent of
    // how its raw setting value is normalized: a declared server endpoint
    // replaces a managed default for the same reason a declared agent directory
    // replaces an ambient one. Both normalizations are already materialized
    // identically by the shared instance owner.
    normalization: z.enum(['httpOrigin', 'configuredPath']),
    constants: z.record(z.string().trim().min(1), PluginBackendExternalSessionSourceInstanceConstantV1Schema).default({}),
  }).strict(),
]);
export type PluginBackendExternalSessionSourceInstanceV1 =
  z.infer<typeof PluginBackendExternalSessionSourceInstanceV1Schema>;

const EXTERNAL_SESSION_SOURCE_INSTANCE_KINDS_V1 = Object.freeze([
  'default',
  'connectedServiceProfiles',
  'agentSetting',
  'agentSettingOverride',
] as const satisfies readonly PluginBackendExternalSessionSourceInstanceV1['kind'][]);

const EXTERNAL_SESSION_SOURCE_INSTANCE_KIND_SET: ReadonlySet<string> =
  new Set(EXTERNAL_SESSION_SOURCE_INSTANCE_KINDS_V1);

function isKnownExternalSessionSourceInstanceKind(kind: unknown): boolean {
  return typeof kind === 'string' && EXTERNAL_SESSION_SOURCE_INSTANCE_KIND_SET.has(kind);
}

/**
 * Instance kinds this reader does not know are ignored rather than failing the
 * whole declaration, so an older host stays usable against a newer producer's
 * manifest/projection. Known kinds remain strictly validated, and the accepted
 * type stays `never` so no first-party declaration can author an unknown kind.
 */
const UnknownPluginBackendExternalSessionSourceInstanceV1Schema = z.custom<never>((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as Readonly<Record<string, unknown>>).kind;
  return typeof kind === 'string'
    && kind.trim().length > 0
    && !EXTERNAL_SESSION_SOURCE_INSTANCE_KIND_SET.has(kind);
});

const PluginBackendExternalSessionSourceInstancesV1Schema = z.array(z.union([
  PluginBackendExternalSessionSourceInstanceV1Schema,
  UnknownPluginBackendExternalSessionSourceInstanceV1Schema,
]))
  .min(1)
  .max(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION)
  .transform((instances) => instances.filter(
    (instance): instance is PluginBackendExternalSessionSourceInstanceV1 =>
      isKnownExternalSessionSourceInstanceKind(instance.kind),
  ));

function isStructurallyCompleteExternalSessionSourceInstance(
  instance: PluginBackendExternalSessionSourceInstanceV1,
): boolean {
  if (instance.constants === undefined) return false;
  if (instance.kind === 'connectedServiceProfiles') {
    return typeof instance.fields?.serviceId === 'string'
      && typeof instance.fields?.profileId === 'string';
  }
  if (instance.kind === 'agentSetting' || instance.kind === 'agentSettingOverride') {
    return typeof instance.field === 'string';
  }
  return true;
}

function externalSessionInstanceConstantMatchesField(
  field: PluginBackendExternalSessionSourceSchemaFieldV1,
  value: string | number | boolean | null,
): boolean {
  if (value === null) return field.nullish === true;
  if (field.kind === 'unknown') return true;
  if (typeof value !== 'string') return false;
  if (field.kind === 'literal') return value === field.value;
  if (field.kind === 'enum') return field.values.includes(value);
  return (field.min === undefined || value.length >= field.min)
    && (field.max === undefined || value.length <= field.max);
}

export const PluginBackendExternalSessionSourceDeclarationV1Schema = z.object({
  sourceKind: z.string().trim().min(1),
  schema: PluginBackendExternalSessionSourceSchemaV1Schema,
  key: PluginBackendExternalSessionSourceKeyV1Schema,
  instances: PluginBackendExternalSessionSourceInstancesV1Schema.optional(),
  /**
   * Cold, declarative opt-in for terminal transcript follow. Omission is
   * deliberately unavailable: read/import remain usable, while terminal
   * follow requires provider-owned explicit user-row classification.
   */
  terminalFollow: z.object({
    userRowClassification: z.literal('explicitV1'),
  }).strict().optional(),
}).strict().superRefine((declaration, ctx) => {
  for (const issue of findBackendExternalSessionSourceReferenceIssues(declaration)) {
    ctx.addIssue({
      code: 'custom',
      path: [...issue.path],
      message: `Undeclared external-session source field "${issue.fieldName}"`,
    });
  }
  const defaults = declaration.instances?.filter((instance) => instance.kind === 'default') ?? [];
  if (defaults.length > 1) {
    ctx.addIssue({ code: 'custom', path: ['instances'], message: 'Only one default external-session source instance is allowed' });
  }
  const settingOverrides = declaration.instances?.filter(
    (instance) => instance.kind === 'agentSettingOverride',
  ) ?? [];
  if (settingOverrides.length > 0 && defaults.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['instances'],
      message: 'An agent-setting override requires exactly one fallback default source instance',
    });
  }
  if (settingOverrides.length > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['instances'],
      message: 'Only one agent-setting default override is allowed',
    });
  }
  const connectedServiceIds = new Set<string>();
  const fieldsByName = new Map(declaration.schema.fields.map((field) => [field.name, field] as const));
  const kindField = fieldsByName.get('kind');
  if (!kindField || kindField.kind !== 'literal' || kindField.value !== declaration.sourceKind) {
    ctx.addIssue({
      code: 'custom',
      path: ['schema', 'fields'],
      message: 'External-session source declarations require a kind literal matching sourceKind',
    });
  }
  for (const [index, instance] of (declaration.instances ?? []).entries()) {
    // Declaration-level checks also observe instances the instance schema
    // already rejected, so structurally incomplete entries are left to it.
    if (!isStructurallyCompleteExternalSessionSourceInstance(instance)) continue;
    for (const [fieldName, value] of Object.entries(instance.constants)) {
      const field = fieldsByName.get(fieldName);
      if (field && !externalSessionInstanceConstantMatchesField(field, value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instances', index, 'constants', fieldName],
          message: `External-session source constant does not satisfy field '${fieldName}'`,
        });
      }
    }
    const suppliedFields = new Set(['kind', ...Object.keys(instance.constants)]);
    if (instance.kind === 'connectedServiceProfiles') {
      suppliedFields.add(instance.fields.serviceId);
      suppliedFields.add(instance.fields.profileId);
    }
    if (instance.kind === 'agentSetting' || instance.kind === 'agentSettingOverride') {
      suppliedFields.add(instance.field);
      if (Object.prototype.hasOwnProperty.call(instance.constants, instance.field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instances', index, 'constants', instance.field],
          message: 'Agent-setting target fields cannot also be constants',
        });
      }
    }
    for (const field of declaration.schema.fields) {
      if (field.optional || field.nullish || suppliedFields.has(field.name)) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['instances', index],
        message: `External-session source instance does not supply required field '${field.name}'`,
      });
    }
    if (instance.kind !== 'connectedServiceProfiles') continue;
    if (connectedServiceIds.has(instance.serviceId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['instances', index, 'serviceId'],
        message: `Duplicate connected-service profile source owner for '${instance.serviceId}'`,
      });
    }
    connectedServiceIds.add(instance.serviceId);
    for (const [mappingName, fieldName] of Object.entries(instance.fields)) {
      const field = fieldsByName.get(fieldName);
      if (field && field.kind !== 'string') {
        ctx.addIssue({
          code: 'custom',
          path: ['instances', index, 'fields', mappingName],
          message: `Connected-service identity target '${fieldName}' must be a string field`,
        });
      }
    }
    if (Object.prototype.hasOwnProperty.call(instance.constants, instance.fields.serviceId)
      || Object.prototype.hasOwnProperty.call(instance.constants, instance.fields.profileId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['instances', index, 'constants'],
        message: 'Connected-service identity fields cannot also be constants',
      });
    }
    if (instance.fields.serviceId === instance.fields.profileId) {
      ctx.addIssue({
        code: 'custom',
        path: ['instances', index, 'fields'],
        message: 'Connected-service and profile identifiers require distinct source fields',
      });
    }
  }
});
export type PluginBackendExternalSessionSourceDeclarationV1 =
  z.infer<typeof PluginBackendExternalSessionSourceDeclarationV1Schema>;

export const PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema = z.enum([
  'native_prevention',
  'unsupported',
]);
export type PluginAgentExternalLinkedTakeoverWriterSafetyV1 = z.infer<
  typeof PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema
>;

const PluginAgentExternalLinkedTakeoverV1Schema = z.object({
  writerSafety: PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema,
}).strict();

export const PluginBackendExternalSessionSurfaceV1Schema = z.object({
  sources: z.array(PluginBackendExternalSessionSourceDeclarationV1Schema).default([]).refine(
    (sources) => new Set(sources.map((source) => source.sourceKind)).size === sources.length,
    'External-session source kinds must be unique within an Agent contribution',
  ),
  externalLinkedTakeover: PluginAgentExternalLinkedTakeoverV1Schema.optional(),
}).strict();
export type PluginBackendExternalSessionSurfaceV1 =
  z.infer<typeof PluginBackendExternalSessionSurfaceV1Schema>;

export const PluginBackendSurfacesV1Schema = z.object({
  externalSession: PluginBackendExternalSessionSurfaceV1Schema.optional(),
}).strict();
export type PluginBackendSurfacesV1 = z.infer<typeof PluginBackendSurfacesV1Schema>;

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

export const PluginBackendStructuredOutputRecoveryV1Schema = z.object({
  plan: z.enum(['loose-sections', 'none']).optional(),
  delegate: z.enum(['loose-deliverables', 'loose-deliverables-with-single-fallback', 'none']).optional(),
}).passthrough();
export type PluginBackendStructuredOutputRecoveryV1 =
  z.infer<typeof PluginBackendStructuredOutputRecoveryV1Schema>;

export const PluginBackendExecutionRunCapabilitiesV1Schema = z.object({
  supported: z.boolean().default(true),
  structuredOutputRecovery: PluginBackendStructuredOutputRecoveryV1Schema.optional(),
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
  providerId: PluginOptionalStringSchema,
  agentId: PluginOptionalStringSchema,
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  launch: PluginBackendLaunchV1Schema.optional(),
  install: PluginBackendInstallV1Schema.optional(),
  capabilities: PluginBackendCapabilitiesV1Schema.default({
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
  surfaceHandlers: z.array(BackendSurfaceDeclarationV1Schema).default([]),
  surfaces: PluginBackendSurfacesV1Schema.optional(),
  runtimeOptionsSchema: PluginLooseJsonObjectSchema.optional(),
  probe: PluginBackendProbeV1Schema.optional(),
}).passthrough();

export const PluginBackendDefinitionV1Schema = PluginBackendDefinitionV1BaseSchema.superRefine((value, ctx) => {
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : '';
  const legacyAgentId = typeof value.agentId === 'string' ? value.agentId.trim() : '';
  if (!providerId && !legacyAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['providerId'],
      message: 'Plugin backend manifests must declare providerId.',
    });
  }
  if (providerId && legacyAgentId && providerId !== legacyAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agentId'],
      message: 'Legacy agentId must match providerId when both are declared.',
    });
  }
  if (hasOwn(value, 'runtimeAdapters')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeAdapters'],
      message: 'Manifest-declared backend runtime handlers are retired; runtimeAdapters is not accepted.',
    });
  }
  if (hasOwn(value, 'runtimeCoreHooks')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeCoreHooks'],
      message: 'Manifest-declared backend runtime handlers are retired; runtimeCoreHooks is not accepted.',
    });
  }
  if (value.surfaceHandlers.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['surfaceHandlers'],
      message: 'Manifest-declared backend surface handlers are retired; executable handlers must be published by the authoritative activated runtime.',
    });
  }
});
export type PluginBackendDefinitionV1 = z.infer<typeof PluginBackendDefinitionV1Schema>;
