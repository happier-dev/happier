import { computeTurnEndpointDelayMs, type TurnEndpointPolicy } from '@/voice/input/TurnEndpointDetector';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export type TurnEndpointSignalSource = 'heuristic' | 'native_stream' | 'native_vad' | 'web_vad';

export type TurnEndpointSignal = Readonly<{
    detectedAt: number;
    sessionId: string;
    source: TurnEndpointSignalSource;
    transcript: string;
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
    }>) => {
        const transcript = normalizeNonEmptyString(args.transcript) ?? '';
        if (!activeSession || activeSession.token !== args.expectedToken || activeSession.sessionId !== args.sessionId) {
            return;
        }

        deps.onSignal({
            detectedAt: now(),
            sessionId: args.sessionId,
            source: args.source,
            transcript,
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
        signalEndpointDetected: ({ sessionId, source, transcript }) => {
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
            });
        },
    };
}
