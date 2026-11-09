import type { DoctorSnapshotHomeTransportDiagnostics } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function diagnostics(input: Readonly<{
    homeServerIdentityId: string;
    state: DoctorSnapshotHomeTransportDiagnostics['state'];
    atMs: number;
    observedPath?: 'direct' | 'relay';
}>): DoctorSnapshotHomeTransportDiagnostics {
    const observation = input.observedPath
        ? { carrier: 'iroh' as const, observedPath: input.observedPath }
        : { carrier: 'iroh' as const };
    return {
        homeServerIdentityId: input.homeServerIdentityId,
        remoteEndpointId: `endpoint-${input.homeServerIdentityId}`,
        state: input.state,
        ...(input.state === 'connected' || input.state === 'connecting' ? { current: observation } : {}),
        lastKnown: observation,
        effectiveConfiguration: {
            policy: 'automatic',
            relayUrls: [],
            directAddressCount: 0,
        },
        lastTransitionAtMs: input.atMs,
    };
}

describe('Iroh Home transport diagnostics materializer', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('publishes a stable external-store revision for live subscribers', async () => {
        const {
            createIrohHomeTransportDiagnosticsPublisher,
            readIrohHomeTransportDiagnosticsRevision,
            subscribeIrohHomeTransportDiagnostics,
        } = await import('./irohHomeTransportDiagnostics');
        const listener = vi.fn();
        const unsubscribe = subscribeIrohHomeTransportDiagnostics(listener);
        const before = readIrohHomeTransportDiagnosticsRevision();
        const publisher = createIrohHomeTransportDiagnosticsPublisher({
            producerId: 'revision-test', leaseId: 'lease-1', homeServerIdentityId: 'revision-home',
        });

        publisher.publish(diagnostics({
            homeServerIdentityId: 'revision-home', state: 'connecting', atMs: 10,
        }));

        expect(readIrohHomeTransportDiagnosticsRevision()).toBeGreaterThan(before);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it('keeps equal same-generation diagnostics quiet without retiring a replacement publisher', async () => {
        const owner = await import('./irohHomeTransportDiagnostics');
        const identity = { producerId: 'equal-diagnostics', leaseId: 'lease', homeServerIdentityId: 'equal-home' };
        const publisher = owner.createIrohHomeTransportDiagnosticsPublisher(identity);
        const value = diagnostics({ homeServerIdentityId: identity.homeServerIdentityId, state: 'connected', atMs: 10, observedPath: 'relay' });
        publisher.publish(value);
        const revision = owner.readIrohHomeTransportDiagnosticsRevision();
        const listener = vi.fn();
        const stop = owner.subscribeIrohHomeTransportDiagnostics(listener);
        try {
            publisher.publish(structuredClone(value));
            expect(owner.readIrohHomeTransportDiagnosticsRevision()).toBe(revision);
            expect(listener).not.toHaveBeenCalled();
            const replacement = owner.createIrohHomeTransportDiagnosticsPublisher(identity);
            replacement.publish(structuredClone(value));
            publisher.release({ ...value, state: 'disconnected' });
            expect(owner.readIrohHomeTransportDiagnostics().find(row => row.homeServerIdentityId === identity.homeServerIdentityId)?.state).toBe('connected');
            const beforeTransition = listener.mock.calls.length;
            replacement.publish({ ...value, lastTransitionAtMs: 20, current: { carrier: 'iroh', observedPath: 'direct' } });
            expect(listener).toHaveBeenCalledTimes(beforeTransition + 1);
            replacement.release({ ...value, state: 'disconnected', lastTransitionAtMs: 30 });
            expect(owner.readIrohHomeTransportDiagnostics().find(row => row.homeServerIdentityId === identity.homeServerIdentityId)?.state).toBe('disconnected');
        } finally { stop(); }
    });

    it('keeps a same-Home active lease current when a sibling lease releases', async () => {
        const {
            createIrohHomeTransportDiagnosticsPublisher,
            readIrohHomeTransportDiagnostics,
        } = await import('./irohHomeTransportDiagnostics');
        const focused = createIrohHomeTransportDiagnosticsPublisher({
            producerId: 'browser-home-carrier',
            leaseId: 'focused',
            homeServerIdentityId: 'home-1',
        });
        const scopedRequest = createIrohHomeTransportDiagnosticsPublisher({
            producerId: 'browser-home-carrier',
            leaseId: 'scoped-request',
            homeServerIdentityId: 'home-1',
        });

        focused.publish(diagnostics({
            homeServerIdentityId: 'home-1', state: 'connected', atMs: 10, observedPath: 'relay',
        }));
        scopedRequest.publish(diagnostics({
            homeServerIdentityId: 'home-1', state: 'connected', atMs: 20, observedPath: 'relay',
        }));
        scopedRequest.release(diagnostics({
            homeServerIdentityId: 'home-1', state: 'disconnected', atMs: 30, observedPath: 'relay',
        }));

        expect(readIrohHomeTransportDiagnostics()).toEqual([
            expect.objectContaining({
                homeServerIdentityId: 'home-1',
                state: 'connected',
                current: { carrier: 'iroh', observedPath: 'relay' },
            }),
        ]);

        focused.release(diagnostics({
            homeServerIdentityId: 'home-1', state: 'disconnected', atMs: 40, observedPath: 'relay',
        }));
        expect(readIrohHomeTransportDiagnostics()).toEqual([
            expect.objectContaining({
                homeServerIdentityId: 'home-1',
                state: 'disconnected',
                current: undefined,
                lastKnown: { carrier: 'iroh', observedPath: 'relay' },
            }),
        ]);
    });

    it('ignores late facts and release calls from a superseded producer generation', async () => {
        const {
            createIrohHomeTransportDiagnosticsPublisher,
            readIrohHomeTransportDiagnostics,
        } = await import('./irohHomeTransportDiagnostics');
        const stale = createIrohHomeTransportDiagnosticsPublisher({
            producerId: 'browser-home-carrier', leaseId: 'reused', homeServerIdentityId: 'home-1',
        });
        stale.publish(diagnostics({ homeServerIdentityId: 'home-1', state: 'connecting', atMs: 10 }));
        const replacement = createIrohHomeTransportDiagnosticsPublisher({
            producerId: 'browser-home-carrier', leaseId: 'reused', homeServerIdentityId: 'home-1',
        });
        replacement.publish(diagnostics({
            homeServerIdentityId: 'home-1', state: 'connected', atMs: 20, observedPath: 'relay',
        }));

        stale.release(diagnostics({ homeServerIdentityId: 'home-1', state: 'disconnected', atMs: 30 }));
        stale.publish(diagnostics({ homeServerIdentityId: 'home-1', state: 'unavailable', atMs: 40 }));

        expect(readIrohHomeTransportDiagnostics()).toEqual([
            expect.objectContaining({
                state: 'connected',
                current: { carrier: 'iroh', observedPath: 'relay' },
            }),
        ]);
    });

    it('retains every active and inactive Home observation without an arbitrary Home-count quota', async () => {
        const {
            createIrohHomeTransportDiagnosticsPublisher,
            readIrohHomeTransportDiagnostics,
        } = await import('./irohHomeTransportDiagnostics');
        const active = Array.from({ length: 65 }, (_, index) => {
            const homeServerIdentityId = `active-${index}`;
            const publisher = createIrohHomeTransportDiagnosticsPublisher({
                producerId: 'test-active', leaseId: String(index), homeServerIdentityId,
            });
            publisher.publish(diagnostics({
                homeServerIdentityId, state: 'connected', atMs: index, observedPath: 'direct',
            }));
            return publisher;
        });
        for (let index = 0; index < 70; index += 1) {
            const homeServerIdentityId = `inactive-${index}`;
            const publisher = createIrohHomeTransportDiagnosticsPublisher({
                producerId: 'test-inactive', leaseId: String(index), homeServerIdentityId,
            });
            publisher.publish(diagnostics({
                homeServerIdentityId, state: 'connected', atMs: 100 + index, observedPath: 'relay',
            }));
            publisher.release(diagnostics({
                homeServerIdentityId, state: 'disconnected', atMs: 200 + index, observedPath: 'relay',
            }));
        }

        const materialized = readIrohHomeTransportDiagnostics();
        expect(materialized.filter((entry) => entry.homeServerIdentityId.startsWith('active-'))).toHaveLength(65);
        expect(materialized.filter((entry) => entry.homeServerIdentityId.startsWith('inactive-'))).toHaveLength(70);
        expect(materialized.find((entry) => entry.homeServerIdentityId === 'inactive-69')).toMatchObject({
            current: undefined,
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
        });

        for (const publisher of active) {
            publisher.release(diagnostics({
                homeServerIdentityId: publisher.homeServerIdentityId,
                state: 'disconnected',
                atMs: 1_000,
                observedPath: 'direct',
            }));
        }
        expect(readIrohHomeTransportDiagnostics()).toHaveLength(135);
    });

    it('retires only the explicitly forgotten Home while preserving saved offline Homes', async () => {
        const {
            createIrohHomeTransportDiagnosticsPublisher,
            readIrohHomeTransportDiagnostics,
            retireIrohHomeTransportDiagnostics,
        } = await import('./irohHomeTransportDiagnostics');
        for (const homeServerIdentityId of ['forgotten-home', 'saved-offline-home']) {
            const publisher = createIrohHomeTransportDiagnosticsPublisher({
                producerId: 'retirement-test', leaseId: homeServerIdentityId, homeServerIdentityId,
            });
            publisher.publish(diagnostics({
                homeServerIdentityId, state: 'connected', atMs: 10, observedPath: 'relay',
            }));
            publisher.release(diagnostics({
                homeServerIdentityId, state: 'disconnected', atMs: 20, observedPath: 'relay',
            }));
        }

        retireIrohHomeTransportDiagnostics('forgotten-home');

        expect(readIrohHomeTransportDiagnostics().map((entry) => entry.homeServerIdentityId))
            .toEqual(['saved-offline-home']);
        expect(readIrohHomeTransportDiagnostics()[0]).toMatchObject({
            state: 'disconnected',
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
        });
    });
});
