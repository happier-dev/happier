import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import type { TurnEndpointSignal } from './TurnEndpointController';

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
}>;

type StartWebVadSessionArgs = Readonly<{
    minSpeechMs: number;
    redemptionMs: number;
    sessionId: string;
}>;

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
        try {
            await previousSession.vad.pause();
        } catch {
            // Ignore teardown failures and allow heuristic fallback to continue.
        }
    };

    return {
        isActiveSession: (sessionId) => activeSession?.sessionId === normalizeSessionId(sessionId),
        startSession: async ({ minSpeechMs, redemptionMs, sessionId }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            if (!normalizedSessionId || !isDomRuntime()) {
                await clearActiveSession();
                return false;
            }

            await clearActiveSession();

            const token = nextToken++;
            try {
                const { MicVAD } = await import('@ricky0123/vad-web');
                const vad = await MicVAD.new({
                    minSpeechMs: normalizeDurationMs(minSpeechMs),
                    model: 'v5',
                    redemptionMs: normalizeDurationMs(redemptionMs),
                    onSpeechEnd: () => {
                        if (!activeSession || activeSession.sessionId !== normalizedSessionId || activeSession.token !== token) {
                            return;
                        }

                        deps.onEndpointSignal({
                            detectedAt: now(),
                            sessionId: normalizedSessionId,
                            source: 'web_vad',
                            transcript: '',
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
