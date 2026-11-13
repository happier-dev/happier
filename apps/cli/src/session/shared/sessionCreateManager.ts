import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { SessionManagerV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { SessionManagerV1 } from '@happier-dev/protocol';

export const HAPPIER_SESSION_CREATE_MANAGER_ENV_KEY = 'HAPPIER_SESSION_CREATE_MANAGER_V1_JSON';

/** A malformed host relation carrier fails before creation rather than silently creating a root. */
export function readSessionCreateManagerFromEnv(env: NodeJS.ProcessEnv = sessionProcessEnvironment()): SessionManagerV1 | undefined {
  const raw = env[HAPPIER_SESSION_CREATE_MANAGER_ENV_KEY];
  return raw === undefined ? undefined : SessionManagerV1Schema.parse(JSON.parse(raw));
}
