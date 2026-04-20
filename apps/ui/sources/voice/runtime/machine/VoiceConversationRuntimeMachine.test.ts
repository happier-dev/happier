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

    it('supports explicit connected, listening, and disconnected lifecycle transitions', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToConnected({ controlSessionId: 's1' });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'connected',
            error: null,
        });

        machine.transitionToListening({ controlSessionId: 's1' });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'listening',
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
