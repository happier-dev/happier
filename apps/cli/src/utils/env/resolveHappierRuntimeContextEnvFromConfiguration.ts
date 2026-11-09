import { configuration } from '@/configuration';

import {
  resolveHappierRuntimeContextEnv,
} from '@/utils/env/resolveHappierRuntimeContextEnv';

/**
 * Resolve the authoritative Happier runtime-context env from the process's
 * resolved `configuration` singleton.
 *
 * Managed CLI integrations and opt-in current-user Windows shell bridges use
 * this explicit Home/server selection. POSIX Agent tool bridges consume the
 * admitted Session MCP reference without reading custodian Account credentials.
 *
 * `configuration` has already merged env overrides with persisted server
 * selection, so this is the single resolved view; consumers do not re-resolve.
 */
export function resolveHappierRuntimeContextEnvFromConfiguration(): Record<string, string> {
  return resolveHappierRuntimeContextEnv({
    homeDir: configuration.happyHomeDir,
    daemonLifecycleScopeId:
      String(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? '').trim()
      || configuration.activeServerId,
    server: {
      activeServerId: configuration.activeServerId,
      canonicalServerUrl: configuration.serverUrl,
      apiServerUrl: configuration.apiServerUrl,
      webappUrl: configuration.webappUrl,
    },
  });
}
