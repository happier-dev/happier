import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  PluginLooseJsonObjectSchema,
  PluginOptionalStringSchema,
  PluginStringArraySchema,
} from './_shared.js';
import { BackendSurfaceDeclarationV1Schema } from './backendSurfaceDeclarationV1.js';
import { findBackendExternalSessionSourceReferenceIssues } from './backendExternalSessionSourceReferences.js';
import { ConnectedServiceIdSchema } from '../connect/connectedServiceBindings.js';
import { MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION } from './contributionLimits.js';

export const PluginBackendLaunchV1Schema = lazyZodSchema(() => z.looseObject({
  binaryName: PluginOptionalStringSchema,
  command: PluginOptionalStringSchema,
  args: z.optional(PluginStringArraySchema),
  env: z.optional(z.record(z.string(), z.string())),
  resolutionPolicy: PluginOptionalStringSchema,
}));
export type PluginBackendLaunchV1 = z.infer<typeof PluginBackendLaunchV1Schema>;

export const PluginBackendInstallV1Schema = lazyZodSchema(() => z.looseObject({
  managedInstall: z.optional(PluginLooseJsonObjectSchema),
  manualInstall: z.optional(PluginLooseJsonObjectSchema),
  sourcePreference: PluginOptionalStringSchema,
}));
export type PluginBackendInstallV1 = z.infer<typeof PluginBackendInstallV1Schema>;

export const PluginBackendProbeV1Schema = lazyZodSchema(() => z.looseObject({
  models: z.optional(PluginLooseJsonObjectSchema),
  modes: z.optional(PluginLooseJsonObjectSchema),
  configOptions: z.optional(PluginLooseJsonObjectSchema),
  authStatus: z.optional(PluginLooseJsonObjectSchema),
}));
export type PluginBackendProbeV1 = z.infer<typeof PluginBackendProbeV1Schema>;

export const PluginBackendExternalSessionSourceWhenV1Schema = lazyZodSchema(() => z.strictObject({
  field: z.string().check(z.trim(), z.minLength(1)),
  equals: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginBackendExternalSessionSourceWhenV1 =
  z.infer<typeof PluginBackendExternalSessionSourceWhenV1Schema>;

const PluginBackendExternalSessionSourceFieldBaseV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.trim(), z.minLength(1)),
  optional: z.optional(z.boolean()),
  nullish: z.optional(z.boolean()),
  min: z.optional(z.number().check(z.int(), z.nonnegative())),
  max: z.optional(z.number().check(z.int(), z.positive())),
}));

export const PluginBackendExternalSessionSourceSchemaFieldV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.extend(PluginBackendExternalSessionSourceFieldBaseV1Schema, {
    kind: z.literal('literal'),
    value: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.extend(PluginBackendExternalSessionSourceFieldBaseV1Schema, {
    kind: z.literal('string'),
  }),
  z.extend(PluginBackendExternalSessionSourceFieldBaseV1Schema, {
    kind: z.literal('enum'),
    values: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
  }),
  z.extend(PluginBackendExternalSessionSourceFieldBaseV1Schema, {
    kind: z.literal('unknown'),
  }),
]));
export type PluginBackendExternalSessionSourceSchemaFieldV1 =
  z.infer<typeof PluginBackendExternalSessionSourceSchemaFieldV1Schema>;

export const PluginBackendExternalSessionSourceSchemaRefinementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('requiresWhenEquals'),
    field: z.string().check(z.trim(), z.minLength(1)),
    when: PluginBackendExternalSessionSourceWhenV1Schema,
  }),
  z.strictObject({
    kind: z.literal('forbidsWhenEquals'),
    fields: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
    when: PluginBackendExternalSessionSourceWhenV1Schema,
  }),
]));
export type PluginBackendExternalSessionSourceSchemaRefinementV1 =
  z.infer<typeof PluginBackendExternalSessionSourceSchemaRefinementV1Schema>;

