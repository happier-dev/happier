import { z } from 'zod';

export const ExecutionRunIntentSchema = z.enum([
  'review',
  'plan',
  'delegate',
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
