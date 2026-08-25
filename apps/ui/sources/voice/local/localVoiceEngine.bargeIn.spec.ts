import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnEndpointSignal } from '@/voice/runtime/input/TurnEndpointController';

import {
    expoSpeechSpeak,
    expoSpeechStop,
    flushMicrotasks,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    submitMessage,
} from './localVoiceEngine.testHarness';

/**
 * Live barge-in wiring: a runtime-owned endpoint signal that lands WHILE the
 * agent is `speaking` must be forwarded to the (previously dead) barge-in
 * controller, which re-validates state/session/backchannel-gate/echo before it
 * aborts playback and interrupt-and-rearms listening.
 *
 * The capture owner is replaced with a thin double so the test can:
 *  - capture the engine's `onEndpointSignal` callback (the only public entry to
 *    `handleRuntimeOwnedEndpointSignal`), and
 *  - observe the rearm leg of the barge-in via `startCapture` (the function the
 *    machine drives through `interruptAndRearmListening` -> `startListening`).
 */

type CaptureOwnerHooks = Readonly<{
    onEndpointSignal: (signal: TurnEndpointSignal) => void;
    startCapture: ReturnType<typeof vi.fn>;
}>;

const captureOwnerHooks = vi.hoisted(() => ({
    current: null as
        | (CaptureOwnerHooks & { instance: Record<string, unknown> })
        | null,
}));

async function registerControlSessionBinding(controlSessionId: string, conversationSessionId: string): Promise<void> {
    const storage = await getStorage();
    const state = storage.getState();
    storage.__setState({
        sessions: {
            ...state.sessions,
            [conversationSessionId]: {
                id: conversationSessionId,
                active: true,
                updatedAt: Date.now(),
                metadata: {},
            },
        },
    });
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    voiceSessionBindingStore.getState().bind({
        adapterId: 'local_direct',
        controlSessionId,
        conversationSessionId,
        transcriptMode: 'native_session',
        targetSessionId: null,
        updatedAt: Date.now(),
    });
}

// The shared harness `beforeEach` runs `vi.doUnmock`, so the capture-owner
// double is registered after that hook and read on the first engine import.
// This suite deliberately retains one engine module graph; subsequent tests
// reuse the same double and reset its observable calls.
function registerCaptureOwnerDouble(): void {
    vi.doMock('@/voice/runtime/input/LocalVoiceCaptureOwner', () => ({
        createLocalVoiceCaptureOwner: (deps: { onEndpointSignal?: (signal: TurnEndpointSignal) => void }) => {
            const startCapture = vi.fn(async () => {});
            const instance = {
                resolveManualBargeInAction: vi.fn(() => ({ kind: 'noop', reason: 'not_speaking' })),
                resolveEndpointSignalAction: vi.fn(() => ({ kind: 'ignore', reason: 'not_hands_free' })),
                startCapture,
                stopCapture: vi.fn(async () => ({ provider: 'device', text: '', continueHandsFree: false })),
                stopEndpointDrivenCapture: vi.fn(async () => ({ kind: 'ignore', reason: 'empty_transcript', shouldRearm: false })),
                isHandsFreeCaptureSession: vi.fn(() => false),
                clearHandsFree: vi.fn(),
                setMuted: vi.fn(async () => {}),
                stopSession: vi.fn(async () => {}),
            };
            captureOwnerHooks.current = {
                onEndpointSignal: (signal) => deps.onEndpointSignal?.(signal),
                startCapture,
                instance,
            };
            return instance;
        },
    }));
}