export const PluginBackendExternalSessionSourceSchemaV1Schema = lazyZodSchema(() => z.strictObject({
  fields: z.array(PluginBackendExternalSessionSourceSchemaFieldV1Schema).check(z.minLength(1), z.refine((fields) => new Set(fields.map((field) => field.name)).size === fields.length, 'External-session source field names must be unique')),
  refinements: z.optional(z.array(PluginBackendExternalSessionSourceSchemaRefinementV1Schema)),
}));
export type PluginBackendExternalSessionSourceSchemaV1 =
  z.infer<typeof PluginBackendExternalSessionSourceSchemaV1Schema>;

export const PluginBackendExternalSessionSourceKeySegmentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('literal'),
    value: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('field'),
    field: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('homeMode'),
    field: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('conditionalField'),
    field: z.string().check(z.trim(), z.minLength(1)),
    when: PluginBackendExternalSessionSourceWhenV1Schema,
  }),
  z.strictObject({
    kind: z.literal('connectedServiceScope'),
    groupField: z.string().check(z.trim(), z.minLength(1)),
    profileField: z.string().check(z.trim(), z.minLength(1)),
    when: PluginBackendExternalSessionSourceWhenV1Schema,
  }),
]));
export type PluginBackendExternalSessionSourceKeySegmentV1 =
  z.infer<typeof PluginBackendExternalSessionSourceKeySegmentV1Schema>;

export const PluginBackendExternalSessionSourceKeyV1Schema = lazyZodSchema(() => z.strictObject({
  segments: z.array(PluginBackendExternalSessionSourceKeySegmentV1Schema).check(z.minLength(1)),
}));
export type PluginBackendExternalSessionSourceKeyV1 =
  z.infer<typeof PluginBackendExternalSessionSourceKeyV1Schema>;

const PluginBackendExternalSessionSourceInstanceConstantV1Schema = lazyZodSchema(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]));

export const PluginBackendExternalSessionSourceInstanceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('default'),
    constants: z._default(z.record(z.string().check(z.trim(), z.minLength(1)), PluginBackendExternalSessionSourceInstanceConstantV1Schema), {}),
  }),
  z.strictObject({
    kind: z.literal('connectedServiceProfiles'),
    serviceId: ConnectedServiceIdSchema,
    constants: z._default(z.record(z.string().check(z.trim(), z.minLength(1)), PluginBackendExternalSessionSourceInstanceConstantV1Schema), {}),
    fields: z.strictObject({
      serviceId: z.string().check(z.trim(), z.minLength(1)),
      profileId: z.string().check(z.trim(), z.minLength(1)),
    }),
  }),
  z.strictObject({
    kind: z.literal('agentSetting'),
    settingId: z.string().check(z.trim(), z.minLength(1)),
    byServerIdSettingId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    field: z.string().check(z.trim(), z.minLength(1)),
    // How the host turns the raw setting value into the field value; a value the
    // policy rejects yields no source at all rather than a broken one.
    normalization: z.literal('httpOrigin'),
    constants: z._default(z.record(z.string().check(z.trim(), z.minLength(1)), PluginBackendExternalSessionSourceInstanceConstantV1Schema), {}),
  }),
  z.strictObject({
    /**
     * A configured source which replaces the declaration's paired default.
     * It stays a distinct kind from `agentSetting` because replacement is part
     * of the declared contract: the pairing above is read from the kind rather
     * than inferred from a flag every materializer would have to reconcile.
     */
    kind: z.literal('agentSettingOverride'),
    settingId: z.string().check(z.trim(), z.minLength(1)),
    byServerIdSettingId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    field: z.string().check(z.trim(), z.minLength(1)),
    // Whether a configured source REPLACES the paired default is independent of
    // how its raw setting value is normalized: a declared server endpoint
    // replaces a managed default for the same reason a declared agent directory
    // replaces an ambient one. Both normalizations are already materialized
    // identically by the shared instance owner.
    normalization: z.enum(['httpOrigin', 'configuredPath']),
    constants: z._default(z.record(z.string().check(z.trim(), z.minLength(1)), PluginBackendExternalSessionSourceInstanceConstantV1Schema), {}),
  }),
]));
export type PluginBackendExternalSessionSourceInstanceV1 =
  z.infer<typeof PluginBackendExternalSessionSourceInstanceV1Schema>;

