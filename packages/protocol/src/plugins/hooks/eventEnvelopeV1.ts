import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { HookCategoryV1Schema } from '../../hooks/hookCategories.js';
import { HookIdV1Schema } from '../../hooks/hookIds.js';
import { HookScopeV1Schema } from '../../hooks/hookScopes.js';
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';

export const HookEventEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  hookVersion: z._default(z.literal(1), 1),
  eventId: HookIdV1Schema,
  category: HookCategoryV1Schema,
  scope: HookScopeV1Schema,
  happySessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  agentSessionId: z.optional(NonBlankOpaqueIdentifierSchema),
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  backendTarget: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  workspaceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  cwd: z.optional(z.string().check(z.trim(), z.minLength(1))),
  turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  toolCallId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  timestampMs: z.number().check(z.int(), z.nonnegative()),
  payload: z._default(z.record(z.string(), z.unknown()), {}),
}));
export type HookEventEnvelopeV1 = z.infer<typeof HookEventEnvelopeV1Schema>;

export function readHookEventEnvelopeV1(value: unknown): HookEventEnvelopeV1 | null {
  const parsed = HookEventEnvelopeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
