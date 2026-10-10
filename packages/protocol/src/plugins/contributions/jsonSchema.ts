import { lazyZodSchema } from '../../lazyZodSchema.js';
/**
 * The JSON value and JSON Schema dialect are deliberately independent from
 * plugin identity and contribution declarations. Keeping this owner neutral
 * lets protocol roots use the canonical schema constructors without a module
 * initialization cycle through contribution identity.
 */
import { z } from 'zod';

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
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(z.unknown()), z.record(z.string(), z.unknown()),
]));

// Stored Workflow envelopes reach this structural JSON owner before their
// purpose-specific schema. Parse its existing dialect without recursive calls;
// strict normalization and transport byte limits remain separate owners.
export const PluginJsonValueV2Schema: z.ZodType<PluginJsonValueV2> = z.unknown().transform((value, context): PluginJsonValueV2 => {
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
        context.addIssue({ code: 'custom', path: task.path, message: 'JSON values cannot contain cycles' });
        failed = true;
        continue;
      }
      ancestors.add(task.value);
      pending.push({ finish: task.value });
    }
    const parsed = PluginJsonValueShallowSchema.safeParse(task.value);
    if (!parsed.success) {
      failed = true;
      for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: [...task.path, ...issue.path] });
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
});

const PluginJsonValueProjectionSchema = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
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

export const PluginJsonSchemaV2Schema: z.ZodType<PluginJsonSchemaV2> = z.lazy(() => z.object({
  $schema: z.literal('http://json-schema.org/draft-07/schema#').optional(),
  $ref: z.string().regex(/^#(?:\/.*)?$/u, 'Schema references must be document-local JSON Pointers').optional(),
  definitions: z.record(z.string(), PluginJsonSchemaV2Schema).optional(),
  $defs: z.record(z.string(), PluginJsonSchemaV2Schema).optional(),
  type: z.enum(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']).optional(),
  format: z.enum(['date-time', 'time', 'date', 'duration', 'uri', 'uri-reference', 'uri-template', 'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer', 'relative-json-pointer']).optional(),
  title: z.string().optional(), description: z.string().optional(),
  default: PluginJsonValueV2Schema.optional(), enum: z.array(PluginJsonValueV2Schema).optional(), const: PluginJsonValueV2Schema.optional(),
  properties: z.record(z.string(), PluginJsonSchemaV2Schema).optional(), required: z.array(z.string()).optional(),
  propertyNames: PluginJsonSchemaV2Schema.optional(),
  additionalProperties: z.union([z.boolean(), PluginJsonSchemaV2Schema]).optional(), items: PluginJsonSchemaV2Schema.optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  uniqueItems: z.boolean().optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  multipleOf: z.number().finite().positive().optional(),
  exclusiveMinimum: z.number().finite().optional(), exclusiveMaximum: z.number().finite().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), pattern: z.string().optional(),
  'x-happier-max-utf8-bytes': z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  'x-happier-max-serialized-utf8-bytes': z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  anyOf: z.array(PluginJsonSchemaV2Schema).optional(), oneOf: z.array(PluginJsonSchemaV2Schema).optional(), allOf: z.array(PluginJsonSchemaV2Schema).optional(),
  not: PluginJsonSchemaV2Schema.optional(),
}).strict());
