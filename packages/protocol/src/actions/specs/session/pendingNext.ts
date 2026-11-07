import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { PreNormalizedActionSpec } from '../../actionSpecs.js';

export const SessionPendingNextInputSchema = lazyZodSchema(() => z.strictObject({}));
export const SessionPendingNextOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['opened', 'none']) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.optional(z.enum([
    'noClient', 'no_navigation_host', 'not_ready', 'cancelled', 'scope_changed',
    'details_unavailable', 'target_unavailable', 'navigation_failed',
  ])) }),
]));
export type SessionPendingNextOutput = z.infer<typeof SessionPendingNextOutputSchema>;

/** Navigation belongs to the current mounted client, never Session resume. */
function createSessionPendingNextActionSpecs() {
  return [{
  id: 'session.pending.next', approval: {result: 'required'},
  title: 'Go to the next pending request',
  description: 'Focus the oldest answerable pending request on the mounted client. Returns unavailable when no client can navigate.',
  safety: 'safe',
  sideEffectClass: 'external',
  // A committed cross-Home navigation may retire its starting Account scope.
  // Only this closed, status-only completion can survive that retirement.
  accountAuthorityRetirementStatuses: ['opened'],
  executionPlacement: 'client',
  placements: ['command_palette'],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { voiceClientToolName: 'nextPendingRequest', mcpToolName: 'session_pending_next' },
  inputSchema: SessionPendingNextInputSchema,
  outputSchema: SessionPendingNextOutputSchema,
  inputHints: { description: 'Jump to the oldest request that is waiting for your answer.', fields: [] },
  examples: { voice: { argsExample: '{}' } },
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const SESSION_PENDING_NEXT_ACTION_SPECS: ReturnType<typeof createSessionPendingNextActionSpecs> = lazyActionSpecArray(createSessionPendingNextActionSpecs);
