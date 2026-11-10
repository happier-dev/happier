import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { defineProtocolJsonValue } from '../../plugins/actions/protocolComposableSchema.js';

/**
 * Wire-level `systemTasks` contract shared between protocol consumers.
 *
 * Ownership boundary:
 * - This module only defines stable schemas, types, and protocol invariants.
 * - It does not own task catalogs, orchestration, execution policy, installers,
 *   CLI invocation details, or any workflow-specific behavior.
 */

export const SYSTEM_TASK_PROTOCOL_VERSION = 1 as const;

type SystemTaskJsonPrimitive = null | string | number | boolean;
export interface SystemTaskJsonObject {
  readonly [key: string]: SystemTaskJsonValue;
}
export type SystemTaskJsonArray = ReadonlyArray<SystemTaskJsonValue>;
export type SystemTaskJsonValue =
  | SystemTaskJsonPrimitive
  | SystemTaskJsonArray
  | SystemTaskJsonObject;

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSystemTaskJsonValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): value is SystemTaskJsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      if (seen.has(value)) {
        return false;
      }

      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return value.every((entry) => isSystemTaskJsonValue(entry, seen));
        }

        if (!isPlainJsonObject(value)) {
          return false;
        }

        return Object.values(value).every((entry) => isSystemTaskJsonValue(entry, seen));
      } finally {
        seen.delete(value);
      }
    default:
      return false;
  }
}

export const SystemTaskJsonValueSchema = lazyZodSchema(() => {
  const schema = z.custom<SystemTaskJsonValue>(
    (value): value is SystemTaskJsonValue => isSystemTaskJsonValue(value),
    'Expected a JSON-safe value',
  );
  // Preserve native SystemTask admission while projecting its JSON wire position
  // through the canonical JSON definition, as other Protocol boundary adapters do.
  const jsonSchema = defineProtocolJsonValue().jsonSchema;
  schema._zod.processJSONSchema = (_context, projection) => {
    Object.assign(projection, jsonSchema);
  };
  return schema;
});

export const SystemTaskSpecSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(SYSTEM_TASK_PROTOCOL_VERSION),
  kind: z.string().check(z.minLength(1)),
  params: SystemTaskJsonValueSchema,
}));
export type SystemTaskSpec = z.infer<typeof SystemTaskSpecSchema>;

export const SystemTaskEventSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(SYSTEM_TASK_PROTOCOL_VERSION),
  taskId: z.string().check(z.minLength(1)),
  tsMs: z.number().check(z.int(), z.nonnegative()),
  type: z.string().check(z.minLength(1)),
  stepId: z.optional(z.string().check(z.minLength(1))),
  message: z.optional(z.string().check(z.minLength(1))),
  data: z.optional(SystemTaskJsonValueSchema),
}));
export type SystemTaskEvent = z.infer<typeof SystemTaskEventSchema>;

export const SystemTaskResultErrorSchema = lazyZodSchema(() => z.strictObject({
  code: z.string().check(z.minLength(1)),
  message: z.string().check(z.minLength(1)),
}));
export type SystemTaskResultError = z.infer<typeof SystemTaskResultErrorSchema>;

const SystemTaskSuccessResultSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(SYSTEM_TASK_PROTOCOL_VERSION),
  taskId: z.string().check(z.minLength(1)),
  ok: z.literal(true),
  data: z.optional(SystemTaskJsonValueSchema),
}));

const SystemTaskFailureResultSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(SYSTEM_TASK_PROTOCOL_VERSION),
  taskId: z.string().check(z.minLength(1)),
  ok: z.literal(false),
  error: SystemTaskResultErrorSchema,
}));

export const SystemTaskResultSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  SystemTaskSuccessResultSchema,
  SystemTaskFailureResultSchema,
]));
export type SystemTaskResult = z.infer<typeof SystemTaskResultSchema>;
