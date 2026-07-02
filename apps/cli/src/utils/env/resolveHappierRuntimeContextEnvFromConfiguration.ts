import { configuration } from '@/configuration';

import {
  resolveHappierRuntimeContextEnv,
} from '@/utils/env/resolveHappierRuntimeContextEnv';

/**
 * Resolve the authoritative Happier runtime-context env from the process's
 * resolved `configuration` singleton.
 *
 * This is the value injected into every coding-agent subprocess at the spawn
 * seam (see `createProviderAcpRuntime` → `createCatalogRuntimeBackend`) so that
 * shell-bridge `happier tools` invocations — and their child CLI process — read
 * credentials from the correct home dir and talk to the correct server
 * regardless of what the agent's shell tool happens to inherit.
 *
 * `configuration` has already merged env overrides with persisted server
 * selection, so this is the single resolved view; consumers do not re-resolve.
 */
export function resolveHappierRuntimeContextEnvFromConfiguration(): Record<string, string> {
  return resolveHappierRuntimeContextEnv({
    homeDir: configuration.happyHomeDir,
    server: {
      activeServerId: configuration.activeServerId,
      canonicalServerUrl: configuration.serverUrl,
      apiServerUrl: configuration.apiServerUrl,
      webappUrl: configuration.webappUrl,
    },
  });
}
