import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createManagedEndpointSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';

import { storage } from '@/sync/domains/state/storage';
import { PauseController } from '@/utils/timing/pauseController';
import { log } from '@/log';

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
        const onEndpointOnline = vi.fn();
        const detach = bindEndpointConnectivityStateToRealtimeStore({
            subscribe: (listener) => supervisor.subscribe(listener),
            pause,
            onEndpointOnline,
        });
        await supervisor.start();

        expect(storage.getState().endpointStatus).toBe('offline');
        expect(storage.getState().endpointLastErrorMessage).toBe('nope');
        expect(pause.isPaused()).toBe(true);
        expect(onEndpointOnline).toHaveBeenCalledTimes(0);

        probeResult = { status: 'ready' };
        supervisor.invalidate();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(storage.getState().endpointStatus).toBe('online');
        expect(pause.isPaused()).toBe(false);
        expect(onEndpointOnline).toHaveBeenCalledTimes(1);

        supervisor.reportFailure({ errorMessage: 'Network request failed' });
        expect(storage.getState().endpointStatus).toBe('offline');
        expect(storage.getState().endpointLastErrorMessage).toBe('Network request failed');

        detach();
        await supervisor.stop();
    });

    it('reports a failed endpoint-online listener while the store keeps updating', async () => {
        let probeResult: ReadinessProbeResult = { status: 'server_unreachable', errorMessage: 'nope' };
        const supervisor = createManagedEndpointSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            initialFastRetryDelayMs: 10,
            backoffMinMs: 10,
            backoffMaxMs: 50,
            probeReadiness: async () => probeResult,
        });
        const logged = vi.spyOn(log, 'log');
        const detach = bindEndpointConnectivityStateToRealtimeStore({
            subscribe: (listener) => supervisor.subscribe(listener),
            onEndpointOnline: () => { throw new Error('resync failed'); },
        });
        try {
            await supervisor.start();
            probeResult = { status: 'ready' };
            supervisor.invalidate();
            await new Promise<void>((resolve) => queueMicrotask(resolve));
            await new Promise<void>((resolve) => queueMicrotask(resolve));
            expect(storage.getState().endpointStatus).toBe('online');
            expect(logged.mock.calls.filter(([line]) => line.includes('endpoint-online listener failed')).length).toBe(1);
        } finally {
            logged.mockRestore();
            detach();
            await supervisor.stop();
        }
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

    it('stores a sanitized endpoint error message instead of the raw one', async () => {
        // Redaction detail is owned by sanitizeEndpointErrorMessage.test.ts; this proves the binder applies it.
        const supervisor = createManagedEndpointSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            initialFastRetryDelayMs: 10,
            backoffMinMs: 10,
            backoffMaxMs: 50,
            probeReadiness: async () => ({
                status: 'server_unreachable',
                errorMessage: 'request failed: https://admin:secret@custom.example.test:9443/path/ (Authorization: Bearer hdr.eyJzdWIiOiJ0ZXN0In0.sig)',
            }),
        });

        const detach = bindEndpointConnectivityStateToRealtimeStore({ subscribe: (listener) => supervisor.subscribe(listener) });
        await supervisor.start();

        expect(storage.getState().endpointStatus).toBe('offline');
        expect(storage.getState().endpointLastErrorMessage).toContain('https://custom.example.test:9443/path');
        expect(storage.getState().endpointLastErrorMessage).not.toContain('admin:secret@');
        expect(storage.getState().endpointLastErrorMessage).not.toContain('hdr.eyJ');

        detach();
        await supervisor.stop();
    });

    describe('backoff retry of a presented outage', () => {
        function publishStates(states: ReadonlyArray<{ phase: string; attempt: number }>): string[] {
            const published: string[] = [];
            let emit: ((state: any) => void) | undefined;
            const detach = bindEndpointConnectivityStateToRealtimeStore({
                subscribe: (listener) => { emit = listener as (state: any) => void; return () => {}; },
            });
            for (const state of states) {
                emit?.({ ...state, reason: null, nextRetryAt: null, lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null });
                published.push(storage.getState().endpointStatus);
            }
            detach();
            return published;
        }

        it('does not re-present the timer-driven connecting phase of an offline endpoint', () => {
            expect(publishStates([
                { phase: 'offline', attempt: 1 }, { phase: 'connecting', attempt: 2 }, { phase: 'offline', attempt: 2 },
            ])).toEqual(['offline', 'offline', 'offline']);
        });

        it('still presents a start or explicit retry (attempt zero) as connecting', () => {
            expect(publishStates([{ phase: 'offline', attempt: 1 }, { phase: 'connecting', attempt: 0 }]))
                .toEqual(['offline', 'connecting']);
        });
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
