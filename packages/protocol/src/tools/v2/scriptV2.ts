import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const ScriptToolInputV2Schema = lazyZodSchema(() => z.strictObject({
  code: z.string(),
  language: z.optional(z.enum(['javascript', 'typescript'])),
  title: z.optional(z.string()),
  origin: z.optional(z.enum(['native', 'cli'])),
  cellId: z.optional(z.string()),
}));
export type ScriptToolInputV2 = z.infer<typeof ScriptToolInputV2Schema>;

export const ScriptToolResultV2Schema = lazyZodSchema(() => z.strictObject({
  output: z.optional(z.unknown()),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  calls: z.optional(z.readonly(z.array(z.strictObject({
    id: z.optional(z.string()),
    source: z.optional(z.string()),
    tool: z.string(),
    status: z.enum(['running', 'completed', 'error', 'denied']),
    summary: z.optional(z.string()),
    durationMs: z.optional(z.number().check(z.nonnegative())),
    refusalCause: z.optional(z.unknown()),
  })))),
}));
export type ScriptToolResultV2 = z.infer<typeof ScriptToolResultV2Schema>;
