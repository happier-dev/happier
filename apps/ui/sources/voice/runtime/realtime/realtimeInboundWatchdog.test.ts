import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { createRealtimeInboundWatchdog } from './realtimeInboundWatchdog';

const STALL_MS = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.inboundWatchdog.stallTimeoutMs;
const AWAITING_MS = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.inboundWatchdog.awaitingResponseTimeoutMs;

describe('createRealtimeInboundWatchdog', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('fires a stall after the timeout when a turn is active and no inbound event arrives', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markTurnActive(true);

        // Just before the timeout: no fire.
        vi.advanceTimersByTime(STALL_MS - 1);
        expect(onStall).not.toHaveBeenCalled();

        // At the timeout: stall.
        vi.advanceTimersByTime(1);
        expect(onStall).toHaveBeenCalledTimes(1);
    });

    it('resets the timer on each inbound event so a live stream never false-fires', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markTurnActive(true);

        // Inbound events arrive steadily within the window — never a stall.
        for (let i = 0; i < 10; i += 1) {
            vi.advanceTimersByTime(STALL_MS - 1);
            watchdog.noteInboundEvent();
        }
        expect(onStall).not.toHaveBeenCalled();

        // Once the events stop, a stall eventually fires.
        vi.advanceTimersByTime(STALL_MS);
        expect(onStall).toHaveBeenCalledTimes(1);
    });

    it('does not false-fire during legitimate between-turn silence (no active turn)', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        // No active turn: prolonged silence is legitimate.
        vi.advanceTimersByTime(STALL_MS * 5);
        expect(onStall).not.toHaveBeenCalled();
    });

    it('arms when a turn becomes active and disarms when the turn ends', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markTurnActive(true);
        vi.advanceTimersByTime(STALL_MS - 1);

        // Turn ends before the stall window elapses — no fire.
        watchdog.markTurnActive(false);
        vi.advanceTimersByTime(STALL_MS * 3);
        expect(onStall).not.toHaveBeenCalled();
    });

    it('fires at most once per active turn (no repeat firing without re-arming)', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markTurnActive(true);
        vi.advanceTimersByTime(STALL_MS);
        expect(onStall).toHaveBeenCalledTimes(1);

        // Without a fresh turn/inbound activity, the timer does not re-fire.
        vi.advanceTimersByTime(STALL_MS * 3);
        expect(onStall).toHaveBeenCalledTimes(1);
    });

    it('an inbound event re-arms a turn that already stalled (recovers after a recoverable reconnect)', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markTurnActive(true);
        vi.advanceTimersByTime(STALL_MS);
        expect(onStall).toHaveBeenCalledTimes(1);

        // Inbound resumes (reconnect succeeded), then stalls again.
        watchdog.noteInboundEvent();
        vi.advanceTimersByTime(STALL_MS);
        expect(onStall).toHaveBeenCalledTimes(2);
    });

    it('stop() clears the timer so no stall fires after teardown', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markTurnActive(true);
        watchdog.stop();

        vi.advanceTimersByTime(STALL_MS * 5);
        expect(onStall).not.toHaveBeenCalled();
    });

    it('noteInboundEvent while inactive does not arm the watchdog', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        // Inbound events without an active turn must not arm a stall timer.
        watchdog.noteInboundEvent();
        vi.advanceTimersByTime(STALL_MS * 3);
        expect(onStall).not.toHaveBeenCalled();
    });

    // F2: the AWAITING-RESPONSE / "thinking" window — after the user's turn ends
    // but before the agent emits its first `speaking` audio — must also be covered.
    it('fires a stall during the awaiting-response (thinking) window using the generous timeout', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markAwaitingResponse(true);

        // The tighter active-turn timeout must NOT fire here — the thinking window
        // uses the more generous awaiting timeout.
        vi.advanceTimersByTime(STALL_MS);
        expect(onStall).not.toHaveBeenCalled();

        // Just before the awaiting timeout: still no fire.
        vi.advanceTimersByTime(AWAITING_MS - STALL_MS - 1);
        expect(onStall).not.toHaveBeenCalled();

        // At the awaiting timeout: a stall (a fully-dead inbound stream while thinking).
        vi.advanceTimersByTime(1);
        expect(onStall).toHaveBeenCalledTimes(1);
    });

    it('resets the awaiting-response timer on inbound events so a live thinking gap never false-fires', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markAwaitingResponse(true);

        for (let i = 0; i < 5; i += 1) {
            vi.advanceTimersByTime(AWAITING_MS - 1);
            watchdog.noteInboundEvent();
        }
        expect(onStall).not.toHaveBeenCalled();
    });

    it('the active-turn arm supersedes the awaiting window with the tighter timeout once the agent speaks', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markAwaitingResponse(true);
        // Agent starts speaking: switch to the tighter active-turn timeout.
        watchdog.markTurnActive(true);

        vi.advanceTimersByTime(STALL_MS);
        expect(onStall).toHaveBeenCalledTimes(1);
    });

    it('disarming the awaiting window (back to idle/listening) clears the timer', () => {
        const onStall = vi.fn();
        const watchdog = createRealtimeInboundWatchdog({ onStall });

        watchdog.start();
        watchdog.markAwaitingResponse(true);
        vi.advanceTimersByTime(AWAITING_MS - 1);
        watchdog.markAwaitingResponse(false);

        vi.advanceTimersByTime(AWAITING_MS * 3);
        expect(onStall).not.toHaveBeenCalled();
    });
});