/**
 * The declared instance kinds are closed. Admitting an unknown kind and then
 * dropping it would activate a declaration with fewer sources than it authored,
 * which is indistinguishable from a working one; refusing the declaration is
 * the only spelling an author can act on.
 */
const PluginBackendExternalSessionSourceInstancesV1Schema =
  lazyZodSchema(() => z.array(PluginBackendExternalSessionSourceInstanceV1Schema).check(z.minLength(1), z.maxLength(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION)));

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

export const PluginBackendExternalSessionSourceDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  sourceKind: z.string().check(z.trim(), z.minLength(1)),
  /** Only positive source evidence admits conversation-content search. */
  contentSearch: z.optional(z.boolean()),
  schema: PluginBackendExternalSessionSourceSchemaV1Schema,
  key: PluginBackendExternalSessionSourceKeyV1Schema,
  instances: z.optional(PluginBackendExternalSessionSourceInstancesV1Schema),
  /**
   * This source can discover provider sessions only for the existing
   * resume-in-Happier flow. It does not claim link, transcript, follow,
   * takeover, terminal attachment, or writer-safety semantics.
   */
  resumeOnly: z.optional(z.literal(true)),
  /**
   * Cold, declarative opt-in for terminal transcript follow. Omission is
   * deliberately unavailable: read/import remain usable, while terminal
   * follow requires provider-owned explicit user-row classification.
   */
  terminalFollow: z.optional(z.strictObject({
    userRowClassification: z.literal('explicitV1'),
  })),
}).check(z.superRefine((declaration, ctx) => {
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
})));
export type PluginBackendExternalSessionSourceDeclarationV1 =
  z.infer<typeof PluginBackendExternalSessionSourceDeclarationV1Schema>;

export const PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema = lazyZodSchema(() => z.enum([
  'native_prevention',
  'unsupported',
]));
export type PluginAgentExternalLinkedTakeoverWriterSafetyV1 = z.infer<
  typeof PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema
>;

const PluginAgentExternalLinkedTakeoverV1Schema = lazyZodSchema(() => z.strictObject({
  writerSafety: PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema,
}));

export const PluginBackendExternalSessionSurfaceV1Schema = lazyZodSchema(() => z.strictObject({
  sources: z._default(z.array(PluginBackendExternalSessionSourceDeclarationV1Schema), []).check(z.refine((sources) => new Set(sources.map((source) => source.sourceKind)).size === sources.length, 'External-session source kinds must be unique within an Agent contribution')),
  externalLinkedTakeover: z.optional(PluginAgentExternalLinkedTakeoverV1Schema),
}));
export type PluginBackendExternalSessionSurfaceV1 =
  z.infer<typeof PluginBackendExternalSessionSurfaceV1Schema>;

export const PluginBackendSurfacesV1Schema = lazyZodSchema(() => z.strictObject({
  externalSession: z.optional(PluginBackendExternalSessionSurfaceV1Schema),
}));
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

export const PluginBackendStructuredOutputRecoveryV1Schema = lazyZodSchema(() => z.looseObject({
  plan: z.optional(z.enum(['loose-sections', 'none'])),
  delegate: z.optional(z.enum(['loose-deliverables', 'loose-deliverables-with-single-fallback', 'none'])),
}));
export type PluginBackendStructuredOutputRecoveryV1 =
  z.infer<typeof PluginBackendStructuredOutputRecoveryV1Schema>;

export const PluginBackendExecutionRunCapabilitiesV1Schema = lazyZodSchema(() => z.looseObject({
  supported: z._default(z.boolean(), true),
  structuredOutputRecovery: z.optional(PluginBackendStructuredOutputRecoveryV1Schema),
}));
export type PluginBackendExecutionRunCapabilitiesV1 = z.infer<typeof PluginBackendExecutionRunCapabilitiesV1Schema>;

