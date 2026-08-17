import { z } from 'zod';

import type { AgentActivityStatusV1 } from './agentActivityStatusV1.js';

/**
 * Presentation tone for an agent-activity status.
 *
 * Components switch on the six tones, never on the ten statuses: a status added to the vocabulary
 * needs one tone decision here instead of a colour/glyph branch in every surface. Tone is
 * deliberately theme-free — the tone -> ink/glyph binding belongs to the UI theme owner.
 */
export const AGENT_ACTIVITY_TONES_V1 = [
  'pending',
  'live',
  'attention',
  'success',
  'danger',
  'neutral',
] as const;

export const AgentActivityToneV1Schema = z.enum(AGENT_ACTIVITY_TONES_V1);
export type AgentActivityToneV1 = z.infer<typeof AgentActivityToneV1Schema>;

/**
 * Total status -> tone mapping. The switch has no `default` arm on purpose: a new status makes the
 * function fail to compile at the `never` check below instead of silently reading as neutral.
 */
export function resolveAgentActivityTone(status: AgentActivityStatusV1): AgentActivityToneV1 {
  switch (status) {
    case 'queued':
    case 'starting':
    case 'blocked':
      return 'pending';
    case 'running':
      return 'live';
    case 'waiting':
      return 'attention';
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'timedOut':
      return 'danger';
    case 'cancelled':
    case 'unknown':
      return 'neutral';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
