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
 * `baseUrl` is the address the user declared, already admitted by the shared
 * managed-service endpoint policy (`readManagedServiceEndpointUrl` with
 * `userDeclaredAttach`, which the managed-services owner re-applies before it
 * dials): `https:` reaches any host, plain `http:` stays on the same loopback
 * names as a server Happier spawns itself, and a URL carrying embedded
 * credentials is refused outright so the secret never rides the address into a
 * service id, a snapshot or a log. That policy has ONE owner; this builder does
 * not restate it.
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
