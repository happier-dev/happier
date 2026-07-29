import { createHash } from 'node:crypto';

import { hashOpenCodeDirectKeyAuthContent } from '../../auth/services/materialize/directKeyAuthHash.js';

export const OPENCODE_MANAGED_SERVER_STATE_PATH_ENV_KEY = 'HAPPIER_OPENCODE_SERVER_STATE_PATH';

/**
 * Env var carrying the STABLE connected-service selection identity that the managed-server launch
 * fingerprint keys on. Populated by the connected-services materializer alongside
 * `OPENCODE_AUTH_CONTENT`. It must encode the account/profile selection (provider id + connected
 * mode + service/account-or-group intent + request-auth plugin/config) and NOT rotating
 * access/refresh token bytes, so that a token refresh for the same account does NOT change the
 * fingerprint (and therefore does not churn the managed server). See
 * `resolveOpenCodeManagedServerStateFingerprintInput`.
 */
export const OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV = 'HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY';

/**
 * Optional env var carrying an explicit opencode binary identity (e.g. `version|path`) for the
 * launch fingerprint. When unset, the fingerprint folds in `HAPPIER_OPENCODE_PATH` (an explicit
 * binary override) so changing the binary path yields a new fingerprint.
 */
export const OPENCODE_BINARY_IDENTITY_ENV = 'HAPPIER_OPENCODE_BINARY_IDENTITY';

function readEnvString(env: NodeJS.ProcessEnv, key: string): string {
  return typeof env[key] === 'string' ? env[key] ?? '' : '';
}

function hashSecret(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return '';
  return createHash('sha256').update(raw).digest('hex');
}

function normalizeIdentityValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Compute the managed-server launch fingerprint INPUT: the stable selection identity that determines
 * whether a connected (or native) session may REUSE an existing managed `opencode serve` process.
 *
 * The fingerprint keys on a STABLE selection identity (provider/connected-mode/account/profile +
 * request-auth plugin + config isolation + XDG root + binary + server auth) and EXCLUDES rotating
 * access/refresh token values:
 * - `OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV`: the stable per-account identity emitted by
 *   the materializer. When present it REPLACES the rotating auth-content hash, so a same-account
 *   token rotation keeps the fingerprint unchanged.
 * - When NO selection identity is present (native sessions), the
 *   fingerprint falls back to hashing `OPENCODE_AUTH_CONTENT` so distinct stored credentials never
 *   collide. Native sessions have no `OPENCODE_AUTH_CONTENT`, so their auth-identity class is empty
 *   and never collides with connected sessions.
 * - `OPENCODE_BINARY_IDENTITY_ENV` (else `HAPPIER_OPENCODE_PATH`): changing the opencode binary
 *   yields a new fingerprint.
 * - `XDG_CONFIG_HOME` (set only for config-isolated connected sessions) + the server-auth
 *   credentials are part of the stable identity.
 *
 * NOTE: the runtime "generation key" (the specific process generation, which changes on every
 * managed start — see the generic host `managedServerPersistence`) is intentionally NOT part of this
 * fingerprint; that would defeat server reuse. The fingerprint governs REUSE; the generation key
 * tracks process IDENTITY across reuse.
 */
export function resolveOpenCodeManagedServerStateFingerprintInput(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  // Stable selection identity wins; otherwise fall back to the (rotating) auth-content hash so two
  // different stored credentials never collide. Native => no auth content => empty class.
  const selectionIdentity = normalizeIdentityValue(env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]);
  const authContentHash = hashSecret(env.OPENCODE_AUTH_CONTENT);
  const authIdentityClass = selectionIdentity
    ? `selection:${selectionIdentity}`
    : authContentHash
      ? `auth-content:${authContentHash}`
      : '';

  const openCodeBinaryIdentity = normalizeIdentityValue(
    env[OPENCODE_BINARY_IDENTITY_ENV] ?? env.HAPPIER_OPENCODE_PATH,
  );

  const directKeyAuthHash = hashOpenCodeDirectKeyAuthContent(env.OPENCODE_AUTH_CONTENT);

  return {
    HOME: readEnvString(env, 'HOME'),
    USERPROFILE: readEnvString(env, 'USERPROFILE'),
    HAPPIER_HOME_DIR: readEnvString(env, 'HAPPIER_HOME_DIR'),
    XDG_CONFIG_HOME: readEnvString(env, 'XDG_CONFIG_HOME'),
    XDG_DATA_HOME: readEnvString(env, 'XDG_DATA_HOME'),
    XDG_STATE_HOME: readEnvString(env, 'XDG_STATE_HOME'),
    XDG_CACHE_HOME: readEnvString(env, 'XDG_CACHE_HOME'),
    OPENCODE_CONFIG_CONTENT: readEnvString(env, 'OPENCODE_CONFIG_CONTENT'),
    authIdentityClass,
    directKeyAuthHash,
    openCodeBinaryIdentity,
    OPENAI_API_KEY: readEnvString(env, 'OPENAI_API_KEY'),
    ANTHROPIC_API_KEY: readEnvString(env, 'ANTHROPIC_API_KEY'),
    OPENCODE_SERVER_USERNAME: readEnvString(env, 'OPENCODE_SERVER_USERNAME'),
    OPENCODE_SERVER_PASSWORD: readEnvString(env, 'OPENCODE_SERVER_PASSWORD'),
  };
}

export function isOpenCodeManagedServerCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.includes('opencode') && normalized.includes('serve');
}
