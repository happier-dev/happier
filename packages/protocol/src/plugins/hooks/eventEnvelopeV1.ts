import { z } from 'zod';

import { HookCategoryV1Schema } from '../../hooks/hookCategories.js';
import { HookIdV1Schema } from '../../hooks/hookIds.js';
import { HookScopeV1Schema } from '../../hooks/hookScopes.js';

export const HookEventEnvelopeV1Schema = z.object({
  hookVersion: z.literal(1).default(1),
  eventId: HookIdV1Schema,
  category: HookCategoryV1Schema,
  scope: HookScopeV1Schema,
  happySessionId: z.string().trim().min(1).optional(),
  agentSessionId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  backendTarget: z.string().trim().min(1).optional(),
  machineId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  turnId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1).optional(),
  timestampMs: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type HookEventEnvelopeV1 = z.infer<typeof HookEventEnvelopeV1Schema>;

export function readHookEventEnvelopeV1(value: unknown): HookEventEnvelopeV1 | null {
  const parsed = HookEventEnvelopeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
