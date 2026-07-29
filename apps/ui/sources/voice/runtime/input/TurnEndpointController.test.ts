import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeTurnEndpointPolicy } from './TurnEndpointDetector';

import { createTurnEndpointController } from './TurnEndpointController';

describe('createTurnEndpointController', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('schedules heuristic endpoint signals for the active capture session', async () => {
        vi.useFakeTimers();
        const onSignal = vi.fn();
        const controller = createTurnEndpointController({
            onSignal,
            now: () => Date.now(),
        });

        controller.startSession('session-1');
        controller.signalHeuristicTranscriptFinalized({
            sessionId: 'session-1',
            transcript: 'hello runtime',
            policy: normalizeTurnEndpointPolicy({ silenceMs: 25, minSpeechMs: 0 }),
        });

        await vi.advanceTimersByTimeAsync(24);
        expect(onSignal).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            source: 'heuristic',
            transcript: 'hello runtime',
            endpoint: { reason: 'structural_fallback', confidence: null },
        }));
    });

    it('does not accelerate endpointing from punctuation alone', async () => {
        vi.useFakeTimers();
        const onSignal = vi.fn();
        const controller = createTurnEndpointController({ onSignal, now: () => Date.now() });
        controller.startSession('session-1');
        controller.signalHeuristicTranscriptFinalized({
            sessionId: 'session-1',
            transcript: 'Are we done?',
            policy: normalizeTurnEndpointPolicy({ silenceMs: 700, minSpeechMs: 0 }),
        });
        await vi.advanceTimersByTimeAsync(699);
        expect(onSignal).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1', transcript: 'Are we done?', source: 'heuristic',
            endpoint: { reason: 'structural_fallback', confidence: null },
        }));
    });

    it('extends structurally incomplete utterances instead of firing at the acoustic delay', async () => {
        vi.useFakeTimers();
        const onSignal = vi.fn();
        const controller = createTurnEndpointController({ onSignal, now: () => Date.now() });
        controller.startSession('session-1');
        controller.signalHeuristicTranscriptFinalized({
            sessionId: 'session-1',
            transcript: 'I also need to',
            policy: normalizeTurnEndpointPolicy({ silenceMs: 700, minSpeechMs: 0 }),
        });
        await vi.advanceTimersByTimeAsync(700);
        expect(onSignal).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(700);
        expect(onSignal).toHaveBeenCalledTimes(1);
        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            endpoint: { reason: 'structural_incomplete', confidence: 0.7 },
        }));
    });

    it('cancels stale heuristic signals and forwards native endpoint signals immediately', () => {
        const onSignal = vi.fn();
        const controller = createTurnEndpointController({
            onSignal,
            now: () => 1_000,
        });

        controller.startSession('session-1');
        controller.signalHeuristicTranscriptFinalized({
            sessionId: 'session-1',
            transcript: 'ignored',
            policy: normalizeTurnEndpointPolicy({ silenceMs: 0, minSpeechMs: 0 }),
        });
        controller.startSession('session-2');
        controller.signalEndpointDetected({
            sessionId: 'session-1',
            source: 'native_stream',
            transcript: 'stale',
        });
        controller.signalEndpointDetected({
            sessionId: 'session-2',
            source: 'native_stream',
            transcript: 'fresh',
        });

        expect(onSignal).toHaveBeenCalledTimes(1);
        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-2',
            source: 'native_stream',
            transcript: 'fresh',
            endpoint: { reason: 'acoustic_endpoint', confidence: null },
        }));
    });

    it('emits at most one endpoint for a capture session', () => {
        const onSignal = vi.fn();
        const controller = createTurnEndpointController({
            onSignal,
            now: () => 1_000,
        });

        controller.startSession('session-1');
        controller.signalEndpointDetected({
            sessionId: 'session-1',
            source: 'native_stream',
            transcript: 'first',
        });
        controller.signalEndpointDetected({
            sessionId: 'session-1',
            source: 'native_stream',
            transcript: 'duplicate',
        });

        expect(onSignal).toHaveBeenCalledTimes(1);
        expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
            transcript: 'first',
        }));
    });
});
