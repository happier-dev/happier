import { z } from 'zod';

const PromptInvocationTokenV1Schema = z
  .string()
  .min(2)
  // Single-segment invocation tokens only (no nested slashes), and disallow obvious absolute paths.
  .regex(/^\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);

export type PromptInvocationTokenV1 = z.infer<typeof PromptInvocationTokenV1Schema>;

export const PromptInvocationBehaviorV1Schema = z.enum(['insert', 'insert_and_send']);
export type PromptInvocationBehaviorV1 = z.infer<typeof PromptInvocationBehaviorV1Schema>;

export const PromptInvocationAvailabilityV1Schema = z.enum(['global', 'session_only']);
export type PromptInvocationAvailabilityV1 = z.infer<typeof PromptInvocationAvailabilityV1Schema>;

export const PromptInvocationTargetV1Schema = z.object({
  kind: z.literal('doc'),
  artifactId: z.string().min(1),
});

export type PromptInvocationTargetV1 = z.infer<typeof PromptInvocationTargetV1Schema>;

export const PromptInvocationEntryV1Schema = z.object({
  id: z.string().min(1),
  token: PromptInvocationTokenV1Schema,
  title: z.string().min(1),
  target: PromptInvocationTargetV1Schema,
  behavior: PromptInvocationBehaviorV1Schema.default('insert'),
  allowArgs: z.boolean().default(false),
  availableIn: PromptInvocationAvailabilityV1Schema.default('global'),
});

export type PromptInvocationEntryV1 = z.infer<typeof PromptInvocationEntryV1Schema>;

export const PromptInvocationsV1Schema = z
  .object({
    v: z.literal(1).default(1),
    entries: z.array(PromptInvocationEntryV1Schema).default([]),
  })
  .catch({ v: 1, entries: [] });

export type PromptInvocationsV1 = z.infer<typeof PromptInvocationsV1Schema>;

export function normalizePromptInvocationTokenV1(token: string): string {
  return String(token ?? '').trim().toLowerCase();
}
