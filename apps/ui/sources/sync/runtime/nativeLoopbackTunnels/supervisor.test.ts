import { describe, expect, it, vi } from 'vitest';

import { createLoopbackTunnelSupervisor } from './supervisor';
import type {
    LoopbackTunnelAdapter,
    LoopbackTunnelLease,
    LoopbackTunnelProbe,
    LoopbackTunnelRequest,
} from './types';

type Request = LoopbackTunnelRequest & Readonly<{
    destinationHost: '127.0.0.1';
    destinationPort: number;
    verificationToken?: string;
}>;

function createRequest(): Request {
    return {
        remoteHostId: 'home-a',
        destinationHost: '127.0.0.1',
        destinationPort: 3005,
        purpose: 'home',
    };
}

function createLeaseFactory() {
    return ({ key, request, localPort }: { key: string; request: Request; localPort: number }) => ({
        leaseId: `loopback:${key}`,
        key,
        remoteHostId: request.remoteHostId,
        localUrl: `http://127.0.0.1:${localPort}`,
        channelMode: 'loopback-port' as const,
        purpose: request.purpose,
        status: 'ready' as const,
        startedAt: '2026-08-30T00:00:00.000Z',
    });
}

describe('provider-neutral loopback tunnel supervisor', () => {
    it('coalesces starts and releases the native tunnel after the final lease', async () => {
        const adapter: LoopbackTunnelAdapter<Request> = {
            startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe: LoopbackTunnelProbe<Request> = vi.fn(async () => ({ ok: true as const }));
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter,
            probe,
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
        });

        const first = supervisor.ensureTunnel(createRequest());
        const second = supervisor.ensureTunnel(createRequest());
        const [firstLease, secondLease] = await Promise.all([first, second]);

        expect(firstLease).toEqual(secondLease);
        expect(adapter.startLoopbackTunnel).toHaveBeenCalledTimes(1);
        expect(supervisor.listTunnels().platformLimitations).toEqual([]);

        await supervisor.releaseTunnel(firstLease.leaseId);
        expect(adapter.stopLoopbackTunnel).not.toHaveBeenCalled();
        await supervisor.releaseTunnel(secondLease.leaseId);
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        expect(supervisor.listTunnels().leases).toEqual([]);
        expect(supervisor.listTunnels().platformLimitations).toEqual([]);
    });

    it('discards a tunnel that finishes after the active server generation changes', async () => {
        let generation = 1;
        let resolveStart: ((value: { nativeTunnelId: string; localPort: number }) => void) | undefined;
        const adapter: LoopbackTunnelAdapter<Request> = {
            startLoopbackTunnel: vi.fn(() => new Promise<{ nativeTunnelId: string; localPort: number }>((resolve) => { resolveStart = resolve; })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter,
            probe: vi.fn(async () => ({ ok: true as const })),
            buildKey: () => 'home-key',
            getGeneration: () => generation,
            createLease: ({ key, request, localPort, generation: leaseGeneration }) => ({
                leaseId: `loopback:${key}`,
                key,
                remoteHostId: request.remoteHostId,
                localUrl: `http://127.0.0.1:${localPort}`,
                channelMode: 'loopback-port' as const,
                purpose: request.purpose,
                status: 'ready' as const,
                startedAt: '2026-08-30T00:00:00.000Z',
                ...(leaseGeneration === undefined ? {} : { generation: leaseGeneration }),
            }),
        });
        const pending = supervisor.ensureTunnel(createRequest());
        generation = 2;
        resolveStart?.({ nativeTunnelId: 'native-stale', localPort: 49153 });
        await expect(pending).rejects.toThrow('loopback_tunnel_stale_generation');
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-stale');
        expect(supervisor.listTunnels().leases).toEqual([]);
    });

    it('keeps failed-lease bookkeeping when probe-cleanup stop fails and lets release retry the stop', async () => {
        const stopLoopbackTunnel = vi.fn(async () => undefined)
            .mockRejectedValueOnce(new Error('native_stop_failed'))
            .mockResolvedValueOnce(undefined);
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: {
                startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
                stopLoopbackTunnel,
            },
            probe: vi.fn(async () => ({ ok: false as const, reason: 'remote-service-unreachable' })),
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toMatchObject({
            name: 'LoopbackTunnelPostAcquisitionError',
            message: 'loopback_tunnel_probe_failed:remote-service-unreachable',
            cleanupError: expect.objectContaining({ message: 'native_stop_failed' }),
        });

        const failedLease = supervisor.listTunnels().leases[0];
        expect(failedLease).toEqual(expect.objectContaining({
            leaseId: 'loopback:home-key',
            localUrl: 'http://127.0.0.1:49152',
            status: 'failed',
        }));

        await supervisor.releaseTunnel(failedLease!.leaseId);
        expect(stopLoopbackTunnel).toHaveBeenCalledTimes(2);
        expect(supervisor.listTunnels().leases).toEqual([]);
    });

    it('force-disposes one failed native handle shared by concurrent acquisitions', async () => {
        let resolveStart: ((value: { nativeTunnelId: string; localPort: number }) => void) | undefined;
        const stopLoopbackTunnel = vi.fn(async () => undefined)
            .mockRejectedValueOnce(new Error('native_stop_failed'))
            .mockResolvedValueOnce(undefined);
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: {
                startLoopbackTunnel: vi.fn(() => new Promise<{ nativeTunnelId: string; localPort: number }>((resolve) => {
                    resolveStart = resolve;
                })),
                stopLoopbackTunnel,
            },
            probe: vi.fn(async () => ({ ok: false as const, reason: 'remote-service-unreachable' })),
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
        });

        const first = supervisor.ensureTunnel(createRequest());
        const second = supervisor.ensureTunnel(createRequest());
        resolveStart?.({ nativeTunnelId: 'native-shared', localPort: 49152 });
        const acquisitions = await Promise.allSettled([first, second]);

        expect(acquisitions).toEqual([
            expect.objectContaining({
                status: 'rejected',
                reason: expect.objectContaining({
                    message: 'loopback_tunnel_probe_failed:remote-service-unreachable',
                    cleanupError: expect.objectContaining({ message: 'native_stop_failed' }),
                }),
            }),
            expect.objectContaining({
                status: 'rejected',
                reason: expect.objectContaining({
                    message: 'loopback_tunnel_probe_failed:remote-service-unreachable',
                    cleanupError: expect.objectContaining({ message: 'native_stop_failed' }),
                }),
            }),
        ]);
        expect(supervisor.listTunnels().leases).toEqual([
            expect.objectContaining({ leaseId: 'loopback:home-key', status: 'failed' }),
        ]);
        expect(stopLoopbackTunnel).toHaveBeenCalledTimes(1);

        await supervisor.dispose();

        expect(stopLoopbackTunnel).toHaveBeenCalledTimes(2);
        expect(stopLoopbackTunnel).toHaveBeenLastCalledWith('native-shared');
        expect(supervisor.listTunnels().leases).toEqual([]);
    });

    it('closes admission synchronously when disposal begins, settles admitted starts, and releases their late handles', async () => {
        let resolveStart: ((value: { nativeTunnelId: string; localPort: number }) => void) | undefined;
        const startLoopbackTunnel = vi.fn(() => new Promise<{ nativeTunnelId: string; localPort: number }>((resolve) => {
            resolveStart = resolve;
        }));
        const stopLoopbackTunnel = vi.fn(async () => undefined);
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: { startLoopbackTunnel, stopLoopbackTunnel },
            probe: vi.fn(async () => ({ ok: true as const })),
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
        });

        const admitted = supervisor.ensureTunnel(createRequest());
        await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));

        const disposal = supervisor.dispose();

        // Admission is already closed while disposal is still settling the
        // admitted start: no second native start may begin.
        expect(startLoopbackTunnel).toHaveBeenCalledTimes(1);
        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('loopback_tunnel_disposed');
        expect(startLoopbackTunnel).toHaveBeenCalledTimes(1);

        // The admitted start settles, and the same disposal pass releases the
        // handle it produced instead of leaving it owned by a dead supervisor.
        resolveStart?.({ nativeTunnelId: 'native-late', localPort: 49154 });
        await expect(admitted).resolves.toEqual(expect.objectContaining({ leaseId: 'loopback:home-key' }));
        await disposal;
        expect(stopLoopbackTunnel).toHaveBeenCalledWith('native-late');
        expect(supervisor.listTunnels().leases).toEqual([]);

        // A disposed supervisor cannot restart native work.
        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('loopback_tunnel_disposed');
        expect(startLoopbackTunnel).toHaveBeenCalledTimes(1);
    });

    it('reopens admission when disposal fails so the same owner keeps supervising, then closes it on success', async () => {
        const stopLoopbackTunnel = vi.fn(async () => undefined)
            .mockRejectedValueOnce(new Error('native_stop_failed'));
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: {
                startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
                stopLoopbackTunnel,
            },
            probe: vi.fn(async () => ({ ok: true as const })),
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
        });
        const lease = await supervisor.ensureTunnel(createRequest());

        await expect(supervisor.dispose()).rejects.toThrow('native_stop_failed');
        // The failed stop stays owned by the same supervisor, which remains the
        // live owner; acquisition admission is available again for its retry.
        expect(supervisor.listTunnels().leases).toEqual([
            expect.objectContaining({ leaseId: 'loopback:home-key', status: 'failed' }),
        ]);
        const reacquired = await supervisor.ensureTunnel(createRequest());
        expect(reacquired.leaseId).toBe(lease.leaseId);

        // A successful disposal is terminal: the handle is released once more
        // and the supervisor accepts no further work.
        await supervisor.dispose();
        expect(stopLoopbackTunnel).toHaveBeenCalledTimes(3);
        expect(stopLoopbackTunnel).toHaveBeenLastCalledWith('native-1');
        expect(supervisor.listTunnels().leases).toEqual([]);
        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('loopback_tunnel_disposed');
    });

    it('applies consumer failure codes, probe diagnostics, and platform limitation configuration', async () => {
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: {
                startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            },
            probe: vi.fn(async () => ({ ok: false as const, reason: 'remote-service-unreachable' })),
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
            failureCodes: {
                suspended: 'custom_tunnel_suspended',
                probeFailed: 'custom_tunnel_probe_failed',
                staleGeneration: 'custom_tunnel_stale_generation',
            },
            platformLimitations: {
                foreground: { id: 'fg-only', severity: 'info', reason: 'foreground-only', message: 'limitation.foreground-only' },
            },
            limitationForProbeFailure: (reason) => ({
                id: `consumer.${reason}`,
                severity: 'error',
                reason,
                message: `limitation.${reason}`,
            }),
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('custom_tunnel_probe_failed');

        const snapshot = supervisor.listTunnels();
        expect(snapshot.platformLimitations).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: 'foreground-only', severity: 'info' }),
            expect.objectContaining({ reason: 'remote-service-unreachable', severity: 'error' }),
        ]));

        supervisor.markSuspended();
        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('custom_tunnel_suspended');
    });

    it('retains the newest successfully verified request when a healthy lease is reused', async () => {
        const probe = vi.fn(async () => ({ ok: true as const }));
        const startLoopbackTunnel = vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 }));
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: { startLoopbackTunnel, stopLoopbackTunnel: vi.fn(async () => undefined) },
            probe,
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
        });
        const firstRequest = { ...createRequest(), verificationToken: 'token-old' };
        const rotatedRequest = { ...createRequest(), verificationToken: 'token-new' };

        const first = await supervisor.ensureTunnel(firstRequest);
        expect(probe).toHaveBeenCalledWith('http://127.0.0.1:49152', firstRequest);
        const reused = await supervisor.ensureTunnel(rotatedRequest);
        // Healthy reuse re-probes the stored lease and never starts a second native tunnel.
        expect(reused.leaseId).toBe(first.leaseId);
        expect(startLoopbackTunnel).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledTimes(2);
        supervisor.markSuspended();
        await supervisor.markForeground();

        expect(probe).toHaveBeenLastCalledWith('http://127.0.0.1:49152', rotatedRequest);
        expect(supervisor.listTunnels().leases[0]).toEqual(expect.objectContaining({ status: 'ready' }));
    });

    it('shares a healthy lease without re-proving it for a request it already verified', async () => {
        const probe = vi.fn(async () => ({ ok: true as const }));
        const startLoopbackTunnel = vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 }));
        const stopLoopbackTunnel = vi.fn(async () => undefined);
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: { startLoopbackTunnel, stopLoopbackTunnel },
            probe,
            buildKey: () => 'home-key',
            buildVerificationKey: (candidate) => candidate.verificationToken ?? '',
            createLease: createLeaseFactory(),
        });
        const request = { ...createRequest(), verificationToken: 'token-focused' };

        // The focused connection holds the lease; three scoped reads then acquire it in turn.
        const focused = await supervisor.ensureTunnel(request);
        for (let read = 0; read < 3; read += 1) {
            const lease = await supervisor.ensureTunnel({ ...request });
            expect(lease.leaseId).toBe(focused.leaseId);
            await supervisor.releaseTunnel(lease.leaseId);
        }

        expect(startLoopbackTunnel).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledTimes(1);
        // Each read held a real reference: the focused holder still keeps the tunnel open.
        expect(stopLoopbackTunnel).not.toHaveBeenCalled();
        expect(supervisor.listTunnels().leases[0]).toEqual(expect.objectContaining({ status: 'ready' }));
    });

    it('gives each of several concurrent reads of an already-verified lease its own reference', async () => {
        const startLoopbackTunnel = vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 }));
        const stopLoopbackTunnel = vi.fn(async () => undefined);
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: { startLoopbackTunnel, stopLoopbackTunnel },
            probe: vi.fn(async () => ({ ok: true as const })),
            buildKey: () => 'home-key',
            buildVerificationKey: (candidate) => candidate.verificationToken ?? '',
            createLease: createLeaseFactory(),
        });
        const request = { ...createRequest(), verificationToken: 'token-focused' };

        // The focused connection holds the lease; a screen then issues three scoped reads at once.
        const focused = await supervisor.ensureTunnel(request);
        const reads = await Promise.all([0, 1, 2].map(() => supervisor.ensureTunnel({ ...request })));
        for (const lease of reads) await supervisor.releaseTunnel(lease.leaseId);

        // The reads' releases never stop the tunnel under the focused holder.
        expect(stopLoopbackTunnel).not.toHaveBeenCalled();
        await supervisor.releaseTunnel(focused.leaseId);
        expect(stopLoopbackTunnel).toHaveBeenCalledTimes(1);
        expect(startLoopbackTunnel).toHaveBeenCalledTimes(1);
    });

    it('keeps supervising after a transient native status-read error until authoritative closure', async () => {
        type NativeListener = (event: {
            type: 'ready' | 'path_changed' | 'degraded' | 'closed' | 'error';
            tunnelHandle: string;
            status: 'ready' | 'degraded' | 'closed' | 'error';
            observedPath?: string;
            errorCode?: string;
            atMs: number;
        }) => void;
        const nativeListenerRef: { current: NativeListener | null } = { current: null };
        const stopLoopbackTunnel = vi.fn(async () => undefined);
        const unsubscribeNative = vi.fn();
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: {
                startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
                stopLoopbackTunnel,
                subscribeLoopbackTunnelEvents: (_nativeTunnelId, listener) => {
                    nativeListenerRef.current = listener;
                    return unsubscribeNative;
                },
            },
            probe: vi.fn(async () => ({ ok: true as const })),
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
        });
        const observed: unknown[] = [];
        supervisor.subscribe((event) => observed.push(event));
        const lease = await supervisor.ensureTunnel(createRequest());
        const nativeListener = nativeListenerRef.current;
        if (!nativeListener) throw new Error('Native tunnel listener was not registered');

        nativeListener({
            type: 'error',
            tunnelHandle: 'native-1',
            status: 'error',
            errorCode: 'status_observation_failed',
            atMs: 10,
        });

        expect(supervisor.listTunnels().leases[0]).toEqual(expect.objectContaining({
            leaseId: lease.leaseId,
            status: 'ready',
        }));
        expect(stopLoopbackTunnel).not.toHaveBeenCalled();
        expect(unsubscribeNative).not.toHaveBeenCalled();

        nativeListener({
            type: 'path_changed',
            tunnelHandle: 'native-1',
            status: 'ready',
            observedPath: 'relay',
            atMs: 11,
        });
        expect(observed).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'error', errorCode: 'status_observation_failed' }),
            expect.objectContaining({ type: 'path_changed', lease: expect.objectContaining({ leaseId: lease.leaseId }), observedPath: 'relay' }),
        ]));
        expect(supervisor.listTunnels().leases[0]?.status).toBe('ready');

        nativeListener({
            type: 'closed',
            tunnelHandle: 'native-1',
            status: 'closed',
            errorCode: 'transport_closed',
            atMs: 12,
        });
        await vi.waitFor(() => expect(stopLoopbackTunnel).toHaveBeenCalledTimes(1));
        expect(unsubscribeNative).toHaveBeenCalledTimes(1);
        expect(supervisor.listTunnels().leases[0]?.status).toBe('stopped');
        expect(observed).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'closed', lease: expect.objectContaining({ leaseId: lease.leaseId }), errorCode: 'transport_closed' }),
        ]));
    });

    it('stops native observation while suspended and resubscribes only after the foreground probe succeeds', async () => {
        let activeListener: ((event: never) => void) | null = null;
        const unsubscribe = vi.fn(() => { activeListener = null; });
        const subscribeLoopbackTunnelEvents = vi.fn((_nativeTunnelId: string, listener: (event: never) => void) => {
            activeListener = listener;
            return unsubscribe;
        });
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: {
                startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
                stopLoopbackTunnel: vi.fn(async () => undefined),
                subscribeLoopbackTunnelEvents,
            },
            probe: vi.fn(async () => ({ ok: true as const })),
            buildKey: () => 'home-key',
            createLease: createLeaseFactory(),
        });
        const lease = await supervisor.ensureTunnel(createRequest());
        expect(subscribeLoopbackTunnelEvents).toHaveBeenCalledTimes(1);
        expect(activeListener).not.toBeNull();

        supervisor.markSuspended();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(activeListener).toBeNull();
        expect(supervisor.listTunnels().leases[0]).toEqual(expect.objectContaining({ status: 'degraded' }));

        await supervisor.markForeground();

        expect(subscribeLoopbackTunnelEvents).toHaveBeenCalledTimes(2);
        expect(activeListener).not.toBeNull();
        expect(supervisor.listTunnels().leases[0]).toEqual(expect.objectContaining({ leaseId: lease.leaseId, status: 'ready' }));
    });

    describe('lease reuse, replacement and foreground recovery', () => {
        type StartResult = { nativeTunnelId: string; localPort: number };
        const unreachable = { ok: false as const, reason: 'remote-service-unreachable' };

        function createSupervisor(
            adapter: LoopbackTunnelAdapter<Request>,
            probe: LoopbackTunnelProbe<Request>,
        ) {
            return createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
                adapter,
                probe,
                buildKey: () => 'home-key',
                createLease: createLeaseFactory(),
            });
        }

        it('dedupes concurrent replacement of a stale ready tunnel into one native start', async () => {
            const pendingReplacementStarts: Array<(value: StartResult) => void> = [];
            const startLoopbackTunnel = vi.fn(async () => {
                if (startLoopbackTunnel.mock.calls.length === 1) {
                    return { nativeTunnelId: 'native-1', localPort: 49152 };
                }
                return await new Promise<StartResult>((resolve) => {
                    pendingReplacementStarts.push(resolve);
                });
            });
            const adapter: LoopbackTunnelAdapter<Request> = {
                startLoopbackTunnel,
                stopLoopbackTunnel: vi.fn(async () => undefined),
            };
            const probe = vi.fn<LoopbackTunnelProbe<Request>>()
                .mockResolvedValueOnce({ ok: true })
                .mockResolvedValueOnce(unreachable)
                .mockResolvedValue({ ok: true });
            const supervisor = createSupervisor(adapter, probe);

            await supervisor.ensureTunnel(createRequest());
            const firstReplacement = supervisor.ensureTunnel(createRequest());
            const secondReplacement = supervisor.ensureTunnel(createRequest());
            await vi.waitFor(() => {
                expect(pendingReplacementStarts.length).toBe(1);
            });
            pendingReplacementStarts[0]?.({ nativeTunnelId: 'native-2', localPort: 49153 });

            await expect(Promise.all([firstReplacement, secondReplacement])).resolves.toEqual([
                expect.objectContaining({ localUrl: 'http://127.0.0.1:49153' }),
                expect.objectContaining({ localUrl: 'http://127.0.0.1:49153' }),
            ]);
            expect(startLoopbackTunnel).toHaveBeenCalledTimes(2);
        });

        it('keeps a shared tunnel alive until every sequential consumer releases the lease', async () => {
            const adapter: LoopbackTunnelAdapter<Request> = {
                startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            };
            const supervisor = createSupervisor(adapter, vi.fn(async () => ({ ok: true as const })));

            const firstLease = await supervisor.ensureTunnel(createRequest());
            const secondLease = await supervisor.ensureTunnel(createRequest());

            await supervisor.releaseTunnel(firstLease.leaseId);
            expect(supervisor.listTunnels().leases.map((lease) => lease.leaseId)).toEqual([secondLease.leaseId]);
            expect(adapter.stopLoopbackTunnel).not.toHaveBeenCalled();

            await supervisor.releaseTunnel(secondLease.leaseId);
            expect(supervisor.listTunnels().leases).toEqual([]);
            expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        });

        it('keeps released lease bookkeeping when the native stop fails', async () => {
            const adapter: LoopbackTunnelAdapter<Request> = {
                startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
                stopLoopbackTunnel: vi.fn(async () => {
                    throw new Error('native_stop_failed');
                }),
            };
            const supervisor = createSupervisor(adapter, vi.fn(async () => ({ ok: true as const })));

            const lease = await supervisor.ensureTunnel(createRequest());
            await expect(supervisor.releaseTunnel(lease.leaseId)).rejects.toThrow('native_stop_failed');

            expect(supervisor.listTunnels().leases).toEqual([expect.objectContaining({
                leaseId: lease.leaseId,
                status: 'failed',
            })]);
        });

        it('stops a stale ready tunnel before replacing it', async () => {
            const adapter: LoopbackTunnelAdapter<Request> = {
                startLoopbackTunnel: vi.fn()
                    .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                    .mockResolvedValueOnce({ nativeTunnelId: 'native-2', localPort: 49153 }),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            };
            const probe = vi.fn<LoopbackTunnelProbe<Request>>()
                .mockResolvedValueOnce({ ok: true })
                .mockResolvedValueOnce(unreachable)
                .mockResolvedValueOnce({ ok: true });
            const supervisor = createSupervisor(adapter, probe);

            await supervisor.ensureTunnel(createRequest());
            await supervisor.ensureTunnel(createRequest());

            expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
            expect(adapter.startLoopbackTunnel).toHaveBeenCalledTimes(2);
        });

        it('preserves retained consumer references when replacing a degraded stale tunnel', async () => {
            const adapter: LoopbackTunnelAdapter<Request> = {
                startLoopbackTunnel: vi.fn()
                    .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                    .mockResolvedValueOnce({ nativeTunnelId: 'native-2', localPort: 49153 }),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            };
            const probe = vi.fn<LoopbackTunnelProbe<Request>>()
                .mockResolvedValueOnce({ ok: true })
                .mockResolvedValueOnce({ ok: true })
                .mockResolvedValueOnce(unreachable)
                .mockResolvedValueOnce({ ok: true });
            const supervisor = createSupervisor(adapter, probe);

            const firstLease = await supervisor.ensureTunnel(createRequest());
            const secondLease = await supervisor.ensureTunnel(createRequest());
            const replacementLease = await supervisor.ensureTunnel(createRequest());

            expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
            expect(replacementLease.localUrl).toBe('http://127.0.0.1:49153');

            await supervisor.releaseTunnel(firstLease.leaseId);
            await supervisor.releaseTunnel(secondLease.leaseId);
            expect(adapter.stopLoopbackTunnel).not.toHaveBeenCalledWith('native-2');
            expect(supervisor.listTunnels().leases).toEqual([
                expect.objectContaining({
                    leaseId: replacementLease.leaseId,
                    localUrl: 'http://127.0.0.1:49153',
                    status: 'ready',
                }),
            ]);

            await supervisor.releaseTunnel(replacementLease.leaseId);
            expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-2');
        });

        it('preserves a degraded stale lease when the reprobe fails and re-establishment cannot start', async () => {
            const adapter: LoopbackTunnelAdapter<Request> = {
                startLoopbackTunnel: vi.fn()
                    .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                    .mockRejectedValueOnce(new Error('native_start_failed')),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            };
            const probe = vi.fn<LoopbackTunnelProbe<Request>>()
                .mockResolvedValueOnce({ ok: true })
                .mockResolvedValueOnce(unreachable);
            const supervisor = createSupervisor(adapter, probe);

            const firstLease = await supervisor.ensureTunnel(createRequest());
            await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('native_start_failed');

            expect(supervisor.listTunnels().leases).toEqual([
                expect.objectContaining({
                    leaseId: firstLease.leaseId,
                    key: firstLease.key,
                    status: 'degraded',
                    localUrl: firstLease.localUrl,
                }),
            ]);
            expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        });

        it('stops a failed foreground tunnel immediately after the reprobe fails, then replaces it on the next ensure', async () => {
            const adapter: LoopbackTunnelAdapter<Request> = {
                startLoopbackTunnel: vi.fn()
                    .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                    .mockResolvedValueOnce({ nativeTunnelId: 'native-2', localPort: 49153 }),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            };
            const probe = vi.fn<LoopbackTunnelProbe<Request>>()
                .mockResolvedValueOnce({ ok: true })
                .mockResolvedValueOnce(unreachable)
                .mockResolvedValueOnce({ ok: true });
            const supervisor = createSupervisor(adapter, probe);

            await supervisor.ensureTunnel(createRequest());
            await supervisor.markForeground();

            // The stop happens at foreground time, not lazily on the next ensure.
            expect(adapter.stopLoopbackTunnel).toHaveBeenCalledTimes(1);
            expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
            expect(supervisor.listTunnels().leases[0]?.status).toBe('failed');

            await supervisor.ensureTunnel(createRequest());

            expect(adapter.stopLoopbackTunnel).toHaveBeenCalledTimes(1);
            expect(supervisor.listTunnels().leases[0]).toEqual(expect.objectContaining({
                localUrl: 'http://127.0.0.1:49153',
                status: 'ready',
            }));
        });

        it('clears stale start diagnostics after a foreground re-probe verifies a healthy lease', async () => {
            const error = Object.assign(new Error('Native authentication failed.'), { code: 'authentication-failed' });
            const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
                adapter: {
                    startLoopbackTunnel: vi.fn()
                        .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                        .mockRejectedValueOnce(error),
                    stopLoopbackTunnel: vi.fn(async () => undefined),
                },
                probe: vi.fn(async () => ({ ok: true as const })),
                buildKey: (request) => request.remoteHostId,
                createLease: createLeaseFactory(),
                limitationForStartError: (caught) => (
                    (caught as { code?: string }).code === 'authentication-failed'
                        ? { id: 'consumer.authentication-failed', severity: 'error', reason: 'authentication-failed', message: 'limitation.authentication-failed' }
                        : null
                ),
            });
            const reasons = () => supervisor.listTunnels().platformLimitations.map((limitation) => limitation.reason);

            await supervisor.ensureTunnel(createRequest());
            await expect(supervisor.ensureTunnel({ ...createRequest(), remoteHostId: 'home-b' })).rejects.toBe(error);
            expect(reasons()).toContain('authentication-failed');

            await supervisor.markForeground();

            expect(reasons()).not.toContain('authentication-failed');
        });
    });
});
