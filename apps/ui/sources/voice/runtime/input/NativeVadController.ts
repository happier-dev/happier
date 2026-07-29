import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { resolveNativeSileroVadBridge } from './NativeSileroVadBridge';
import type { TurnEndpointSignal } from './TurnEndpointController';
import { createTurnPolicyEndpointGate } from './turnPolicyEndpointGate';
import type { TurnPolicy } from './turnPolicyMachine';

export type NativeVadSession = Readonly<{
    stop: () => void | Promise<void>;
}>;

export type NativeVadBridge = Readonly<{
    startSession: (args: Readonly<{
        minSpeechMs: number;
        onSpeechEnd: () => void;
        /**
         * Optional speech-START edge. When the native module surfaces it, the
         * controller feeds the two-stage hysteresis machine so a sub-`confirmMs`
         * segment is debounced as a false start. Bridges that cannot emit it omit
         * it, and the controller degrades to single-stage (legacy) behavior.
         */
        onSpeechStart?: () => void;
        redemptionMs: number;
        sessionId: string;
    }>) => NativeVadSession | Promise<NativeVadSession>;
}>;

type ActiveNativeVadSession = Readonly<{
    session: NativeVadSession;
    sessionId: string;
    token: number;
}>;

type PendingNativeVadStart = Readonly<{
    sessionId: string;
    token: number;
}>;

type NativeVadControllerDeps = Readonly<{
    bridge?: NativeVadBridge | null;
    now?: () => number;
    onEndpointSignal: (signal: TurnEndpointSignal) => void;
    onSpeechCandidateStart?: (input: Readonly<{ sessionId: string; source: 'native_vad' }>) => void;
    onSpeechCandidateFalseAlarm?: (input: Readonly<{ sessionId: string; source: 'native_vad' }>) => void;
    /**
     * Two-stage hysteresis policy. Applied only when the bridge surfaces a
     * speech-start edge; otherwise the controller stays single-stage. Defaults to
     * the canonical {@link createTurnPolicyEndpointGate} policy.
     */
    turnPolicy?: Partial<TurnPolicy>;
    /**
     * Optional accessor for the streaming STT's latest partial transcript, so the
     * acoustic `native_vad` endpoint signal carries the in-flight text instead of
     * a hardcoded empty string (transcript-gap / semantic consumers downstream).
     */
    getLatestPartialTranscript?: () => string | null | undefined;
}>;

type StartNativeVadSessionArgs = Readonly<{
    minSpeechMs: number;
    redemptionMs: number;
    sessionId: string;
}>;

export type NativeVadController = Readonly<{
    isActiveSession: (sessionId: string | null | undefined) => boolean;
    startSession: (args: StartNativeVadSessionArgs) => Promise<boolean>;
    stopSession: (sessionId?: string | null) => Promise<void>;
}>;

function normalizeSessionId(sessionId: string | null | undefined): string | null {
    return normalizeNonEmptyString(sessionId);
}

function normalizeDurationMs(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.round(value));
}

function safelyNotifyObserver(notify: () => void): void {
    try {
        notify();
    } catch {
        // Observers cannot take ownership of native session lifecycle or teardown.
    }
}

