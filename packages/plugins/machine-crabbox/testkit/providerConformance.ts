import { createHash } from 'node:crypto';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Crabbox CLI (direct) and coordinator REST boundaries for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, result, managedId, privateBinding } = world;
    const foreignId = 'cbx_111111111111';
    const leaseId = `cbx_${createHash('sha256').update(managedId).digest('hex').slice(0, 12)}`;
    const coordinator = world.contribution === 'crabbox-coordinator';
    const launch: Record<string, unknown> = coordinator
        ? { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux', nativeImageId: 'ami-test', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 }
        : { backendId: 'local-container', transport: 'direct', namespace: 'test-org', target: 'linux', nativeImageId: 'ubuntu:24.04', ttlSeconds: 5400, idleTimeoutSeconds: 1800, localContainerRuntime: 'docker' };
    return {
        foreignId, launch,
        account: { service: { pluginId: 'happier.machine.crabbox', localId: 'coordinator' },
            environment: { CRABBOX_COORDINATOR_URL: 'https://coordinator.example.test/native', CRABBOX_COORDINATOR_TOKEN: privateBinding, CRABBOX_ORG: 'test-org' } },
        // A coordinator lease read carries no guest power fact.
        facts: { nativeExpiry: 'with-evidence', ...(coordinator ? { inspectPower: 'unknown' as const } : {}) },
        process(_request, args) {
            if (args[0] === 'warmup') { s.allocations++; s.present = true; s.owned.add('sandbox'); }
            if (args[0] === 'stop') { world.remove(args[args.indexOf('--id') + 1], leaseId, () => { s.present = false; s.owned.delete('sandbox'); }); return result(''); }
            const isForeign = args[args.indexOf('--id') + 1] === foreignId;
            return (isForeign ? s.foreignPresent : s.present) ? result({ id: isForeign ? foreignId : leaseId, provider: 'local-container', target: 'linux', state: 'ready', serverId: 'a'.repeat(64),
                sshHost: '203.0.113.8', sshUser: 'root', sshPort: '22', ready: true, hasHost: true,
                ...(s.evidence ? { expiresAt: new Date(world.nativeExpiry).toISOString() } : {}) }) : result('', 4);
        },
        http(_request, { path, method, isForeign }) {
            if (method === 'PUT') { s.allocations++; s.present = true; s.owned.add('lease'); }
            if (path.endsWith('/release')) world.remove(path.split('/').at(-2), leaseId, () => { s.present = false; s.owned.delete('lease'); });
            const leasePresent = isForeign ? s.foreignPresent : s.present;
            return { value: { lease: { id: isForeign ? foreignId : leaseId, provider: 'aws', org: 'test-org', state: leasePresent ? 'active' : 'released', keep: true, cloudID: isForeign ? 'i-foreign' : 'i-owned',
                ...(leasePresent ? { host: '203.0.113.8', sshUser: 'crabbox', sshPort: '22', sshHostKey: world.publicKey,
                    ...(s.evidence ? { expiresAt: new Date(world.nativeExpiry).toISOString() } : {}) }
                    : { cleanupStatus: 'complete', cleanupCompletedAt: '2026-11-01T00:01:00Z', releaseDeletesServer: true }) } } };
        },
    };
};
