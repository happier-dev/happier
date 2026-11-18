import { readFile } from 'node:fs/promises';

import { resolveServerIdentityRecordPath } from '@happier-dev/cli-common/firstPartyRuntime/personalHome/layout';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

import { resolveStackOwnServerIdentityRecordPath } from '../stack/server_profile_reconciliation.mjs';
import {
  buildRemoteServerIdentityRecordCommand,
  resolveRemoteStackStatePaths,
} from './remote_commands.mjs';

async function readLocalRecord(recordPath) {
  try {
    return await readFile(recordPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * A shared-database stack's daemon host recognizes its own server's Home identity only from the
 * record at its own stack state path (Home readiness and `server set --home-identity-record`).
 * When the server runs on another host, the controller carries the record that server wrote to
 * that path over its existing SSH transport. Admission is unchanged: the daemon host still accepts
 * the identity only when the live server publishes it. `serverTarget: null` is a controller-local
 * server. Returns the carried identity, or null when the server has recorded none.
 */
export async function carryStackOwnServerIdentityRecord(
  { stackName, runtimeMode, env, serverTarget, daemonTarget, sshArgs = [] },
  { runProcess },
) {
  const runOn = async (target, serverIdentityId) => {
    const recordPath = resolveServerIdentityRecordPath(
      resolveRemoteStackStatePaths(target, { stackName, runtimeMode })
        .serverLightDataDir,
    );
    const result = await runProcess({
      label: `remote:${target.name}`,
      command: 'ssh',
      args: [
        ...sshArgs,
        '-o',
        'BatchMode=yes',
        target.ssh,
        buildRemoteServerIdentityRecordCommand(target, {
          recordPath,
          serverIdentityId,
        }),
      ],
      env,
      silent: true,
    });
    if (result?.code !== 0) {
      throw new Error(
        `[dev-targets] ${target.name} server identity record ${serverIdentityId ? 'write' : 'read'} failed (code=${String(result?.code ?? 'unknown')})`,
      );
    }
    return String(result.out ?? '');
  };
  const recorded = serverTarget
    ? await runOn(serverTarget, null)
    : await readLocalRecord(resolveStackOwnServerIdentityRecordPath(env));
  const serverIdentityId = normalizeServerIdentityIdCapability(recorded);
  if (!serverIdentityId) return null;
  await runOn(daemonTarget, serverIdentityId);
  return serverIdentityId;
}
