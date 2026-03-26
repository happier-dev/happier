import { describe, expect, it, vi } from 'vitest';

import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';

import { PauseController } from '@/utils/timing/pauseController';
import { InvalidateSync } from '@/utils/sessions/sync';

describe('sync connectivity gating', () => {
    it('pauses sync units while endpoint is offline and coalesces invalidations until online', async () => {
        const pause = new PauseController();

        let state: ManagedEndpointSupervisorState = {
            phase: 'offline',
            reason: 'server_unreachable',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: 'Network request failed',
            lastProbe: { status: 'server_unreachable', errorMessage: 'Network request failed' },
        };

        const listeners = new Set<(s: ManagedEndpointSupervisorState) => void>();
        const supervisor: ManagedEndpointSupervisor = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            invalidate: vi.fn(),
            reportFailure: vi.fn(),
            waitUntilOnline: vi.fn(async () => {}),
            getState: () => state,
            subscribe: (listener) => {
                listeners.add(listener);
                listener(state);
                return () => listeners.delete(listener);
            },
        };

        const detach = supervisor.subscribe((next) => {
            if (next.phase === 'online') {
                pause.resume();
            } else {
                pause.pause();
            }
        });

        const command = vi.fn(async () => {});
        const unit = new InvalidateSync(command, {
            pause,
            backoff: { minDelayMs: 1, maxDelayMs: 1, maxFailureCount: 'infinite' },
        });

        unit.invalidate();
        unit.invalidate();
        unit.invalidate();
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(pause.isPaused()).toBe(true);
        expect(command).toHaveBeenCalledTimes(0);

        state = {
            ...state,
            phase: 'online',
            reason: 'initial_connect',
            lastConnectedAt: Date.now(),
            lastErrorMessage: null,
            lastProbe: { status: 'ready' },
        };
        for (const listener of listeners) listener(state);

        expect(pause.isPaused()).toBe(false);
        await unit.awaitQueue({ timeoutMs: 2_000 });
        expect(command).toHaveBeenCalledTimes(1);

        detach();
    });
});
