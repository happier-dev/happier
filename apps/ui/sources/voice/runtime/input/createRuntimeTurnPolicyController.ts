import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import type { AdaptiveInterruptionConfig } from './resolveAdaptiveInterruptionDecision';
import type { TurnEndpointSignal } from './TurnEndpointController';

export type RuntimeTurnCaptureProvider = 'recorded_audio' | 'device' | 'local_neural';
export type EndpointDrivenRuntimeTurnCaptureProvider = Extract<RuntimeTurnCaptureProvider, 'device' | 'local_neural'>;
export type RuntimeTurnStatus = 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';

export type RuntimeEndpointSignalAction =
    | Readonly<{
        kind: 'ignore';
        reason:
            | 'hands_free_disabled'
            | 'hands_free_inactive'
            | 'in_flight'
            | 'not_recording'
            | 'provider_not_endpoint_driven'
            | 'session_mismatch';
    }>
    | Readonly<{
        kind: 'stop_capture';
        provider: EndpointDrivenRuntimeTurnCaptureProvider;
        sessionId: string;
    }>;

export type RuntimeStoppedCaptureAction =
    | Readonly<{
        followUp: RuntimeStoppedCaptureFollowUpAction;
        kind: 'ignore';
        reason: 'backchannel' | 'empty_transcript';
    }>
    | Readonly<{
        followUp: RuntimeStoppedCaptureFollowUpAction;
        kind: 'submit_turn';
        transcript: string;
    }>;

export type RuntimeStoppedCaptureFollowUpAction =
    | Readonly<{
        kind: 'none';
    }>
    | Readonly<{
        kind: 'rearm_capture';
        provider: EndpointDrivenRuntimeTurnCaptureProvider;
        sessionId: string;
    }>;

export type RuntimeManualBargeInAction =
    | Readonly<{
        kind: 'noop';
        reason: 'barge_in_disabled' | 'different_session' | 'not_speaking';
    }>
    | Readonly<{
        kind: 'interrupt_and_rearm';
        handsFree: boolean;
        provider: RuntimeTurnCaptureProvider;
        sessionId: string;
    }>;

export type RuntimeTurnPolicyController = Readonly<{
    clearHandsFreeCaptureSession: (args: Readonly<{
        provider: EndpointDrivenRuntimeTurnCaptureProvider;
        sessionId?: string | null;
    }>) => void;
    isHandsFreeCaptureSession: (args: Readonly<{
        provider: EndpointDrivenRuntimeTurnCaptureProvider;
        sessionId: string;
    }>) => boolean;
    resolveEndpointSignalAction: (args: Readonly<{
        currentSessionId: string | null;
        currentStatus: RuntimeTurnStatus;
        handsFreeEnabled: boolean;
        inFlight: boolean;
        provider: RuntimeTurnCaptureProvider;
        signal: TurnEndpointSignal;
    }>) => RuntimeEndpointSignalAction;
    resolveManualBargeInAction: (args: Readonly<{
        bargeInEnabled: boolean;
        currentSessionId: string | null;
        currentStatus: RuntimeTurnStatus;
        handsFree: boolean;
        provider: RuntimeTurnCaptureProvider;
        requestedSessionId: string;
    }>) => RuntimeManualBargeInAction;
    resolveStoppedCaptureAction: (args: Readonly<{
        adaptiveConfig: AdaptiveInterruptionConfig;
        continueHandsFree: boolean;
        provider: EndpointDrivenRuntimeTurnCaptureProvider;
        sessionId: string;
        transcript?: string | null;
    }>) => RuntimeStoppedCaptureAction;
    setHandsFreeCaptureSession: (args: Readonly<{
        provider: EndpointDrivenRuntimeTurnCaptureProvider;
        sessionId: string | null;
    }>) => void;
}>;

function normalizeSessionId(sessionId: string | null | undefined): string | null {
    return normalizeNonEmptyString(sessionId);
}