export const PluginBackendSessionMediaCapabilitySupportV1Schema = lazyZodSchema(() => z.looseObject({
  supported: z._default(z.boolean(), false),
}));
export type PluginBackendSessionMediaCapabilitySupportV1 = z.infer<typeof PluginBackendSessionMediaCapabilitySupportV1Schema>;

export const PluginBackendSessionMediaOutputCapabilitiesV1Schema = lazyZodSchema(() => z.looseObject({
  supported: z._default(z.boolean(), false),
  mediaKinds: z.optional(z.array(z.literal('image'))),
  sources: z.optional(z.array(z.enum(['provider-generated', 'tool-output', 'acp-content', 'mcp-content']))),
  storage: z.optional(z.literal('session-media-file')),
}));
export type PluginBackendSessionMediaOutputCapabilitiesV1 = z.infer<typeof PluginBackendSessionMediaOutputCapabilitiesV1Schema>;

export const PluginBackendNativeImageGenerationCapabilitiesV1Schema = lazyZodSchema(() => z.looseObject({
  supported: z._default(z.boolean(), false),
  mediaKinds: z.optional(z.array(z.literal('image'))),
  streamingPartials: z.optional(z.boolean()),
}));
export type PluginBackendNativeImageGenerationCapabilitiesV1 = z.infer<typeof PluginBackendNativeImageGenerationCapabilitiesV1Schema>;

export const PluginBackendSessionMediaCapabilitiesV1Schema = lazyZodSchema(() => z._default(z.looseObject({
  acceptsImageInput: z._default(PluginBackendSessionMediaCapabilitySupportV1Schema, { supported: false }),
  emitsSessionMedia: z._default(PluginBackendSessionMediaOutputCapabilitiesV1Schema, { supported: false }),
  nativeImageGeneration: z._default(PluginBackendNativeImageGenerationCapabilitiesV1Schema, { supported: false }),
}), {
  acceptsImageInput: { supported: false },
  emitsSessionMedia: { supported: false },
  nativeImageGeneration: { supported: false },
}));
export type PluginBackendSessionMediaCapabilitiesV1 = z.infer<typeof PluginBackendSessionMediaCapabilitiesV1Schema>;

const ContextCompactionPhaseV1Schema = lazyZodSchema(() => z.enum(['started', 'progress', 'completed', 'failed', 'cancelled']));

export const PluginBackendSessionContextCompactionEventsCapabilitiesV1Schema = lazyZodSchema(() => z._default(z.looseObject({
  supported: z._default(z.boolean(), false),
  phases: z.optional(z.array(ContextCompactionPhaseV1Schema)),
  tokenCounts: z.optional(z.boolean()),
  progress: z.optional(z.boolean()),
}), { supported: false }));
export type PluginBackendSessionContextCompactionEventsCapabilitiesV1 =
  z.infer<typeof PluginBackendSessionContextCompactionEventsCapabilitiesV1Schema>;

export const PluginBackendSessionContextCompactionManualTriggerCapabilitiesV1Schema = lazyZodSchema(() => z._default(z.looseObject({
  supported: z._default(z.boolean(), false),
  transport: z.optional(z.enum(['native-runtime-hook', 'raw-provider-command'])),
  acceptsInstructions: z.optional(z.boolean()),
}), { supported: false }));
export type PluginBackendSessionContextCompactionManualTriggerCapabilitiesV1 =
  z.infer<typeof PluginBackendSessionContextCompactionManualTriggerCapabilitiesV1Schema>;

export const PluginBackendSessionContextCompactionTranscriptInferenceCapabilitiesV1Schema = lazyZodSchema(() => z._default(z.looseObject({
  supported: z._default(z.boolean(), false),
}), { supported: false }));
export type PluginBackendSessionContextCompactionTranscriptInferenceCapabilitiesV1 =
  z.infer<typeof PluginBackendSessionContextCompactionTranscriptInferenceCapabilitiesV1Schema>;

