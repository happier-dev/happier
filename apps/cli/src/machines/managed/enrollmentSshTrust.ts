import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSshKnownHostLine, persistSshKnownHostTrust, resolveSshKnownHostTrust, SystemTaskExecutionError, type InteractiveSystemTaskContext } from '@happier-dev/cli-common/systemTasks';
import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedBootstrapCarrierV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { configuration } from '@/configuration';
import { readManagedSshTrustedHostKey, resolveSshBootstrapHostKeyPin, settleRemoteSshHostTrust } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { createManagedBootstrapTaskRunner } from './enrollmentTask';

type SshHost = Readonly<Omit<Extract<ManagedBootstrapCarrierV1, { kind: 'ssh' }>, 'credentialRef'>>;
type SshTrustIdentity = Pick<ManagedEnrollmentCorrelationV1, 'homeId' | 'managedId'>
    | Readonly<{ homeId: string; presetId: string; operationId: string }>;

/** Resource acquisition owns first-use trust through the same managed operation question as enrollment. */
export async function runManagedSessionSshTrust(input: Readonly<{
    correlation: ManagedEnrollmentCorrelationV1;
    carrier: ManagedBootstrapCarrierV1 | SshHost;
    guestHostPublicKey?: string;
    operationId?: string;
    /** Only delegated Account enrollment uses Home's requester response authorization. */
    requesterEnrollmentAccountId?: string;
}> & Omit<Parameters<typeof createManagedBootstrapTaskRunner>[0], 'readResponseOwner'>): Promise<void> {
    if (input.carrier.kind !== 'ssh') return;
    const carrier = input.carrier;
    const trustedHostKey = readManagedSshTrustedHostKey(carrier, input.guestHostPublicKey);
    const taskRunner = createManagedBootstrapTaskRunner({ ...input, readResponseOwner: () => input.operationId && input.requesterEnrollmentAccountId ? {
        correlation: input.correlation, operationId: input.operationId, readTaskId: taskRunner.readTaskId,
    } : undefined });
    await taskRunner.run({ run: async ctx => {
        ctx.emit({ type: 'progress', stepId: 'ssh.trust', message: 'Verifying SSH host trust' });
        const resolution = await resolveManagedSshHostTrust({ ...input, carrier, trustedHostKey, signal: ctx.signal });
        await settleRemoteSshHostTrust(ctx, resolution);
        return { trusted: true };
    } });
}

/** The admitted resource or preparation operation, rather than its reusable network address, owns trust. */
export async function resolveManagedEnrollmentSshTrust(input: Readonly<{
    correlation: SshTrustIdentity;
    carrier: SshHost;
    trustedHostKey?: string;
}>): Promise<Readonly<{ knownHostsPath: string; trustedHostKey?: string }>> {
    const owner = input.correlation;
    const identity = createHash('sha256').update(JSON.stringify('managedId' in owner
        ? [owner.homeId, owner.managedId] : [owner.homeId, 'preset', owner.presetId, owner.operationId])).digest('hex');
    const knownHostsPath = join(configuration.happyHomeDir, 'ssh', 'managed', identity, 'known_hosts');
    let text: string;
    try { text = await readFile(knownHostsPath, 'utf8'); }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return { knownHostsPath, ...(input.trustedHostKey === undefined ? {} : { trustedHostKey: input.trustedHostKey }) };
        }
        throw error;
    }
    const saved = text.split(/\r?\n/u).map(parseSshKnownHostLine).find(entry => entry !== null);
    if (!saved) throw new SystemTaskExecutionError('invalid_trusted_host_key', 'The managed resource host key is invalid.');
    // A resource can move to another address; its approved key stays pinned.
    const host = input.carrier.port && input.carrier.port !== 22
        ? `[${input.carrier.address}]:${input.carrier.port}` : input.carrier.address;
    const trustedHostKey = `${host} ${saved.keyType} ${saved.key}`;
    if (input.trustedHostKey !== undefined) {
        const trust = resolveSshKnownHostTrust({ scannedHostKeyLine: trustedHostKey, trustedHostKey: input.trustedHostKey });
        if (trust.status === 'rejected') {
            throw new SystemTaskExecutionError(trust.reason === 'invalidTrustedHostKey' ? 'invalid_trusted_host_key' : 'trusted_host_key_mismatch',
                'The retained credential does not match the managed resource host key.');
        }
    }
    return { knownHostsPath, trustedHostKey };
}

async function resolveManagedSshHostTrust(input: Readonly<{
    correlation: SshTrustIdentity;
    carrier: SshHost;
    trustedHostKey?: string;
    signal?: AbortSignal;
}>) {
    const trust = await resolveManagedEnrollmentSshTrust(input);
    const { resolveLiveRemoteHostTrust } = await import('@/capabilities/systemTasks/ssh/liveRemoteSshBootstrap');
    return resolveLiveRemoteHostTrust({ ssh: {
        target: `${input.carrier.user}@${input.carrier.address}`, auth: 'agent',
        ...(input.carrier.port === undefined ? {} : { port: input.carrier.port }),
        ...(input.carrier.hostKeyEvidence === undefined ? {} : { hostKeyEvidence: input.carrier.hostKeyEvidence }), ...trust,
    }, knownHostsMode: 'app', signal: input.signal });
}

/** A temporary preparation guest belongs to the preset's original finite admission, before a managed row exists. */
export async function runPreparedPresetSshHostTrust(input: Readonly<{
    correlation: Readonly<{ homeId: string; presetId: string; operationId: string }>;
    carrier: SshHost;
    signal?: AbortSignal;
    prompt: InteractiveSystemTaskContext['prompt'];
}>): Promise<void> {
    const resolution = await resolveManagedSshHostTrust(input);
    await settleRemoteSshHostTrust({ prompt: async request => {
        const answer = await input.prompt(request);
        input.signal?.throwIfAborted();
        return answer;
    } }, resolution);
}

/** Session placement consumes retained/previously approved trust without enrolling a guest daemon. */
export async function prepareManagedSessionSshTrust(input: Readonly<{
    correlation: Pick<ManagedEnrollmentCorrelationV1, 'homeId' | 'managedId'>;
    carrier: Extract<ManagedBootstrapCarrierV1, { kind: 'ssh' }>;
    guestHostPublicKey?: string;
}>): Promise<Readonly<{ knownHostsPath: string }>> {
    const trustedHostKey = readManagedSshTrustedHostKey(input.carrier, input.guestHostPublicKey);
    const trust = await resolveManagedEnrollmentSshTrust({ ...input, trustedHostKey });
    if (trust.trustedHostKey === undefined) {
        throw new SystemTaskExecutionError('ssh_host_trust_required', 'Approve this managed resource SSH host key before placing a Session.');
    }
    resolveSshBootstrapHostKeyPin({ trustedHostKey: trust.trustedHostKey, hostKeyEvidence: input.carrier.hostKeyEvidence });
    const approved = resolveSshKnownHostTrust({ scannedHostKeyLine: trust.trustedHostKey, trustedHostKey: trust.trustedHostKey });
    if (approved.status !== 'trusted') throw new SystemTaskExecutionError('invalid_trusted_host_key', 'The managed resource host key is invalid.');
    persistSshKnownHostTrust({ knownHostsPath: trust.knownHostsPath, trust: approved, trustedHostKey: trust.trustedHostKey });
    return { knownHostsPath: trust.knownHostsPath };
}
