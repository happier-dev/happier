import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SessionEnvOverlayEntryV1Schema } from '../../spawn/envOverlay.js';
import { AgentProviderRequirementsV1Schema } from '../compatibility/v1.js';
import { ProviderAdapterBindingKeyV1Schema } from '../sessions/adapterBindingKeyV1.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema } from '../ids.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import { ProviderWireProtocolSchema } from '../capabilities/v1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { ProviderCredentialTransportV1Schema } from '../credentials/v1.js';
import { ProviderModelGenerationSettingsV1Schema, ProviderRoleModelsV1Schema } from '../connections/v1.js';

const ProviderBindingKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));

const PrepareInputBaseSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  agentTargetKey: ProviderAgentTargetKeySchema,
  model: z.optional(ProviderModelDescriptorV1Schema),
  roleModels: z.optional(ProviderRoleModelsV1Schema),
  reservedBindingCandidate: z.optional(z.strictObject({
    contributionKey: ProviderContributionKeySchema,
    endpointTemplateId: ProviderLocalIdSchema,
    protocol: ProviderWireProtocolSchema,
    normalizedUrl: ProviderEndpointUrlSyntaxSchema,
  })),
}));

export const AgentProviderBindingPrepareInputV1Schema = lazyZodSchema(() => z.union([
  z.extend(PrepareInputBaseSchema, { bindingKey: ProviderBindingKeySchema }),
  z.extend(PrepareInputBaseSchema, { connectionId: ProviderConnectionIdSchema }),
]));

export const AgentProviderBindingPreparedV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  materialization: AgentProviderRequirementsV1Schema.shape.materialization,
  adapterBindingKey: z.optional(ProviderAdapterBindingKeyV1Schema),
}));

const ResolvedSelectionBaseSchema = lazyZodSchema(() => z.strictObject({
  model: ProviderModelDescriptorV1Schema,
}));

const ResolvedSelectionSchema = z.union([
  z.extend(ResolvedSelectionBaseSchema, { bindingKey: ProviderBindingKeySchema }),
  z.extend(ResolvedSelectionBaseSchema, { connectionId: ProviderConnectionIdSchema }),
]);

export const AgentProviderBindingResolvedFactsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  agentTargetKey: ProviderAgentTargetKeySchema,
  selection: ResolvedSelectionSchema,
  contributionKey: z.nullable(ProviderContributionKeySchema),
  endpoint: z.strictObject({
    endpointTemplateId: ProviderLocalIdSchema,
    normalizedUrl: ProviderEndpointUrlSyntaxSchema,
    protocol: ProviderWireProtocolSchema,
    publicHeaders: z.record(z.string(), z.string()),
  }),
  runtimeCredentialTransport: z.nullable(ProviderCredentialTransportV1Schema),
  modelSettings: z.optional(ProviderModelGenerationSettingsV1Schema),
  roleModels: z.optional(ProviderRoleModelsV1Schema),
  compatibilityFingerprint: z.string().check(z.minLength(1), z.maxLength(512)),
}));

export type AgentProviderBindingPrepareInputV1 = z.infer<typeof AgentProviderBindingPrepareInputV1Schema>;
export type AgentProviderBindingPreparedV1 = z.infer<typeof AgentProviderBindingPreparedV1Schema>;
export type AgentProviderBindingResolvedFactsV1 = z.infer<typeof AgentProviderBindingResolvedFactsV1Schema>;

export const PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1 = Object.freeze({
  env: Object.freeze({ maxRows: 32, maxNameBytes: 128, maxValueBytes: 32 * 1024, maxAggregateBytes: 256 * 1024 }),
  config: Object.freeze({ maxDepth: 24, maxNodes: 8_192, maxKeyBytes: 256, maxStringBytes: 256 * 1024, maxAggregateBytes: 1024 * 1024 }),
  files: Object.freeze({ maxFiles: 16, maxPathBytes: 512, maxContentBytes: 1024 * 1024, maxAggregateBytes: 4 * 1024 * 1024 }),
  redaction: Object.freeze({ maxValues: 32, maxValueBytes: 16 * 1024, maxAggregateBytes: 128 * 1024 }),
  launch: Object.freeze({ maxRootPathBytes: 4 * 1024, maxEncodedBytes: 1024 * 1024 }),
} as const);

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;
const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasOnlyDataProperties(value: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
    'value' in descriptor && descriptor.get === undefined && descriptor.set === undefined
  );
}

function isPlainDataObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && hasOnlyDataProperties(value);
}

const PlainDataObjectV1Schema = lazyZodSchema(() => z.unknown().check(z.superRefine((value, ctx) => {
  if (!isPlainDataObject(value)) {
    ctx.addIssue({ code: 'custom', message: 'Provider materialization values must be plain data objects' });
  }
})));

function boundedArrayPreflight(maxItems: number, label: string) {
  return z.unknown().check(z.superRefine((value, ctx) => {
    if (!Array.isArray(value)) {
      ctx.addIssue({ code: 'custom', message: `${label} must be an array` });
      return;
    }
    if (value.length > maxItems) {
      ctx.addIssue({ code: 'custom', message: `${label} exceeds the item limit` });
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowedKeys = new Set([...value.keys()].map(String).concat('length'));
    const hasUnsafeDescriptor = Object.getOwnPropertySymbols(value).length > 0
      || Object.keys(descriptors).some((key) => !allowedKeys.has(key))
      || [...value.keys()].some((index) => {
        const descriptor = descriptors[String(index)];
        return !descriptor || !('value' in descriptor)
          || descriptor.get !== undefined || descriptor.set !== undefined;
      });
    if (hasUnsafeDescriptor) {
      ctx.addIssue({ code: 'custom', message: `${label} must be a dense array of plain data values` });
    }
  }));
}

const ProviderEnvEntryV1Schema = lazyZodSchema(() => z.pipe(z.unknown().check(z.superRefine((value, ctx) => {
  if (!isPlainDataObject(value)) {
    ctx.addIssue({ code: 'custom', message: 'Provider environment entries must be plain data objects' });
  }
})), (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionEnvOverlayEntryV1Schema, { source: z.literal('provider') }))));

export const ProviderBindingEnvOverlayV1Schema = z.pipe(boundedArrayPreflight(
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.env.maxRows,
  'Provider environment',
), z.array(ProviderEnvEntryV1Schema).check(z.maxLength(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.env.maxRows), z.superRefine((entries, ctx) => {
    const seen = new Set<string>();
    let aggregate = 0;
    entries.forEach((entry, index) => {
      const nameBytes = utf8Bytes(entry.name);
      const valueBytes = entry.value === null ? 0 : utf8Bytes(entry.value);
      aggregate += nameBytes + valueBytes;
      if (nameBytes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.env.maxNameBytes) {
        ctx.addIssue({ code: 'custom', path: [index, 'name'], message: 'Provider environment name exceeds the byte limit' });
      }
      if (valueBytes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.env.maxValueBytes) {
        ctx.addIssue({ code: 'custom', path: [index, 'value'], message: 'Provider environment value exceeds the byte limit' });
      }
      const normalizedName = entry.name.toUpperCase();
      if (seen.has(normalizedName)) {
        ctx.addIssue({ code: 'custom', path: [index, 'name'], message: 'Duplicate provider environment operation' });
      }
      seen.add(normalizedName);
    });
    if (aggregate > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.env.maxAggregateBytes) {
      ctx.addIssue({ code: 'custom', message: 'Provider environment exceeds the aggregate byte limit' });
    }
  })));
export type ProviderBindingEnvOverlayV1 = z.infer<typeof ProviderBindingEnvOverlayV1Schema>;

const SupplementalRedactionValuesV1Schema = z.pipe(boundedArrayPreflight(
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.redaction.maxValues,
  'Redaction values',
), z.array(z.string()).check(z.maxLength(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.redaction.maxValues), z.superRefine((values, ctx) => {
    let aggregate = 0;
    values.forEach((value, index) => {
      const bytes = utf8Bytes(value);
      aggregate += bytes;
      if (bytes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.redaction.maxValueBytes) {
        ctx.addIssue({ code: 'custom', path: [index], message: 'Redaction value exceeds the byte limit' });
      }
    });
    if (aggregate > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.redaction.maxAggregateBytes) {
      ctx.addIssue({ code: 'custom', message: 'Redaction values exceed the aggregate byte limit' });
    }
  })));

type CanonicalJsonPrimitive = null | boolean | number | string;
export type ProviderBindingCanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProviderBindingCanonicalJsonValue[]
  | Readonly<{ [key: string]: ProviderBindingCanonicalJsonValue }>;
export type ProviderBindingCanonicalJsonObject = Exclude<
  ProviderBindingCanonicalJsonValue,
  CanonicalJsonPrimitive | readonly ProviderBindingCanonicalJsonValue[]
