import Ajv, { type ValidateFunction } from 'ajv';
import { z } from 'zod';

import {
  containsEquivalentPluginJsonValue,
  pluginJsonValuesEqual,
} from '../contributions/jsonSchemaValues.js';
import {
  PluginJsonSchemaV2Schema,
  type PluginJsonSchemaV2,
} from '../contributions/publicTypes.js';
import { PLUGIN_MANIFEST_INPUT_LIMITS } from '../manifest/limits.js';

const schemaLimits = Object.freeze({
  maxDepth: PLUGIN_MANIFEST_INPUT_LIMITS.depth,
  maxNodes: PLUGIN_MANIFEST_INPUT_LIMITS.nodes,
  maxStringBytes: PLUGIN_MANIFEST_INPUT_LIMITS.stringBytes,
});

const valueLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 65_536,
  maxStringBytes: 4 * 1024 * 1024,
});

type CloneState = { nodes: number; stringBytes: number };
type StrictJsonLimits = Readonly<{
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
}>;
const textEncoder = new TextEncoder();

function cloneStrictJson(value: unknown, limits: StrictJsonLimits, path: string): unknown {
  const ancestors = new WeakSet<object>();
  const state: CloneState = { nodes: 0, stringBytes: 0 };

  const visit = (input: unknown, currentPath: string, depth: number): unknown => {
    if (depth > limits.maxDepth) throw new Error(`${currentPath} exceeds the maximum plain-data depth`);
    state.nodes += 1;
    if (state.nodes > limits.maxNodes) throw new Error(`${currentPath} exceeds the maximum plain-data node count`);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      state.stringBytes += textEncoder.encode(input).byteLength;
      if (state.stringBytes > limits.maxStringBytes) throw new Error(`${currentPath} exceeds the maximum plain-data string size`);
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error(`${currentPath} must contain finite JSON numbers`);
      return input;
    }
    if (typeof input !== 'object') throw new Error(`${currentPath} must contain strict JSON data`);
    if (ancestors.has(input)) throw new Error(`${currentPath} must not contain cyclic data`);
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const keys = Reflect.ownKeys(descriptors);
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
            throw new Error(`${currentPath} must not contain holes or accessors`);
          }
        }
        if (keys.some((key) => typeof key === 'symbol'
          || (key !== 'length' && (!/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= input.length)))) {
          throw new Error(`${currentPath} must not contain extra array properties`);
        }
        return Object.freeze(input.map((_entry, index) => {
          const descriptor = descriptors[String(index)]!;
          return visit(descriptor.value, `${currentPath}[${index}]`, depth + 1);
        }));
      }

      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${currentPath} must contain only plain objects`);
      }
      const output = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key === 'symbol') throw new Error(`${currentPath} must not contain symbol keys`);
        state.stringBytes += textEncoder.encode(key).byteLength;
        if (state.stringBytes > limits.maxStringBytes) throw new Error(`${currentPath} exceeds the maximum plain-data string size`);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
          throw new Error(`${currentPath}.${key} must be enumerable data`);
        }
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, `${currentPath}.${key}`, depth + 1),
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
      return Object.freeze(output);
    } finally {
      ancestors.delete(input);
    }
  };

  return visit(value, path, 0);
}

function invalidSchema(message: string): Error {
  return new Error(`Invalid plugin JSON Schema: ${message}`);
}

function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, ownProperties: true, strict: false, validateSchema: false });
  ajv.removeKeyword('enum');
  ajv.addKeyword({
    keyword: 'enum',
    metaSchema: { type: 'array', minItems: 1 },
    compile: (allowed: unknown) => {
      if (!Array.isArray(allowed) || allowed.length === 0) {
        throw new Error('Plugin JSON Schema enum must contain at least one value');
      }
      const seen: unknown[] = [];
      for (const candidate of allowed) {
        if (containsEquivalentPluginJsonValue(seen, candidate)) {
          throw new Error('Plugin JSON Schema enum values must be unique');
        }
        seen.push(candidate);
      }
      return (value: unknown) => containsEquivalentPluginJsonValue(allowed, value);
    },
    errors: false,
  });
  ajv.removeKeyword('const');
  ajv.addKeyword({
    keyword: 'const',
    validate: (expected: unknown, value: unknown) => pluginJsonValuesEqual(expected, value),
    errors: false,
  });
  return ajv;
}

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw invalidSchema(`${label} values must be unique`);
}

function assertSchemaSemantics(schema: Readonly<Record<string, unknown>>): void {
  if (Array.isArray(schema.enum) && schema.enum.length === 0) throw invalidSchema('enum must contain at least one value');
  if (Array.isArray(schema.required)) assertUniqueStrings(schema.required as readonly string[], 'required');
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    if (variants.length === 0) throw invalidSchema(`${keyword} must contain at least one schema`);
    for (const variant of variants) assertSchemaSemantics(variant as Readonly<Record<string, unknown>>);
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    assertSchemaSemantics(schema.items as Readonly<Record<string, unknown>>);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object'
    && !Array.isArray(schema.additionalProperties)) {
    assertSchemaSemantics(schema.additionalProperties as Readonly<Record<string, unknown>>);
  }
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    for (const child of Object.values(schema.properties)) {
      assertSchemaSemantics(child as Readonly<Record<string, unknown>>);
    }
  }
}

function normalizePluginJsonSchema(schema: object): PluginJsonSchemaV2 {
  let normalized: unknown;
  try {
    normalized = cloneStrictJson(schema, schemaLimits, 'schema');
  } catch (error) {
    throw invalidSchema(error instanceof Error ? error.message : 'schema is not strict JSON');
  }
  const parsed = PluginJsonSchemaV2Schema.safeParse(normalized);
  if (!parsed.success) throw invalidSchema('schema is outside the public plugin schema vocabulary');
  assertSchemaSemantics(normalized as Readonly<Record<string, unknown>>);
  return parsed.data;
}

export function compilePluginJsonSchema(schema: object): ValidateFunction {
  return createAjv().compile(normalizePluginJsonSchema(schema));
}

/**
 * Adapts the protocol-owned JSON Schema vocabulary to Zod consumers that
 * require an object schema, without making Zod a second schema-semantics owner.
 */
export function createPluginJsonSchemaZodObjectAdapter(schema: object) {
  const normalized = normalizePluginJsonSchema(schema);
  const validate = createAjv().compile(normalized);
  const adapter = z.object({}).passthrough().superRefine((value, ctx) => {
    if (!isValidPluginJsonSchemaValue(validate, value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Value does not match the plugin JSON Schema',
      });
    }
  });

  // The pinned Zod exporter exposes a processor hook for boundary adapters.
  // Copy a fresh protocol-validated value because the exporter mutates its
  // destination while adding the selected draft marker.
  adapter._zod.processJSONSchema = (_ctx, json) => {
    Object.assign(json, PluginJsonSchemaV2Schema.parse(normalized));
    json.type = 'object';
  };
  return adapter;
}

export function isValidPluginJsonSchemaValue(validate: ValidateFunction, value: unknown): boolean {
  try {
    return validate(cloneStrictJson(value, valueLimits, 'value')) === true;
  } catch {
    return false;
  }
}
