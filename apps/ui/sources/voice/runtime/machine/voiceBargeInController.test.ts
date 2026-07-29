import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTurnTakingTelemetry } from '@/voice/input/turnTakingTelemetry';

import { createVoiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';
import { createVoiceBargeInController } from './voiceBargeInController';

type Harness = ReturnType<typeof createHarness>;

function createHarness(now = () => 10_000) {
    const machine = createVoiceConversationRuntimeMachine();
    const telemetry = createTurnTakingTelemetry({ enabled: true, now: () => 0 });
    const beginInterruptionCandidate = vi.fn(() => 'retained' as const);
    const resolveInterruptionCandidate = vi.fn<(resolution: 'false_alarm' | 'confirmed') => void>();
    const startListening = vi.fn(() => Promise.resolve());
    const controller = createVoiceBargeInController({
        machine,
        telemetry,
        now,
        playback: { beginInterruptionCandidate, resolveInterruptionCandidate },
        startListening: () => startListening(),
    });
    return { machine, telemetry, beginInterruptionCandidate, resolveInterruptionCandidate, startListening, controller };
}

async function driveToSpeaking(machine: Harness['machine'], sessionId: string): Promise<void> {
    machine.transitionToConnecting({ controlSessionId: sessionId });
    machine.transitionToSpeaking({ controlSessionId: sessionId });
    expect(machine.getSnapshot()).toMatchObject({ controlSessionId: sessionId, state: 'speaking' });
}

describe('voiceBargeInController', () => {
    beforeEach(() => {
        createVoiceConversationRuntimeMachine().reset();
    });

    it('barges in on substantive user speech during speaking: aborts playback, interrupts, rearms', async () => {
        const { machine, resolveInterruptionCandidate, startListening, controller, telemetry } = createHarness();
        await driveToSpeaking(machine, 's1');

        await controller.handleUserSpeechDuringPlayback({
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'wait that is not what i meant at all',
            speakingElapsedMs: 2_000,
        });

        // TTS playback aborted via the injected playback abort (single owner; no direct TtsController edit).
        expect(resolveInterruptionCandidate).toHaveBeenCalledWith('confirmed');
        // Capture rearmed through the machine's public interrupt+rearm API (honors the legal table).
        expect(startListening).toHaveBeenCalledTimes(1);
        expect(machine.getSnapshot()).toMatchObject({ controlSessionId: 's1', state: 'listening' });
        expect(telemetry.snapshot().counters.bargeIn).toBe(1);
    });

    it('does NOT barge-in on a one-word backchannel (reuses the T2 backchannel gate)', async () => {
        const { machine, resolveInterruptionCandidate, startListening, controller, telemetry } = createHarness();
        await driveToSpeaking(machine, 's1');

        await controller.handleUserSpeechDuringPlayback({
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'mhm',
            speakingElapsedMs: 2_000,
        });

        expect(resolveInterruptionCandidate).toHaveBeenCalledWith('false_alarm');
        expect(startListening).not.toHaveBeenCalled();
        expect(machine.getSnapshot()).toMatchObject({ state: 'speaking' });
        const counters = telemetry.snapshot().counters;
        expect(counters.bargeIn).toBe(0);
        expect(counters.backchannelSuppressed).toBe(1);
    });

    it('does NOT barge-in inside the protected-head window even for substantive speech', async () => {
        const { machine, resolveInterruptionCandidate, controller, telemetry } = createHarness();
        await driveToSpeaking(machine, 's1');

        await controller.handleUserSpeechDuringPlayback({
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'actually i changed my mind completely',
            // Inside the default 800ms protected head.
            speakingElapsedMs: 200,
        });

        expect(resolveInterruptionCandidate).toHaveBeenCalledWith('false_alarm');
        expect(machine.getSnapshot()).toMatchObject({ state: 'speaking' });
        expect(telemetry.snapshot().counters.backchannelSuppressed).toBe(1);
    });

    it('does NOT barge-in when the candidate is TTS self-echo (reuses the T3 echo guard)', async () => {
        const { machine, resolveInterruptionCandidate, controller, telemetry } = createHarness();
        await driveToSpeaking(machine, 's1');

        controller.onTtsStarted('the capital of france is paris');

        await controller.handleUserSpeechDuringPlayback({
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'the capital of france is paris',
            speakingElapsedMs: 2_000,
        });

        expect(resolveInterruptionCandidate).toHaveBeenCalledWith('false_alarm');
        expect(machine.getSnapshot()).toMatchObject({ state: 'speaking' });
        expect(telemetry.snapshot().counters.echoSuppressed).toBe(1);
        expect(telemetry.snapshot().counters.bargeIn).toBe(0);
    });

    it('ignores the signal when the machine is not speaking (no-op, honors the legal table)', async () => {
        const { machine, beginInterruptionCandidate, startListening, controller, telemetry } = createHarness();
        machine.transitionToConnecting({ controlSessionId: 's1' });
        machine.transitionToListening({ controlSessionId: 's1' });

        await controller.handleUserSpeechDuringPlayback({
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'hello are you there',
            speakingElapsedMs: 0,
        });

        expect(beginInterruptionCandidate).not.toHaveBeenCalled();
        expect(startListening).not.toHaveBeenCalled();
        expect(machine.getSnapshot()).toMatchObject({ state: 'listening' });
        expect(telemetry.snapshot().counters.bargeIn).toBe(0);
    });

    it('ignores a signal for a different session than the one currently owning the machine', async () => {
        const { machine, beginInterruptionCandidate, controller } = createHarness();
        await driveToSpeaking(machine, 's1');

        await controller.handleUserSpeechDuringPlayback({
            sessionId: 's2',
            source: 'native_vad',
            transcript: 'this belongs to another session entirely',
            speakingElapsedMs: 2_000,
        });

        expect(beginInterruptionCandidate).not.toHaveBeenCalled();
        expect(machine.getSnapshot()).toMatchObject({ controlSessionId: 's1', state: 'speaking' });
    });

    it('barge-in can be disabled, leaving playback and state untouched', async () => {
        const { machine, beginInterruptionCandidate, startListening, controller } = createHarness();
        await driveToSpeaking(machine, 's1');

        await controller.handleUserSpeechDuringPlayback({
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'stop talking i want to say something',
            speakingElapsedMs: 2_000,
            bargeInEnabled: false,
        });

        expect(beginInterruptionCandidate).not.toHaveBeenCalled();
        expect(startListening).not.toHaveBeenCalled();
        expect(machine.getSnapshot()).toMatchObject({ state: 'speaking' });
    });

    it('ducks or pauses immediately on a speech-start candidate without destructively interrupting', async () => {
        const { machine, beginInterruptionCandidate, resolveInterruptionCandidate, startListening, controller } = createHarness();
        await driveToSpeaking(machine, 's1');

        const result = controller.onUserSpeechCandidate({ sessionId: 's1', bargeInEnabled: true });

        expect(result).toEqual({ status: 'candidate', playback: 'retained' });
        expect(beginInterruptionCandidate).toHaveBeenCalledTimes(1);
        expect(resolveInterruptionCandidate).not.toHaveBeenCalled();
        expect(startListening).not.toHaveBeenCalled();
        expect(machine.getSnapshot().state).toBe('speaking');
    });

    it('resumes retained playback when a candidate ends as a false alarm', async () => {
        const { machine, resolveInterruptionCandidate, controller } = createHarness();
        await driveToSpeaking(machine, 's1');
        controller.onUserSpeechCandidate({ sessionId: 's1', bargeInEnabled: true });

        controller.cancelUserSpeechCandidate({ sessionId: 's1' });
        controller.cancelUserSpeechCandidate({ sessionId: 's1' });

        expect(resolveInterruptionCandidate).toHaveBeenCalledTimes(1);
        expect(resolveInterruptionCandidate).toHaveBeenCalledWith('false_alarm');
        expect(machine.getSnapshot().state).toBe('speaking');
    });

    it('coalesces repeated speech-start edges and restores once when playback/session stops', async () => {
        const { machine, beginInterruptionCandidate, resolveInterruptionCandidate, controller } = createHarness();
        await driveToSpeaking(machine, 's1');

        expect(controller.onUserSpeechCandidate({ sessionId: 's1' })).toEqual({
            status: 'candidate', playback: 'retained',
        });
        expect(controller.onUserSpeechCandidate({ sessionId: 's1' })).toEqual({
            status: 'candidate', playback: 'retained',
        });
        controller.onTtsStopped();
        controller.onTtsStopped();

        expect(beginInterruptionCandidate).toHaveBeenCalledTimes(1);
        expect(resolveInterruptionCandidate).toHaveBeenCalledTimes(1);
        expect(resolveInterruptionCandidate).toHaveBeenCalledWith('false_alarm');
    });

    it('fails a provisional candidate open after the bounded retention window', async () => {
        vi.useFakeTimers();
        try {
            const { machine, resolveInterruptionCandidate, controller } = createHarness();
            await driveToSpeaking(machine, 's1');
            controller.onUserSpeechCandidate({ sessionId: 's1', bargeInEnabled: true });

            await vi.advanceTimersByTimeAsync(3_001);

            expect(resolveInterruptionCandidate).toHaveBeenCalledTimes(1);
            expect(resolveInterruptionCandidate).toHaveBeenCalledWith('false_alarm');
            expect(machine.getSnapshot().state).toBe('speaking');
        } finally {
            vi.useRealTimers();
        }
    });
});
