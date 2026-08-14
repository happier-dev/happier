import { z } from 'zod';

import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { utf8ByteLength } from '../bugs/reports/utf8.js';

const PluginInvocationLogIdentifierSchema = z.string().trim().min(1).max(32_768);
const PluginInvocationLogRecordIdentitySchema = z.string().max(2_048);
const PluginInvocationLogFieldKeySchema = z.string().max(256);
const ServerIdentityIdSchema = z.string().trim().regex(/^srv_[A-Za-z0-9._-]{1,60}$/u);

const PluginInvocationLogMessageV1Schema = z.string().refine(
  (value) => utf8ByteLength(value) <= 4_096,
  'Plugin invocation log message must not exceed 4096 UTF-8 bytes',
);

/**
 * The host-stamped record shape emitted by the structured plugin logger.
 * This is an internal machine-RPC payload, not a Plugin SDK author surface.
 */
export const PluginInvocationLogRecordV1Schema = z.object({
  version: z.literal(1),
  kind: z.literal('plugin_invocation_log'),
  level: z.enum(['debug', 'info', 'warn', 'error', 'diagnostic']),
  message: PluginInvocationLogMessageV1Schema.optional(),
  fields: z.record(PluginInvocationLogFieldKeySchema, StrictJsonValueSchema).optional(),
  diagnostic: z.record(PluginInvocationLogFieldKeySchema, StrictJsonValueSchema).optional(),
  context: z.object({
    plugin: z.object({
      id: PluginInvocationLogRecordIdentitySchema,
      version: PluginInvocationLogRecordIdentitySchema,
    }).strict(),
    contribution: z.object({
      id: PluginInvocationLogRecordIdentitySchema,
      qualifiedId: PluginInvocationLogRecordIdentitySchema,
    }).strict(),
    generation: PluginInvocationLogRecordIdentitySchema,
    correlationId: PluginInvocationLogRecordIdentitySchema,
    // New invocation surfaces remain readable without weakening the record's
    // strict top-level shape.
    surface: z.string().trim().min(1).max(128),
    sessionId: PluginInvocationLogRecordIdentitySchema.optional(),
  }).strict(),
  occurredAtMs: z.number().int().nonnegative().safe(),
  sequence: z.number().int().nonnegative().safe(),
}).strict();
export type PluginInvocationLogRecordV1 = z.infer<typeof PluginInvocationLogRecordV1Schema>;

export const PluginInvocationLogReadQueryV1Schema = z.object({
  pluginId: z.string().trim().min(1).max(256),
  generation: PluginInvocationLogIdentifierSchema.optional(),
  correlationId: PluginInvocationLogIdentifierSchema.optional(),
  cursor: z.number().int().nonnegative().safe().optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();
export type PluginInvocationLogReadQueryV1 = z.infer<typeof PluginInvocationLogReadQueryV1Schema>;

const PluginInvocationLogTargetV1Schema = z.object({
  serverIdentityId: ServerIdentityIdSchema,
  machineId: PluginInvocationLogIdentifierSchema,
}).strict();

/**
 * One exact, bounded machine-RPC read. The target identity is repeated at the
 * daemon boundary so a stale or cross-server route cannot be reinterpreted as
 * an equivalent local log query.
 */
export const DaemonPluginInvocationLogReadRequestV1Schema = z.object({
  version: z.literal(1),
  target: PluginInvocationLogTargetV1Schema,
  query: PluginInvocationLogReadQueryV1Schema,
}).strict();
export type DaemonPluginInvocationLogReadRequestV1 = z.infer<
  typeof DaemonPluginInvocationLogReadRequestV1Schema
>;

export const DaemonPluginInvocationLogReadResponseV1Schema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    kind: z.literal('available'),
    records: z.array(PluginInvocationLogRecordV1Schema).max(500),
    cursor: z.number().int().nonnegative().safe(),
    hasMore: z.boolean(),
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal('unavailable'),
    code: z.enum([
      'plugin_log_request_invalid',
      'plugin_log_target_mismatch',
      'plugin_log_target_unavailable',
      'plugin_log_reader_unavailable',
    ]),
  }).strict(),
]);
export type DaemonPluginInvocationLogReadResponseV1 = z.infer<
  typeof DaemonPluginInvocationLogReadResponseV1Schema
>;
