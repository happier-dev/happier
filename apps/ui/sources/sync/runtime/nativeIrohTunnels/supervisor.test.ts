import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIrohHomeTunnelSupervisor } from './supervisor';
import type { IrohHomeTunnelRequest } from './types';
import { readIrohHomeTransportDiagnostics } from '@/sync/runtime/irohHomeTransportDiagnostics';

function homeIdentity(scope: string, index: number | string): string {
    return `srv_${scope}_${typeof index === 'number' ? String(index).padStart(3, '0') : index}`;
}

function readScopeDiagnostics(scope: string) {
    const prefix = `srv_${scope}_`;
    return readIrohHomeTransportDiagnostics().filter(
        (entry) => entry.homeServerIdentityId.startsWith(prefix),
    );
}

function makeRequest(homeServerIdentityId: string): IrohHomeTunnelRequest {
    return {
        remoteHostId: `profile-${homeServerIdentityId}`,
        purpose: 'home',
        homeServerIdentityId,
        endpointId: `endpoint-${homeServerIdentityId}`,
        canonicalServerUrl: `https://${homeServerIdentityId}.example.test`,
        policy: 'automatic',
        verification: { kind: 'authenticated', token: 'token-a' },
    };
}

function createNativeFake() {
    let counter = 0;
    return {
        ensureHomeTunnel: vi.fn(async (input: { homeServerIdentityId: string; endpointId: string }) => {
            counter += 1;
            return {
                leaseId: `native-lease-${counter}`,
                homeServerIdentityId: input.homeServerIdentityId,
                homeEndpointId: input.endpointId,
                runtimeOrigin: `http://127.0.0.1:${45000 + counter}`,
                carrier: 'iroh' as const,
                observedPath: 'direct' as const,
                startedAtMs: counter,
            };
        }),
        releaseHomeTunnel: vi.fn(async () => undefined),
    };
}

function createSupervisorUnderTest() {
    return createIrohHomeTunnelSupervisor({
        native: createNativeFake(),
        probe: async () => ({ ok: true }),
    });
}