function normalizeInterruptionTranscript(value: string | null | undefined): string {
    const normalized = normalizeNonEmptyString(value) ?? '';
    if (!normalized) {
        return '';
    }

    return normalized
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function resolveStoppedCaptureFollowUp(args: Readonly<{
    continueHandsFree: boolean;
    provider: EndpointDrivenRuntimeTurnCaptureProvider;
    sessionId: string;
}>): RuntimeStoppedCaptureFollowUpAction {
    const normalizedSessionId = normalizeSessionId(args.sessionId);
    if (!args.continueHandsFree || !normalizedSessionId) {
        return {
            kind: 'none',
        };
    }

    return {
        kind: 'rearm_capture',
        provider: args.provider,
        sessionId: normalizedSessionId,
    };
}

export function createRuntimeTurnPolicyController(): RuntimeTurnPolicyController {
    const handsFreeSessions: Record<EndpointDrivenRuntimeTurnCaptureProvider, string | null> = {
        device: null,
        local_neural: null,
    };

    return {
        setHandsFreeCaptureSession: ({ provider, sessionId }) => {
            handsFreeSessions[provider] = normalizeSessionId(sessionId);
        },
        clearHandsFreeCaptureSession: ({ provider, sessionId }) => {
            const normalizedSessionId = normalizeSessionId(sessionId);
            if (normalizedSessionId && handsFreeSessions[provider] !== normalizedSessionId) {
                return;
            }
            handsFreeSessions[provider] = null;
        },
        isHandsFreeCaptureSession: ({ provider, sessionId }) =>
            handsFreeSessions[provider] === normalizeSessionId(sessionId),
        resolveEndpointSignalAction: ({
            currentSessionId,
            currentStatus,
            handsFreeEnabled,
            inFlight,
            provider,
            signal,
        }) => {
            if (inFlight) {
                return { kind: 'ignore', reason: 'in_flight' } as const;
            }

            if (currentStatus !== 'recording') {
                return { kind: 'ignore', reason: 'not_recording' } as const;
            }

            const normalizedCurrentSessionId = normalizeSessionId(currentSessionId);
            const normalizedSignalSessionId = normalizeSessionId(signal.sessionId);
            if (!normalizedCurrentSessionId || !normalizedSignalSessionId || normalizedCurrentSessionId !== normalizedSignalSessionId) {
                return { kind: 'ignore', reason: 'session_mismatch' } as const;
            }

            if (provider !== 'device' && provider !== 'local_neural') {
                return { kind: 'ignore', reason: 'provider_not_endpoint_driven' } as const;
            }

            if (!handsFreeEnabled) {
                return { kind: 'ignore', reason: 'hands_free_disabled' } as const;
            }

            if (!handsFreeSessions[provider] || handsFreeSessions[provider] !== normalizedSignalSessionId) {
                return { kind: 'ignore', reason: 'hands_free_inactive' } as const;
            }

            return {
                kind: 'stop_capture',
                provider,
                sessionId: normalizedSignalSessionId,
            } as const;
        },
        resolveStoppedCaptureAction: ({ adaptiveConfig, continueHandsFree, provider, sessionId, transcript }) => {
            const normalizedTranscript = normalizeNonEmptyString(transcript) ?? '';
            const followUp = resolveStoppedCaptureFollowUp({
                continueHandsFree,
                provider,
                sessionId,
            });

            if (!normalizedTranscript) {
                return {
                    followUp,
                    kind: 'ignore',
                    reason: 'empty_transcript',
                } as const;
            }

            const ignoredPhrases = new Set(
                adaptiveConfig.ignoredPhrases
                    .map((phrase) => normalizeInterruptionTranscript(phrase))
                    .filter((phrase) => phrase.length > 0),
            );
            if (ignoredPhrases.has(normalizeInterruptionTranscript(normalizedTranscript))) {
                return {
                    followUp,
                    kind: 'ignore',
                    reason: 'backchannel',
                } as const;
            }

            return {
                followUp,
                kind: 'submit_turn',
                transcript: normalizedTranscript,
            } as const;
        },
        resolveManualBargeInAction: ({
            bargeInEnabled,
            currentSessionId,
            currentStatus,
            handsFree,
            provider,
            requestedSessionId,
        }) => {
            if (currentStatus !== 'speaking') {
                return { kind: 'noop', reason: 'not_speaking' } as const;
            }

            const normalizedCurrentSessionId = normalizeSessionId(currentSessionId);
            const normalizedRequestedSessionId = normalizeSessionId(requestedSessionId);
            if (!normalizedCurrentSessionId || !normalizedRequestedSessionId || normalizedCurrentSessionId !== normalizedRequestedSessionId) {
                return { kind: 'noop', reason: 'different_session' } as const;
            }

            if (!bargeInEnabled) {
                return {
                    kind: 'noop',
                    reason: 'barge_in_disabled',
                } as const;
            }

            return {
                kind: 'interrupt_and_rearm',
                handsFree,
                provider,
                sessionId: normalizedRequestedSessionId,
            } as const;
        },
    };
}
