import { z } from 'zod';

import { SessionEnvOverlayEntryV1Schema } from '../../spawn/envOverlay.js';

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

const PlainDataObjectV1Schema = z.unknown().superRefine((value, ctx) => {
  if (!isPlainDataObject(value)) {
    ctx.addIssue({ code: 'custom', message: 'Provider materialization values must be plain data objects' });
  }
});

function boundedArrayPreflight(maxItems: number, label: string) {
  return z.unknown().superRefine((value, ctx) => {
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
  });
}

const ProviderEnvEntryV1Schema = z.unknown().superRefine((value, ctx) => {
  if (!isPlainDataObject(value)) {
    ctx.addIssue({ code: 'custom', message: 'Provider environment entries must be plain data objects' });
  }
}).pipe(SessionEnvOverlayEntryV1Schema.extend({ source: z.literal('provider') }).strict());

export const ProviderBindingEnvOverlayV1Schema = boundedArrayPreflight(
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.env.maxRows,
  'Provider environment',
).pipe(z.array(ProviderEnvEntryV1Schema)
  .max(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.env.maxRows)
  .superRefine((entries, ctx) => {
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
  }));
export type ProviderBindingEnvOverlayV1 = z.infer<typeof ProviderBindingEnvOverlayV1Schema>;

const SupplementalRedactionValuesV1Schema = boundedArrayPreflight(
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.redaction.maxValues,
  'Redaction values',
).pipe(z.array(z.string())
  .max(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.redaction.maxValues)
  .superRefine((values, ctx) => {
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
  }));

type CanonicalJsonPrimitive = null | boolean | number | string;
interface CanonicalJsonArray extends ReadonlyArray<CanonicalJsonValue> {}
interface CanonicalJsonObject { readonly [key: string]: CanonicalJsonValue }
type CanonicalJsonValue = CanonicalJsonPrimitive | CanonicalJsonArray | CanonicalJsonObject;

function validateCanonicalJsonObject(value: unknown, ctx: z.RefinementCtx): value is CanonicalJsonObject {
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

export const ProviderBindingCanonicalJsonObjectV1Schema = z.unknown().superRefine((value, ctx) => {
  validateCanonicalJsonObject(value, ctx);
}).transform((value) => value as CanonicalJsonObject);
export type ProviderBindingCanonicalJsonObjectV1 = z.infer<typeof ProviderBindingCanonicalJsonObjectV1Schema>;

const ProviderBindingRelativePathV1Schema = z.string().min(1).superRefine((value, ctx) => {
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
});

const ProviderBindingFileV1Schema = PlainDataObjectV1Schema.pipe(z.object({
  relativePath: ProviderBindingRelativePathV1Schema,
  utf8: z.string(),
}).strict());

const ProviderBindingFilesV1Schema = boundedArrayPreflight(
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxFiles,
  'Provider files',
).pipe(z.array(ProviderBindingFileV1Schema)
  .min(1)
  .max(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxFiles)
  .superRefine((files, ctx) => {
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
  }));

const commonMaterializationShape = {
  v: z.literal(1),
  env: ProviderBindingEnvOverlayV1Schema,
  additionalRedactionValues: SupplementalRedactionValuesV1Schema.optional(),
};

const AgentProviderBindingMaterializationDataV1Schema = z.discriminatedUnion('kind', [
  z.object({ ...commonMaterializationShape, kind: z.literal('spawnEnv') }).strict(),
  z.object({
    ...commonMaterializationShape,
    kind: z.literal('engineConfig'),
    engineConfig: ProviderBindingCanonicalJsonObjectV1Schema,
  }).strict(),
  z.object({ ...commonMaterializationShape, kind: z.literal('configFile'), files: ProviderBindingFilesV1Schema }).strict(),
]);
export const AgentProviderBindingMaterializationV1Schema = PlainDataObjectV1Schema
  .pipe(AgentProviderBindingMaterializationDataV1Schema);
export type AgentProviderBindingMaterializationV1 = z.infer<typeof AgentProviderBindingMaterializationV1Schema>;

const HostMaterializedRootPathV1Schema = z.string().min(1).superRefine((value, ctx) => {
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
});

const ProviderBindingLaunchRelativePathsV1Schema = boundedArrayPreflight(
  PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxFiles,
  'Provider launch file paths',
).pipe(z.array(ProviderBindingRelativePathV1Schema)
  .min(1)
  .max(PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.files.maxFiles)
  .superRefine((paths, ctx) => {
    const seen = new Set<string>();
    paths.forEach((path, index) => {
      const normalized = path.toLocaleLowerCase('en-US');
      if (seen.has(normalized)) {
        ctx.addIssue({ code: 'custom', path: [index], message: 'Provider launch file paths collide by case' });
      }
      seen.add(normalized);
    });
  }));

const AgentProviderBindingLaunchMaterializationDataV1Schema = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), kind: z.literal('spawnEnv') }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('engineConfig'),
    engineConfig: ProviderBindingCanonicalJsonObjectV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('configFile'),
    rootPath: HostMaterializedRootPathV1Schema,
    relativePaths: ProviderBindingLaunchRelativePathsV1Schema,
  }).strict(),
]);
export const AgentProviderBindingLaunchMaterializationV1Schema = PlainDataObjectV1Schema
  .pipe(AgentProviderBindingLaunchMaterializationDataV1Schema);
export type AgentProviderBindingLaunchMaterializationV1 = z.infer<typeof AgentProviderBindingLaunchMaterializationV1Schema>;
