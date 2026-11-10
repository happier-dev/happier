import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { utf8ByteLength } from '../bugs/reports/utf8.js';
import { SERVER_IDENTITY_ID_PATTERN } from '../features/payload/capabilities/serverIdentityCapabilities.js';

const PluginInvocationLogIdentifierSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(32_768)));
const PluginInvocationLogRecordIdentitySchema = lazyZodSchema(() => z.string().check(z.maxLength(2_048)));
const PluginInvocationLogFieldKeySchema = lazyZodSchema(() => z.string().check(z.maxLength(256)));
const ServerIdentityIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.regex(SERVER_IDENTITY_ID_PATTERN)));

const PluginInvocationLogMessageV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => utf8ByteLength(value) <= 4_096, 'Plugin invocation log message must not exceed 4096 UTF-8 bytes')));

/**
 * The host-stamped record shape emitted by the structured plugin logger.
 * This is an internal machine-RPC payload, not a Plugin SDK author surface.
 */
export const PluginInvocationLogRecordV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  kind: z.literal('plugin_invocation_log'),
  level: z.enum(['debug', 'info', 'warn', 'error', 'diagnostic']),
  message: z.optional(PluginInvocationLogMessageV1Schema),
  fields: z.optional(z.record(PluginInvocationLogFieldKeySchema, StrictJsonValueSchema)),
  diagnostic: z.optional(z.record(PluginInvocationLogFieldKeySchema, StrictJsonValueSchema)),
  context: z.strictObject({
    plugin: z.strictObject({
      id: PluginInvocationLogRecordIdentitySchema,
      version: PluginInvocationLogRecordIdentitySchema,
    }),
    contribution: z.strictObject({
      id: PluginInvocationLogRecordIdentitySchema,
      qualifiedId: PluginInvocationLogRecordIdentitySchema,
    }),
    occurrenceId: PluginInvocationLogRecordIdentitySchema,
    correlationId: PluginInvocationLogRecordIdentitySchema,
    // New invocation surfaces remain readable without weakening the record's
    // strict top-level shape.
    surface: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    sessionId: z.optional(PluginInvocationLogRecordIdentitySchema),
  }),
  occurredAtMs: z.number().check(z.int(), z.nonnegative(), z.int()),
  sequence: z.number().check(z.int(), z.nonnegative(), z.int()),
}));
export type PluginInvocationLogRecordV1 = z.infer<typeof PluginInvocationLogRecordV1Schema>;

export const PluginInvocationLogReadQueryV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  occurrenceId: z.optional(PluginInvocationLogIdentifierSchema),
  correlationId: z.optional(PluginInvocationLogIdentifierSchema),
  cursor: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  logId: z.optional(PluginInvocationLogIdentifierSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));
export type PluginInvocationLogReadQueryV1 = z.infer<typeof PluginInvocationLogReadQueryV1Schema>;

const PluginInvocationLogTargetV1Schema = lazyZodSchema(() => z.strictObject({
  serverIdentityId: ServerIdentityIdSchema,
  machineId: PluginInvocationLogIdentifierSchema,
}));

/**
 * One exact, bounded machine-RPC read. The target identity is repeated at the
 * daemon boundary so a stale or cross-server route cannot be reinterpreted as
 * an equivalent local log query.
 */
export const DaemonPluginInvocationLogReadRequestV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  target: PluginInvocationLogTargetV1Schema,
  query: PluginInvocationLogReadQueryV1Schema,
  waitForChanges: z.optional(z.literal(true)),
}));
export type DaemonPluginInvocationLogReadRequestV1 = z.infer<
  typeof DaemonPluginInvocationLogReadRequestV1Schema
>;

export const DaemonPluginInvocationLogReadResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('available'),
    records: z.array(PluginInvocationLogRecordV1Schema).check(z.maxLength(500)),
    cursor: z.number().check(z.int(), z.nonnegative(), z.int()),
    hasMore: z.boolean(),
    logId: PluginInvocationLogIdentifierSchema,
    cursorReset: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('unavailable'),
    code: z.enum([
      'plugin_log_request_invalid',
      'plugin_log_target_mismatch',
      'plugin_log_target_unavailable',
      'plugin_log_reader_unavailable',
    ]),
  }),
]));
export type DaemonPluginInvocationLogReadResponseV1 = z.infer<
  typeof DaemonPluginInvocationLogReadResponseV1Schema
>;
