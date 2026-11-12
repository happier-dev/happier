import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { MachineProvisionersService } from '@happier-dev/plugin-sdk';
import type { MachineProvisionerBootstrapCarrierV1, MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import type { LumeNativeClient } from './nativeClient.js';
import { LUME_DEFAULT_LOGIN, LumeResourceV1Schema } from './schemas.js';
import { hardenMacosSshPasswordLogin } from './passwordPolicy.js';

function refusal(code: string, nativeCause?: MachineProvisionerNativeCauseV1): never {
  throw new PluginError({ code, ...(nativeCause ? { details: { nativeCause } } : {}) });
}
function completed(result: PluginProcessResult) {
  return result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
    && result.termination.requestedBy.kind === 'none' && !result.stdoutTruncated && !result.stderrTruncated;
}
const PASSWORD_ENV = 'HAPPIER_LUME_GUEST_PASSWORD';
function quote(value: string) { return `'${value.replace(/'/gu, "'\\''")}'`; }

/** Public-key preparation and transport evidence, never an SSH installer.
 * Run state and the guest address come only from the serve API
 * (`native.connection`). The vendor `lume ssh` command is not used: it
 * re-derives run state with a 2 s `lsof` probe that misreports "not running" on
 * hosts with slow network mounts. The guest is reached with plain `ssh` as the
 * image's published default login (or the explicitly prepared account).
 * Lume 0.6.1 accepted any host key; this pins the key observed by ssh-keyscan
 * (StrictHostKeyChecking=yes against a private known_hosts), which is stricter.
 * The password travels only in the child environment, read by a private,
 * secret-free askpass script; the private temp directory is removed afterwards.
 * A host-owned file lease supplies the retained key for fresh key-only proofs.
 * macOS password SSH is disabled only after the first successful key proof.
 */
export async function resolveLumeBootstrap(input: Readonly<{
  native: LumeNativeClient; exec: ExecService;
  credentials: Pick<MachineProvisionersService, 'materializeBootstrapCredential'>;
  resource: unknown; bootstrapPublicKey?: string;
  credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }>;
  signal?: AbortSignal;
}>): Promise<MachineProvisionerBootstrapCarrierV1> {
  const resource = LumeResourceV1Schema.parse(input.resource);
  const publicKey = input.bootstrapPublicKey;
  if (!input.credentialRef || !publicKey
    || !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n\u0000]+)?$/u.test(publicKey)) {
    refusal('credential_unavailable');
  }
  const connection = await input.native.connection({ storage: resource.storage, vmName: resource.vmName }, input.signal);
  if (connection.kind === 'pending') refusal('native_not_ready');
  if (connection.kind === 'unavailable') refusal('native_resource_unavailable', connection.nativeCause);
  if (connection.kind !== 'connection') refusal('provider_unavailable', 'nativeCause' in connection ? connection.nativeCause : undefined);
  if (isIP(connection.address) === 0) refusal('provider_unavailable');
  const guestOs = connection.guestOs.toLowerCase();
  if (guestOs !== (resource.privateCarrier?.guestOs ?? 'macos')) refusal('provider_unavailable');
  const user = resource.privateCarrier?.user ?? LUME_DEFAULT_LOGIN.user;
  input.signal?.throwIfAborted();
  const carrier = await resolveMachineProvisionerSshBootstrap({ exec: input.exec,
    connection: { address: connection.address, user, port: 22 }, credentialRef: input.credentialRef, signal: input.signal });
  input.signal?.throwIfAborted();
  // Only the public key is sent as the remote command. It is idempotent on Retry. C50 owns the private key/reference lifetime.
  const command = `umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${quote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${quote(publicKey)} >> ~/.ssh/authorized_keys)`;
  const directory = await mkdtemp(join(tmpdir(), 'happier-lume-ssh-'));
  let lease: Awaited<ReturnType<MachineProvisionersService['materializeBootstrapCredential']>> | undefined;
  try {
    const askpass = join(directory, 'askpass.sh');
    const knownHosts = join(directory, 'known_hosts');
    await writeFile(knownHosts, `${carrier.hostKeyEvidence.hostKey}\n`, { mode: 0o600 });
    lease = await input.credentials.materializeBootstrapCredential({ kind: 'file' });
    if (lease.kind !== 'file') refusal('credential_unavailable');
    const ssh = await input.exec.systemTools.resolve({ toolId: 'ssh', purpose: 'Prepare key-only SSH in the managed guest', signal: input.signal });
    const common = ['-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'LogLevel=ERROR'];
    const target = ['-p', '22', '--', `${user}@${connection.address}`];
    const keyRequest = { executable: ssh.executable, args: [...common,
      '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no', '-o', 'IdentitiesOnly=yes', '-i', lease.path, ...target] };
    const proveKey = async () => {
      try { return completed(await input.exec.run({ ...keyRequest, args: [...keyRequest.args, 'true'] }, { signal: input.signal })); }
      catch (error) {
        input.signal?.throwIfAborted();
        return projectMachineProvisionerActionFailure(error, () => false);
      }
    };
    if (!await proveKey()) {
      await writeFile(askpass, `#!/bin/sh\nprintf '%s\\n' "$${PASSWORD_ENV}"\n`, { mode: 0o700 });
      const installed = await input.exec.run({ executable: ssh.executable,
        args: [...common, '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no',
          '-o', 'NumberOfPasswordPrompts=1', ...target, command],
        env: { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY ?? ':0', [PASSWORD_ENV]: LUME_DEFAULT_LOGIN.password } },
      { signal: input.signal });
      if (!completed(installed) || !await proveKey()) refusal('native_ssh_key_authentication_failed');
    }
    if (guestOs === 'macos' && resource.keepPasswordLogin !== true) {
      await hardenMacosSshPasswordLogin({ exec: input.exec, request: keyRequest, user, proveKey, signal: input.signal });
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof PluginError) throw error;
    return refusal('native_ssh_key_authentication_failed');
  } finally {
    try { await lease?.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  return carrier;
}
