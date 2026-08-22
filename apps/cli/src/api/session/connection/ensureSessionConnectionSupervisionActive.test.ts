import {
    createManagedConnectionSupervisor,
    type ManagedConnectionTransport,
    type TransportDisconnectEvent,
} from '@happier-dev/connection-supervisor';
import { describe, expect, it, vi } from 'vitest';

import { ensureSessionConnectionSupervisionActive } from './ensureSessionConnectionSupervisionActive';

function createTransportHarness() {
    let connected = false;
    const connectedListeners = new Set<() => void>();
    const disconnectedListeners = new Set<(event: TransportDisconnectEvent) => void>();

    const transport: ManagedConnectionTransport = {
        connect: vi.fn(async () => {
            connected = true;
            for (const listener of connectedListeners) listener();
        }),
        disconnect: vi.fn(async () => {
            connected = false;
        }),
        destroy: vi.fn(async () => {}),
        isConnected: () => connected,
        onConnected: (listener) => {
            connectedListeners.add(listener);
            return () => connectedListeners.delete(listener);
        },
        onDisconnected: (listener) => {
            disconnectedListeners.add(listener);
            return () => disconnectedListeners.delete(listener);
        },
        onError: () => () => {},
    };

    return {
        transport,
        emitDisconnect: (event: TransportDisconnectEvent) => {
            connected = false;
            for (const listener of disconnectedListeners) listener(event);
        },
    };
}

describe('ensureSessionConnectionSupervisionActive', () => {
    it('preserves the supervisor-owned retry schedule when queue and write demand arrives offline', async () => {
        vi.useFakeTimers();
        try {
            const firstTransport = createTransportHarness();
            const secondTransport = createTransportHarness();
            const transports = [firstTransport, secondTransport];
            const createTransport = vi.fn(() => {
                const next = transports.shift();
                if (!next) throw new Error('missing transport');
                return next.transport;
            });
            const supervisor = createManagedConnectionSupervisor({
                createTransport,
                probeReadiness: async () => ({ status: 'ready' }),
                initialFastRetryDelayMs: 0,
                maxFastRetries: 0,
                backoffMinMs: 1_000,
                backoffMaxMs: 1_000,
                jitterRatio: 0,
            });

            await supervisor.start();
            firstTransport.emitDisconnect({ reason: 'transport closed' });
            await Promise.resolve();
            await Promise.resolve();

            const scheduled = supervisor.getState();
            expect(scheduled).toEqual(expect.objectContaining({
                phase: 'offline',
                attempt: 1,
                nextRetryAt: Date.now() + 1_000,
            }));

            await ensureSessionConnectionSupervisionActive(supervisor);
            await ensureSessionConnectionSupervisionActive(supervisor);
            await ensureSessionConnectionSupervisionActive(supervisor);

            expect(supervisor.getState()).toEqual(scheduled);
            expect(createTransport).toHaveBeenCalledTimes(1);
            expect(secondTransport.transport.connect).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
