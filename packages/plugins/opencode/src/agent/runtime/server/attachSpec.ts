import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';

/**
 * The settings field holding the `OPENCODE_SERVER_PASSWORD` of a server the
 * user runs themselves. It is deliberately unbound (no `perActiveServer`
 * binding): the companion `byServerId` field of such a binding is a plain
 * object setting that lands in synced account settings, and the daemon secret
 * writer keys by field id with no per-server dimension. One machine attaching
 * two differently-secured servers therefore shares this one slot — the
 * accepted consequence of keeping the credential out of synced storage.
 */
export const OPENCODE_SERVER_PASSWORD_SETTING_ID = 'opencodeServerPassword';

/**
 * OpenCode's Basic-auth middleware defaults the username to `opencode` and is
 * enabled solely by the password environment variable, so an attached server
 * expects exactly this username — the same one the owned-spawn spec uses.
 */
export const OPENCODE_SERVER_BASIC_USERNAME = 'opencode';

/**
 * The one specification for a `opencode serve` process Happier does *not* own.
 *
 * Session attach and External Sessions browse attach both build their service
 * from here, so there is a single answer to "how does Happier reach an
 * OpenCode server": a `ManagedServiceSpec` supervised by the managed-services
 * owner, with the host resolving and applying the credential. When no password
 * is recorded the host resolves nothing and the attach is unauthenticated,
 * which is the pre-existing behavior for an unsecured server.
 *
 * `baseUrl` is whatever address the user declared — any host, `http:` or
 * `https:`. Only the loopback endpoints Happier allocates for servers it spawns
 * itself are pinned to this machine.
 */
export function buildOpenCodeManagedServerAttachSpec(params: Readonly<{
  id: string;
  baseUrl: string;
}>): ManagedServiceSpec {
  return {
    id: params.id,
    mode: {
      kind: 'attach',
      baseUrl: params.baseUrl,
    },
    healthCheck: {
      kind: 'http',
      target: { kind: 'servicePath', path: '/global/health' },
      timeoutMs: 5_000,
    },
    healthPolicy: {
      intervalMs: 10_000,
      consecutiveFailures: 3,
    },
    // A password-protected OpenCode server answers `/global/health` with 401
    // exactly like `/session`, so the probe has to carry the credential too or
    // the service can never become healthy.
    clientAccess: {
      kind: 'declaredSecretBasic',
      username: OPENCODE_SERVER_BASIC_USERNAME,
      passwordSecretId: OPENCODE_SERVER_PASSWORD_SETTING_ID,
    },
    startupTimeoutMs: 30_000,
  };
}
