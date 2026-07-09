import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createVoiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

describe('VoiceConversationRuntimeMachine', () => {
    beforeEach(() => {
        createVoiceConversationRuntimeMachine().reset();
    });

    it('waits for listening start confirmation before entering listening', async () => {
        const deferred = createDeferred<void>();
        const machine = createVoiceConversationRuntimeMachine({
            listeningStartTimeoutMs: 1_000,
        });

        const rearmPromise = machine.rearmListening({
            controlSessionId: 's1',
            startListening: () => deferred.promise,
        });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'acquiring_mic',
        });

        deferred.resolve();
        await rearmPromise;

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'listening',
            error: null,
        });
    });

    it('transitions to mic_error with stt_timeout when listening start confirmation times out', async () => {
        vi.useFakeTimers();
        try {
            const machine = createVoiceConversationRuntimeMachine({
                listeningStartTimeoutMs: 25,
            });

            const rearmPromise = machine.rearmListening({
                controlSessionId: 's1',
                startListening: () => new Promise<void>(() => {}),
            });

            await vi.advanceTimersByTimeAsync(30);
            await rearmPromise;

            expect(machine.getSnapshot()).toMatchObject({
                controlSessionId: 's1',
                state: 'mic_error',
                error: {
                    kind: 'stt_timeout',
                    recoverable: true,
                },
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('maps rejected startListening calls onto recoverable mic_error', async () => {
        const machine = createVoiceConversationRuntimeMachine({
            listeningStartTimeoutMs: 1_000,
        });

        await machine.rearmListening({
            controlSessionId: 's1',
            startListening: async () => {
                throw new Error('device_stt_start_failed');
            },
        });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'mic_error',
            error: {
                kind: 'provider_error',
                reason: 'device_stt_start_failed',
                recoverable: true,
            },
        });
    });

    it('keeps micMuted as an orthogonal snapshot attribute', async () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.setMuted(true);
        machine.transitionToSpeaking({ controlSessionId: 's1' });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'speaking',
            micMuted: true,
        });
    });

    it('supports explicit listening and disconnected lifecycle transitions', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToListening({ controlSessionId: 's1' });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'listening',
            error: null,
        });

        machine.transitionToDisconnected({
            controlSessionId: 's1',
            error: {
                kind: 'transport_disconnect',
                reason: 'lost connection',
                recoverable: true,
            },
        });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'disconnected',
            error: {
                kind: 'transport_disconnect',
                reason: 'lost connection',
                recoverable: true,
            },
        });
    });

    it('renames the post-transcription compute state to thinking', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToListening({ controlSessionId: 's1' });
        machine.transitionToThinking({ controlSessionId: 's1' });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'thinking',
            error: null,
        });
    });

    it('records the owning adapter for an entry transition and clears it on disconnect', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToConnecting({ controlSessionId: 's1', adapterId: 'realtime_elevenlabs' });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'connecting',
            adapterId: 'realtime_elevenlabs',
        });

        // A non-owner mid-pipeline transition is rejected (owner guard).
        machine.transitionToSpeaking({ controlSessionId: 's2' });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'connecting',
            adapterId: 'realtime_elevenlabs',
        });

        machine.transitionToDisconnected({ controlSessionId: 's1' });
        expect(machine.getSnapshot()).toMatchObject({
            state: 'disconnected',
            adapterId: null,
        });
    });

    it('rejects an illegal source-state transition as a no-op', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToEnding({ controlSessionId: 's1' });
        // ending -> speaking is not a legal transition; it must be ignored.
        machine.transitionToSpeaking({ controlSessionId: 's1' });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'ending',
        });
    });

    it('ignores late listening confirmations after the machine resets the active session', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToAcquiringMic({ controlSessionId: 's1' });
        machine.reset();
        machine.confirmListeningStarted({ controlSessionId: 's1' });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: null,
            state: 'disconnected',
            error: null,
        });
    });

    it('ignores late listening confirmations after control session ownership retargets', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToAcquiringMic({ controlSessionId: 's1' });
        machine.transitionToAcquiringMic({ controlSessionId: 's2' });
        machine.confirmListeningStarted({ controlSessionId: 's1' });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's2',
            state: 'acquiring_mic',
            error: null,
        });
    });

    it('can enter acquiring_mic before a recorder-backed listen path finishes starting', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToAcquiringMic({ controlSessionId: 's1' });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'acquiring_mic',
            error: null,
        });
    });

    it('ignores a stale rearm rejection after control session ownership retargets', async () => {
        const machine = createVoiceConversationRuntimeMachine({
            listeningStartTimeoutMs: 1_000,
        });
        const deferred = createDeferred<void>();

        const rearmPromise = machine.rearmListening({
            controlSessionId: 's1',
            startListening: () => deferred.promise,
        });

        // A newer owner takes over while the first start is still in flight.
        machine.transitionToAcquiringMic({ controlSessionId: 's2' });

        // The losing start now rejects late — it must not stomp mic_error onto s2.
        deferred.reject(new Error('device_stt_start_failed'));
        await rearmPromise;

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's2',
            state: 'acquiring_mic',
            error: null,
        });
    });

    it('ignores a stale rearm timeout after control session ownership retargets', async () => {
        vi.useFakeTimers();
        try {
            const machine = createVoiceConversationRuntimeMachine({
                listeningStartTimeoutMs: 25,
            });

            const rearmPromise = machine.rearmListening({
                controlSessionId: 's1',
                startListening: () => new Promise<void>(() => {}),
            });

            // A newer owner takes over before the stale timeout fires.
            machine.transitionToAcquiringMic({ controlSessionId: 's2' });

            await vi.advanceTimersByTimeAsync(30);
            await rearmPromise;

            expect(machine.getSnapshot()).toMatchObject({
                controlSessionId: 's2',
                state: 'acquiring_mic',
                error: null,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborts the in-flight capture signal when the listening start times out', async () => {
        vi.useFakeTimers();
        try {
            const machine = createVoiceConversationRuntimeMachine({
                listeningStartTimeoutMs: 25,
            });

            let observedSignal: AbortSignal | undefined;
            const rearmPromise = machine.rearmListening({
                controlSessionId: 's1',
                startListening: (signal) => {
                    observedSignal = signal;
                    return new Promise<void>(() => {});
                },
            });

            expect(observedSignal).toBeDefined();
            expect(observedSignal?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(30);
            await rearmPromise;

            expect(observedSignal?.aborted).toBe(true);
            expect(machine.getSnapshot()).toMatchObject({
                controlSessionId: 's1',
                state: 'mic_error',
                error: { kind: 'stt_timeout' },
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('interrupts speaking and rearms listening through the machine owner seam', async () => {
        const deferred = createDeferred<void>();
        const machine = createVoiceConversationRuntimeMachine();
        const startListening = vi.fn(() => deferred.promise);

        machine.transitionToSpeaking({ controlSessionId: 's1' });
        const rearmPromise = machine.interruptAndRearmListening({
            controlSessionId: 's1',
            startListening,
        });

        expect(startListening).toHaveBeenCalledTimes(1);
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'acquiring_mic',
            error: null,
        });

        deferred.resolve();
        await rearmPromise;

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'listening',
            error: null,
        });
    });
});
