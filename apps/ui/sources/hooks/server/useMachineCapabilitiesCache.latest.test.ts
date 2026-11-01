import { describe, expect, it, vi } from 'vitest';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

describe('latest machine capability answer', () => {
    it('follows the newest answer for a capability across freshness generations of the same machine', async () => {
        const network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://latest-capability-answer.test', 'latest-capability-account');
        const answers = [['p-1'], []];
        // Real scoped RPC admission, response parsing and cache logic consume Socket ACKs.
        network.setRpcResponder(async () => ({
            protocolVersion: 1,
            results: { 'tool.plugins': { ok: true, checkedAt: 1, data: { pendingChanges: answers.shift() } } },
        }));
        const cache = await import('./useMachineCapabilitiesCache');
        const request = { requests: [{ id: 'tool.plugins' as const }] };
        const latest = () => cache.getLatestMachineCapabilityCacheState('m1', home.id, 'tool.plugins');
        const notified = vi.fn();
        const unsubscribe = cache.subscribeLatestMachineCapabilityCacheState('m1', home.id, 'tool.plugins', notified);

        try {
            expect(cache.getLatestMachineCapabilityCacheUpdatedAt('m1', home.id, 'tool.plugins')).toBeNull();
            const before = Date.now();
            await cache.prefetchMachineCapabilities({ machineId: 'm1', serverId: home.id, cacheKeySalt: '3:0', request, timeoutMs: 1000 });
            expect(latest()).toMatchObject({ status: 'loaded', snapshot: { response: { results: {
                'tool.plugins': { data: { pendingChanges: ['p-1'] } },
            } } } });
            // When this answer was received, for an honest "As of".
            expect(cache.getLatestMachineCapabilityCacheUpdatedAt('m1', home.id, 'tool.plugins')).toBeGreaterThanOrEqual(before);

            // The Plugins page reconnected and asked again under its next generation.
            await cache.prefetchMachineCapabilities({ machineId: 'm1', serverId: home.id, cacheKeySalt: '3:1', request, timeoutMs: 1000 });
            expect(latest()).toMatchObject({ status: 'loaded', snapshot: { response: { results: {
                'tool.plugins': { data: { pendingChanges: [] } },
            } } } });
            expect(notified).toHaveBeenCalled();

            // Another machine's answers are not this machine's.
            expect(cache.getLatestMachineCapabilityCacheState('m2', home.id, 'tool.plugins')).toBeNull();
        } finally {
            unsubscribe();
            await network.dispose();
        }
    });
});