export const PluginBackendSessionContextCompactionCapabilitiesV1Schema = lazyZodSchema(() => z._default(z.looseObject({
  events: PluginBackendSessionContextCompactionEventsCapabilitiesV1Schema,
  manualTrigger: PluginBackendSessionContextCompactionManualTriggerCapabilitiesV1Schema,
  transcriptInference: PluginBackendSessionContextCompactionTranscriptInferenceCapabilitiesV1Schema,
}), {
  events: { supported: false },
  manualTrigger: { supported: false },
  transcriptInference: { supported: false },
}));
export type PluginBackendSessionContextCompactionCapabilitiesV1 =
  z.infer<typeof PluginBackendSessionContextCompactionCapabilitiesV1Schema>;

export const PluginBackendSessionCapabilitiesV1Schema = lazyZodSchema(() => z._default(z.looseObject({
  media: PluginBackendSessionMediaCapabilitiesV1Schema,
  contextCompaction: PluginBackendSessionContextCompactionCapabilitiesV1Schema,
}), {
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
}));
export type PluginBackendSessionCapabilitiesV1 = z.infer<typeof PluginBackendSessionCapabilitiesV1Schema>;

export const PluginBackendCapabilitiesV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizePluginBackendCapabilitiesInput), z._default(z.looseObject({
    executionRun: z._default(PluginBackendExecutionRunCapabilitiesV1Schema, { supported: true }),
    session: PluginBackendSessionCapabilitiesV1Schema,
  }), {
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
  })));
export type PluginBackendCapabilitiesV1 = z.infer<typeof PluginBackendCapabilitiesV1Schema>;

export function normalizePluginBackendCapabilitiesV1(input: unknown): PluginBackendCapabilitiesV1 {
  return PluginBackendCapabilitiesV1Schema.parse(input);
}

export const PluginBackendDefinitionV1BaseSchema = lazyZodSchema(() => z.looseObject({
  kindVersion: z._default(z.literal(1), 1),
  id: z.string().check(z.trim(), z.minLength(1)),
  providerId: PluginOptionalStringSchema,
  agentId: PluginOptionalStringSchema,
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  launch: z.optional(PluginBackendLaunchV1Schema),
  install: z.optional(PluginBackendInstallV1Schema),
  capabilities: z._default(PluginBackendCapabilitiesV1Schema, {
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
  surfaceHandlers: z._default(z.array(BackendSurfaceDeclarationV1Schema), []),
  surfaces: z.optional(PluginBackendSurfacesV1Schema),
  runtimeOptionsSchema: z.optional(PluginLooseJsonObjectSchema),
  probe: z.optional(PluginBackendProbeV1Schema),
}));

export const PluginBackendDefinitionV1Schema = lazyZodSchema(() => PluginBackendDefinitionV1BaseSchema.check(z.superRefine((value, ctx) => {
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : '';
  const legacyAgentId = typeof value.agentId === 'string' ? value.agentId.trim() : '';
  if (!providerId && !legacyAgentId) {
    ctx.addIssue({
      code: "custom",
      path: ['providerId'],
      message: 'Plugin backend manifests must declare providerId.',
    });
  }
  if (providerId && legacyAgentId && providerId !== legacyAgentId) {
    ctx.addIssue({
      code: "custom",
      path: ['agentId'],
      message: 'Legacy agentId must match providerId when both are declared.',
    });
  }
  if (hasOwn(value, 'runtimeAdapters')) {
    ctx.addIssue({
      code: "custom",
      path: ['runtimeAdapters'],
      message: 'Manifest-declared backend runtime handlers are retired; runtimeAdapters is not accepted.',
    });
  }
  if (hasOwn(value, 'runtimeCoreHooks')) {
    ctx.addIssue({
      code: "custom",
      path: ['runtimeCoreHooks'],
      message: 'Manifest-declared backend runtime handlers are retired; runtimeCoreHooks is not accepted.',
    });
  }
  if (value.surfaceHandlers.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ['surfaceHandlers'],
      message: 'Manifest-declared backend surface handlers are retired; executable handlers must be published by the authoritative activated runtime.',
    });
  }
})));
export type PluginBackendDefinitionV1 = z.infer<typeof PluginBackendDefinitionV1Schema>;