export function createNativeVadController(deps: NativeVadControllerDeps): NativeVadController {
    const now = deps.now ?? (() => Date.now());
    let activeSession: ActiveNativeVadSession | null = null;
    let pendingStart: PendingNativeVadStart | null = null;
    let nextToken = 1;
    const turnPolicyEndpointGate = createTurnPolicyEndpointGate({
        ...(deps.turnPolicy ? { policy: deps.turnPolicy } : {}),
        now,
    });
    const resolveBridge = async (): Promise<NativeVadBridge | null | undefined> =>
        deps.bridge === undefined ? await resolveNativeSileroVadBridge() : deps.bridge;

    const clearActiveSession = async (sessionId?: string | null, preservePendingToken?: number) => {
        const normalizedSessionId = normalizeSessionId(sessionId);
        if (
            pendingStart
            && pendingStart.token !== preservePendingToken
            && (!normalizedSessionId || pendingStart.sessionId === normalizedSessionId)
        ) {
            pendingStart = null;
        }
        if (!activeSession) {
            return;
        }

        if (normalizedSessionId && activeSession.sessionId !== normalizedSessionId) {
            return;
        }

        const previousSession = activeSession;
        activeSession = null;
        turnPolicyEndpointGate.reset();
        safelyNotifyObserver(() => deps.onSpeechCandidateFalseAlarm?.({
            sessionId: previousSession.sessionId,
            source: 'native_vad',
        }));
        try {
            await previousSession.session.stop();
        } catch {
            // Ignore native teardown failures; callers will preserve provider fallback endpointing.
        }
    };

    return {
        isActiveSession: (sessionId) => activeSession?.sessionId === normalizeSessionId(sessionId),
        startSession: async ({ minSpeechMs, redemptionMs, sessionId }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            if (!normalizedSessionId) {
                await clearActiveSession();
                return false;
            }

            turnPolicyEndpointGate.reset();

            const token = nextToken++;
            pendingStart = { sessionId: normalizedSessionId, token };
            await clearActiveSession(undefined, token);
            if (pendingStart?.token !== token) {
                return false;
            }
            try {
                const bridge = await resolveBridge();
                if (pendingStart?.token !== token) {
                    return false;
                }
                if (!bridge) {
                    pendingStart = null;
                    return false;
                }

                const session = await bridge.startSession({
                    minSpeechMs: normalizeDurationMs(minSpeechMs),
                    // Speech-START edge → two-stage machine (when the native module
                    // surfaces it). The matching speech-end gates emission so a
                    // sub-confirmMs blip opens no turn.
                    onSpeechStart: () => {
                        if (!activeSession || activeSession.sessionId !== normalizedSessionId || activeSession.token !== token) {
                            return;
                        }
                        turnPolicyEndpointGate.noteSpeechDetected();
                        safelyNotifyObserver(() => deps.onSpeechCandidateStart?.({
                            sessionId: normalizedSessionId,
                            source: 'native_vad',
                        }));
                    },
                    onSpeechEnd: () => {
                        if (!activeSession || activeSession.sessionId !== normalizedSessionId || activeSession.token !== token) {
                            return;
                        }
                        // False-start debounce: drop a segment shorter than confirmMs.
                        if (!turnPolicyEndpointGate.shouldEmitEndpoint()) {
                            safelyNotifyObserver(() => deps.onSpeechCandidateFalseAlarm?.({
                                sessionId: normalizedSessionId,
                                source: 'native_vad',
                            }));
                            return;
                        }

                        safelyNotifyObserver(() => deps.onEndpointSignal({
                            detectedAt: now(),
                            sessionId: normalizedSessionId,
                            source: 'native_vad',
                            transcript: normalizeNonEmptyString(deps.getLatestPartialTranscript?.()) ?? '',
                            // Speech-segment span (start → endpoint) measured by the
                            // two-stage gate, so the downstream barge-in duration gate
                            // can demote a short acknowledgement instead of treating
                            // every endpoint as duration-unknown.
                            durationMs: turnPolicyEndpointGate.getLastSegmentDurationMs(),
                            endpoint: { reason: 'acoustic_endpoint', confidence: null },
                        }));
                    },
                    redemptionMs: normalizeDurationMs(redemptionMs),
                    sessionId: normalizedSessionId,
                });

                if (pendingStart?.token !== token) {
                    try {
                        await session.stop();
                    } catch {
                        // A late native session still loses ownership even if teardown fails.
                    }
                    return false;
                }

                pendingStart = null;
                activeSession = {
                    session,
                    sessionId: normalizedSessionId,
                    token,
                };
                return true;
            } catch {
                if (pendingStart?.token === token) {
                    pendingStart = null;
                }
                return false;
            }
        },
        stopSession: clearActiveSession,
    };
}
