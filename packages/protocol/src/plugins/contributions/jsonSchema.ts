import { lazyZodSchema } from '../../lazyZodSchema.js';
/**
 * The JSON value and JSON Schema dialect are deliberately independent from
 * plugin identity and contribution declarations. Keeping this owner neutral
 * lets protocol roots use the canonical schema constructors without a module
 * initialization cycle through contribution identity.
 */
import { z } from 'zod/mini';

/** Shared portable declaration rule: every object remains closed, including union arms. */
export function isRecursivelyClosedPluginJsonSchemaV2(schema: PluginJsonSchemaV2): boolean {
  if ((schema.type === 'object' || schema.properties) && schema.additionalProperties !== false) return false;
  return Object.values(schema.properties ?? {}).every(isRecursivelyClosedPluginJsonSchemaV2)
    && Object.values(schema.definitions ?? {}).every(isRecursivelyClosedPluginJsonSchemaV2)
    && Object.values(schema.$defs ?? {}).every(isRecursivelyClosedPluginJsonSchemaV2)
    && (!schema.items || isRecursivelyClosedPluginJsonSchemaV2(schema.items))
    && (!schema.not || isRecursivelyClosedPluginJsonSchemaV2(schema.not))
    && [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].every(isRecursivelyClosedPluginJsonSchemaV2);
}

/**
 * Mutable structural JSON authored into declarations and carried on wire
 * payloads, admitted by `PluginJsonValueV2Schema`. It is deliberately distinct
 * from the strict runtime value in `json/strictJsonValue.ts`: this spelling
 * describes data before strict normalization, so it stays mutable and carries
 * none of the prototype, accessor, dense-array, well-formed-Unicode, or
 * aggregate-byte guarantees that the strict normalizer enforces. Values of
 * this type may be passed where a strict runtime value is expected; a strict
 * runtime value may not be passed back the other way.
 */
export type PluginJsonValueV2 =
  | null
  | boolean
  | number
  | string
  | PluginJsonValueV2[]
  | { [key: string]: PluginJsonValueV2 };

const PluginJsonValueShallowSchema = lazyZodSchema(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(),
  z.array(z.unknown()), z.record(z.string(), z.unknown()),
]));

// Stored Workflow envelopes reach this structural JSON owner before their
// purpose-specific schema. Parse its existing dialect without recursive calls;
// strict normalization and transport byte limits remain separate owners.
export const PluginJsonValueV2Schema: z.ZodMiniType<PluginJsonValueV2> = z.pipe(z.unknown(), z.transform((value, context): PluginJsonValueV2 => {
  let output: unknown;
  let failed = false;
  const ancestors = new WeakSet<object>();
  type Task = { value: unknown; path: (string | number)[]; assign: (value: unknown) => void }
    | { finish: object };
  const pending: Task[] = [{ value, path: [], assign: (parsed) => { output = parsed; } }];
  while (pending.length > 0) {
    const task = pending.pop()!;
    if ('finish' in task) { ancestors.delete(task.finish); continue; }
    if (task.value !== null && typeof task.value === 'object') {
      if (ancestors.has(task.value)) {
        context.issues.push({ code: 'custom', path: task.path, message: 'JSON values cannot contain cycles', input: context.value });
        failed = true;
        continue;
      }
      ancestors.add(task.value);
      pending.push({ finish: task.value });
    }
    const parsed = PluginJsonValueShallowSchema.safeParse(task.value);
    if (!parsed.success) {
      failed = true;
      for (const issue of parsed.error.issues) context.issues.push({ ...issue, path: [...task.path, ...issue.path], input: ('input' in issue ? issue.input ?? context.value : context.value) } as z.core.$ZodRawIssue);
      continue;
    }
    const result = parsed.data;
    task.assign(result);
    if (Array.isArray(result)) {
      for (let index = result.length - 1; index >= 0; index -= 1) {
        pending.push({ value: result[index], path: [...task.path, index], assign: (child) => { result[index] = child; } });
      }
    } else if (result !== null && typeof result === 'object') {
      const keys = Object.keys(result);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        pending.push({ value: result[key], path: [...task.path, key], assign: (child) => { result[key] = child; } });
      }
    }
  }
  return failed ? z.NEVER : output as PluginJsonValueV2;
}));

