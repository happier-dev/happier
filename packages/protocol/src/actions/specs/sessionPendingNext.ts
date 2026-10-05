import { z } from 'zod';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const SessionPendingNextInputSchema = z.object({}).strict();
export const SessionPendingNextOutputSchema = z.object({
  status: z.enum(['opened', 'none', 'unavailable']),
}).strict();

/** Navigation belongs to the current mounted client, never Session resume. */
export const SESSION_PENDING_NEXT_ACTION_SPECS = [{
  id: 'session.pending.next',
  title: 'Go to the next pending request',
  description: 'Focus the oldest answerable pending request on the mounted client. Returns unavailable when no client can navigate.',
  safety: 'safe',
  sideEffectClass: 'external',
  executionPlacement: 'client',
  placements: ['command_palette'],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { voiceClientToolName: 'nextPendingRequest', mcpToolName: 'session_pending_next' },
  inputSchema: SessionPendingNextInputSchema,
  outputSchema: SessionPendingNextOutputSchema,
}] as const satisfies readonly PreNormalizedActionSpec[];
