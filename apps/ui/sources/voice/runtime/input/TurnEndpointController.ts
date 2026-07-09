import { computeTurnEndpointDelayMs, type TurnEndpointPolicy } from './TurnEndpointDetector';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export type TurnEndpointSignalSource = 'heuristic' | 'native_stream' | 'native_vad' | 'web_vad';

export type TurnEndpointSignal = Readonly<{
    detectedAt: number;
    sessionId: string;
    source: TurnEndpointSignalSource;
    transcript: string;
    /**
     * Measured spoken duration of the candidate utterance, in ms, when the
     * producer can supply it (the two-stage endpoint gate tracks the
     * speech-start → endpoint span). Absent when genuinely unknown — the
     * downstream backchannel duration gate treats unknown as "not a short
     * acknowledgement" so a real barge-in is never suppressed for lack of data.
     */
    durationMs?: number | null;
    /**
     * STT confidence of the candidate utterance, in [0,1], when the recognizer
     * exposes it. Absent when the producer has no confidence signal.
     */
    confidence?: number | null;
}>;

type ActiveTurnEndpointSession = Readonly<{
    sessionId: string;
    startedAt: number;
    token: number;
    timer: ReturnType<typeof setTimeout> | null;
}>;

type TurnEndpointControllerDeps = Readonly<{
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    now?: () => number;
    onSignal: (signal: TurnEndpointSignal) => void;
    queueTask?: (task: () => void) => void;
    setTimer?: (task: () => void, waitMs: number) => ReturnType<typeof setTimeout>;
}>;

export type TurnEndpointController = Readonly<{
    clearSession: (sessionId?: string | null) => void;
    signalEndpointDetected: (args: Readonly<{
        sessionId: string;
        source: Exclude<TurnEndpointSignalSource, 'heuristic'>;
        transcript?: string | null;
        durationMs?: number | null;
        confidence?: number | null;
    }>) => void;
    signalHeuristicTranscriptFinalized: (args: Readonly<{
        policy: TurnEndpointPolicy;
        sessionId: string;
        transcript?: string | null;
    }>) => void;
    startSession: (sessionId: string) => void;
}>;

export function createTurnEndpointController(deps: TurnEndpointControllerDeps): TurnEndpointController {
    const now = deps.now ?? (() => Date.now());
    const setTimer = deps.setTimer ?? ((task, waitMs) => setTimeout(task, waitMs));
    const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    const queueTask = deps.queueTask ?? ((task) => queueMicrotask(task));

    let nextToken = 1;
    let activeSession: ActiveTurnEndpointSession | null = null;

    const normalizeSessionId = (sessionId: string | null | undefined): string | null => normalizeNonEmptyString(sessionId);

    const clearActiveTimer = (session: ActiveTurnEndpointSession | null) => {
        if (!session?.timer) return;
        clearTimer(session.timer);
    };

    const replaceActiveSession = (session: ActiveTurnEndpointSession | null) => {
        clearActiveTimer(activeSession);
        activeSession = session;
    };

    const emitIfActive = (args: Readonly<{
        expectedToken: number;
        sessionId: string;
        source: TurnEndpointSignalSource;
        transcript?: string | null;
        durationMs?: number | null;
        confidence?: number | null;
    }>) => {
        const transcript = normalizeNonEmptyString(args.transcript) ?? '';
        if (!activeSession || activeSession.token !== args.expectedToken || activeSession.sessionId !== args.sessionId) {
            return;
        }

        const durationMs = typeof args.durationMs === 'number' && Number.isFinite(args.durationMs)
            ? Math.max(0, args.durationMs)
            : null;
        const confidence = typeof args.confidence === 'number' && Number.isFinite(args.confidence)
            ? args.confidence
            : null;

        replaceActiveSession(null);
        deps.onSignal({
            detectedAt: now(),
            sessionId: args.sessionId,
            source: args.source,
            transcript,
            durationMs,
            confidence,
        });
    };

    return {
        startSession: (sessionId: string) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            if (!normalizedSessionId) {
                replaceActiveSession(null);
                return;
            }

            replaceActiveSession({
                sessionId: normalizedSessionId,
                startedAt: now(),
                token: nextToken++,
                timer: null,
            });
        },
        clearSession: (sessionId?: string | null) => {
            if (!activeSession) return;

            const normalizedSessionId = normalizeSessionId(sessionId);
            if (normalizedSessionId && activeSession.sessionId !== normalizedSessionId) {
                return;
            }

            replaceActiveSession(null);
        },
        signalHeuristicTranscriptFinalized: ({ sessionId, transcript, policy }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            if (!activeSession || !normalizedSessionId || activeSession.sessionId !== normalizedSessionId) {
                return;
            }

            const expectedToken = activeSession.token;
            const waitMs = computeTurnEndpointDelayMs(policy, now() - activeSession.startedAt);
            replaceActiveSession({
                ...activeSession,
                timer: null,
            });

            if (!activeSession || activeSession.sessionId !== normalizedSessionId || activeSession.token !== expectedToken) {
                return;
            }

            if (waitMs <= 0) {
                queueTask(() => {
                    emitIfActive({
                        expectedToken,
                        sessionId: normalizedSessionId,
                        source: 'heuristic',
                        transcript,
                    });
                });
                return;
            }

            const timer = setTimer(() => {
                if (activeSession && activeSession.sessionId === normalizedSessionId && activeSession.token === expectedToken) {
                    activeSession = {
                        ...activeSession,
                        timer: null,
                    };
                }

                emitIfActive({
                    expectedToken,
                    sessionId: normalizedSessionId,
                    source: 'heuristic',
                    transcript,
                });
            }, waitMs);

            if (activeSession && activeSession.sessionId === normalizedSessionId && activeSession.token === expectedToken) {
                activeSession = {
                    ...activeSession,
                    timer,
                };
                return;
            }

            clearTimer(timer);
        },
        signalEndpointDetected: ({ sessionId, source, transcript, durationMs, confidence }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            if (!activeSession || !normalizedSessionId || activeSession.sessionId !== normalizedSessionId) {
                return;
            }

            const expectedToken = activeSession.token;
            replaceActiveSession({
                ...activeSession,
                timer: null,
            });

            emitIfActive({
                expectedToken,
                sessionId: normalizedSessionId,
                source,
                transcript,
                durationMs,
                confidence,
            });
        },
    };
}
