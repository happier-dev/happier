import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { ExecService, PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { MachineProvisionerBootstrapCarrierV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { LumeNativeClient } from './nativeClient.js';
import { LumeResourceV1Schema } from './schemas.js';

function refusal(code: string): never {
  throw Object.assign(new Error('Lume private bootstrap unavailable'), { code });
}
function completed(result: PluginProcessResult) {
  return result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
    && result.termination.requestedBy.kind === 'none' && !result.stdoutTruncated && !result.stderrTruncated;
}
function quote(value: string) { return `'${value.replace(/'/gu, "'\\''")}'`; }

/** Public-key preparation and transport evidence, never an SSH installer.
 * Pinned Lume0.6.1 Commands/SSH.swift authenticates the native default `lume`
 * account, or the explicitly selected account, and checks exact storage/name +
 * running/SSH availability. Canonical macOS images use the native default;
 * custom images explicitly declare their prepared account and guest OS.
 * No password override, private key or enrollment bytes enter this process.
 */
export async function resolveLumeBootstrap(input: Readonly<{
  native: LumeNativeClient; exec: Pick<ExecService, 'run'>;
  executable: PluginExecSpawnRequest['executable']; scanner: PluginExecSpawnRequest['executable'];
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
  if (connection.kind !== 'connection' || isIP(connection.address) === 0) refusal('provider_unavailable');
  const guestOs = connection.guestOs.toLowerCase();
  if (guestOs !== (resource.privateCarrier?.guestOs ?? 'macos')) refusal('provider_unavailable');
  const user = resource.privateCarrier?.user ?? 'lume';
  input.signal?.throwIfAborted();
  let scan: PluginProcessResult;
  try {
    scan = await input.exec.run({ executable: input.scanner, args: ['-t', 'ed25519', connection.address] }, { signal: input.signal });
  } catch { return refusal('provider_unavailable'); }
  if (!completed(scan)) refusal('provider_unavailable');
  let lines: string[];
  try { lines = new TextDecoder('utf-8', { fatal: true }).decode(scan.stdout).split(/\r?\n/u); }
  catch { return refusal('provider_unavailable'); }
  const matching = lines.map(line => line.trim().split(/\s+/u))
    .filter(parts => parts.length === 3 && parts[0] === connection.address && parts[1] === 'ssh-ed25519'
      && /^[A-Za-z0-9+/]+={0,2}$/u.test(parts[2]));
  const keys = [...new Set(matching.map(parts => `${parts[1]} ${parts[2]}`))];
  if (keys.length !== 1) refusal('provider_unavailable');
  const hostKey = keys[0];
  const encoded = hostKey.split(' ')[1];
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) refusal('provider_unavailable');
  const fingerprint = `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/u, '')}`;
  // Only the public key is sent via the vendor's joined command argument. This
  // command is idempotent on Retry. C50 owns the private key/reference lifetime.
  const command = `umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${quote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${quote(publicKey)} >> ~/.ssh/authorized_keys)`;
  let installed: PluginProcessResult;
  try {
    installed = await input.exec.run({ executable: input.executable,
      args: ['ssh', resource.vmName, '--storage', resource.storage,
        ...(resource.privateCarrier ? ['--user', user] : []), '--timeout', '0', command] }, { signal: input.signal });
  } catch { return refusal('provider_unavailable'); }
  if (!completed(installed)) refusal('provider_unavailable');
  return { kind: 'ssh', address: connection.address, user, port: 22,
    hostKeyEvidence: { hostKey, fingerprint }, credentialRef: input.credentialRef };
}
