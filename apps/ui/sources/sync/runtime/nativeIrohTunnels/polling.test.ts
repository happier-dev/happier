import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { reactNativeWebAppState } from '@/dev/testkit/runtime/reactNativeRuntime';
import { bindNativeLoopbackTunnelRuntimeActivity } from '@/sync/runtime/nativeLoopbackTunnels/runtime';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { acquireIrohHomeRuntimeOrigin, createIrohHomeTunnelRuntime, disposeIrohHomeTunnelRuntime, getIrohHomeTunnelRuntime } from './runtime';
import type { IrohNativeLifecycleModule } from './supervisor';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Document visibility is the OS boundary for desktop renderers. Keep the
// document stable across runtime replacement, as it is in the real app.
const documentBoundary = Object.assign(new EventTarget(), { visibilityState: 'visible' });

describe('Iroh status observation activity cost', () => {
    afterEach(async () => {
        await disposeIrohHomeTunnelRuntime();
        resetRuntimeFetch();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it.each([
        { phase: 'settled', signal: 'visibility' },
        { phase: 'acquiring', signal: 'visibility' },
        { phase: 'foregrounding', signal: 'visibility' },
        { phase: 'settled', signal: 'appState' },
    ] as const)(
        'keeps leases but reads no native status while inactive after $phase work ($signal)',
        async ({ phase, signal }) => {
            vi.useFakeTimers();
            documentBoundary.visibilityState = 'visible';
            vi.stubGlobal('document', documentBoundary);
            let observedPath: 'direct' | 'relay' = 'direct';
            const getTunnelStatus = vi.fn(async () => ({ active: true, connectionActive: true, observedPath }));
            const releaseHomeTunnel = vi.fn(async () => undefined);
            const native: IrohNativeLifecycleModule = {
                ensureHomeTunnel: async (input) => ({
                    leaseId: 'native-lease', homeServerIdentityId: input.homeServerIdentityId,
                    homeEndpointId: input.endpointId, runtimeOrigin: 'http://127.0.0.1:45901',
                    carrier: 'iroh', observedPath: 'direct', startedAtMs: 1,
                }),
                releaseHomeTunnel,
                getTunnelStatus,
            };
            // Hold the real readiness path at its HTTP boundary so suspension
            // can occur while either acquisition or foreground recovery awaits IO.
            let holdReadiness = false;
            const readinessEntered = createDeferred<void>();
            const readinessReleased = createDeferred<void>();
            setRuntimeFetch(async (input) => {
                if (String(input).endsWith('/v1/features')) {
                    return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_poll' } } });
                }
                if (String(input).endsWith('/health') && holdReadiness) {
                    readinessEntered.resolve();
                    await readinessReleased.promise;
                }
                return Response.json({ ok: true });
            });
            const runtime = phase === 'settled' ? getIrohHomeTunnelRuntime({ native }) : createIrohHomeTunnelRuntime({ native });
            // Focused Home startup already binds activity. Exercise that
            // production binding directly for the two late-completion cases.
            const lifecycle = phase === 'settled' ? null : bindNativeLoopbackTunnelRuntimeActivity({
                isActive: isRuntimeActive,
                subscribe: subscribeToRuntimeActiveChange,
                runtimes: [runtime],
            });
            async function setActive(next: boolean): Promise<void> {
                if (!next) getTunnelStatus.mockClear();
                if (signal === 'appState') {
                    reactNativeWebAppState.emit(next ? 'active' : 'background');
                } else {
                    documentBoundary.visibilityState = next ? 'visible' : 'hidden';
                    documentBoundary.dispatchEvent(new Event('visibilitychange'));
                }
                await vi.advanceTimersByTimeAsync(0);
            }
            try {
                holdReadiness = phase === 'acquiring';
                const request = {
                    homeServerIdentityId: 'srv_poll', endpoint: { endpointId: 'endpoint-poll' },
                    canonicalServerUrl: 'https://poll.example.test', verification: { kind: 'enrollment' as const },
                };
                const acquiring = phase === 'settled' ? acquireIrohHomeRuntimeOrigin(request) : runtime.acquireHomeRuntimeOrigin(request);
                if (phase === 'acquiring') {
                    await readinessEntered.promise;
                    await setActive(false);
                    readinessReleased.resolve();
                }
                const lease = await acquiring;
                if (phase !== 'acquiring') {
                    await vi.advanceTimersByTimeAsync(2_000);
                    expect(getTunnelStatus).toHaveBeenCalled();
                    await setActive(false);
                    if (phase === 'foregrounding') {
                        holdReadiness = true;
                        await setActive(true);
                        await readinessEntered.promise;
                        await setActive(false);
                        readinessReleased.resolve();
                        await vi.advanceTimersByTimeAsync(0);
                    }
                }

                await vi.advanceTimersByTimeAsync(60_000);
                expect(getTunnelStatus).toHaveBeenCalledTimes(0);
                expect(releaseHomeTunnel).not.toHaveBeenCalled();
                expect(runtime.listTunnels().leases).toEqual([expect.objectContaining({ leaseId: lease.leaseId })]);

                holdReadiness = false;
                await setActive(true);
                expect(getTunnelStatus).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(2_000);
                expect(getTunnelStatus).toHaveBeenCalledTimes(2);
                expect(runtime.listTunnels().leases[0]).toEqual(expect.objectContaining({ status: 'ready', observedPath: 'direct' }));

                observedPath = 'relay';
                await vi.advanceTimersByTimeAsync(2_000);
                expect(runtime.listTunnels().leases[0]).toEqual(expect.objectContaining({ status: 'ready', observedPath: 'relay' }));
                await lease.release();
                expect(releaseHomeTunnel).toHaveBeenCalledExactlyOnceWith('native-lease');
                getTunnelStatus.mockClear();
                await vi.advanceTimersByTimeAsync(60_000);
                expect(getTunnelStatus).not.toHaveBeenCalled();
                if (phase === 'settled') {
                    // Logout/disposal can replace the runtime without another
                    // visibility edge; its initial state must still be inactive.
                    await setActive(false);
                    await disposeIrohHomeTunnelRuntime();
                    getIrohHomeTunnelRuntime({ native });
                    await expect(acquireIrohHomeRuntimeOrigin(request)).rejects.toThrow('iroh_home_tunnel_suspended');
                    await vi.advanceTimersByTimeAsync(60_000);
                    expect(getTunnelStatus).not.toHaveBeenCalled();
                    await setActive(true);
                }
            } finally {
                lifecycle?.remove();
                await runtime.dispose();
                await disposeIrohHomeTunnelRuntime();
            }
        },
    );
});