describe('Iroh Home transport diagnostics retention', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('retains the same native Home lease and URL while its connection degrades and recovers', async () => {
        vi.useFakeTimers();
        let connectionActive = true;
        const native = {
            ...createNativeFake(),
            getTunnelStatus: vi.fn(async () => ({
                active: true,
                connectionActive,
                observedPath: 'direct' as const,
            })),
        };
        const supervisor = createIrohHomeTunnelSupervisor({
            native,
            probe: async () => ({ ok: true }),
        });
        try {
            const lease = await supervisor.ensureTunnel(makeRequest(homeIdentity('recovery', 1)));
            await vi.advanceTimersByTimeAsync(0);

            connectionActive = false;
            await vi.advanceTimersToNextTimerAsync();
            expect(supervisor.listTunnels().leases).toEqual([
                expect.objectContaining({ leaseId: lease.leaseId, localUrl: lease.localUrl, status: 'degraded' }),
            ]);
            expect(native.releaseHomeTunnel).not.toHaveBeenCalled();

            connectionActive = true;
            await vi.advanceTimersToNextTimerAsync();
            expect(supervisor.listTunnels().leases).toEqual([
                expect.objectContaining({ leaseId: lease.leaseId, localUrl: lease.localUrl, status: 'ready' }),
            ]);
            expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(1);
            expect(native.releaseHomeTunnel).not.toHaveBeenCalled();

            await supervisor.releaseTunnel(lease.leaseId);
            expect(native.releaseHomeTunnel).toHaveBeenCalledExactlyOnceWith('native-lease-1');
        } finally {
            await supervisor.dispose();
            vi.useRealTimers();
        }
    });

    it('retains inactive Home history without an arbitrary eviction bound and never evicts a Home holding an active lease', async () => {
        const supervisor = createSupervisorUnderTest();
        const scope = 'retention';
        const activeHomes = 70;
        for (let index = 0; index < activeHomes; index += 1) {
            await supervisor.ensureTunnel(makeRequest(homeIdentity(scope, `active${index}`)));
        }
        const releasedHomes = 80;
        for (let index = 0; index < releasedHomes; index += 1) {
            const lease = await supervisor.ensureTunnel(makeRequest(homeIdentity(scope, index)));
            await supervisor.releaseTunnel(lease.leaseId);
        }

        const diagnostics = readScopeDiagnostics(scope);
        // Diagnostics are a technical projection, not a product quota. Keep
        // every Home until its owner is replaced, rather than silently
        // evicting valid support data at an invented count; the oldest-transition
        // Homes still hold live leases and are never evicted for newer ones.
        expect(diagnostics.length).toBe(activeHomes + releasedHomes);
        const retained = diagnostics.map((entry) => entry.homeServerIdentityId);
        expect(retained).toContain(homeIdentity(scope, releasedHomes - 1));
        expect(retained).toContain(homeIdentity(scope, 0));
        const active = diagnostics.filter((entry) => entry.homeServerIdentityId.includes('active'));
        expect(active).toHaveLength(activeHomes);
        expect(active.every((entry) => entry.state === 'connected')).toBe(true);
    });

    it('ages a Home fact through the existing release lifecycle and keeps its proven last-known path', async () => {
        const supervisor = createSupervisorUnderTest();
        const scope = 'release';
        const lease = await supervisor.ensureTunnel({
            ...makeRequest(homeIdentity(scope, 1)),
            relayUrls: ['https://relay.example.test'],
        });
        expect(readScopeDiagnostics(scope)[0]).toMatchObject({
            state: 'connected',
            remoteEndpointId: `endpoint-${homeIdentity(scope, 1)}`,
            effectiveConfiguration: { policy: 'automatic', relayUrls: ['https://relay.example.test'] },
            current: { carrier: 'iroh' },
        });

        await supervisor.releaseTunnel(lease.leaseId);

        const [released] = readScopeDiagnostics(scope);
        expect(released?.homeServerIdentityId).toBe(homeIdentity(scope, 1));
        expect(released?.state).toBe('disconnected');
        expect(released?.current).toBeUndefined();
        expect(released?.lastKnown).toEqual({ carrier: 'iroh', observedPath: 'direct' });
    });

    it('ages every owned Home fact when the runtime is disposed', async () => {
        const supervisor = createSupervisorUnderTest();
        const scope = 'dispose';
        await supervisor.ensureTunnel(makeRequest(homeIdentity(scope, 1)));
        await supervisor.ensureTunnel(makeRequest(homeIdentity(scope, 2)));

        await supervisor.dispose();

        const diagnostics = readScopeDiagnostics(scope);
        expect(diagnostics.map((entry) => entry.homeServerIdentityId)).toEqual([
            homeIdentity(scope, 1),
            homeIdentity(scope, 2),
        ]);
        expect(diagnostics.every((entry) => entry.state === 'disconnected')).toBe(true);
        expect(diagnostics.every((entry) => entry.current === undefined)).toBe(true);
    });

    it('reports a failed retained-custody retry and clears custody only after a later disposal succeeds', async () => {
        const releaseAttempts = new Map<string, number>();
        const releaseHomeTunnel = vi.fn(async (leaseId: string) => {
            const attempts = (releaseAttempts.get(leaseId) ?? 0) + 1;
            releaseAttempts.set(leaseId, attempts);
            if (attempts <= 3) throw new Error(`native release failed: ${leaseId}`);
        });
        const supervisor = createIrohHomeTunnelSupervisor({
            native: {
                // A misrouted native result: the lease is bound to another Home,
                // so the adapter fails closed and must clean the lease up.
                ensureHomeTunnel: vi.fn(async (input: { endpointId: string }) => ({
                    leaseId: `native-lease-${input.endpointId}`,
                    homeServerIdentityId: 'srv_home_other',
                    homeEndpointId: input.endpointId,
                    runtimeOrigin: 'http://127.0.0.1:45001',
                    carrier: 'iroh' as const,
                    observedPath: 'direct' as const,
                    startedAtMs: 1,
                })),
                releaseHomeTunnel,
            },
            probe: async () => ({ ok: true }),
        });

        await expect(supervisor.ensureTunnel(makeRequest(homeIdentity('custody', 1))))
            .rejects.toMatchObject({ code: 'identity_mismatch' });
        await expect(supervisor.ensureTunnel(makeRequest(homeIdentity('custody', 2))))
            .rejects.toMatchObject({ code: 'identity_mismatch' });
        // Immediate cleanup plus one retry at the failed start's terminal
        // boundary; the still-unreleased lease stays owned rather than orphaned.
        expect([...releaseAttempts.values()]).toEqual([2, 2]);

        await expect(supervisor.dispose()).rejects.toThrow('Failed to dispose every Iroh Home tunnel.');

        expect([...releaseAttempts.values()]).toEqual([3, 3]);

        await supervisor.dispose();
        expect([...releaseAttempts.values()]).toEqual([4, 4]);

        // Successful cleanup removed the adapter from retained custody.
        await supervisor.dispose();
        expect([...releaseAttempts.values()]).toEqual([4, 4]);
    });

    it('keeps each read Home-scoped when a non-focused Home is released', async () => {
        const supervisor = createSupervisorUnderTest();
        const scope = 'scoped';
        const focused = await supervisor.ensureTunnel(makeRequest(homeIdentity(scope, 1)));
        const secondary = await supervisor.ensureTunnel(makeRequest(homeIdentity(scope, 2)));

        await supervisor.releaseTunnel(secondary.leaseId);

        const diagnostics = readScopeDiagnostics(scope);
        expect(diagnostics.map((entry) => entry.homeServerIdentityId)).toEqual([
            homeIdentity(scope, 1),
            homeIdentity(scope, 2),
        ]);
        expect(diagnostics[0]?.state).toBe('connected');
        expect(diagnostics[0]?.remoteEndpointId).toBe(`endpoint-${homeIdentity(scope, 1)}`);
        expect(diagnostics[1]?.state).toBe('disconnected');
        expect(diagnostics[1]?.remoteEndpointId).toBe(`endpoint-${homeIdentity(scope, 2)}`);

        await supervisor.releaseTunnel(focused.leaseId);
        expect(readScopeDiagnostics(scope).every((entry) => entry.state === 'disconnected')).toBe(true);
    });
});
