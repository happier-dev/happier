import { SessionRolesV1Schema } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import type { SessionRolesV1 } from '@happier-dev/protocol';

export const HAPPIER_SESSION_CREATE_ROLES_ENV_KEY = 'HAPPIER_SESSION_CREATE_ROLES_V1_JSON';

/** Fresh creation only; malformed host content never becomes an unconfigured worker. */
export function readSessionCreateRolesFromEnv(env: NodeJS.ProcessEnv = process.env): SessionRolesV1 | undefined {
  const raw = env[HAPPIER_SESSION_CREATE_ROLES_ENV_KEY];
  return raw === undefined ? undefined : SessionRolesV1Schema.parse(JSON.parse(raw));
}
