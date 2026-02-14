import { z } from 'zod';

/**
 * One-shot request/response tasks executed by the daemon (not transcript-materialized by default).
 *
 * V1 scope:
 * - SCM commit message generator
 *
 * These schemas are used by session-scoped RPC `ephemeral.task.run` and MCP equivalents.
 */

export const EphemeralTaskKindSchema = z.enum([
  'scm.commit_message',
]);
export type EphemeralTaskKind = z.infer<typeof EphemeralTaskKindSchema>;

export const EphemeralTaskPermissionModeSchema = z.enum([
  'no_tools',
  'read_only',
  'workspace_write',
  'full',
]);
export type EphemeralTaskPermissionMode = z.infer<typeof EphemeralTaskPermissionModeSchema>;

export const EphemeralTaskRunRequestSchema = z.object({
  kind: EphemeralTaskKindSchema,
  sessionId: z.string().min(1),
  // Optional bounded input payload; task-specific.
  input: z.unknown().optional(),
  permissionMode: EphemeralTaskPermissionModeSchema.optional(),
}).passthrough();
export type EphemeralTaskRunRequest = z.infer<typeof EphemeralTaskRunRequestSchema>;

export const EphemeralTaskRunResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
export type EphemeralTaskRunResponse = z.infer<typeof EphemeralTaskRunResponseSchema>;

