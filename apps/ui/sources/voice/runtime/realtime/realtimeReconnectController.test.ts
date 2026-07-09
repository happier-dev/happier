import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { createRealtimeReconnectController } from './realtimeReconnectController';

const RECONNECT = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect;

type Harness = {
    attemptReconnect: ReturnType<typeof vi.fn>;
    surfaceRecoverable: ReturnType<typeof vi.fn>;
    surfaceNonRecoverable: ReturnType<typeof vi.fn>;
    controller: ReturnType<typeof createRealtimeReconnectController>;
};

function createHarness(
    attemptImpl: () => Promise<boolean> = async () => true,
): Harness {
    const attemptReconnect = vi.fn(attemptImpl);
    const surfaceRecoverable = vi.fn();
    const surfaceNonRecoverable = vi.fn();
    const controller = createRealtimeReconnectController({
        attemptReconnect,
        surfaceRecoverable,
        surfaceNonRecoverable,
    });
    return { attemptReconnect, surfaceRecoverable, surfaceNonRecoverable, controller };
}

describe('createRealtimeReconnectController', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('surfaces a recoverable drop and schedules a backoff reconnect that preserves continuity', async () => {
        const { attemptReconnect, surfaceRecoverable, surfaceNonRecoverable, controller } =
            createHarness(async () => true);

        controller.handleTransientDrop({
            controlSessionId: 's1',
            kind: 'transport_disconnect',
            reason: 'realtime_transport_disconnected',
        });

        // The user-visible state is recoverable (graceful disconnected+retry), not a hard error.
        expect(surfaceRecoverable).toHaveBeenCalledTimes(1);
        expect(surfaceRecoverable).toHaveBeenCalledWith(
            expect.objectContaining({ controlSessionId: 's1', kind: 'transport_disconnect' }),
        );
        expect(surfaceNonRecoverable).not.toHaveBeenCalled();
        // Reconnect does NOT fire synchronously — it waits for the backoff.
        expect(attemptReconnect).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        expect(attemptReconnect).toHaveBeenCalledTimes(1);
        expect(attemptReconnect).toHaveBeenCalledWith(expect.objectContaining({ controlSessionId: 's1', attempt: 1 }));
    });

    it('grows the backoff exponentially, capped at maxBackoffMs, across failed attempts', async () => {
        const { attemptReconnect, controller } = createHarness(async () => false);

        controller.handleTransientDrop({
            controlSessionId: 's1',
            kind: 'transport_disconnect',
            reason: 'drop',
        });

        // Attempt 1 after baseBackoffMs.
        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        expect(attemptReconnect).toHaveBeenCalledTimes(1);

        // Attempt 2 after base * factor.
        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs * RECONNECT.backoffFactor);
        expect(attemptReconnect).toHaveBeenCalledTimes(2);

        // Attempt 3 after base * factor^2.
        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs * RECONNECT.backoffFactor ** 2);
        expect(attemptReconnect).toHaveBeenCalledTimes(3);
    });

    it('caps total retries then surfaces non-recoverable failure', async () => {
        const { attemptReconnect, surfaceNonRecoverable, controller } = createHarness(async () => false);

        controller.handleTransientDrop({
            controlSessionId: 's1',
            kind: 'transport_disconnect',
            reason: 'drop',
        });

        // Run far past every capped backoff window so all retries fire.
        for (let i = 0; i < RECONNECT.maxRetries + 2; i += 1) {
            await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs);
        }

        expect(attemptReconnect).toHaveBeenCalledTimes(RECONNECT.maxRetries);
        expect(surfaceNonRecoverable).toHaveBeenCalledTimes(1);
        expect(surfaceNonRecoverable).toHaveBeenCalledWith(
            expect.objectContaining({ controlSessionId: 's1' }),
        );
    });

    it('stops retrying once a reconnect attempt succeeds', async () => {
        let calls = 0;
        const { attemptReconnect, surfaceNonRecoverable, controller } = createHarness(async () => {
            calls += 1;
            return calls >= 2; // first attempt fails, second succeeds
        });

        controller.handleTransientDrop({ controlSessionId: 's1', kind: 'transport_disconnect', reason: 'drop' });

        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs * RECONNECT.backoffFactor);
        expect(attemptReconnect).toHaveBeenCalledTimes(2);

        // No further attempts even after a long wait.
        await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs * 4);
        expect(attemptReconnect).toHaveBeenCalledTimes(2);
        expect(surfaceNonRecoverable).not.toHaveBeenCalled();
    });

    it('routes a non-recoverable drop straight to error with no reconnect attempts', async () => {
        const { attemptReconnect, surfaceRecoverable, surfaceNonRecoverable, controller } = createHarness();

        controller.handleNonRecoverableDrop({
            controlSessionId: 's1',
            kind: 'mic_permission_denied',
            reason: 'realtime_mic_permission_denied',
        });

        await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs * (RECONNECT.maxRetries + 2));

        expect(surfaceNonRecoverable).toHaveBeenCalledTimes(1);
        expect(surfaceNonRecoverable).toHaveBeenCalledWith(
            expect.objectContaining({ controlSessionId: 's1', kind: 'mic_permission_denied' }),
        );
        expect(attemptReconnect).not.toHaveBeenCalled();
        expect(surfaceRecoverable).not.toHaveBeenCalled();
    });

    it('cancel() stops a pending reconnect (clean stop wins over an in-flight reconnect)', async () => {
        const { attemptReconnect, surfaceNonRecoverable, controller } = createHarness(async () => false);

        controller.handleTransientDrop({ controlSessionId: 's1', kind: 'transport_disconnect', reason: 'drop' });
        controller.cancel();

        await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs * (RECONNECT.maxRetries + 2));

        expect(attemptReconnect).not.toHaveBeenCalled();
        expect(surfaceNonRecoverable).not.toHaveBeenCalled();
    });

    it('a fresh transient drop after a successful reconnect resets the retry budget', async () => {
        let phase1Calls = 0;
        const attempt = vi.fn(async () => {
            phase1Calls += 1;
            return true; // always succeeds
        });
        const surfaceRecoverable = vi.fn();
        const surfaceNonRecoverable = vi.fn();
        const controller = createRealtimeReconnectController({
            attemptReconnect: attempt,
            surfaceRecoverable,
            surfaceNonRecoverable,
        });

        controller.handleTransientDrop({ controlSessionId: 's1', kind: 'transport_disconnect', reason: 'drop' });
        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        expect(attempt).toHaveBeenCalledTimes(1);

        // A later, independent drop should again start at attempt 1.
        controller.handleTransientDrop({ controlSessionId: 's1', kind: 'transport_disconnect', reason: 'drop2' });
        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        expect(attempt).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 1 }));
        expect(phase1Calls).toBe(2);
    });
});
