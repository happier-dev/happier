import { systemTasks } from '@happier-dev/cli-common';
import { SSH_TUNNEL_SYSTEM_TASK_KIND_IDS } from '@happier-dev/protocol/ssh/tunnels';
import { SYSTEM_TASK_PROTOCOL_VERSION, SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';
import { runLocalHappierJsonCommand } from '../happierCli.js';

/** The installed CLI owns tunnel tasks and daemon selection; hsetup only bridges the process boundary. */
export function createDaemonSshTunnelRegistryEntries(): systemTasks.SystemTaskRegistryEntry[] {
  return SSH_TUNNEL_SYSTEM_TASK_KIND_IDS.map((kind) => ({
    kind,
    handler: systemTasks.createExecutionRunnerFromKind({
      async run(ctx) {
        const result = SystemTaskResultSchema.parse(await runLocalHappierJsonCommand({
          args: ['daemon', 'system-task', '--json'],
          stdinText: JSON.stringify({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, kind, params: ctx.params }),
          signal: ctx.signal,
          allowJsonFailure: true,
        }));
        if (!result.ok) throw new systemTasks.SystemTaskExecutionError(result.error.code, result.error.message);
        return result.data ?? null;
      },
    }),
  }));
}
