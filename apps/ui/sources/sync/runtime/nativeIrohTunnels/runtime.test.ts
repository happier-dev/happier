import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

import type { IrohHomeTunnelAcquireInput, IrohHomeTunnelLease, IrohHomeTunnelRequest } from './types';
import type { IrohHomeTunnelSupervisor } from './supervisor';
import type { LoopbackTunnelLifecycleEvent, LoopbackTunnelSnapshot } from '@/sync/runtime/nativeLoopbackTunnels/types';
import * as profiles from '../../domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import {
    createIrohHomeTunnelRuntime,
    disposeIrohHomeTunnelRuntime,
    getIrohHomeTunnelRuntime,
} from './runtime';
import { createIrohHomeTunnelSupervisor } from './supervisor';

function randomScope(): string {
    return `iroh_lifecycle_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const HOME_IDENTITY_A = 'srv_home_a';
const HOME_IDENTITY_B = 'srv_home_b';

function nativeLease(
    leaseId: string,
    homeServerIdentityId: string,
    endpointId: string,
    port: number,
): {
    leaseId: string;
    homeServerIdentityId: string;
    homeEndpointId: string;
    runtimeOrigin: string;
    carrier: 'iroh';
    observedPath: 'direct';
    startedAtMs: number;
} {
    return {
        leaseId,
        homeServerIdentityId,
        homeEndpointId: endpointId,
        runtimeOrigin: `http://127.0.0.1:${port}`,
        carrier: 'iroh',
        observedPath: 'direct',
        startedAtMs: 1,
    };
}

function makeRequest(overrides: Partial<IrohHomeTunnelRequest> = {}): IrohHomeTunnelRequest {
    return {
        remoteHostId: 'profile-a',
        purpose: 'home',
        homeServerIdentityId: HOME_IDENTITY_A,
        endpointId: 'endpoint-a',
        canonicalServerUrl: 'https://order.example.test',
        policy: 'automatic',
        verification: { kind: 'authenticated', token: 'token-a' },
        ...overrides,
    };
}

