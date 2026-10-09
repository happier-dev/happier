import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PromptDocArtifactRefV1Schema } from './promptArtifactRefsV1.js';

const PromptInvocationTokenV1Schema = lazyZodSchema(() => z
  .string()
  .min(2)
  // Single-segment invocation tokens only (no nested slashes), and disallow obvious absolute paths.
  .regex(/^\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/));

export type PromptInvocationTokenV1 = z.infer<typeof PromptInvocationTokenV1Schema>;

export const PromptInvocationBehaviorV1Schema = lazyZodSchema(() => z.enum(['insert', 'insert_on_send', 'insert_and_send']));
export type PromptInvocationBehaviorV1 = z.infer<typeof PromptInvocationBehaviorV1Schema>;

export const PromptInvocationAvailabilityV1Schema = lazyZodSchema(() => z.enum(['global', 'session_only']));
export type PromptInvocationAvailabilityV1 = z.infer<typeof PromptInvocationAvailabilityV1Schema>;

export const PromptInvocationTargetV1Schema = PromptDocArtifactRefV1Schema;

export type PromptInvocationTargetV1 = z.infer<typeof PromptInvocationTargetV1Schema>;

export const PromptInvocationEntryV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  token: PromptInvocationTokenV1Schema,
  title: z.string().min(1),
  target: PromptInvocationTargetV1Schema,
  behavior: PromptInvocationBehaviorV1Schema.default('insert'),
  allowArgs: z.boolean().default(false),
  availableIn: PromptInvocationAvailabilityV1Schema.default('global'),
}).passthrough());

export type PromptInvocationEntryV1 = z.infer<typeof PromptInvocationEntryV1Schema>;

export const PromptInvocationsV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1).default(1),
    entries: z.array(PromptInvocationEntryV1Schema).default([]),
  })
  .passthrough()
  .catch({ v: 1, entries: [] }));

export type PromptInvocationsV1 = z.infer<typeof PromptInvocationsV1Schema>;

export function normalizePromptInvocationTokenV1(token: string): string {
  return String(token ?? '').trim().toLowerCase();
}

/** A session-only template requires an actually addressed session, not a draft. */
export function isPromptInvocationAvailable(
  entry: Pick<PromptInvocationEntryV1, 'availableIn'>,
  context: Readonly<{ sessionId: string | null }>,
): boolean {
  return entry.availableIn === 'global'
    || (entry.availableIn === 'session_only' && Boolean(context.sessionId?.trim()));
}

export function validatePromptInvocationTokenV1(params: Readonly<{
  token: string;
  entries: readonly Pick<PromptInvocationEntryV1, 'id' | 'token'>[];
  excludingInvocationId?: string | null;
  /** UI-enabled slash tokens from the canonical Action catalogue. */
  actionTokens: readonly string[];
}>): Readonly<{ ok: true; token: string } | { ok: false; reason: 'invalid' | 'reserved' | 'actionCollision' | 'duplicate' }> {
  const trimmed = params.token.trim();
  const token = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (!PromptInvocationTokenV1Schema.safeParse(token).success) return { ok: false, reason: 'invalid' };
  const normalized = normalizePromptInvocationTokenV1(token);
  if (normalized === '/clear' || normalized === '/compact') return { ok: false, reason: 'reserved' };
  if (params.actionTokens.some((candidate) => candidate.startsWith('/') && normalizePromptInvocationTokenV1(candidate) === normalized)) {
    return { ok: false, reason: 'actionCollision' };
  }
  if (params.entries.some((entry) => entry.id !== params.excludingInvocationId && normalizePromptInvocationTokenV1(entry.token) === normalized)) {
    return { ok: false, reason: 'duplicate' };
  }
  return { ok: true, token };
}
