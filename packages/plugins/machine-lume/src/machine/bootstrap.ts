import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { MachineProvisionersService } from '@happier-dev/plugin-sdk';
import type { MachineProvisionerBootstrapCarrierV1, MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectMachineProvisionerActionFailure, quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { LumeNativeClient } from './nativeClient.js';
import { LumeResourceV1Schema } from './schemas.js';
import { hardenMacosSshPasswordLogin } from './passwordPolicy.js';
import { observeLumeSshGuest, withLumeSshGuest, lumeProcessSucceeded as completed } from './sshGuest.js';

function refusal(code: string, nativeCause?: MachineProvisionerNativeCauseV1): never {
  throw new PluginError({ code, ...(nativeCause ? { details: { nativeCause } } : {}) });
}

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
  credentials: Pick<MachineProvisionersService, 'materializeBootstrapCredential' | 'establishSshHostTrust'>;
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
  const { carrier: observation, guestOs } = await observeLumeSshGuest(input);
  const carrier = { ...observation, credentialRef: input.credentialRef };
  const user = carrier.user;
  input.signal?.throwIfAborted();
  // Only the public key is sent as the remote command. It is idempotent on Retry. C50 owns the private key/reference lifetime.
  const command = `umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${quote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${quote(publicKey)} >> ~/.ssh/authorized_keys)`;
  await withLumeSshGuest({ exec: input.exec, carrier, signal: input.signal,
    establishSshHostTrust: observation => input.credentials.establishSshHostTrust(observation) }, async guest => {
    const lease = await input.credentials.materializeBootstrapCredential({ kind: 'file' });
    try {
      if (lease.kind !== 'file') refusal('credential_unavailable');
      const keyRequest = guest.keyRequest(lease.path);
      const proveKey = async () => {
        try { return completed(await input.exec.run({ ...keyRequest, args: [...keyRequest.args ?? [], 'true'] }, { signal: input.signal })); }
        catch (error) {
          input.signal?.throwIfAborted();
          return projectMachineProvisionerActionFailure(error, () => false);
        }
      };
      if (!await proveKey()) {
        const installed = await guest.runPassword(command);
        if (!completed(installed) || !await proveKey()) refusal('native_ssh_key_authentication_failed');
      }
      if (guestOs === 'macos' && resource.keepPasswordLogin !== true) {
        await hardenMacosSshPasswordLogin({ exec: input.exec, request: keyRequest, user, proveKey, signal: input.signal });
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof PluginError) throw error;
      return refusal('native_ssh_key_authentication_failed');
    } finally { await lease.dispose(); }
  });
  return carrier;
}
