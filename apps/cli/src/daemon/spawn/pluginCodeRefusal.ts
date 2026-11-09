import type { MachineTargetV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1';
import { PluginCodeUnreadableError } from '@/plugins/runtime/moduleFailure';

/** Present the admitted requester's existing setup route; never perform setup or re-authorize. */
export function projectPluginCodeRefusal(error: unknown, requester: Readonly<{
  platform: NodeJS.Platform;
  role?: 'use' | 'manage';
  target?: MachineTargetV1;
}>): SessionSpawnLaunchErrorV1 | undefined {
  if (!(error instanceof PluginCodeUnreadableError) || requester.platform !== 'linux') return undefined;
  return { kind: 'launch_error', code: error.code, message: error.message,
    pluginCodeRefusal: { remedy: requester.role === 'manage' && requester.target
      ? { kind: 'open_machine_security', target: { serverId: requester.target.serverId, machineId: requester.target.machineId } }
      : { kind: 'ask_machine_manager' } } };
}
