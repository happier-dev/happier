import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { describe, expect, it, vi } from 'vitest';

import type { EndpointConnectivitySnapshot } from '@/sync/store/domains/realtime';

import { bindManagedConnectionStateToRealtimeStore } from './bindManagedConnectionStateToRealtimeStore';

function createManagedConnectionState(
    phase: ManagedConnectionState['phase'],
    overrides: Partial<ManagedConnectionState> = {},
): ManagedConnectionState {
    return {
        phase,
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
        ...overrides,
    };
}

function createBoundStore(params: Readonly<{ onOnline?: () => void }> = {}) {
    let publish: ((state: ManagedConnectionState) => void) | null = null;
    const snapshots: EndpointConnectivitySnapshot[] = [];

    const unsubscribe = bindManagedConnectionStateToRealtimeStore({
        subscribe: (listener) => {
            publish = listener;
            return () => {
                publish = null;
            };
        },
        setEndpointConnectivity: (snapshot) => {
            snapshots.push(snapshot);
        },
        onOnline: params.onOnline,
    });

    return {
        unsubscribe,
        snapshots,
        publish(phase: ManagedConnectionState['phase'], overrides?: Partial<ManagedConnectionState>) {
            if (!publish) throw new Error('binder did not subscribe');
            publish(createManagedConnectionState(phase, overrides));
        },
        get statuses(): string[] {
            return snapshots.map((snapshot) => snapshot.status);
        },
    };
}

describe('bindManagedConnectionStateToRealtimeStore', () => {
    it('publishes authoritative phases verbatim', () => {
        const bound = createBoundStore();

        bound.publish('connecting');
        bound.publish('online');
        bound.publish('offline', { reason: 'server_unreachable', attempt: 3, lastErrorMessage: 'Network request failed' });
        bound.publish('auth_failed');

        expect(bound.statuses).toEqual(['connecting', 'online', 'offline', 'auth_failed']);
        expect(bound.snapshots[2]).toMatchObject({
            status: 'offline',
            reason: 'server_unreachable',
            attempt: 3,
            lastErrorMessage: 'Network request failed',
        });
    });

    it('does not surface an intentional teardown as a disconnected endpoint', () => {
        const bound = createBoundStore();

        bound.publish('online');
        // Backgrounding stops every supervisor; the app resubscribes on foreground and immediately restarts it.
        // Nothing about that teardown is evidence that the server is unreachable.
        bound.publish('shutting_down');

        expect(bound.statuses).toEqual(['online', 'connecting']);
    });

    it('keeps a real outage visible across a teardown', () => {
        const bound = createBoundStore();

        bound.publish('offline', { reason: 'server_unreachable' });
        bound.publish('shutting_down');

        expect(bound.statuses).toEqual(['offline', 'offline']);
    });

    it('keeps an authentication failure visible across a teardown', () => {
        const bound = createBoundStore();

        bound.publish('auth_failed');
        bound.publish('shutting_down');

        expect(bound.statuses).toEqual(['auth_failed', 'auth_failed']);
    });

    it('still triggers the resume pipeline when the endpoint comes back after a teardown', () => {
        const onOnline = vi.fn();
        const bound = createBoundStore({ onOnline });

        bound.publish('online');
        expect(onOnline).not.toHaveBeenCalled();

        bound.publish('shutting_down');
        bound.publish('connecting');
        bound.publish('online');

        expect(onOnline).toHaveBeenCalledTimes(1);
    });
    it('does not re-present a known outage as connecting on each automatic retry attempt', () => {
        const bound = createBoundStore();

        bound.publish('offline', { reason: 'server_unreachable', attempt: 1, nextRetryAt: 1_000 });
        // The retry timer fired: the target is still known unreachable, so nothing new is claimed.
        bound.publish('connecting', { reason: 'server_unreachable', attempt: 1 });
        bound.publish('offline', { reason: 'server_unreachable', attempt: 2, nextRetryAt: 2_000 });
        bound.publish('connecting', { reason: 'server_unreachable', attempt: 2 });
        bound.publish('online', { attempt: 2 });

        expect(bound.statuses).toEqual(['offline', 'offline', 'online']);
        expect(bound.snapshots[1]).toMatchObject({ attempt: 2, nextRetryAt: 2_000 });
    });

    it('presents connecting for an explicit retry that restarts from attempt zero', () => {
        const bound = createBoundStore();

        bound.publish('offline', { reason: 'server_unreachable', attempt: 4, nextRetryAt: 1_000 });
        bound.publish('shutting_down');
        bound.publish('connecting', { attempt: 0 });

        expect(bound.statuses).toEqual(['offline', 'offline', 'connecting']);
    });
});
