import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { resolveNativeSileroVadBridge } from './NativeSileroVadBridge';
import type { TurnEndpointSignal } from './TurnEndpointController';

export type NativeVadSession = Readonly<{
    stop: () => void | Promise<void>;
}>;

export type NativeVadBridge = Readonly<{
    startSession: (args: Readonly<{
        minSpeechMs: number;
        onSpeechEnd: () => void;
        redemptionMs: number;
        sessionId: string;
    }>) => NativeVadSession | Promise<NativeVadSession>;
}>;

type ActiveNativeVadSession = Readonly<{
    session: NativeVadSession;
    sessionId: string;
    token: number;
}>;

type NativeVadControllerDeps = Readonly<{
    bridge?: NativeVadBridge | null;
    now?: () => number;
    onEndpointSignal: (signal: TurnEndpointSignal) => void;
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

export function createNativeVadController(deps: NativeVadControllerDeps): NativeVadController {
    const now = deps.now ?? (() => Date.now());
    let activeSession: ActiveNativeVadSession | null = null;
    let nextToken = 1;
    const resolveBridge = async (): Promise<NativeVadBridge | null | undefined> =>
        deps.bridge === undefined ? await resolveNativeSileroVadBridge() : deps.bridge;

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
            await previousSession.session.stop();
        } catch {
            // Ignore native teardown failures; callers will preserve provider fallback endpointing.
        }
    };

    return {
        isActiveSession: (sessionId) => activeSession?.sessionId === normalizeSessionId(sessionId),
        startSession: async ({ minSpeechMs, redemptionMs, sessionId }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            const bridge = await resolveBridge();
            if (!normalizedSessionId || !bridge) {
                await clearActiveSession();
                return false;
            }

            await clearActiveSession();

            const token = nextToken++;
            try {
                const session = await bridge.startSession({
                    minSpeechMs: normalizeDurationMs(minSpeechMs),
                    onSpeechEnd: () => {
                        if (!activeSession || activeSession.sessionId !== normalizedSessionId || activeSession.token !== token) {
                            return;
                        }

                        deps.onEndpointSignal({
                            detectedAt: now(),
                            sessionId: normalizedSessionId,
                            source: 'native_vad',
                            transcript: '',
                        });
                    },
                    redemptionMs: normalizeDurationMs(redemptionMs),
                    sessionId: normalizedSessionId,
                });

                activeSession = {
                    session,
                    sessionId: normalizedSessionId,
                    token,
                };
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
