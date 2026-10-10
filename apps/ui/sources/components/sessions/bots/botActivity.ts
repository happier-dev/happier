import {
  isUrgentSessionListAttentionState,
  mapSessionAwarenessToListAttentionState,
} from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';

export type BotActivity = 'needsYou' | 'working' | 'quiet';

type OperationalAwareness = Parameters<
  typeof mapSessionAwarenessToListAttentionState
>[0];

/**
 * What a Bot is doing, as the roster header, the rail badge and the rail pins all say it: one
 * reading of the Session's operational awareness.
 */
export function classifyBotActivity(
  primary: OperationalAwareness | null | undefined,
): BotActivity {
  if (!primary) return 'quiet';
  const state = mapSessionAwarenessToListAttentionState(primary);
  if (isUrgentSessionListAttentionState(state)) return 'needsYou';
  return state === 'thinking' ? 'working' : 'quiet';
}

/** The same reading from a loaded row (the rail holds rows, not row view models). */
export function readBotActivity(
  session: SessionListRenderableSession,
  nowMs: number,
): BotActivity {
  return classifyBotActivity(
    getSessionStatus(session, nowMs).awareness.operational.primary,
  );
}