const PluginJsonValueProjectionSchema = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(),
  z.array(PluginJsonValueV2Schema),
  z.record(z.string(), PluginJsonValueV2Schema),
]));
PluginJsonValueV2Schema._zod.processJSONSchema = (context, _json, params) => {
  z.core.process(PluginJsonValueProjectionSchema, context, params);
  context.seen.get(PluginJsonValueV2Schema)!.ref = PluginJsonValueProjectionSchema;
};

export type PluginJsonSchemaV2 = {
  $schema?: 'http://json-schema.org/draft-07/schema#';
  /** Self-contained root/JSON Pointer references only; no external schema loading. */
  $ref?: string;
  definitions?: Record<string, PluginJsonSchemaV2>;
  $defs?: Record<string, PluginJsonSchemaV2>;
  type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
  format?: 'date-time' | 'time' | 'date' | 'duration' | 'uri' | 'uri-reference' | 'uri-template' | 'url' | 'email' | 'hostname' | 'ipv4' | 'ipv6' | 'regex' | 'uuid' | 'json-pointer' | 'relative-json-pointer';
  title?: string;
  description?: string;
  default?: PluginJsonValueV2;
  enum?: PluginJsonValueV2[];
  const?: PluginJsonValueV2;
  properties?: Record<string, PluginJsonSchemaV2>;
  propertyNames?: PluginJsonSchemaV2;
  required?: string[];
  additionalProperties?: boolean | PluginJsonSchemaV2;
  items?: PluginJsonSchemaV2;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  'x-happier-max-utf8-bytes'?: number;
  'x-happier-max-serialized-utf8-bytes'?: number;
  pattern?: string;
  anyOf?: PluginJsonSchemaV2[];
  oneOf?: PluginJsonSchemaV2[];
  allOf?: PluginJsonSchemaV2[];
  not?: PluginJsonSchemaV2;
};

const PluginJsonSchemaV2Definition: z.ZodMiniType<PluginJsonSchemaV2> = lazyZodSchema(() => z.strictObject({
  $schema: z.optional(z.literal('http://json-schema.org/draft-07/schema#')),
  $ref: z.optional(z.string().check(z.regex(/^#(?:\/.*)?$/u, 'Schema references must be document-local JSON Pointers'))),
  definitions: z.optional(z.record(z.string(), PluginJsonSchemaV2Schema)),
  $defs: z.optional(z.record(z.string(), PluginJsonSchemaV2Schema)),
  type: z.optional(z.enum(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object'])),
  format: z.optional(z.enum(['date-time', 'time', 'date', 'duration', 'uri', 'uri-reference', 'uri-template', 'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer', 'relative-json-pointer'])),
  title: z.optional(z.string()), description: z.optional(z.string()),
  default: z.optional(PluginJsonValueV2Schema), enum: z.optional(z.array(PluginJsonValueV2Schema)), const: z.optional(PluginJsonValueV2Schema),
  properties: z.optional(z.record(z.string(), PluginJsonSchemaV2Schema)), required: z.optional(z.array(z.string())),
  propertyNames: z.optional(PluginJsonSchemaV2Schema),
  additionalProperties: z.optional(z.union([z.boolean(), PluginJsonSchemaV2Schema])), items: z.optional(PluginJsonSchemaV2Schema),
  minItems: z.optional(z.number().check(z.int(), z.nonnegative())), maxItems: z.optional(z.number().check(z.int(), z.nonnegative())),
  uniqueItems: z.optional(z.boolean()),
  minimum: z.optional(z.number()), maximum: z.optional(z.number()),
  multipleOf: z.optional(z.number().check(z.positive())),
  exclusiveMinimum: z.optional(z.number()), exclusiveMaximum: z.optional(z.number()),
  minLength: z.optional(z.number().check(z.int(), z.nonnegative())), maxLength: z.optional(z.number().check(z.int(), z.nonnegative())), pattern: z.optional(z.string()),
  'x-happier-max-utf8-bytes': z.optional(z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER))),
  'x-happier-max-serialized-utf8-bytes': z.optional(z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER))),
  anyOf: z.optional(z.array(PluginJsonSchemaV2Schema)), oneOf: z.optional(z.array(PluginJsonSchemaV2Schema)), allOf: z.optional(z.array(PluginJsonSchemaV2Schema)),
  not: z.optional(PluginJsonSchemaV2Schema),
}));

// Native projection revisits recursive getters; construct this declaration
// once while retaining the public lazy root and its recursive admission.
export const PluginJsonSchemaV2Schema: z.ZodMiniType<PluginJsonSchemaV2> = z.lazy(() => PluginJsonSchemaV2Definition);