function makeLease(request: IrohHomeTunnelRequest, leaseId: string, localUrl: string): IrohHomeTunnelLease {
    return {
        leaseId,
        key: `test:${leaseId}`,
        remoteHostId: request.remoteHostId,
        localUrl,
        channelMode: 'loopback-port',
        purpose: 'home',
        status: 'ready',
        startedAt: '2026-08-30T00:00:00.000Z',
        homeServerIdentityId: request.homeServerIdentityId,
        endpointId: request.endpointId,
        carrier: 'iroh',
        observedPath: 'direct',
    };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function identityFeaturesPayload(serverIdentityId: string): unknown {
    return { features: {}, capabilities: { serverIdentity: { serverIdentityId } } };
}

function createSupervisorFake(): {
    supervisor: IrohHomeTunnelSupervisor;
    ensureTunnel: ReturnType<typeof vi.fn>;
    listTunnels: ReturnType<typeof vi.fn>;
    releaseTunnel: ReturnType<typeof vi.fn>;
    markSuspended: ReturnType<typeof vi.fn>;
    markForeground: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    /** Every native stop the supervisor actually performed, in order. */
    nativeStops: string[];
    /** Lease ids whose native handle the supervisor still owns. */
    outstandingLeaseIds: () => string[];
    failNextStop: (leaseId: string) => void;
    emit: (event: LoopbackTunnelLifecycleEvent<IrohHomeTunnelLease>) => void;
} {
    const stored: { lease: IrohHomeTunnelLease | null } = { lease: null };
    // Mirrors the real supervisor's ownership contract: one reference-counted
    // native handle per lease id, stopped exactly once when the last reference
    // releases or on disposal, and retained by the same supervisor when a stop
    // fails so a later release/disposal can retry it.
    const referenceCounts = new Map<string, number>();
    const failingStops = new Set<string>();
    const nativeStops: string[] = [];
    function performNativeStop(leaseId: string): void {
        nativeStops.push(leaseId);
        if (failingStops.delete(leaseId)) throw new Error('native stop failed');
        referenceCounts.delete(leaseId);
    }
    const ensureTunnel = vi.fn(async (request: IrohHomeTunnelRequest) => {
        const lease = makeLease(request, `lease-${ensureTunnel.mock.calls.length}`, `http://127.0.0.1:${45800 + ensureTunnel.mock.calls.length}`);
        stored.lease = lease;
        referenceCounts.set(lease.leaseId, (referenceCounts.get(lease.leaseId) ?? 0) + 1);
        return lease;
    });
    const listTunnels = vi.fn((): LoopbackTunnelSnapshot<IrohHomeTunnelLease, never> => ({
        leases: stored.lease ? [stored.lease] : [],
        platformLimitations: [],
    }));
    const releaseTunnel = vi.fn(async (leaseId: string) => {
        const referenceCount = referenceCounts.get(leaseId);
        // An unknown lease id was already stopped and dropped by this owner.
        if (referenceCount === undefined) return;
        if (referenceCount > 1) {
            referenceCounts.set(leaseId, referenceCount - 1);
            return;
        }
        performNativeStop(leaseId);
    });
    const dispose = vi.fn(async () => {
        const errors: unknown[] = [];
        for (const leaseId of [...referenceCounts.keys()]) {
            try {
                performNativeStop(leaseId);
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Failed to dispose every loopback tunnel.');
    });
    const markSuspended = vi.fn();
    const markForeground = vi.fn(async () => undefined);
    const readDiagnostics = vi.fn(() => []);
    const listeners = new Set<(event: LoopbackTunnelLifecycleEvent<IrohHomeTunnelLease>) => void>();
    const unsubscribe = vi.fn((listener: (event: LoopbackTunnelLifecycleEvent<IrohHomeTunnelLease>) => void) => {
        listeners.delete(listener);
    });
    const subscribe = vi.fn((listener: (event: LoopbackTunnelLifecycleEvent<IrohHomeTunnelLease>) => void) => {
        listeners.add(listener);
        return () => unsubscribe(listener);
    });
    const supervisor = {
        ensureTunnel,
        listTunnels,
        releaseTunnel,
        dispose,
        markSuspended,
        markForeground,
        subscribe,
        readDiagnostics,
    } as unknown as IrohHomeTunnelSupervisor;
    return {
        supervisor, ensureTunnel, listTunnels, releaseTunnel, markSuspended, markForeground, unsubscribe,
        nativeStops,
        outstandingLeaseIds: () => [...referenceCounts.keys()],
        failNextStop: (leaseId: string) => { failingStops.add(leaseId); },
        emit: (event) => { for (const listener of listeners) listener(event); },
    };
}

/** Records the real native lifecycle boundary so stop custody is observable. */
function createRecordingNativeLifecycle(): {
    module: { ensureHomeTunnel: ReturnType<typeof vi.fn>; releaseHomeTunnel: ReturnType<typeof vi.fn> };
    stops: string[];
    startCount: () => number;
    failNextStop: (nativeTunnelId: string) => void;
} {
    const stops: string[] = [];
    const failingStops = new Set<string>();
    let starts = 0;
    const ensureHomeTunnel = vi.fn(async (input: { homeServerIdentityId: string; endpointId: string }) => {
        starts += 1;
        return nativeLease(`native-lease-${starts}`, input.homeServerIdentityId, input.endpointId, 45980 + starts);
    });
    const releaseHomeTunnel = vi.fn(async (nativeTunnelId: string) => {
        stops.push(nativeTunnelId);
        if (failingStops.delete(nativeTunnelId)) throw new Error('native stop failed');
    });
    return {
        module: { ensureHomeTunnel, releaseHomeTunnel },
        stops,
        startCount: () => starts,
        failNextStop: (nativeTunnelId: string) => { failingStops.add(nativeTunnelId); },
    };
}

/** The real supervisor over the recording native boundary: stop custody is observable, not restated by a fake. */
function supervisorOver(native: ReturnType<typeof createRecordingNativeLifecycle>) {
    return () => createIrohHomeTunnelSupervisor({ native: native.module, probe: async () => ({ ok: true }) });
}

describe('Iroh Home tunnel lifecycle runtime', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(async () => {
        await disposeIrohHomeTunnelRuntime().catch(() => undefined);
        resetRuntimeFetch();
        profiles.resetServerProfilesRuntimeForTests();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('retains the native listener across QUIC loss and republishes its recovered connection', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://terminal.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const native = createRecordingNativeLifecycle();
        let connectionActive = true;
        const getTunnelStatus = vi.fn(async () => ({ active: true, connectionActive, observedPath: 'direct' }));
        setRuntimeFetch(async (input) => String(input).endsWith('/v1/features')
            ? jsonResponse(200, identityFeaturesPayload(HOME_IDENTITY_A))
            : jsonResponse(200, { ok: true }));
        const runtime = createIrohHomeTunnelRuntime({ native: { ...native.module, getTunnelStatus } });
        const request = {
            homeServerIdentityId: HOME_IDENTITY_A, endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://terminal.example.test',
            verification: { kind: 'authenticated' as const, token: 'token-a' },
        };
        vi.useFakeTimers();
        try {
            const recovery = vi.fn();
            runtime.subscribeRecoveryRequired(recovery);
            const retained = await runtime.ensureHomeTunnel(request);
            connectionActive = false;
            await vi.advanceTimersByTimeAsync(2_000);
            expect(recovery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                homeServerIdentityId: HOME_IDENTITY_A, reason: 'degraded', activePublication: true,
            }));
            expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
            await vi.advanceTimersByTimeAsync(4_000);
            expect(recovery).toHaveBeenCalledTimes(1);
            connectionActive = true;
            await vi.advanceTimersByTimeAsync(2_000);
            expect(native.startCount()).toBe(1);
            expect(native.stops).toEqual([]);
            expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBe(retained.runtimeOrigin);
        } finally {
            await runtime.dispose();
        }
    });

    it.each(['active', 'secondary'] as const)('requests recovery only for a degraded active publication without restarting its native handle: %s', async (publication) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://degraded.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const native = createRecordingNativeLifecycle();
        let active = true;
        setRuntimeFetch(async (input) => String(input).endsWith('/v1/features')
            ? jsonResponse(200, createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: HOME_IDENTITY_A } } }))
            : jsonResponse(200, { ok: true }));
        const runtime = createIrohHomeTunnelRuntime({
            native: { ...native.module, getTunnelStatus: async () => ({ active, observedPath: 'direct' }) },
        });
        const recovery = vi.fn();
        runtime.subscribeRecoveryRequired(recovery);
        vi.useFakeTimers();
        try {
            const acquire = publication === 'active' ? runtime.ensureHomeTunnel : runtime.acquireHomeRuntimeOrigin;
            await acquire({ homeServerIdentityId: HOME_IDENTITY_A,
                endpoint: { endpointId: 'endpoint-a' }, canonicalServerUrl: home.serverUrl,
                verification: { kind: 'authenticated', token: 'token-a' } });
            await vi.advanceTimersByTimeAsync(0);
            active = false;
            await vi.advanceTimersByTimeAsync(2_000);
            if (publication === 'active') {
                expect(recovery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                    reason: 'degraded', activePublication: true, homeServerIdentityId: HOME_IDENTITY_A,
                }));
            }
            await vi.advanceTimersByTimeAsync(4_000);
            expect(recovery).toHaveBeenCalledTimes(publication === 'active' ? 1 : 0);
            expect(native.startCount()).toBe(1);
            expect(native.stops).toEqual([]);
        } finally { await runtime.dispose(); }
    });

    it('publishes the runtime origin only after native acquire, authenticated readiness, and identity proof', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://order.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });

        const events: string[] = [];
        let publishedAtFeatures = false;
        const native = {
            ensureHomeTunnel: vi.fn(async (input: { homeServerIdentityId: string; endpointId: string }) => {
                events.push('native:start');
                return nativeLease('native-lease-1', input.homeServerIdentityId, input.endpointId, 45901);
            }),
            releaseHomeTunnel: vi.fn(async () => undefined),
        };
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            events.push(url.endsWith('/health') ? 'probe:health' : url.endsWith('/v1/auth/ping') ? 'probe:auth-ping' : 'probe:features');
            if (url === 'http://127.0.0.1:45901/health') return jsonResponse(200, { ok: true });
            if (url === 'http://127.0.0.1:45901/v1/auth/ping') {
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-a');
                return jsonResponse(200, { ok: true });
            }
            if (url === 'http://127.0.0.1:45901/v1/features') {
                // The identity proof must run before any publication exists.
                publishedAtFeatures = profiles.getActiveServerSnapshot().runtimeOrigin !== undefined;
                return jsonResponse(200, identityFeaturesPayload(HOME_IDENTITY_A));
            }
            throw new Error(`unexpected request ${url}`);
        });
        const runtime = createIrohHomeTunnelRuntime({ native });
        const lease = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: {
                endpointId: 'endpoint-a',
                relayUrls: ['https://relay.example.test'],
                directAddresses: ['192.168.1.10:4242'],
            },
            canonicalServerUrl: 'https://order.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });

        expect(events[0]).toBe('native:start');
        expect(events).not.toContain('probe:health');
        expect(events.indexOf('probe:features')).toBeGreaterThan(events.indexOf('native:start'));
        expect(events.indexOf('probe:auth-ping')).toBeGreaterThan(events.indexOf('probe:features'));
        expect(publishedAtFeatures).toBe(false);

        const snapshot = profiles.getActiveServerSnapshot();
        expect(snapshot.runtimeOrigin).toBe('http://127.0.0.1:45901');
        expect(snapshot.carrier).toBe('iroh');
        expect(snapshot).not.toHaveProperty('irohObservedPath');
        expect(snapshot).not.toHaveProperty('irohRelayPolicy');
        expect(snapshot.serverUrl).toBe('https://order.example.test');
        expect(lease.observedPath).toBe('direct');
        expect(lease.carrier).toBe('iroh');

        // Descriptor/identity facts and the relay policy ride the native request;
        // the verification token never enters native configuration.
        expect(native.ensureHomeTunnel).toHaveBeenCalledWith({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpointId: 'endpoint-a',
            policy: 'automatic',
            relayUrls: ['https://relay.example.test'],
            directAddresses: ['192.168.1.10:4242'],
        });
    });

    it('acquires a verified pre-token runtime origin without publishing active-profile state and returns a scoped release', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const active = await profiles.upsertServerProfile({ serverUrl: 'https://active.example.test', source: 'manual' });
        await profiles.setActiveServerId(active.id, { scope: 'device' });

        const native = createRecordingNativeLifecycle();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: supervisorOver(native) });
        const acquired = await runtime.acquireHomeRuntimeOrigin({
            homeServerIdentityId: HOME_IDENTITY_B,
            endpoint: { endpointId: 'endpoint-b' },
            canonicalServerUrl: 'https://enrollment.example.test',
            verification: { kind: 'enrollment' },
        });

        expect(acquired).toMatchObject({
            carrier: 'iroh',
            observedPath: 'direct',
            runtimeOrigin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u),
        });
        expect(native.module.ensureHomeTunnel).toHaveBeenCalledWith(expect.objectContaining({
            homeServerIdentityId: HOME_IDENTITY_B,
            endpointId: 'endpoint-b',
        }));
        expect(profiles.getActiveServerSnapshot().serverId).toBe(profiles.resolveServerProfileScopeId(active));
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        expect(profiles.getActiveServerSnapshot().carrier).toBeUndefined();

        await acquired.release();
        expect(native.stops).toEqual(['native-lease-1']);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('fails closed without acquiring anything when the endpoint identity is missing', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://malformed.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });

        const native = {
            ensureHomeTunnel: vi.fn(async () => nativeLease('native-lease-never', HOME_IDENTITY_A, 'endpoint-a', 45971)),
            releaseHomeTunnel: vi.fn(async () => undefined),
        };
        const runtime = createIrohHomeTunnelRuntime({ native });

        await expect(runtime.ensureHomeTunnel({
            homeServerIdentityId: '   ',
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://malformed.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        })).rejects.toThrow('iroh_home_tunnel_invalid_endpoint');
        await expect(runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: '' },
            canonicalServerUrl: 'https://malformed.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        })).rejects.toThrow('iroh_home_tunnel_invalid_endpoint');

        expect(native.ensureHomeTunnel).not.toHaveBeenCalled();
        expect(native.releaseHomeTunnel).not.toHaveBeenCalled();
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it.each([
        {
            reason: 'identity-mismatch',
            port: 45911,
            respond: (pathname: string) => pathname === '/v1/features'
                ? jsonResponse(200, identityFeaturesPayload('srv_home_other'))
                : jsonResponse(200, { ok: true }),
        },
        {
            reason: 'auth-failed',
            port: 45921,
            respond: (pathname: string) => pathname === '/v1/auth/ping'
                ? jsonResponse(403, { error: 'forbidden' })
                : jsonResponse(200, identityFeaturesPayload(HOME_IDENTITY_A)),
        },
        {
            reason: 'health-unavailable',
            port: 45931,
            respond: (pathname: string) => pathname === '/v1/features'
                ? jsonResponse(200, identityFeaturesPayload(HOME_IDENTITY_A))
                : jsonResponse(503, { error: 'unavailable' }),
        },
    ])('releases the native lease and never publishes when the readiness probe fails with $reason', async ({ reason, port, respond }) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: `https://${reason}.example.test`, source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });

        const native = {
            ensureHomeTunnel: vi.fn(async () => nativeLease(`native-lease-${reason}`, HOME_IDENTITY_A, 'endpoint-a', port)),
            releaseHomeTunnel: vi.fn(async () => undefined),
        };
        setRuntimeFetch(async (input) => {
            const url = new URL(String(input));
            if (url.origin !== `http://127.0.0.1:${port}`) throw new Error(`unexpected request ${url.href}`);
            return respond(url.pathname);
        });
        const runtime = createIrohHomeTunnelRuntime({ native });

        await expect(runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: `https://${reason}.example.test`,
            verification: { kind: 'authenticated', token: 'token-a' },
        })).rejects.toThrow(`iroh_home_tunnel_probe_failed:${reason}`);

        expect(native.releaseHomeTunnel).toHaveBeenCalledWith(`native-lease-${reason}`);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('retains failed-start cleanup custody and retries the exact native lease during runtime disposal', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();

        let rejectFirstStop = true;
        const native = {
            ensureHomeTunnel: vi.fn(async () => nativeLease('native-lease-failed-start', HOME_IDENTITY_A, 'endpoint-a', 45932)),
            releaseHomeTunnel: vi.fn(async () => {
                if (rejectFirstStop) {
                    rejectFirstStop = false;
                    throw new Error('native stop failed');
                }
            }),
        };
        const runtime = createIrohHomeTunnelRuntime({
            createSupervisor: () => createIrohHomeTunnelSupervisor({
                native,
                probe: async () => ({ ok: false, reason: 'health-unavailable' }),
            }),
        });
        const input: IrohHomeTunnelAcquireInput = {
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://failed-start.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        };

        await expect(runtime.acquireHomeRuntimeOrigin(input)).rejects.toMatchObject({
            name: 'LoopbackTunnelPostAcquisitionError',
            message: 'iroh_home_tunnel_probe_failed:health-unavailable',
            cleanupError: expect.objectContaining({ message: 'native stop failed' }),
        });
        expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(1);
        expect(native.releaseHomeTunnel).toHaveBeenCalledTimes(1);
        expect(native.releaseHomeTunnel).toHaveBeenLastCalledWith('native-lease-failed-start');

        await runtime.dispose();

        expect(native.releaseHomeTunnel).toHaveBeenCalledTimes(2);
        expect(native.releaseHomeTunnel).toHaveBeenLastCalledWith('native-lease-failed-start');
        expect(runtime.listTunnels().leases).toEqual([]);
    });

    it('stops the native tunnel exactly once per released lease and never again on disposal', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const native = createRecordingNativeLifecycle();
        const runtime = createIrohHomeTunnelRuntime({
            createSupervisor: () => createIrohHomeTunnelSupervisor({
                native: native.module,
                probe: async () => ({ ok: true }),
            }),
        });

        const lease = await runtime.acquireHomeRuntimeOrigin({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://single-stop.example.test',
            verification: { kind: 'enrollment' },
        });

        await lease.release();
        // The returned release stays idempotent for its own caller.
        await lease.release();
        expect(native.stops).toEqual(['native-lease-1']);
        expect(runtime.listTunnels().leases).toEqual([]);

        // Disposal must not stop a handle the supervisor already released.
        await runtime.dispose();
        expect(native.stops).toEqual(['native-lease-1']);
    });

    it('keeps a failed native stop owned by the supervisor and retries it on the next release', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const native = createRecordingNativeLifecycle();
        const runtime = createIrohHomeTunnelRuntime({
            createSupervisor: () => createIrohHomeTunnelSupervisor({
                native: native.module,
                probe: async () => ({ ok: true }),
            }),
        });

        const lease = await runtime.acquireHomeRuntimeOrigin({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://failed-stop.example.test',
            verification: { kind: 'enrollment' },
        });
        native.failNextStop('native-lease-1');

        await expect(lease.release()).rejects.toThrow('native stop failed');
        expect(native.stops).toEqual(['native-lease-1']);
        // Custody is not lost: the supervisor still owns the failed handle.
        expect(runtime.listTunnels().leases).toMatchObject([{ leaseId: lease.leaseId, status: 'failed' }]);

        await lease.release();
        expect(native.stops).toEqual(['native-lease-1', 'native-lease-1']);
        expect(runtime.listTunnels().leases).toEqual([]);
    });

    it('unpublishes before disposal, retries the failed native stop, and leaves no publication custody behind', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://dispose-custody.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const native = createRecordingNativeLifecycle();
        const runtime = createIrohHomeTunnelRuntime({
            createSupervisor: () => createIrohHomeTunnelSupervisor({
                native: native.module,
                probe: async () => ({ ok: true }),
            }),
        });

        const lease = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://dispose-custody.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBe(lease.localUrl);
        native.failNextStop('native-lease-1');

        await expect(runtime.dispose()).rejects.toThrow('native stop failed');
        // The publication is cleared even though the native stop failed...
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        // ...and the failed handle remains owned by the supervisor for retry.
        expect(native.stops).toEqual(['native-lease-1']);
        expect(runtime.listTunnels().leases).toMatchObject([{ status: 'failed' }]);

        await runtime.dispose();
        expect(native.stops).toEqual(['native-lease-1', 'native-lease-1']);
        expect(runtime.listTunnels().leases).toEqual([]);

        // No leaked publication or duplicate ownership can drive a third stop.
        await runtime.dispose();
        await runtime.releaseActiveHomeTunnels();
        expect(native.stops).toEqual(['native-lease-1', 'native-lease-1']);
    });

    it('shares one native tunnel across concurrent leases and stops it only after the last reference releases', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const native = createRecordingNativeLifecycle();
        const runtime = createIrohHomeTunnelRuntime({
            createSupervisor: () => createIrohHomeTunnelSupervisor({
                native: native.module,
                probe: async () => ({ ok: true }),
            }),
        });
        const input: IrohHomeTunnelAcquireInput = {
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://shared-lease.example.test',
            verification: { kind: 'enrollment' },
        };

        const first = await runtime.acquireHomeRuntimeOrigin(input);
        const second = await runtime.acquireHomeRuntimeOrigin(input);
        expect(second.leaseId).toBe(first.leaseId);
        expect(native.startCount()).toBe(1);

        await first.release();
        // A live second reference must keep the shared native tunnel running.
        expect(native.stops).toEqual([]);
        expect(runtime.listTunnels().leases).toHaveLength(1);

        await second.release();
        expect(native.stops).toEqual(['native-lease-1']);
        expect(runtime.listTunnels().leases).toEqual([]);

        await runtime.dispose();
        expect(native.stops).toEqual(['native-lease-1']);
    });

    it('releases the native lease and never publishes when focus changes during acquisition', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://stale-first.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://stale-second.example.test', source: 'manual' });
        await profiles.setActiveServerId(first.id, { scope: 'device' });

        let resolveNative: ((value: ReturnType<typeof nativeLease>) => void) | undefined;
        const native = {
            ensureHomeTunnel: vi.fn(async () => await new Promise<ReturnType<typeof nativeLease>>((resolve) => { resolveNative = resolve; })),
            releaseHomeTunnel: vi.fn(async () => undefined),
        };
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url === 'http://127.0.0.1:45941/health') return jsonResponse(200, { ok: true });
            if (url === 'http://127.0.0.1:45941/v1/auth/ping') return jsonResponse(200, { ok: true });
            if (url === 'http://127.0.0.1:45941/v1/features') {
                return jsonResponse(200, identityFeaturesPayload(HOME_IDENTITY_A));
            }
            throw new Error(`unexpected request ${url}`);
        });
        const runtime = createIrohHomeTunnelRuntime({ native });

        const pending = runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://stale-first.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        await vi.waitFor(() => expect(resolveNative).toBeTypeOf('function'));
        await profiles.setActiveServerId(second.id, { scope: 'device' });
        resolveNative!(nativeLease('native-lease-stale', HOME_IDENTITY_A, 'endpoint-a', 45941));

        await expect(pending).rejects.toThrow('iroh_home_tunnel_stale_focus');
        expect(native.releaseHomeTunnel).toHaveBeenCalledWith('native-lease-stale');
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('reports an honest typed outcome and never publishes when the native module is unavailable', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://nonative.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const runtimeFetch = vi.fn(async () => jsonResponse(200, {}));
        setRuntimeFetch(runtimeFetch);
        const runtime = createIrohHomeTunnelRuntime({ native: null });

        await expect(runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://nonative.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        })).rejects.toThrow(/unavailable/i);

        expect(runtimeFetch).not.toHaveBeenCalled();
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('reuses one verified lease per Home identity and descriptor facts, not per request', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://reuse.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });

        let nativeStarts = 0;
        const native = {
            ensureHomeTunnel: vi.fn(async (input: { endpointId: string }) => {
                nativeStarts += 1;
                return nativeLease(`native-lease-reuse-${nativeStarts}`, HOME_IDENTITY_A, input.endpointId, 45950 + nativeStarts);
            }),
            releaseHomeTunnel: vi.fn(async () => undefined),
        };
        let probeRound = 0;
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return jsonResponse(200, { ok: true });
            if (url.endsWith('/v1/features')) {
                probeRound += 1;
                return jsonResponse(200, identityFeaturesPayload(HOME_IDENTITY_A));
            }
            throw new Error(`unexpected request ${url}`);
        });
        const runtime = createIrohHomeTunnelRuntime({ native });
        const input: IrohHomeTunnelAcquireInput = {
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://reuse.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        };

        const firstLease = await runtime.ensureHomeTunnel(input);
        // Same key facts (the token is not a key fact): the retained lease is re-verified and reused.
        const secondLease = await runtime.ensureHomeTunnel({
            ...input,
            verification: { kind: 'authenticated', token: 'token-a-rotated' },
        });
        expect(secondLease.leaseId).toBe(firstLease.leaseId);
        expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(1);
        expect(probeRound).toBe(2);

        // Different endpoint facts invalidate the lease and force a new native acquisition.
        const otherLease = await runtime.ensureHomeTunnel({
            ...input,
            endpoint: { endpointId: 'endpoint-a-rev2' },
        });
        expect(otherLease.leaseId).not.toBe(firstLease.leaseId);
        expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(2);
        // The active publication owns one reference. Re-acquiring the same
        // lease replaces that reference, and changing descriptor facts releases
        // the superseded native tunnel rather than leaking it.
        expect(native.releaseHomeTunnel).toHaveBeenCalledTimes(1);
        expect(native.releaseHomeTunnel).toHaveBeenCalledWith('native-lease-reuse-1');
    });

    type RetainedCleanupContext = {
        runtime: ReturnType<typeof createIrohHomeTunnelRuntime>;
        native: ReturnType<typeof createRecordingNativeLifecycle>;
        first: Awaited<ReturnType<typeof profiles.upsertServerProfile>>;
        second: Awaited<ReturnType<typeof profiles.upsertServerProfile>>;
        urlFor: (name: string) => string;
    };
    const ensureHomeA = (runtime: RetainedCleanupContext['runtime'], canonicalServerUrl: string, endpointId = 'endpoint-a') =>
        runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId },
            canonicalServerUrl,
            verification: { kind: 'authenticated', token: 'token-a' },
        });

    // One retained-custody contract (a failed native stop stays owned and is retried by the owning lifecycle
    // entry point), reached from three different cleanup origins on the real supervisor.
    it.each<{ origin: string; run: (context: RetainedCleanupContext) => Promise<void> }>([
        {
            origin: 'a focus-race publication rejected, retried by stale-target release',
            run: async ({ runtime, native, first, second, urlFor }) => {
                let resolveEnsure: (() => void) | undefined;
                native.module.ensureHomeTunnel.mockImplementationOnce(async (input: { homeServerIdentityId: string; endpointId: string }) =>
                    await new Promise<ReturnType<typeof nativeLease>>((resolve) => {
                        resolveEnsure = () => resolve(nativeLease('native-lease-1', input.homeServerIdentityId, input.endpointId, 45962));
                    }));
                native.failNextStop('native-lease-1');
                await profiles.setActiveServerId(first.id, { scope: 'device' });
                const pending = ensureHomeA(runtime, urlFor('first'));
                await vi.waitFor(() => expect(resolveEnsure).toBeTypeOf('function'));
                await profiles.setActiveServerId(second.id, { scope: 'device' });
                resolveEnsure!();
                await expect(pending).rejects.toThrow('iroh_home_tunnel_stale_focus');
                await runtime.releaseLeasesForStaleTargets();
            },
        },
        {
            origin: 'a stale-generation lease, retried by stale-target release',
            run: async ({ runtime, native, first, second, urlFor }) => {
                await profiles.setActiveServerId(first.id, { scope: 'device' });
                await ensureHomeA(runtime, urlFor('first'));
                await profiles.setActiveServerId(second.id, { scope: 'device' });
                native.failNextStop('native-lease-1');
                await runtime.releaseLeasesForStaleTargets();
                await runtime.releaseLeasesForStaleTargets();
            },
        },
        {
            origin: 'a superseded lease, retried by active shutdown',
            run: async ({ runtime, native, first, urlFor }) => {
                await profiles.setActiveServerId(first.id, { scope: 'device' });
                await ensureHomeA(runtime, urlFor('first'));
                native.failNextStop('native-lease-1');
                await ensureHomeA(runtime, urlFor('first'), 'endpoint-a-revision-2');
                await runtime.releaseActiveHomeTunnels();
            },
        },
    ])('retains failed native cleanup custody for $origin', async ({ run }) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const token = Math.random().toString(16).slice(2);
        const urlFor = (name: string) => `https://retry-${token}-${name}.example.test`;
        const first = await profiles.upsertServerProfile({ serverUrl: urlFor('first'), source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: urlFor('second'), source: 'manual' });
        const native = createRecordingNativeLifecycle();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: supervisorOver(native) });

        await run({ runtime, native, first, second, urlFor });

        // The first stop failed and was retained; exactly one retry stopped it, then custody ended.
        expect(native.stops.filter((id) => id === 'native-lease-1')).toHaveLength(2);
        expect(runtime.listTunnels().leases.filter((lease) => lease.status === 'failed')).toEqual([]);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('keeps the focused Home lease published when a stale Home lease is released late', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://ab-first.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://ab-second.example.test', source: 'manual' });
        const fake = createSupervisorFake();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });

        await profiles.setActiveServerId(first.id, { scope: 'device' });
        await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://ab-first.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        await profiles.setActiveServerId(second.id, { scope: 'device' });
        const leaseB = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_B,
            endpoint: { endpointId: 'endpoint-b' },
            canonicalServerUrl: 'https://ab-second.example.test',
            verification: { kind: 'authenticated', token: 'token-b' },
        });

        // The stale Home A lease (from before the switch) is released late...
        await runtime.releaseHomeTunnel('lease-1');

        // ...and must not clear or overwrite the focused Home B publication.
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: profiles.resolveServerProfileScopeId(second),
            runtimeOrigin: leaseB.localUrl,
            carrier: 'iroh',
        });

        // Releasing the focused lease unpublishes only its own target-scoped origin.
        await runtime.releaseHomeTunnel(leaseB.leaseId);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        expect(profiles.getActiveServerSnapshot().carrier).toBeUndefined();
    });

    it('keeps the newest Home A lease published when an old A lease is released after refocusing A', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://aba-first.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://aba-second.example.test', source: 'manual' });
        const fake = createSupervisorFake();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });

        await profiles.setActiveServerId(first.id, { scope: 'device' });
        await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://aba-first.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        await profiles.setActiveServerId(second.id, { scope: 'device' });
        await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_B,
            endpoint: { endpointId: 'endpoint-b' },
            canonicalServerUrl: 'https://aba-second.example.test',
            verification: { kind: 'authenticated', token: 'token-b' },
        });
        await profiles.setActiveServerId(first.id, { scope: 'device' });
        const leaseANew = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://aba-first.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });

        // Releasing the superseded first A publication must not clear the newest A lease.
        await runtime.releaseHomeTunnel('lease-1');

        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: profiles.resolveServerProfileScopeId(first),
            runtimeOrigin: leaseANew.localUrl,
            carrier: 'iroh',
        });
    });

    it('releases leases from a prior Home/focus generation during the switch', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://reap-first.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://reap-second.example.test', source: 'manual' });
        const fake = createSupervisorFake();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });

        await profiles.setActiveServerId(first.id, { scope: 'device' });
        const leaseA = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://reap-first.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        await profiles.setActiveServerId(second.id, { scope: 'device' });

        await runtime.releaseLeasesForStaleTargets();

        expect(fake.releaseTunnel).toHaveBeenCalledWith(leaseA.leaseId);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('unpublishes while suspended and republishes only a lease the foreground re-probe verified', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://lifecycle.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });

        const fake = createSupervisorFake();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });

        const lease = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://lifecycle.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBe(lease.localUrl);

        runtime.markSuspended();
        expect(fake.markSuspended).toHaveBeenCalledTimes(1);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();

        // Foreground with a verified-ready lease republishes for the still-focused Home.
        await runtime.markForeground();
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBe(lease.localUrl);

        // Foreground with a lease that failed its re-probe must not republish.
        runtime.markSuspended();
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        fake.listTunnels.mockImplementationOnce(() => ({
            leases: [{ ...lease, status: 'failed' }],
            platformLimitations: [],
        }));
        await runtime.markForeground();
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('keeps a foreground-ready lease unpublished when its focused Home generation is stale', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://stale-foreground.example.test', source: 'manual' });
        const otherHome = await profiles.upsertServerProfile({ serverUrl: 'https://other-foreground.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const fake = createSupervisorFake();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });
        const recoveryEvents: unknown[] = [];
        runtime.subscribeRecoveryRequired((event) => recoveryEvents.push(event));
        const lease = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://stale-foreground.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });

        runtime.markSuspended();
        await profiles.setActiveServerId(otherHome.id, { scope: 'device' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        await runtime.markForeground();

        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        expect(recoveryEvents).toEqual([
            expect.objectContaining({
                leaseId: lease.leaseId,
                homeServerIdentityId: HOME_IDENTITY_A,
                reason: 'stale_generation',
                activePublication: true,
            }),
        ]);
        expect(fake.releaseTunnel).not.toHaveBeenCalled();

        await runtime.releaseLeasesForStaleTargets();
        expect(fake.releaseTunnel).toHaveBeenCalledWith(lease.leaseId);
    });

    it('attempts every active release, retains failed ownership, and retries only the failed lease', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://release-all-first.example.test', source: 'manual' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://release-all-second.example.test', source: 'manual' });
        const fake = createSupervisorFake();
        let failFirstLease = true;
        fake.releaseTunnel.mockImplementation(async (leaseId: string) => {
            if (leaseId === 'lease-1' && failFirstLease) throw new Error('first native stop failed');
        });
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });

        await profiles.setActiveServerId(first.id, { scope: 'device' });
        await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://release-all-first.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        await profiles.setActiveServerId(second.id, { scope: 'device' });
        await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_B,
            endpoint: { endpointId: 'endpoint-b' },
            canonicalServerUrl: 'https://release-all-second.example.test',
            verification: { kind: 'authenticated', token: 'token-b' },
        });

        fake.releaseTunnel.mockClear();
        await expect(runtime.releaseActiveHomeTunnels()).rejects.toThrow('first native stop failed');
        expect(fake.releaseTunnel).toHaveBeenCalledWith('lease-1');
        expect(fake.releaseTunnel).toHaveBeenCalledWith('lease-2');
        // The focused lease's publication is cleared even though another lease's stop failed.
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();

        fake.releaseTunnel.mockClear();
        failFirstLease = false;
        await runtime.releaseActiveHomeTunnels();
        expect(fake.releaseTunnel).toHaveBeenCalledTimes(1);
        expect(fake.releaseTunnel).toHaveBeenCalledWith('lease-1');
    });

    it('disposes the singleton through its runtime owner, stopping every lease including lifecycle-neutral ones the consumer never released', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://dispose.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const native = createRecordingNativeLifecycle();
        const runtime = getIrohHomeTunnelRuntime({ createSupervisor: supervisorOver(native) });
        const focused = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://dispose.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        // A second, unpublished lifecycle-neutral lease whose consumer never releases it.
        await runtime.acquireHomeRuntimeOrigin({
            homeServerIdentityId: HOME_IDENTITY_B,
            endpoint: { endpointId: 'endpoint-b' },
            canonicalServerUrl: 'https://neutral-dispose.example.test',
            verification: { kind: 'enrollment' },
        });
        expect(runtime.listTunnels().leases).toHaveLength(2);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBe(focused.localUrl);

        await disposeIrohHomeTunnelRuntime();

        // The supervisor owns the native handles: exactly one stop each, no second
        // release from a duplicate runtime-side ownership record.
        expect([...native.stops].sort()).toEqual(['native-lease-1', 'native-lease-2']);
        expect(runtime.listTunnels().leases).toEqual([]);
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
    });

    it('keeps the singleton and lifecycle owner when disposal fails, then retries cleanup through that same owner', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://dispose-retry.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const native = createRecordingNativeLifecycle();
        const runtime = getIrohHomeTunnelRuntime({ createSupervisor: supervisorOver(native) });
        await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://dispose-retry.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        native.failNextStop('native-lease-1');

        await expect(disposeIrohHomeTunnelRuntime()).rejects.toThrow('native stop failed');
        // The origin is unpublished before any stop is attempted, and the failed
        // native handle stays owned by the same supervisor.
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        expect(native.stops).toEqual(['native-lease-1']);
        expect(runtime.listTunnels().leases).toMatchObject([{ status: 'failed' }]);
        expect(getIrohHomeTunnelRuntime({ createSupervisor: supervisorOver(createRecordingNativeLifecycle()) })).toBe(runtime);

        await disposeIrohHomeTunnelRuntime();
        expect(native.stops).toEqual(['native-lease-1', 'native-lease-1']);
        expect(runtime.listTunnels().leases).toEqual([]);
        expect(getIrohHomeTunnelRuntime({ createSupervisor: supervisorOver(createRecordingNativeLifecycle()) })).not.toBe(runtime);
    });

    it('closes admission while singleton disposal is in flight, releases an admitted late lease, and refuses all work once disposed', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://dispose-race.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });

        let resolveNative: ((value: ReturnType<typeof nativeLease>) => void) | undefined;
        const native = {
            ensureHomeTunnel: vi.fn(async (input: { homeServerIdentityId: string; endpointId: string }) =>
                await new Promise<ReturnType<typeof nativeLease>>((resolve) => { resolveNative = resolve; })),
            releaseHomeTunnel: vi.fn(async () => undefined),
        };
        const runtime = getIrohHomeTunnelRuntime({
            createSupervisor: () => createIrohHomeTunnelSupervisor({ native, probe: async () => ({ ok: true }) }),
        });

        const admitted = runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://dispose-race.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        await vi.waitFor(() => expect(resolveNative).toBeTypeOf('function'));

        const disposal = disposeIrohHomeTunnelRuntime();
        // Module disposal first settles retained machine leases (promise chains only), then closes the
        // runtime; one macrotask hop deterministically reaches the in-flight state.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The singleton stays published for in-flight callers, but its work entry points refuse while
        // disposal settles the admitted start.
        expect(getIrohHomeTunnelRuntime()).toBe(runtime);
        expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(1);
        await expect(runtime.acquireHomeRuntimeOrigin({
            homeServerIdentityId: HOME_IDENTITY_B,
            endpoint: { endpointId: 'endpoint-b' },
            canonicalServerUrl: 'https://dispose-race.example.test',
            verification: { kind: 'enrollment' },
        })).rejects.toThrow('iroh_home_tunnel_disposed');
        expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(1);

        // The admitted start settles, but its late handle is released and the
        // runtime origin is never published after disposal began.
        resolveNative!(nativeLease('native-lease-late', HOME_IDENTITY_A, 'endpoint-a', 45981));
        await expect(admitted).rejects.toThrow('iroh_home_tunnel_disposed');
        await disposal;
        expect(native.releaseHomeTunnel).toHaveBeenCalledWith('native-lease-late');
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();

        // A disposed runtime refuses further acquisitions without starting native work.
        const input: IrohHomeTunnelAcquireInput = {
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://dispose-race.example.test',
            verification: { kind: 'enrollment' },
        };
        await expect(runtime.acquireHomeRuntimeOrigin(input)).rejects.toThrow('iroh_home_tunnel_disposed');
        await expect(runtime.ensureHomeTunnel(input)).rejects.toThrow('iroh_home_tunnel_disposed');
        expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(1);
    });

    it('keeps the active runtime published across a transient native status observation error, then unpublishes the matching generation on transport closure', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://status-error.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const fake = createSupervisorFake();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });
        const recoveryEvents: unknown[] = [];
        runtime.subscribeRecoveryRequired((event) => recoveryEvents.push(event));
        const lease = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://status-error.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });
        const publishedOrigin = profiles.getActiveServerSnapshot().runtimeOrigin;

        fake.emit({
            type: 'error',
            tunnelHandle: 'native-event',
            status: 'error',
            errorCode: 'status_observation_failed',
            atMs: 10,
            lease,
        });

        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBe(publishedOrigin);
        expect(profiles.getActiveServerSnapshot().carrier).toBe('iroh');
        expect(recoveryEvents).toEqual([]);

        fake.emit({
            type: 'closed',
            tunnelHandle: 'native-event',
            status: 'closed',
            errorCode: 'transport_closed',
            atMs: 11,
            lease: { ...lease, status: 'stopped' },
        });
        expect(profiles.getActiveServerSnapshot().runtimeOrigin).toBeUndefined();
        expect(profiles.getActiveServerSnapshot().carrier).toBeUndefined();
        expect(recoveryEvents).toEqual([
            expect.objectContaining({ leaseId: lease.leaseId, reason: 'terminal' }),
        ]);
    });

    it('requests replacement for a terminal native lease and a foreground probe failure', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://recover.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const fake = createSupervisorFake();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });
        const recoveryEvents: unknown[] = [];
        runtime.subscribeRecoveryRequired((event) => recoveryEvents.push(event));
        const lease = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://recover.example.test',
            verification: { kind: 'authenticated', token: 'token-a' },
        });

        fake.emit({
            type: 'closed', tunnelHandle: 'native-event', status: 'closed',
            errorCode: 'transport_closed', atMs: 10, lease: { ...lease, status: 'stopped' },
        });
        expect(recoveryEvents).toEqual([
            expect.objectContaining({ leaseId: lease.leaseId, homeServerIdentityId: HOME_IDENTITY_A, reason: 'terminal' }),
        ]);

        recoveryEvents.length = 0;
        runtime.markSuspended();
        fake.listTunnels.mockImplementationOnce(() => ({
            leases: [{ ...lease, status: 'failed' }],
            platformLimitations: [],
        }));
        await runtime.markForeground();
        expect(recoveryEvents).toEqual([
            expect.objectContaining({ leaseId: lease.leaseId, homeServerIdentityId: HOME_IDENTITY_A, reason: 'foreground_probe_failed' }),
        ]);
    });

    it('keeps native path telemetry diagnostic-only without republishing the active Home snapshot', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://path.example.test', source: 'manual' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const fake = createSupervisorFake();
        const runtime = createIrohHomeTunnelRuntime({ createSupervisor: () => fake.supervisor });
        const lease = await runtime.ensureHomeTunnel({
            homeServerIdentityId: HOME_IDENTITY_A,
            endpoint: { endpointId: 'endpoint-a' },
            canonicalServerUrl: 'https://path.example.test',
            policy: 'automatic',
            verification: { kind: 'authenticated', token: 'token-a' },
        });

        const publishedSnapshot = profiles.getActiveServerSnapshot();
        expect(publishedSnapshot).toMatchObject({ carrier: 'iroh' });
        expect(publishedSnapshot).not.toHaveProperty('irohObservedPath');
        expect(publishedSnapshot).not.toHaveProperty('irohRelayPolicy');

        fake.emit({
            type: 'path_changed',
            tunnelHandle: 'native-path',
            status: 'ready',
            observedPath: 'relay',
            atMs: 11,
            lease: { ...lease, observedPath: 'relay' },
        });

        expect(profiles.getActiveServerSnapshot()).toBe(publishedSnapshot);
    });
});
