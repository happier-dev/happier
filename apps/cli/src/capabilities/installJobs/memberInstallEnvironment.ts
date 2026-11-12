import { join, posix, win32 } from 'node:path';
import { resolveWindowsSystemToolPath } from '@happier-dev/cli-common/process';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY, MANAGED_TOOLS_ROOT_ENV_KEY } from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';
import { resolveAgentLaunchNativeEnvironment } from '@/daemon/agentIsolation/agentLaunchRuntime';

/** Installers receive the native member's persistent roots, never daemon configuration. */
export function buildMemberAgentInstallEnvironment(home: string): Readonly<Record<string, string>> {
  return {
    HOME: home,
    PATH: buildMemberAgentExecutionPath({ HOME: home }),
    [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: join(home, '.happier'),
    [MANAGED_TOOLS_ROOT_ENV_KEY]: resolveManagedToolsRoot({ HOME: home }),
    ...resolveAgentLaunchNativeEnvironment(home),
  };
}

/** Native tools and the member's own bin directory, never an inherited daemon PATH. */
export function buildMemberAgentExecutionPath(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME || environment.USERPROFILE;
  let executionPath: string;
  if (process.platform === 'win32') {
    const systemTool = resolveWindowsSystemToolPath('taskkill.exe', environment);
    const powerShell = resolveWindowsSystemToolPath('powershell.exe', environment);
    executionPath = [home ? win32.join(home, '.local', 'bin') : undefined,
      systemTool ? win32.dirname(systemTool) : undefined,
      systemTool ? win32.dirname(win32.dirname(systemTool)) : undefined,
      powerShell ? win32.dirname(powerShell) : undefined].filter(Boolean).join(';');
  } else {
    executionPath = [home ? posix.join(home, '.local', 'bin') : undefined,
      '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
  }
  return executionPath;
}
