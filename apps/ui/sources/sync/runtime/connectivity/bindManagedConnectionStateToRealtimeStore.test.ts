import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createManagedEndpointSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';

import { storage } from '@/sync/domains/state/storage';
import { PauseController } from '@/utils/timing/pauseController';

import { bindEndpointConnectivityStateToRealtimeStore } from './bindManagedConnectionStateToRealtimeStore';

describe('bindEndpointConnectivityStateToRealtimeStore', () => {
    afterEach(() => {
        storage.getState().resetEndpointConnectivity();
        vi.useRealTimers();
    });

    it('updates the realtime store when the endpoint supervisor state changes', async () => {
        let probeResult: ReadinessProbeResult = { status: 'server_unreachable', errorMessage: 'nope' };

        const supervisor = createManagedEndpointSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            initialFastRetryDelayMs: 10,
            backoffMinMs: 10,
            backoffMaxMs: 50,
            probeReadiness: async () => probeResult,
        });

        const pause = new PauseController();
        const detach = bindEndpointConnectivityStateToRealtimeStore({
            subscribe: (listener) => supervisor.subscribe(listener),
            pause,
        });
        await supervisor.start();

        expect(storage.getState().endpointStatus).toBe('offline');
        expect(storage.getState().endpointLastErrorMessage).toBe('nope');
        expect(pause.isPaused()).toBe(true);

        probeResult = { status: 'ready' };
        supervisor.invalidate();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(storage.getState().endpointStatus).toBe('online');
        expect(pause.isPaused()).toBe(false);

        supervisor.reportFailure({ errorMessage: 'Network request failed' });
        expect(storage.getState().endpointStatus).toBe('offline');
        expect(storage.getState().endpointLastErrorMessage).toBe('Network request failed');

        detach();
        await supervisor.stop();
    });

    it('stops updating the store after the returned unsubscribe is called', async () => {
        const supervisor = createManagedEndpointSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            initialFastRetryDelayMs: 10,
            backoffMinMs: 10,
            backoffMaxMs: 50,
            probeReadiness: async () => ({ status: 'ready' }),
        });

        const detach = bindEndpointConnectivityStateToRealtimeStore({ subscribe: (listener) => supervisor.subscribe(listener) });
        await supervisor.start();
        expect(storage.getState().endpointStatus).toBe('online');

        detach();
        supervisor.reportFailure({ errorMessage: 'boom' });
        expect(storage.getState().endpointStatus).toBe('online');

        await supervisor.stop();
    });

    it('sanitizes endpoint error messages before storing them', async () => {
        let probeResult: ReadinessProbeResult = {
            status: 'server_unreachable',
            errorMessage:
                'request failed: https://admin:secret@custom.example.test:9443/path/?token=abc#frag (Authorization: Bearer hdr.eyJzdWIiOiJ0ZXN0In0.sig)',
        };

        const supervisor = createManagedEndpointSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            initialFastRetryDelayMs: 10,
            backoffMinMs: 10,
            backoffMaxMs: 50,
            probeReadiness: async () => probeResult,
        });

        const detach = bindEndpointConnectivityStateToRealtimeStore({ subscribe: (listener) => supervisor.subscribe(listener) });
        await supervisor.start();

        expect(storage.getState().endpointStatus).toBe('offline');
        expect(storage.getState().endpointLastErrorMessage).toContain('https://custom.example.test:9443/path');
        expect(storage.getState().endpointLastErrorMessage).not.toContain('admin:secret@');
        expect(storage.getState().endpointLastErrorMessage).not.toContain('token=abc');
        expect(storage.getState().endpointLastErrorMessage).toContain('Bearer [REDACTED]');
        expect(storage.getState().endpointLastErrorMessage).not.toContain('hdr.eyJ');

        probeResult = { status: 'ready' };
        supervisor.invalidate();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        supervisor.reportFailure({
            errorMessage: 'https://admin:secret@custom.example.test:9443/path/?token=abc#frag',
        });
        expect(storage.getState().endpointLastErrorMessage).toBe('https://custom.example.test:9443/path');

        detach();
        await supervisor.stop();
    });

    it('invokes onEndpointOnline when transitioning from offline to online', async () => {
        vi.useFakeTimers();
        try {
            let probeResult: ReadinessProbeResult = { status: 'server_unreachable', errorMessage: 'nope' };

            const supervisor = createManagedEndpointSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                initialFastRetryDelayMs: 10,
                backoffMinMs: 10,
                backoffMaxMs: 50,
                probeReadiness: async () => probeResult,
            });

            const onEndpointOnline = vi.fn();
            const detach = bindEndpointConnectivityStateToRealtimeStore({ subscribe: (listener) => supervisor.subscribe(listener), onEndpointOnline });
            await supervisor.start();

            expect(storage.getState().endpointStatus).toBe('offline');
            expect(onEndpointOnline).toHaveBeenCalledTimes(0);

            probeResult = { status: 'ready' };
            supervisor.invalidate();
            await vi.runAllTimersAsync();

            expect(storage.getState().endpointStatus).toBe('online');
            expect(onEndpointOnline).toHaveBeenCalledTimes(1);

            detach();
            await supervisor.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    describe('teardown (shutting_down) is not a claim about the server', () => {
        // `shutting_down` is published whenever WE stop supervision — backgrounding, a server switch, the
        // stop/start pair inside an explicit invalidation. Letting it reach the store rendered a red
        // "Disconnected" on every resume (`resolveConnectionHealth` maps it to `server_unreachable`).
        function publishPhases(phases: ReadonlyArray<string>): string[] {
            const published: string[] = [];
            const emitters: Array<(state: any) => void> = [];
            const detach = bindEndpointConnectivityStateToRealtimeStore({
                subscribe: (listener) => {
                    emitters.push(listener as (state: any) => void);
                    return () => {};
                },
            });
            for (const phase of phases) {
                emitters[0]?.({
                    phase,
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: null,
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                });
                published.push(storage.getState().endpointStatus);
            }
            detach();
            return published;
        }

        it('reports connecting instead of a teardown phase after a healthy connection is torn down', () => {
            expect(publishPhases(['online', 'shutting_down'])).toEqual(['online', 'connecting']);
        });

        it('keeps an already-diagnosed outage visible through a teardown', () => {
            expect(publishPhases(['offline', 'shutting_down'])).toEqual(['offline', 'offline']);
        });

        it('keeps an auth failure visible through a teardown', () => {
            expect(publishPhases(['auth_failed', 'shutting_down'])).toEqual(['auth_failed', 'auth_failed']);
        });
    });
});
