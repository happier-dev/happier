import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ExecService, PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { MachineProvisionerBootstrapCarrierV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { LUME_DEFAULT_LOGIN, LumeResourceV1Schema } from './schemas.js';
import type { LumeNativeClient } from './nativeClient.js';

export type LumeSshHost = Omit<Extract<MachineProvisionerBootstrapCarrierV1, { kind: 'ssh' }>, 'credentialRef'> & {
  hostKeyEvidence: NonNullable<Extract<MachineProvisionerBootstrapCarrierV1, { kind: 'ssh' }>['hostKeyEvidence']>;
};
export function lumeProcessSucceeded(result: PluginProcessResult) {
  return result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
    && result.termination.requestedBy.kind === 'none' && !result.stdoutTruncated && !result.stderrTruncated;
}

export async function observeLumeSshGuest(input: Readonly<{
  native: LumeNativeClient; exec: ExecService; resource: unknown; signal?: AbortSignal;
}>) {
  const resource = LumeResourceV1Schema.parse(input.resource);
  const connection = await input.native.connection({ storage: resource.storage, vmName: resource.vmName }, input.signal);
  if (connection.kind === 'pending') throw new PluginError({ code: 'native_not_ready' });
  if (connection.kind !== 'connection') throw new PluginError({
    code: connection.kind === 'unavailable' ? 'native_resource_unavailable' : 'provider_unavailable',
    ...('nativeCause' in connection && connection.nativeCause ? { details: { nativeCause: connection.nativeCause } } : {}),
  });
  const guestOs = connection.guestOs.toLowerCase();
  if (isIP(connection.address) === 0 || guestOs !== (resource.privateCarrier?.guestOs ?? 'macos')) {
    throw new PluginError({ code: 'provider_unavailable' });
  }
  const { observeMachineProvisionerSshHost } = await import('@happier-dev/plugin-sdk/machine-provisioners/ssh');
  const carrier = await observeMachineProvisionerSshHost({ exec: input.exec, signal: input.signal,
    connection: { address: connection.address, user: resource.privateCarrier?.user ?? LUME_DEFAULT_LOGIN.user, port: 22 } });
  return { carrier, guestOs };
}

/** Both cold Prepare and per-clone enrollment use the same approved host pin.
 * Only the vendor's published image login enters the temporary askpass environment.
 * No account key, enrollment credential or private SSH key enters a base image.
 */
export async function withLumeSshGuest<T>(input: Readonly<{
  exec: ExecService; carrier: LumeSshHost; signal?: AbortSignal;
  establishSshHostTrust(carrier: LumeSshHost): Promise<void>;
}>, effect: (guest: Readonly<{
  keyRequest(path: string): PluginExecSpawnRequest;
  runPassword(command: string, stdin?: Uint8Array): Promise<PluginProcessResult>;
}>) => Promise<T>): Promise<T> {
  input.signal?.throwIfAborted();
  await input.establishSshHostTrust(input.carrier);
  input.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'happier-lume-ssh-'));
  try {
    const askpass = join(directory, 'askpass.sh');
    const knownHosts = join(directory, 'known_hosts');
    await writeFile(knownHosts, `${input.carrier.hostKeyEvidence.hostKey}\n`, { mode: 0o600 });
    const ssh = await input.exec.systemTools.resolve({ toolId: 'ssh', purpose: 'Access the approved managed Lume guest', signal: input.signal });
    const common = ['-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'LogLevel=ERROR'];
    const target = ['-p', String(input.carrier.port ?? 22), '--', `${input.carrier.user}@${input.carrier.address}`];
    return await effect({
      keyRequest: path => ({ executable: ssh.executable, args: [...common,
        '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no',
        '-o', 'KbdInteractiveAuthentication=no', '-o', 'IdentitiesOnly=yes', '-i', path, ...target] }),
      runPassword: async (command, stdin) => {
        await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$HAPPIER_LUME_GUEST_PASSWORD"\n', { mode: 0o700 });
        return input.exec.run({ executable: ssh.executable, args: [...common,
          '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', ...target, command],
          env: { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY ?? ':0',
            HAPPIER_LUME_GUEST_PASSWORD: LUME_DEFAULT_LOGIN.password }, ...(stdin ? { stdin } : {}) }, { signal: input.signal });
      },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
