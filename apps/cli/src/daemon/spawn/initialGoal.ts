import { SessionInitialGoalRequestV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import type { SessionInitialGoalRequestV1 } from '@happier-dev/protocol';

export const HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY = 'HAPPIER_DAEMON_INITIAL_GOAL';

export function serializeInitialGoalForEnv(goal: SessionInitialGoalRequestV1): string {
  return JSON.stringify(SessionInitialGoalRequestV1Schema.parse(goal));
}

export function readInitialGoalFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SessionInitialGoalRequestV1 | null {
  const raw = env[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY];
  if (raw === undefined) return null;
  try {
    return SessionInitialGoalRequestV1Schema.parse(JSON.parse(raw) as unknown);
  } catch {
    throw new Error('Initial goal handoff is malformed');
  }
}

export function clearInitialGoalFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY];
}
