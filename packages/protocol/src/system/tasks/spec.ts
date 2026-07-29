import { z } from 'zod';

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

export const SystemTaskJsonValueSchema = z.custom<SystemTaskJsonValue>(
  (value): value is SystemTaskJsonValue => isSystemTaskJsonValue(value),
  'Expected a JSON-safe value',
);

export const SystemTaskSpecSchema = z.object({
  protocolVersion: z.literal(SYSTEM_TASK_PROTOCOL_VERSION),
  kind: z.string().min(1),
  params: SystemTaskJsonValueSchema,
}).strict();
export type SystemTaskSpec = z.infer<typeof SystemTaskSpecSchema>;

export const SystemTaskEventSchema = z.object({
  protocolVersion: z.literal(SYSTEM_TASK_PROTOCOL_VERSION),
  taskId: z.string().min(1),
  tsMs: z.number().int().nonnegative(),
  type: z.string().min(1),
  stepId: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  data: SystemTaskJsonValueSchema.optional(),
}).strict();
export type SystemTaskEvent = z.infer<typeof SystemTaskEventSchema>;

export const SystemTaskResultErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();
export type SystemTaskResultError = z.infer<typeof SystemTaskResultErrorSchema>;

const SystemTaskSuccessResultSchema = z.object({
  protocolVersion: z.literal(SYSTEM_TASK_PROTOCOL_VERSION),
  taskId: z.string().min(1),
  ok: z.literal(true),
  data: SystemTaskJsonValueSchema.optional(),
}).strict();

const SystemTaskFailureResultSchema = z.object({
  protocolVersion: z.literal(SYSTEM_TASK_PROTOCOL_VERSION),
  taskId: z.string().min(1),
  ok: z.literal(false),
  error: SystemTaskResultErrorSchema,
}).strict();

export const SystemTaskResultSchema = z.discriminatedUnion('ok', [
  SystemTaskSuccessResultSchema,
  SystemTaskFailureResultSchema,
]);
export type SystemTaskResult = z.infer<typeof SystemTaskResultSchema>;
