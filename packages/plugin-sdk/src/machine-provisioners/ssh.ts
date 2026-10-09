/** @moduleRealm daemon */
import { buildSshKeyscanInvocation } from '@happier-dev/cli-common/ssh';
import { extractFirstScannedSshKnownHostLine } from '@happier-dev/cli-common/systemTasks';
import type { ExecService } from '../exec.js';
import type { MachineProvisionerBootstrapCarrierV1 } from '../machineProvisioners.js';
// Public leaves observe evidence; the canonical host task owns trust,
// replacement approval and known-host persistence.

/** Observe a key; trust, replacement approval and installation remain host-owned. */
export async function resolveMachineProvisionerSshBootstrap(input: Readonly<{
    exec: ExecService;
    connection: Readonly<{ address: string; user: string; port?: number }>;
    credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }>;
    signal?: AbortSignal;
}>): Promise<MachineProvisionerBootstrapCarrierV1> {
    if (!input.credentialRef) throw new Error('credential_unavailable');
    const invocation = buildSshKeyscanInvocation({ host: input.connection.address, port: input.connection.port, keyType: 'ed25519' });
    const scanner = await input.exec.systemTools.resolve({ toolId: 'ssh-keyscan', purpose: 'Observe the exact managed guest host key', signal: input.signal });
    const result = await input.exec.run({ executable: scanner.executable, args: invocation.args }, { signal: input.signal });
    if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0
        || result.termination.requestedBy.kind !== 'none' || result.stdoutTruncated || result.stderrTruncated) throw new Error('provider_unavailable');
    const key = extractFirstScannedSshKnownHostLine(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout));
    return { kind: 'ssh', ...input.connection, hostKeyEvidence: { hostKey: key.line, fingerprint: key.fingerprint }, credentialRef: input.credentialRef };
}
