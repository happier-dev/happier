import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiResourceSubscriptionEventV1 } from '@happier-dev/protocol/plugins/ui';

import type {
    MachinePluginUiResourceWatchNextResult,
} from '@/sync/ops/machineContributionRegistryProjection';
import { createUserRequestLeaseOwner } from '@/sync/runtime/connectivity/userRequestLease';

import { createPluginContextualResourceWatchClient, type PluginSurfaceResourceWatchTransport } from './pluginSurfaceResourceWatch';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return 'web'; } } });
});

// The daemon Machine RPC is the genuine process boundary; the watch owner, its
// pump and the runtime-activity owner it follows stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async () => { throw new Error('Unexpected daemon RPC in an injected watch transport test'); },
}));

type ResourceDigest = Extract<PluginUiResourceSubscriptionEventV1, { kind: 'invalidated' }>['digest'];
const DIGEST_A: ResourceDigest = `sha256:${'a'.repeat(64)}`;
const DIGEST_B: ResourceDigest = `sha256:${'b'.repeat(64)}`;

const globalWithDocument = globalThis as unknown as { document?: unknown };
let originalDocument: unknown;
let page: EventTarget & { visibilityState: 'visible' | 'hidden' };

function setVisibility(state: 'visible' | 'hidden'): void {
    page.visibilityState = state;
    page.dispatchEvent(new Event('visibilitychange'));
}

/**
 * A daemon whose `next` parks until answered or cancelled, like the real long
 * poll. Each call takes a lease from a real lease owner, as `apiSocket.machineRPC`
 * does, and releases it when the call settles.
 */
function createDaemon(leases: ReturnType<typeof createUserRequestLeaseOwner>) {
    let digest = DIGEST_A;
    const calls: { method: 'open' | 'next' | 'close'; atVisibility: string }[] = [];
    const nextSignals: AbortSignal[] = [];
    let parked: ((result: MachinePluginUiResourceWatchNextResult) => void) | null = null;
    const transport: PluginSurfaceResourceWatchTransport = {
        open: async (_machineId, opts) => {
            calls.push({ method: 'open', atVisibility: page.visibilityState });
            return { supported: true, result: { ok: true, subscriptionId: opts.subscriptionId, digest } };
        },
        next: async (_machineId, opts) => {
            calls.push({ method: 'next', atVisibility: page.visibilityState });
            const release = leases.acquire();
            try {
                return await new Promise<MachinePluginUiResourceWatchNextResult>((resolve) => {
                    if (opts.signal) nextSignals.push(opts.signal);
                    parked = resolve;
                    opts.signal?.addEventListener('abort', () => {
                        if (parked === resolve) parked = null;
                        resolve({ supported: false, reason: 'aborted' });
                    }, { once: true });
                });
            } finally { release(); }
        },
        close: async () => { calls.push({ method: 'close', atVisibility: page.visibilityState }); },
    };
    return {
        transport,
        calls,
        nextSignals,
        setDigest(next: ResourceDigest) { digest = next; },
        isParked: () => parked !== null,
    };
}

function createClient(transport: PluginSurfaceResourceWatchTransport) {
    return createPluginContextualResourceWatchClient({
        pluginId: 'acme.preview',
        resource: {
            machineId: 'machine-1',
            serverId: null,
            expectedCallerOccurrenceId: 'occurrence-7',
            context: { kind: 'session', sessionId: 'session-a' },
        },
        subscriptionIdPrefix: 'offscreen',
        transport,
    });
}

describe('daemon Resource watch follows runtime activity', () => {
    beforeEach(() => {
        originalDocument = globalWithDocument.document;
        page = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' });
        globalWithDocument.document = page;
    });
    afterEach(() => {
        globalWithDocument.document = originalDocument;
    });

    it('releases its parked long poll at hide, issues nothing while hidden, and re-opens on return', async () => {
        const leases = createUserRequestLeaseOwner();
        const daemon = createDaemon(leases);
        const events: unknown[] = [];
        const subscription = await createClient(daemon.transport).watchResource('live-status', (event) => { events.push(event); });
        try {
            await vi.waitFor(() => { expect(daemon.isParked()).toBe(true); });
            // A user request (a send) is in flight at hide alongside the parked poll.
            const releaseSend = leases.acquire();
            const teardown = vi.fn();

            expect(leases.deferRoutineTeardown(teardown)).toBe(true);
            setVisibility('hidden');

            // The long poll is not work to finish: hiding cancels it at once.
            expect(daemon.nextSignals[0]?.aborted).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 50));
            // Teardown still waits for the send that was in flight at hide.
            expect(teardown).not.toHaveBeenCalled();
            releaseSend();
            expect(teardown).toHaveBeenCalledTimes(1);

            // Hidden: no poll, no re-open, no backoff loop.
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(daemon.calls.filter((call) => call.atVisibility === 'hidden' && call.method !== 'close')).toEqual([]);

            // Return with an unchanged digest: one re-open, one parked poll, no event.
            setVisibility('visible');
            await vi.waitFor(() => { expect(daemon.isParked()).toBe(true); });
            expect(daemon.calls.map((call) => call.method)).toEqual(['open', 'next', 'open', 'next']);
            expect(events).toEqual([]);

            // Return after the Resource moved while hidden: the observer re-reads once.
            setVisibility('hidden');
            daemon.setDigest(DIGEST_B);
            setVisibility('visible');
            await vi.waitFor(() => { expect(events).toHaveLength(1); });
            expect(events[0]).toMatchObject({ kind: 'invalidated', digest: DIGEST_B });
        } finally {
            subscription.dispose();
        }
    });
});
