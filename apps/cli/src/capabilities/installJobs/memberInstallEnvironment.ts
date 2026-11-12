import { join } from 'node:path';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY, MANAGED_TOOLS_ROOT_ENV_KEY } from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';
import { resolveAgentLaunchNativeEnvironment } from '@/daemon/agentIsolation/agentLaunchRuntime';

/** Installers receive the native member's persistent roots, never daemon configuration. */
export function buildMemberAgentInstallEnvironment(home: string): Readonly<Record<string, string>> {
  return {
    HOME: home,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: join(home, '.happier'),
    [MANAGED_TOOLS_ROOT_ENV_KEY]: resolveManagedToolsRoot({ HOME: home }),
    ...resolveAgentLaunchNativeEnvironment(home),
  };
}
