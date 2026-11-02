import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSshKnownHostLine, resolveSshKnownHostTrust, SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedBootstrapCarrierV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { configuration } from '@/configuration';

/** The admitted managed row, rather than its reusable network address, owns trust. */
export async function resolveManagedEnrollmentSshTrust(input: Readonly<{
    correlation: ManagedEnrollmentCorrelationV1;
    carrier: Extract<ManagedBootstrapCarrierV1, { kind: 'ssh' }>;
    trustedHostKey?: string;
}>): Promise<Readonly<{ knownHostsPath: string; trustedHostKey?: string }>> {
    const identity = createHash('sha256').update(JSON.stringify([input.correlation.homeId, input.correlation.managedId])).digest('hex');
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
