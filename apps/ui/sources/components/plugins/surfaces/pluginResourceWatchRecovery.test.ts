import { it, expect, vi } from 'vitest';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { MachinePluginUiResourceWatchNextResult, MachinePluginUiResourceWatchOpenResult } from '@/sync/ops/machineContributionRegistryProjection';
import { publishMachineContributionRegistryProjectionInvalidation,
    publishMachineContributionRegistryProjectionRefresh } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { createPluginContextualResourceWatchClient, type PluginSurfaceResourceWatchTransport } from './pluginSurfaceResourceWatch';

// The default RPC boundary is unused; no internal Resource or recovery logic is mocked.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async () => { throw new Error('Unexpected daemon RPC'); },
}));

const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;

it('recovers refused admission on the existing Machine push instead of reopening an idle Resource', async () => {
    vi.useFakeTimers();
    // Only daemon RPC is substituted; the store, adapter, watch pump and
    // Machine-scoped recovery publisher remain the production owners.
    let openResult: MachinePluginUiResourceWatchOpenResult = { supported: false, reason: 'error' };
    let answerNext: ((result: MachinePluginUiResourceWatchNextResult) => void) | undefined;
    const opens: { subscriptionId: string }[] = [];
    const transport: PluginSurfaceResourceWatchTransport = {
        open: async (_machineId, options) => {
            opens.push({ subscriptionId: options.subscriptionId });
            return openResult.supported && openResult.result.ok
                ? { supported: true, result: { ...openResult.result, subscriptionId: options.subscriptionId } }
                : openResult;
        },
        next: async (_machineId, options) => new Promise(resolve => {
            answerNext = resolve;
            options.signal?.addEventListener('abort', () => resolve({ supported: false, reason: 'aborted' }), { once: true });
        }),
        close: async () => {},
    };
    const daemon = { opens, transport,
        setOpenResult(result: MachinePluginUiResourceWatchOpenResult) { openResult = result; },
        async answerNext(result: MachinePluginUiResourceWatchNextResult) { answerNext!(result); await Promise.resolve(); },
    };
    daemon.setOpenResult({ supported: false, reason: 'error' });
    const scope = { machineId: 'resource-recovery-machine', serverId: 'resource-recovery-server' };
    const client = createPluginContextualResourceWatchClient({
        pluginId: 'acme.preview',
        resource: { ...scope, expectedCallerOccurrenceId: 'occurrence-7' },
        subscriptionIdPrefix: 'resource-recovery', transport: daemon.transport,
    });
    let digest = DIGEST_A;
    const store = createPluginUiResourceStore({ pluginId: 'acme.preview', client: {
        ...client,
        readResource: async () => ({ contentType: 'application/json', digest, bytes: new TextEncoder().encode('{}') }),
    } });
    const entry = store.getEntry('live-status');
    const release = entry.subscribe(() => {}, true);
    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(entry.getSnapshot().subscription).toBe('reconnecting');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(daemon.opens).toHaveLength(1);
        publishMachineContributionRegistryProjectionRefresh('another-server');
        await vi.advanceTimersByTimeAsync(0);
        expect(daemon.opens).toHaveLength(1);

        daemon.setOpenResult({ supported: true, result: { ok: true, subscriptionId: 'recovered', digest } });
        publishMachineContributionRegistryProjectionInvalidation(scope, 'authority');
        await vi.advanceTimersByTimeAsync(0);
        expect(daemon.opens).toHaveLength(2);
        expect(entry.getSnapshot()).toMatchObject({ subscription: 'live', digest: DIGEST_A, freshness: 'fresh' });
        publishMachineContributionRegistryProjectionRefresh(scope.serverId);
        await vi.advanceTimersByTimeAsync(0);
        expect(daemon.opens).toHaveLength(2);

        digest = DIGEST_B;
        await daemon.answerNext({ supported: true, result: { ok: true, status: 'event', event: {
            version: 1, subscriptionId: daemon.opens[1]!.subscriptionId, kind: 'invalidated', digest,
        } } });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(entry.getSnapshot()).toMatchObject({ subscription: 'live', digest: DIGEST_B, freshness: 'fresh' });
        expect(daemon.opens).toHaveLength(2);
    } finally {
        release();
        store.dispose();
        vi.useRealTimers();
    }
    publishMachineContributionRegistryProjectionInvalidation(scope, 'authority');
    expect(daemon.opens).toHaveLength(2);
});