>;

function validateCanonicalJsonObject(
  value: unknown,
  ctx: z.core.$RefinementCtx,
): value is ProviderBindingCanonicalJsonObject {
  const seen = new Set<object>();
  let nodes = 0;
  let aggregateBytes = 0;

  const visit = (current: unknown, depth: number, path: readonly (string | number)[]): boolean => {
    nodes += 1;
    if (nodes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.config.maxNodes) {
      ctx.addIssue({ code: 'custom', path: [...path], message: 'Canonical JSON exceeds the node limit' });
      return false;
    }
    if (depth > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.config.maxDepth) {
      ctx.addIssue({ code: 'custom', path: [...path], message: 'Canonical JSON exceeds the depth limit' });
      return false;
    }
    if (current === null || typeof current === 'boolean') return true;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        ctx.addIssue({ code: 'custom', path: [...path], message: 'Canonical JSON numbers must be finite' });
        return false;
      }
      return true;
    }
    if (typeof current === 'string') {
      const bytes = utf8Bytes(current);
      aggregateBytes += bytes;
      if (bytes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.config.maxStringBytes) {
        ctx.addIssue({ code: 'custom', path: [...path], message: 'Canonical JSON string exceeds the byte limit' });
        return false;
      }
      return true;
    }
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      ctx.addIssue({ code: 'custom', path: [...path], message: 'Canonical JSON contains an unsupported value or cycle' });
      return false;
    }
    seen.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (!hasOnlyDataProperties(current)) {
      ctx.addIssue({ code: 'custom', path: [...path], message: 'Canonical JSON may not contain accessors' });
      return false;
    }
    let valid = true;
    if (Array.isArray(current)) {
      const allowedKeys = new Set([...current.keys()].map(String).concat('length'));
      if (current.some((_entry, index) => !Object.prototype.hasOwnProperty.call(current, index))
        || Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
        ctx.addIssue({ code: 'custom', path: [...path], message: 'Canonical JSON arrays must be dense and have no extra properties' });
        valid = false;
      }
      for (let index = 0; index < current.length; index += 1) {
        valid = visit(descriptors[String(index)]?.value, depth + 1, [...path, index]) && valid;
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        ctx.addIssue({ code: 'custom', path: [...path], message: 'Canonical JSON objects must be plain' });
        valid = false;
      }
      for (const key of Object.keys(descriptors).sort()) {
        const keyBytes = utf8Bytes(key);
        aggregateBytes += keyBytes;
        if (POISON_KEYS.has(key) || keyBytes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.config.maxKeyBytes) {
          ctx.addIssue({ code: 'custom', path: [...path, key], message: 'Canonical JSON object key is unsafe or too large' });
          valid = false;
          continue;
        }
        valid = visit(descriptors[key]?.value, depth + 1, [...path, key]) && valid;
      }
    }
    seen.delete(current);
    return valid;
  };

  const valid = typeof value === 'object' && value !== null && !Array.isArray(value)
    && visit(value, 1, []);
  if (!valid && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    ctx.addIssue({ code: 'custom', message: 'Engine configuration must be a canonical JSON object' });
  }
  if (aggregateBytes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.config.maxAggregateBytes) {
    ctx.addIssue({ code: 'custom', message: 'Canonical JSON exceeds the aggregate byte limit' });
    return false;
  }
  return valid;
}

export const ProviderBindingCanonicalJsonObjectV1Schema = lazyZodSchema(() => z.pipe(z.unknown().check(z.superRefine((value, ctx) => {
  validateCanonicalJsonObject(value, ctx);
})), z.transform((value) => value as ProviderBindingCanonicalJsonObject)));

const ProviderBindingRelativePathV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.superRefine((value, ctx) => {
  if (utf8Bytes(value) > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxPathBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /^[\\/]/u.test(value)
    || /^[A-Za-z]:/u.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'Provider file path is unsafe or too large' });
    return;
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    ctx.addIssue({ code: 'custom', message: 'Provider file path contains an unsafe segment' });
  }
})));

const ProviderBindingFileV1Schema = lazyZodSchema(() => z.pipe(PlainDataObjectV1Schema, z.strictObject({
  relativePath: ProviderBindingRelativePathV1Schema,
  utf8: z.string(),
  merge: z.optional(z.literal('jsonObject')),
})));

