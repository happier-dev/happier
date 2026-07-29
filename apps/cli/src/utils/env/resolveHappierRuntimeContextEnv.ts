/**
 * Single source of truth for the non-secret Happier runtime-context environment
 * variables that must be made *explicit* for child processes.
 *
 * These values are authoritative: they describe which Happier home directory and
 * which server a child process should use. They are derived from an explicit,
 * already-resolved selection (the process's resolved `configuration`) rather than
 * relying on whatever a parent happened to inherit. Consumers should let these
 * OVERRIDE inherited env for the same keys.
 *
 * Used by:
 * - the shell-bridge command policy when HAPPIER_SHELL_BRIDGE_CONTEXT_ENV opts in
 *   to command-local context env for environments with stale shell startup exports
 *
 * NO secrets (access/refresh tokens, API keys, credential file contents) belong
 * here. Only home dir, active server id, daemon lifecycle scope, and resolved server/webapp URLs.
 */

export type HappierRuntimeServerContext = Readonly<{
  activeServerId: string;
  /** Canonical / public-facing server URL. */
  canonicalServerUrl: string;
  /** API / local server URL (equals canonical unless it is a split local/public stack). */
  apiServerUrl: string;
  webappUrl: string;
}>;

export type ResolveHappierRuntimeContextEnvInput = Readonly<{
  homeDir?: string | null;
  daemonLifecycleScopeId?: string | null;
  server?: HappierRuntimeServerContext | null;
}>;

/**
 * Canonical Happier runtime-context env keys, in a stable order. Useful for
 * callers that need to clear stale inherited values before applying the
 * authoritative selection.
 */
export const HAPPIER_RUNTIME_CONTEXT_ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
] as const;

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the canonical map of Happier context env vars to SET.
 *
 * Keys that are not returned should be treated as absent by the caller: for a
 * non-split stack (api URL equals canonical URL) `HAPPIER_LOCAL_SERVER_URL` and
 * `HAPPIER_PUBLIC_SERVER_URL` are intentionally omitted, and any stale inherited
 * values for them should be cleared by the caller.
 *
 * A split stack points children at the local API while keeping the public URL
 * available for link/QR generation.
 */
export function resolveHappierRuntimeContextEnv(
  input: ResolveHappierRuntimeContextEnvInput,
): Record<string, string> {
  const out: Record<string, string> = {};

  const homeDir = nonEmpty(input.homeDir);
  if (homeDir) out.HAPPIER_HOME_DIR = homeDir;

  const daemonLifecycleScopeId = nonEmpty(input.daemonLifecycleScopeId);
  if (daemonLifecycleScopeId) out.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = daemonLifecycleScopeId;

  const server = input.server;
  if (server) {
    const activeServerId = nonEmpty(server.activeServerId);
    if (activeServerId) out.HAPPIER_ACTIVE_SERVER_ID = activeServerId;

    const canonical = nonEmpty(server.canonicalServerUrl);
    const api = nonEmpty(server.apiServerUrl);

    if (canonical && api && api !== canonical) {
      out.HAPPIER_PUBLIC_SERVER_URL = canonical;
      out.HAPPIER_LOCAL_SERVER_URL = api;
      out.HAPPIER_SERVER_URL = api;
    } else if (canonical) {
      out.HAPPIER_SERVER_URL = canonical;
    } else if (api) {
      out.HAPPIER_SERVER_URL = api;
    }

    const webapp = nonEmpty(server.webappUrl);
    if (webapp) out.HAPPIER_WEBAPP_URL = webapp;
  }

  return out;
}
