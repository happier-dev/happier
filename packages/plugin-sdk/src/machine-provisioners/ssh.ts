/** @moduleRealm any */
import { buildSshKeyscanInvocation } from '@happier-dev/cli-common/ssh/keyscanInvocation';
import { extractFirstScannedSshKnownHostLine } from '@happier-dev/cli-common/systemTasks/kinds/sshKnownHostLine';
import type { ExecService } from '../exec.js';
import { isPluginError, PluginError } from '../errors.js';
import type { MachineProvisionerBootstrapCarrierV1 } from '../machineProvisioners.js';
// Public leaves observe evidence; the canonical host task owns trust,
// replacement approval and known-host persistence.

export { buildMachineProvisionerCloudInit, MACHINE_PROVISIONER_CLOUD_SSH_USER } from './cloudInit.js';

type SshBootstrapCarrier = Extract<MachineProvisionerBootstrapCarrierV1, { kind: 'ssh' }>;
type ObservedSshBootstrapCarrier = SshBootstrapCarrier & Readonly<{
    hostKeyEvidence: NonNullable<SshBootstrapCarrier['hostKeyEvidence']>;
}>;
type SshBootstrapInput = Readonly<{
    exec?: ExecService;
    connection: Readonly<{ address: string; user: string; port?: number }>;
    credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }>;
    signal?: AbortSignal;
}>;

export function resolveMachineProvisionerSshBootstrap(input: SshBootstrapInput & Readonly<{ exec: ExecService }>): Promise<ObservedSshBootstrapCarrier>;
export function resolveMachineProvisionerSshBootstrap(input: SshBootstrapInput): Promise<SshBootstrapCarrier>;
/** Observe on daemon hosts; native hosts retain their existing first-connect trust prompt. */
export async function resolveMachineProvisionerSshBootstrap(input: SshBootstrapInput): Promise<SshBootstrapCarrier> {
    if (!input.credentialRef) throw new PluginError({ code: 'credential_unavailable' });
    input.signal?.throwIfAborted();
    if (!input.exec) return { kind: 'ssh', ...input.connection, credentialRef: input.credentialRef };
    try {
        const invocation = buildSshKeyscanInvocation({ host: input.connection.address, port: input.connection.port, keyType: 'ed25519' });
        input.signal?.throwIfAborted();
        const scanner = await input.exec.systemTools.resolve({ toolId: 'ssh-keyscan', purpose: 'Observe the exact managed guest host key', signal: input.signal });
        const result = await input.exec.run({ executable: scanner.executable, args: invocation.args }, { signal: input.signal });
        input.signal?.throwIfAborted();
        if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0
            || result.termination.requestedBy.kind !== 'none' || result.stdoutTruncated || result.stderrTruncated) {
            throw new PluginError({ code: 'native_ssh_host_key_unavailable' });
        }
        const key = extractFirstScannedSshKnownHostLine(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout));
        return { kind: 'ssh', ...input.connection, hostKeyEvidence: { hostKey: key.line, fingerprint: key.fingerprint }, credentialRef: input.credentialRef };
    } catch (error) {
        input.signal?.throwIfAborted();
        if (isPluginError(error)) throw error;
        throw new PluginError({ code: 'native_ssh_host_key_unavailable' });
    }
}
