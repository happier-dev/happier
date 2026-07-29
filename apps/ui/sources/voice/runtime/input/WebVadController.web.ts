import type { MicSession } from '@/voice/runtime/mic/MicSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import type { TurnEndpointSignal } from './TurnEndpointController';
import { createTurnPolicyEndpointGate } from './turnPolicyEndpointGate';
import type { TurnPolicy } from './turnPolicyMachine';

type WebVadLike = Readonly<{
    pause: () => void | Promise<void>;
    start: () => void | Promise<void>;
}>;

type ActiveWebVadSession = Readonly<{
    sessionId: string;
    token: number;
    vad: WebVadLike;
}>;

type WebVadControllerDeps = Readonly<{
    now?: () => number;
    onEndpointSignal: (signal: TurnEndpointSignal) => void;
    onSpeechCandidateStart?: (input: Readonly<{ sessionId: string; source: 'web_vad' }>) => void;
    onSpeechCandidateFalseAlarm?: (input: Readonly<{ sessionId: string; source: 'web_vad' }>) => void;
    /**
     * Two-stage hysteresis policy layered above the acoustic VAD. The web VAD
     * surfaces both speech-start and speech-end edges, so the `confirmMs`
     * false-start debounce is applied here: a segment whose start→end span is
     * shorter than `confirmMs` is a false start and emits no endpoint. Defaults
     * to the canonical {@link createTurnPolicyEndpointGate} policy.
     */
    turnPolicy?: Partial<TurnPolicy>;
    /**
     * Optional accessor for the streaming STT's latest partial transcript, so the
     * acoustic `web_vad` endpoint signal carries the in-flight text instead of a
     * hardcoded empty string (transcript-gap / semantic consumers downstream).
     */
    getLatestPartialTranscript?: () => string | null | undefined;
}>;

type StartWebVadSessionArgs = Readonly<{
    minSpeechMs: number;
    redemptionMs: number;
    sessionId: string;
    /**
     * The canonical capture session. When provided, the VAD consumes its single
     * long-lived, echo-cancelled stream and shared {@link AudioContext} instead
     * of opening its own — closing the web mic split-brain (one acquisition).
     */
    micSession?: MicSession | null;
}>;

type SharedStreamVadOptions = Readonly<{
    audioContext?: AudioContext;
    getStream: () => Promise<MediaStream>;
    pauseStream: (stream: MediaStream) => Promise<void>;
    resumeStream: (stream: MediaStream) => Promise<MediaStream>;
}>;

/**
 * Build the vad-web option overrides that bind the recognizer to the canonical
 * {@link MicSession} stream + {@link AudioContext}. `pauseStream` is a no-op so
 * a VAD pause never stops the shared mic; lifecycle stays owned by the session.
 */
function buildSharedStreamOptions(micSession: MicSession): SharedStreamVadOptions {
    const resolveStream = async (): Promise<MediaStream> => {
        await micSession.ensureActive();
        const stream = micSession.getStream();
        if (!stream) {
            throw new Error('web_mic_stream_unavailable');
        }
        return stream;
    };
    const audioContext = micSession.getAudioContext?.() ?? undefined;
    return {
        ...(audioContext ? { audioContext } : {}),
        getStream: resolveStream,
        pauseStream: async () => {
            // Intentionally do not stop the shared canonical stream on VAD pause.
        },
        resumeStream: resolveStream,
    };
}

export type WebVadController = Readonly<{
    isActiveSession: (sessionId: string | null | undefined) => boolean;
    startSession: (args: StartWebVadSessionArgs) => Promise<boolean>;
    stopSession: (sessionId?: string | null) => Promise<void>;
}>;

function isDomRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeSessionId(sessionId: string | null | undefined): string | null {
    return normalizeNonEmptyString(sessionId);
}

function normalizeDurationMs(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.round(value));
}

export function createWebVadController(deps: WebVadControllerDeps): WebVadController {
    const now = deps.now ?? (() => Date.now());
    let activeSession: ActiveWebVadSession | null = null;
    let nextToken = 1;
    const turnPolicyEndpointGate = createTurnPolicyEndpointGate({
        ...(deps.turnPolicy ? { policy: deps.turnPolicy } : {}),
        now,
    });

    const clearActiveSession = async (sessionId?: string | null) => {
        const normalizedSessionId = normalizeSessionId(sessionId);
        if (!activeSession) {
            return;
        }

        if (normalizedSessionId && activeSession.sessionId !== normalizedSessionId) {
            return;
        }

        const previousSession = activeSession;
        activeSession = null;
        turnPolicyEndpointGate.reset();
        deps.onSpeechCandidateFalseAlarm?.({ sessionId: previousSession.sessionId, source: 'web_vad' });
        try {
            await previousSession.vad.pause();
        } catch {
            // Ignore teardown failures and allow heuristic fallback to continue.
        }
    };

    return {
        isActiveSession: (sessionId) => activeSession?.sessionId === normalizeSessionId(sessionId),
        startSession: async ({ minSpeechMs, redemptionMs, sessionId, micSession }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            if (!normalizedSessionId || !isDomRuntime()) {
                await clearActiveSession();
                return false;
            }

            await clearActiveSession();
            turnPolicyEndpointGate.reset();

            const token = nextToken++;
            try {
                const { MicVAD } = await import('@ricky0123/vad-web');
                const sharedStreamOptions = micSession ? buildSharedStreamOptions(micSession) : {};
                const vad = await MicVAD.new({
                    minSpeechMs: normalizeDurationMs(minSpeechMs),
                    model: 'v5',
                    redemptionMs: normalizeDurationMs(redemptionMs),
                    ...sharedStreamOptions,
                    // Speech-START edge → two-stage machine. The matching speech-end
                    // gates emission so a sub-confirmMs blip opens no turn.
                    onSpeechStart: () => {
                        if (!activeSession || activeSession.sessionId !== normalizedSessionId || activeSession.token !== token) {
                            return;
                        }
                        turnPolicyEndpointGate.noteSpeechDetected();
                        deps.onSpeechCandidateStart?.({ sessionId: normalizedSessionId, source: 'web_vad' });
                    },
                    onSpeechEnd: () => {
                        if (!activeSession || activeSession.sessionId !== normalizedSessionId || activeSession.token !== token) {
                            return;
                        }
                        // False-start debounce: drop a segment shorter than confirmMs.
                        if (!turnPolicyEndpointGate.shouldEmitEndpoint()) {
                            deps.onSpeechCandidateFalseAlarm?.({ sessionId: normalizedSessionId, source: 'web_vad' });
                            return;
                        }

                        deps.onEndpointSignal({
                            detectedAt: now(),
                            sessionId: normalizedSessionId,
                            source: 'web_vad',
                            transcript: normalizeNonEmptyString(deps.getLatestPartialTranscript?.()) ?? '',
                            // Speech-segment span (start → endpoint) measured by the
                            // two-stage gate, so the downstream barge-in duration gate
                            // can demote a short acknowledgement instead of treating
                            // every endpoint as duration-unknown.
                            durationMs: turnPolicyEndpointGate.getLastSegmentDurationMs(),
                            endpoint: { reason: 'acoustic_endpoint', confidence: null },
                        });
                    },
                });

                activeSession = {
                    sessionId: normalizedSessionId,
                    token,
                    vad,
                };
                await vad.start();
                return true;
            } catch {
                if (activeSession?.token === token) {
                    activeSession = null;
                }
                return false;
            }
        },
        stopSession: clearActiveSession,
    };
}