async function configureBargeInSpeakingSession(sessionId: string): Promise<void> {
    const storage = await getStorage();
    storage.__setState({
        settings: {
            ...storage.getState().settings,
            voice: {
                ...storage.getState().settings.voice,
                providerId: 'local_direct',
                providers: {
                    ...storage.getState().settings.voice.providers,
                    local_direct: { schemaVersion: 1, config: {
                        ...storage.getState().settings.voice.providers.local_direct.config,
                        stt: {
                            ...storage.getState().settings.voice.providers.local_direct.config.stt,
                            provider: 'device',
                        },
                        tts: {
                            ...storage.getState().settings.voice.providers.local_direct.config.tts,
                            autoSpeakReplies: false,
                            bargeInEnabled: true,
                        },
                    } },
                },
            },
        },
    });

    const localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    await localVoiceEngine.toggleLocalVoiceTurn(sessionId);
    await vi.waitFor(() => {
        expect(captureOwnerHooks.current?.startCapture).toHaveBeenCalledTimes(1);
    });
    // The public start owns the admission. The barge-in assertion below must
    // observe only its fresh rearm, rather than counting setup capture.
    captureOwnerHooks.current?.startCapture.mockClear();

    const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
    voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId });
}

const baseSignal = (sessionId: string, transcript: string): TurnEndpointSignal => ({
    detectedAt: Date.now(),
    sessionId,
    source: 'native_vad',
    transcript,
    endpoint: { reason: 'acoustic_endpoint', confidence: null },
});

// The echo guard's protected-head / overlap thresholds (single source of truth).
const PROTECTED_HEAD_MS = 800;
const ECHO_JUST_STARTED_MS = 200;

// Configure a half-duplex local_direct session that AUTO-SPEAKS device-TTS
// replies with barge-in enabled, so a real reply turn flows through
// `sendVoiceTextTurn` (the PRIMARY reply path) and seeds the echo guard.
async function configureReplySpeakingSession(): Promise<void> {
    const storage = await getStorage();
    storage.__setState({
        settings: {
            ...storage.getState().settings,
            voice: {
                ...storage.getState().settings.voice,
                providerId: 'local_direct',
                providers: {
                    ...storage.getState().settings.voice.providers,
                    local_direct: { schemaVersion: 1, config: {
                        ...storage.getState().settings.voice.providers.local_direct.config,
                        stt: {
                            ...storage.getState().settings.voice.providers.local_direct.config.stt,
                            provider: 'device',
                        },
                        tts: {
                            ...storage.getState().settings.voice.providers.local_direct.config.tts,
                            autoSpeakReplies: true,
                            provider: 'device',
                            bargeInEnabled: true,
                        },
                    } },
                },
            },
        },
    });
}

type ReplySpeakingHandle = Readonly<{
    turnPromise: Promise<void>;
    finishSpeak: () => void;
    speakingStartedAt: number;
}>;

// Drive a real reply turn (user text -> injected assistant reply -> device TTS)
// to the `speaking` state via the engine's public send entry. The device speak
// is held open (onDone captured but not fired) so the reply stays in `speaking`
// while the test injects barge-in endpoint signals. Returns the wall clock at
// which the reply began speaking so tests can place candidates relative to the
// protected head.
async function driveReplyToSpeaking(
    engine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>,
    replyText: string,
): Promise<ReplySpeakingHandle> {
    const storage = await getStorage();
    const onDoneRef: { current: (() => void) | undefined } = { current: undefined };
    const onStoppedRef: { current: (() => void) | undefined } = { current: undefined };
    const onStartRef: { current: (() => void) | undefined } = { current: undefined };
    expoSpeechSpeak.mockImplementation((_text: string, opts: any) => {
        onStartRef.current = typeof opts?.onStart === 'function' ? (opts.onStart as () => void) : undefined;
        onDoneRef.current = typeof opts?.onDone === 'function' ? (opts.onDone as () => void) : undefined;
        onStoppedRef.current = typeof opts?.onStopped === 'function' ? (opts.onStopped as () => void) : undefined;
    });
    expoSpeechStop.mockImplementation(() => {
        onStoppedRef.current?.();
    });
    submitMessage.mockImplementationOnce(() => {
        storage.__setState({
            sessionMessages: {
                s1: {
                    messages: [{ id: 'm1', kind: 'agent-text', text: replyText, createdAt: Date.now() + 60_000 }],
                },
            },
        });
        storage.__notify();
    });

    // A real public capture start creates the admission that is retained while
    // the reply speaks. The endpoint callback is only valid for that admitted
    // attempt; direct state injection alone would test a rejected stale signal.
    await engine.toggleLocalVoiceTurn('s1');
    await vi.waitFor(() => {
        expect(captureOwnerHooks.current?.startCapture).toHaveBeenCalledTimes(1);
    });
    captureOwnerHooks.current?.startCapture.mockClear();

    const turnPromise = engine.sendLocalVoiceAgentTextTurn('s1', 'what is the forecast');
    await vi.waitFor(() => {
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
    });
    expect(engine.getLocalVoiceState().status).not.toBe('speaking');
    if (!onStartRef.current) throw new Error('Expected ExpoSpeech onStart callback');
    const speakingStartedAt = Date.now();
    onStartRef.current();
    await vi.waitFor(() => {
        expect(engine.getLocalVoiceState().status).toBe('speaking');
    });

    return {
        turnPromise,
        finishSpeak: () => onDoneRef.current?.(),
        speakingStartedAt,
    };
}

