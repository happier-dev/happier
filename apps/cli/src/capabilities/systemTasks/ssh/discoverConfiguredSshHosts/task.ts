import {
  discoverConfiguredSshHosts,
  type DiscoveredSshHost,
} from '@happier-dev/cli-common/ssh';
import {
  SystemTaskExecutionError,
  type InteractiveSystemTaskKind,
} from '@happier-dev/cli-common/systemTasks';

export const DISCOVER_CONFIGURED_SSH_HOSTS_SYSTEM_TASK_KIND = 'local.ssh.discoverConfiguredHosts.v1' as const;

export function createDiscoverConfiguredSshHostsSystemTaskKind(
  options: Readonly<{ homeDir?: string }> = {},
): InteractiveSystemTaskKind<readonly DiscoveredSshHost[]> {
  return {
    run: async (ctx) => {
      assertNoParams(ctx.params);
      ctx.emit({
        type: 'progress',
        stepId: 'local.ssh.discoverConfiguredHosts',
        message: 'Discovering configured SSH hosts',
      });
      return await discoverConfiguredSshHosts({
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      });
    },
  };
}

function assertNoParams(params: unknown): void {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new SystemTaskExecutionError('invalid_params', 'SSH host discovery params must be an object.');
  }
  const keys = Object.keys(params);
  if (keys.length > 0) {
    throw new SystemTaskExecutionError('invalid_params', `Unsupported SSH host discovery param: ${keys[0] ?? 'unknown'}`);
  }
}
