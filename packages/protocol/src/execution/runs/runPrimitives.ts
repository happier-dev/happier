import { z } from 'zod';

export const ExecutionRunIntentSchema = z.enum([
  'review',
  'plan',
  'delegate',
  'agent',
  'task',
  'voice_agent',
  'memory_hints',
  'scm_commit_message',
  'scm_diff_summary',
]);
export type ExecutionRunIntent = z.infer<typeof ExecutionRunIntentSchema>;

export const ExecutionRunRetentionPolicySchema = z.enum(['ephemeral', 'resumable']);
export type ExecutionRunRetentionPolicy = z.infer<typeof ExecutionRunRetentionPolicySchema>;

export const ExecutionRunClassSchema = z.enum(['bounded', 'long_lived']);
export type ExecutionRunClass = z.infer<typeof ExecutionRunClassSchema>;

export const ExecutionRunIoModeSchema = z.enum(['request_response', 'streaming']);
export type ExecutionRunIoMode = z.infer<typeof ExecutionRunIoModeSchema>;

// Action inputs share this request without importing Voice-dependent stream events.
export const ExecutionRunTurnStreamReadRequestSchema = z.object({
  runId: z.string().min(1),
  streamId: z.string().min(1),
  cursor: z.number().int().min(0),
  maxEvents: z.number().int().min(1).max(256).optional(),
  /** Hold an empty read until this cursor has events or the stream becomes terminal. */
  waitForEvents: z.boolean().optional(),
}).passthrough();
export type ExecutionRunTurnStreamReadRequest = z.infer<typeof ExecutionRunTurnStreamReadRequestSchema>;