describe('local voice engine live barge-in', () => {
    registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });
    beforeEach(() => {
        if (captureOwnerHooks.current) {
            captureOwnerHooks.current.startCapture.mockClear();
        } else {
            registerCaptureOwnerDouble();
        }
    });

    afterEach(async () => {
        const [
            localVoiceEngine,
            { voiceConversationRuntimeMachine },
            { resetVoiceSessionRuntimeStateForTests },
            { voiceSessionBindingStore },
            { __resetVoiceTurnInterruptions },
        ] = await Promise.all([
            import('./localVoiceEngine'),
            import('@/voice/runtime/machine/VoiceConversationRuntimeMachine'),
            import('@/voice/session/voiceSessionStore'),
            import('@/voice/binding/voiceConversationBindingStore'),
            import('@/voice/transcript/voiceTurnInterruption'),
        ]);

        await localVoiceEngine.stopLocalVoiceSession();
        voiceConversationRuntimeMachine.reset();
        await resetVoiceSessionRuntimeStateForTests();
        __resetVoiceTurnInterruptions();

        for (const binding of voiceSessionBindingStore.getState().list()) {
            voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
        }
        voiceSessionBindingStore.getState().replacePersistedBindings([]);
    });

    it('a substantive endpoint signal while speaking aborts playback and rearms listening', async () => {
        const { getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await configureBargeInSpeakingSession('s1');
        expect(getLocalVoiceState().status).toBe('speaking');

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();
        hooks!.onEndpointSignal(baseSignal('s1', 'please stop and listen to me instead'));

        await vi.waitFor(() => {
            expect(hooks!.startCapture).toHaveBeenCalledTimes(1);
        });
        expect(hooks!.startCapture).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 's1' }),
        );
        // interrupt -> rearm walks speaking -> interrupted -> acquiring_mic/listening.
        expect(['recording', 'speaking']).toContain(getLocalVoiceState().status);
    });

    it('a one-word backchannel while speaking does not barge in', async () => {
        const { getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await configureBargeInSpeakingSession('s1');
        expect(getLocalVoiceState().status).toBe('speaking');

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();
        hooks!.onEndpointSignal(baseSignal('s1', 'mhm'));
        hooks!.onEndpointSignal(baseSignal('s1', 'yeah'));

        await Promise.resolve();
        await Promise.resolve();

        expect(hooks!.startCapture).not.toHaveBeenCalled();
        expect(getLocalVoiceState().status).toBe('speaking');
    });

    // The duration gate is an AND with the word gate (maxWords 3, maxDurationMs
    // 700): a short (≤ maxWords) utterance is a backchannel ONLY when its measured
    // duration is also short. A drawn-out short utterance is a real turn. These two
    // cases prove `durationMs` is now plumbed end-to-end onto the endpoint signal
    // and consulted by the gate (before the fix it was always duration-unknown).
    it('a short utterance with a brief measured duration is suppressed as a backchannel', async () => {
        const { getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await configureBargeInSpeakingSession('s1');
        expect(getLocalVoiceState().status).toBe('speaking');

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();
        // 3 words (≤ maxWords) AND a 250 ms span (≤ maxDurationMs) → backchannel.
        hooks!.onEndpointSignal({
            ...baseSignal('s1', 'okay sure thanks'),
            durationMs: 250,
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(hooks!.startCapture).not.toHaveBeenCalled();
        expect(getLocalVoiceState().status).toBe('speaking');
    });

    it('the same short utterance barges in when drawn out past the duration gate', async () => {
        const { getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await configureBargeInSpeakingSession('s1');
        expect(getLocalVoiceState().status).toBe('speaking');

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();
        // Same ≤ maxWords text, but a 1500 ms span (> maxDurationMs) → a real turn
        // the duration gate must NOT demote. Proves the gate consults a known
        // duration rather than blanket-suppressing every short utterance.
        hooks!.onEndpointSignal({
            ...baseSignal('s1', 'okay sure thanks'),
            durationMs: 1_500,
        });

        await vi.waitFor(() => {
            expect(hooks!.startCapture).toHaveBeenCalledTimes(1);
        });
    });

    it('a substantive signal while NOT speaking does not trigger the barge-in rearm', async () => {
        const { getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_direct.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                provider: 'device',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                                bargeInEnabled: true,
                            },
                        } },
                    },
                },
            },
        });

        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        voiceConversationRuntimeMachine.transitionToListening({ controlSessionId: 's1' });
        expect(getLocalVoiceState().status).toBe('recording');

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();
        hooks!.onEndpointSignal(baseSignal('s1', 'please stop and listen to me instead'));

        await Promise.resolve();
        await Promise.resolve();

        // Not speaking: the barge-in controller must not abort/rearm. The pre-existing
        // hands-free endpoint path is mocked to `ignore`, so nothing rearms either.
        expect(hooks!.startCapture).not.toHaveBeenCalled();
    });

    // M1: the PRIMARY reply path (`sendVoiceTextTurn`) must seed the echo guard +
    // protected head exactly like the welcome path, so full-duplex barge-in over
    // a reply does not self-interrupt on the agent's own TTS. These drive a real
    // reply turn (TTS started WITH text), unlike the cases above which transition
    // straight to `speaking` and never seed.
    const REPLY_TEXT = 'the weather today is sunny and warm outside right now';

    it('suppresses the reply echo during the reply (no self-interruption on its own TTS)', async () => {
        const engine = await loadLocalVoiceEngineWithCompatState();
        await configureReplySpeakingSession();
        const handle = await driveReplyToSpeaking(engine, REPLY_TEXT);

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();

        // Past the AEC "just started" window so the drop is decided on TEXT
        // overlap (proving the reply text was seeded), not on timing.
        await new Promise((resolve) => setTimeout(resolve, ECHO_JUST_STARTED_MS + 80));

        // A near-verbatim echo of the reply: every token is in the seeded TTS
        // text -> overlap 1.0 -> dropped. Without the seam this would be a
        // 7-word, past-protected-head turn that interrupts.
        hooks!.onEndpointSignal({
            detectedAt: handle.speakingStartedAt + 5_000,
            endpoint: { reason: 'acoustic_endpoint', confidence: null },
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'the weather today is sunny and warm',
        });
        await flushMicrotasks(4);

        expect(hooks!.startCapture).not.toHaveBeenCalled();
        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(engine.getLocalVoiceState().status).toBe('speaking');

        handle.finishSpeak();
        await handle.turnPromise;
    });

    it('lets a real non-echo barge-in interrupt the reply (abort playback + rearm)', async () => {
        const engine = await loadLocalVoiceEngineWithCompatState();
        await configureReplySpeakingSession();
        const handle = await driveReplyToSpeaking(engine, REPLY_TEXT);

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();

        // Past the AEC just-started window so a genuine turn is judged on overlap.
        await new Promise((resolve) => setTimeout(resolve, ECHO_JUST_STARTED_MS + 80));

        // Low overlap with the reply, > maxWords, past the protected head: a real
        // barge-in that must abort TTS and rearm listening.
        hooks!.onEndpointSignal({
            detectedAt: handle.speakingStartedAt + 5_000,
            endpoint: { reason: 'acoustic_endpoint', confidence: null },
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'please cancel that and call my mother instead now',
        });

        await vi.waitFor(() => {
            expect(hooks!.startCapture).toHaveBeenCalledTimes(1);
        });
        expect(expoSpeechStop).toHaveBeenCalled();
        expect(hooks!.startCapture).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 's1' }),
        );

        await handle.turnPromise;
    });

    it('applies the protected-head window to the reply (early non-echo speech is held)', async () => {
        const engine = await loadLocalVoiceEngineWithCompatState();
        await configureReplySpeakingSession();
        const handle = await driveReplyToSpeaking(engine, REPLY_TEXT);

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();

        // Past the AEC just-started window so the candidate reaches the
        // protected-head gate rather than being dropped as echo-just-started.
        await new Promise((resolve) => setTimeout(resolve, ECHO_JUST_STARTED_MS + 80));

        // Same substantive non-echo turn as the interrupt case, but placed INSIDE
        // the 800 ms protected head -> held (no abort/rearm).
        hooks!.onEndpointSignal({
            detectedAt: handle.speakingStartedAt + Math.floor(PROTECTED_HEAD_MS / 8),
            endpoint: { reason: 'acoustic_endpoint', confidence: null },
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'please cancel that and call my mother instead now',
        });
        await flushMicrotasks(4);

        expect(hooks!.startCapture).not.toHaveBeenCalled();
        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(engine.getLocalVoiceState().status).toBe('speaking');

        handle.finishSpeak();
        await handle.turnPromise;
    });

    // The barge-in interrupt seam marks the full generated assistant turn as
    // interrupted. It never guesses a heard-text prefix from elapsed playback.
    it('a real barge-in marks the persisted assistant turn interrupted', async () => {
        const engine = await loadLocalVoiceEngineWithCompatState();
        const { isVoiceTurnInterrupted } = await import('@/voice/transcript/voiceTurnInterruption');
        await registerControlSessionBinding('s1', 's1');
        await configureReplySpeakingSession();
        const handle = await driveReplyToSpeaking(engine, REPLY_TEXT);

        const hooks = captureOwnerHooks.current;
        expect(hooks).not.toBeNull();

        await new Promise((resolve) => setTimeout(resolve, ECHO_JUST_STARTED_MS + 80));

        hooks!.onEndpointSignal({
            detectedAt: handle.speakingStartedAt + 5_000,
            endpoint: { reason: 'acoustic_endpoint', confidence: null },
            sessionId: 's1',
            source: 'native_vad',
            transcript: 'please cancel that and call my mother instead now',
        });

        await vi.waitFor(() => {
            expect(hooks!.startCapture).toHaveBeenCalledTimes(1);
        });
        expect(isVoiceTurnInterrupted('m1')).toBe(true);

        await handle.turnPromise;
    });

    it('a clean completion does not mark the assistant turn interrupted', async () => {
        const engine = await loadLocalVoiceEngineWithCompatState();
        const { isVoiceTurnInterrupted } = await import('@/voice/transcript/voiceTurnInterruption');
        await registerControlSessionBinding('s1', 's1');
        await configureReplySpeakingSession();
        const handle = await driveReplyToSpeaking(engine, REPLY_TEXT);

        // The reply speaks to completion without any barge-in.
        handle.finishSpeak();
        await handle.turnPromise;
        await flushMicrotasks(4);

        expect(isVoiceTurnInterrupted('m1')).toBe(false);
    });
});