const ProviderBindingFilesV1Schema = z.pipe(boundedArrayPreflight(
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxFiles,
  'Provider files',
), z.array(ProviderBindingFileV1Schema).check(z.minLength(1), z.maxLength(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxFiles), z.superRefine((files, ctx) => {
    const seen = new Set<string>();
    let aggregate = 0;
    files.forEach((file, index) => {
      const normalized = file.relativePath.toLocaleLowerCase('en-US');
      if (seen.has(normalized)) {
        ctx.addIssue({ code: 'custom', path: [index, 'relativePath'], message: 'Provider file paths collide by case' });
      }
      seen.add(normalized);
      const bytes = utf8Bytes(file.utf8);
      aggregate += bytes;
      if (bytes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxContentBytes) {
        ctx.addIssue({ code: 'custom', path: [index, 'utf8'], message: 'Provider file exceeds the byte limit' });
      }
    });
    if (aggregate > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxAggregateBytes) {
      ctx.addIssue({ code: 'custom', message: 'Provider files exceed the aggregate byte limit' });
    }
  })));

const commonMaterializationShape = {
  v: z.literal(1),
  env: ProviderBindingEnvOverlayV1Schema,
  additionalRedactionValues: z.optional(SupplementalRedactionValuesV1Schema),
};

const AgentProviderBindingMaterializationDataV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...commonMaterializationShape, kind: z.literal('spawnEnv') }),
  z.strictObject({
    ...commonMaterializationShape,
    kind: z.literal('engineConfig'),
    engineConfig: ProviderBindingCanonicalJsonObjectV1Schema,
  }),
  z.strictObject({ ...commonMaterializationShape, kind: z.literal('configFile'), files: ProviderBindingFilesV1Schema, nativeHome: z.optional(z.literal(true)) }),
]));
export const AgentProviderBindingMaterializationV1Schema = lazyZodSchema(() => z.pipe(PlainDataObjectV1Schema, AgentProviderBindingMaterializationDataV1Schema));
export type AgentProviderBindingMaterialization = z.infer<typeof AgentProviderBindingMaterializationV1Schema>;
export type AgentProviderBindingMaterializationV1 = AgentProviderBindingMaterialization;

const HostMaterializedRootPathV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.superRefine((value, ctx) => {
  const isAbsolute = value.startsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/u.test(value);
  const segments = value.split(/[\\/]/u);
  if (utf8Bytes(value) > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.launch.maxRootPathBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
    || !isAbsolute
    || segments.some((segment) => segment === '.' || segment === '..')) {
    ctx.addIssue({ code: 'custom', message: 'Materialized provider root path is unsafe or too large' });
  }
})));

const ProviderBindingLaunchRelativePathsV1Schema = z.pipe(boundedArrayPreflight(
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxFiles,
  'Provider launch file paths',
), z.array(ProviderBindingRelativePathV1Schema).check(z.minLength(1), z.maxLength(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxFiles), z.superRefine((paths, ctx) => {
    const seen = new Set<string>();
    paths.forEach((path, index) => {
      const normalized = path.toLocaleLowerCase('en-US');
      if (seen.has(normalized)) {
        ctx.addIssue({ code: 'custom', path: [index], message: 'Provider launch file paths collide by case' });
      }
      seen.add(normalized);
    });
  })));

const AgentProviderBindingLaunchMaterializationDataV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ v: z.literal(1), kind: z.literal('spawnEnv') }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('engineConfig'),
    engineConfig: ProviderBindingCanonicalJsonObjectV1Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('configFile'),
    rootPath: HostMaterializedRootPathV1Schema,
    relativePaths: ProviderBindingLaunchRelativePathsV1Schema,
  }),
]));
export type AgentProviderBindingLaunchMaterialization =
  | Readonly<{ v: 1; kind: 'spawnEnv' }>
  | Readonly<{
      v: 1;
      kind: 'engineConfig';
      engineConfig: ProviderBindingCanonicalJsonObject;
    }>
  | Readonly<{
      v: 1;
      kind: 'configFile';
      rootPath: string;
      relativePaths: readonly string[];
    }>;
export type AgentProviderBindingLaunchMaterializationV1 =
  AgentProviderBindingLaunchMaterialization;
export const AgentProviderBindingLaunchMaterializationV1Schema =
  z.pipe(PlainDataObjectV1Schema, AgentProviderBindingLaunchMaterializationDataV1Schema) as z.ZodMiniType<
      AgentProviderBindingLaunchMaterializationV1,
      AgentProviderBindingLaunchMaterializationV1
    >;
