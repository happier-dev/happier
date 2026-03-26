import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createManagedEndpointSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';

import { storage } from '@/sync/domains/state/storage';
import { PauseController } from '@/utils/timing/pauseController';

import { bindEndpointSupervisorToRealtimeStore } from './bindEndpointSupervisorToRealtimeStore';

describe('bindEndpointSupervisorToRealtimeStore', () => {
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
        const detach = bindEndpointSupervisorToRealtimeStore({
            supervisor,
            pause,
            pauseReason: 'endpoint',
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

        const detach = bindEndpointSupervisorToRealtimeStore({ supervisor });
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

        const detach = bindEndpointSupervisorToRealtimeStore({ supervisor });
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
            const detach = bindEndpointSupervisorToRealtimeStore({ supervisor, onEndpointOnline });
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
});
