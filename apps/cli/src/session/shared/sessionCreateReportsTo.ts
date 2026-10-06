import { SessionReportsToV1Schema } from '@happier-dev/protocol/sessions/relations/sessionReportsToV1';
import type { SessionReportsToV1 } from '@happier-dev/protocol';

export const HAPPIER_SESSION_CREATE_REPORTS_TO_ENV_KEY = 'HAPPIER_SESSION_CREATE_REPORTS_TO_V1_JSON';

/** A malformed host relation carrier fails before creation rather than silently creating a root. */
export function readSessionCreateReportsToFromEnv(env: NodeJS.ProcessEnv = process.env): SessionReportsToV1 | undefined {
  const raw = env[HAPPIER_SESSION_CREATE_REPORTS_TO_ENV_KEY];
  return raw === undefined ? undefined : SessionReportsToV1Schema.parse(JSON.parse(raw));
}
