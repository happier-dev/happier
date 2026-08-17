import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createVoiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from './voiceMachineError';

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
        const machine = createVoiceConversationRuntimeMachine();

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

    it('keeps a bounded provider-owned start acquiring beyond the former blanket timeout, then listens', async () => {
        vi.useFakeTimers();
        try {
            const deferred = createDeferred<void>();
            const machine = createVoiceConversationRuntimeMachine();

            const rearmPromise = machine.rearmListening({
                controlSessionId: 's1',
                startListening: () => deferred.promise,
            });

            await vi.advanceTimersByTimeAsync(30);

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
        } finally {
            vi.useRealTimers();
        }
    });

    it('maps rejected startListening calls onto recoverable mic_error', async () => {
        const machine = createVoiceConversationRuntimeMachine();

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

        machine.transitionToListening({ controlSessionId: 's1', adapterId: null, attemptId: null });
        machine.setMuted({
            controlSessionId: 's1',
            adapterId: null,
            attemptId: null,
            micMuted: true,
        });
        machine.transitionToSpeaking({ controlSessionId: 's1', adapterId: null, attemptId: null });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'speaking',
            micMuted: true,
        });
    });

    it('does not let a replaced realtime owner retain or restore its mute projection', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToConnecting({
            controlSessionId: 'voice-session',
            adapterId: 'happier.voice.openai/realtime-openai',
            attemptId: 1,
        });
        machine.setMuted({
            controlSessionId: 'voice-session',
            adapterId: 'happier.voice.openai/realtime-openai',
            attemptId: 1,
            micMuted: true,
        });

        machine.transitionToConnecting({
            controlSessionId: 'voice-session',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            attemptId: 2,
        });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 'voice-session',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            state: 'connecting',
            micMuted: false,
        });

        // This represents a delayed provider-side mute settlement from the
        // replaced OpenAI attempt. It must not overwrite ElevenLabs' current
        // physical/projected microphone state.
        machine.setMuted({
            controlSessionId: 'voice-session',
            adapterId: 'happier.voice.openai/realtime-openai',
            attemptId: 1,
            micMuted: true,
        });

        expect(machine.getSnapshot().micMuted).toBe(false);

        machine.setMuted({
            controlSessionId: 'voice-session',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            attemptId: 2,
            micMuted: true,
        });

        expect(machine.getSnapshot().micMuted).toBe(true);
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
            error: createVoiceMachineError({ kind: 'transport_disconnect', reason: 'lost connection' }),
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

        machine.transitionToConnecting({ controlSessionId: 's1', adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs' });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'connecting',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        });

        // A non-owner mid-pipeline transition is rejected (owner guard).
        machine.transitionToSpeaking({ controlSessionId: 's2' });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'connecting',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        });

        machine.transitionToDisconnected({ controlSessionId: 's1' });
        expect(machine.getSnapshot()).toMatchObject({
            state: 'disconnected',
            adapterId: null,
            reconnecting: false,
        });
    });

    it('projects reconnecting only for the current adapter and control-session owner', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToConnecting({ controlSessionId: 's1', adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs' });
        machine.transitionToConnected({ controlSessionId: 's1', adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs' });
        machine.setReconnecting({
            controlSessionId: 's1',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            reconnecting: true,
        });
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            state: 'connected',
            reconnecting: true,
        });

        machine.setReconnecting({
            controlSessionId: 'stale-session',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            reconnecting: false,
        });
        machine.setReconnecting({
            controlSessionId: 's1',
            adapterId: 'happier.voice.openai/realtime-openai',
            reconnecting: false,
        });
        expect(machine.getSnapshot().reconnecting).toBe(true);

        machine.transitionToDisconnected({ controlSessionId: 's1', adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs' });
        expect(machine.getSnapshot().reconnecting).toBe(false);
    });

    it('clears a stale realtime owner when a local entry transition starts after a declined realtime attempt', () => {
        const machine = createVoiceConversationRuntimeMachine();

        machine.transitionToConnecting({ controlSessionId: 'realtime-s1', adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs' });
        machine.transitionToDisconnected({
            controlSessionId: 'realtime-s1',
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            error: createVoiceMachineError({ kind: 'provider_error', reason: 'realtime_declined' }),
        });

        // Local adapters intentionally omit adapterId because null is the local
        // engine owner. Starting local capture must replace, not inherit, the
        // retained realtime owner used to project the declined error.
        machine.transitionToAcquiringMic({ controlSessionId: 'local-s1' });

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 'local-s1',
            state: 'acquiring_mic',
            adapterId: null,
            error: null,
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
        const machine = createVoiceConversationRuntimeMachine();
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

    it('ignores a stale rearm completion after control session ownership retargets', async () => {
        const machine = createVoiceConversationRuntimeMachine();
        const deferred = createDeferred<void>();

        const rearmPromise = machine.rearmListening({
            controlSessionId: 's1',
            startListening: () => deferred.promise,
        });

        machine.transitionToAcquiringMic({ controlSessionId: 's2' });
        deferred.resolve();
        await rearmPromise;

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's2',
            state: 'acquiring_mic',
            error: null,
        });
    });

    it('aborts the in-flight provider start when the runtime is explicitly reset', async () => {
        const machine = createVoiceConversationRuntimeMachine();
        let observedSignal: AbortSignal | undefined;
        const rearmPromise = machine.rearmListening({
            controlSessionId: 's1',
            startListening: (signal) => {
                observedSignal = signal;
                return new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
            },
        });

        expect(observedSignal?.aborted).toBe(false);
        machine.reset();
        expect(observedSignal?.aborted).toBe(true);
        await rearmPromise;

        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: null,
            state: 'disconnected',
            error: null,
        });
    });

    it('aborts the in-flight provider start when the owning session disconnects', async () => {
        const machine = createVoiceConversationRuntimeMachine();
        let observedSignal: AbortSignal | undefined;
        const rearmPromise = machine.rearmListening({
            controlSessionId: 's1',
            startListening: (signal) => {
                observedSignal = signal;
                return new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
            },
        });

        machine.transitionToDisconnected({ controlSessionId: 's1' });

        expect(observedSignal?.aborted).toBe(true);
        await rearmPromise;
        expect(machine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'disconnected',
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
