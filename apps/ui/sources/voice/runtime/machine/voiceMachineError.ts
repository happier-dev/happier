import { isPermissionDeniedMicrophoneError } from '@/utils/platform/microphonePermissions';
import type { MicSessionFailure } from '@/voice/runtime/mic/MicSession';

import type {
    VoiceMachineError,
    VoiceMachineErrorPhase,
    VoiceMachineErrorKind,
    VoiceMachineErrorPresentation,
    VoiceMachineRecoveryAction,
    VoiceMachineRetryPolicy,
} from './voiceConversationRuntimeTypes';

export type { VoiceMachineError, VoiceMachineErrorKind };

/**
 * Single source of truth for lifecycle, retry, recovery, and presentation
 * semantics for every machine error kind. Callers provide only identity and a
 * safe reason; they cannot override one field and create a competing policy.
 */
type VoiceMachineErrorPolicy = Readonly<{
    phase: VoiceMachineErrorPhase;
    retryPolicy: VoiceMachineRetryPolicy;
    recoveryAction: VoiceMachineRecoveryAction;
    presentation: VoiceMachineErrorPresentation;
}>;

const POLICY_BY_KIND: Readonly<Record<VoiceMachineErrorKind, VoiceMachineErrorPolicy>> = {
    mic_permission_denied: { phase: 'preflight', retryPolicy: 'user_action', recoveryAction: 'open_settings', presentation: 'permission_required' },
    mic_permission_revoked: { phase: 'active_session', retryPolicy: 'user_action', recoveryAction: 'open_settings_then_reconnect', presentation: 'error' },
    mic_ended: { phase: 'active_session', retryPolicy: 'immediate_once', recoveryAction: 'reconnect', presentation: 'notice' },
    mic_plateau: { phase: 'active_session', retryPolicy: 'immediate_once', recoveryAction: 'reconnect', presentation: 'notice' },
    transport_disconnect: { phase: 'active_session', retryPolicy: 'backoff', recoveryAction: 'reconnect', presentation: 'notice' },
    provider_error: { phase: 'runtime', retryPolicy: 'user_action', recoveryAction: 'retry', presentation: 'notice' },
    provider_auth_invalid: { phase: 'preflight', retryPolicy: 'user_action', recoveryAction: 'review_credentials', presentation: 'error' },
    provider_setup_required: { phase: 'preflight', retryPolicy: 'user_action', recoveryAction: 'open_settings', presentation: 'error' },
    execution_machine_unavailable: { phase: 'preflight', retryPolicy: 'user_action', recoveryAction: 'select_execution_machine', presentation: 'error' },
    reconnect_exhausted: { phase: 'active_session', retryPolicy: 'user_action', recoveryAction: 'reconnect', presentation: 'error' },
    audio_context_suspended: { phase: 'active_session', retryPolicy: 'immediate_once', recoveryAction: 'reconnect', presentation: 'notice' },
    stt_timeout: { phase: 'turn', retryPolicy: 'user_action', recoveryAction: 'retry', presentation: 'notice' },
    tts_failed: { phase: 'turn', retryPolicy: 'user_action', recoveryAction: 'retry', presentation: 'notice' },
    turn_aborted: { phase: 'turn', retryPolicy: 'never', recoveryAction: 'none', presentation: 'interrupted' },
    authentication_required: { phase: 'preflight', retryPolicy: 'user_action', recoveryAction: 'connect_agent', presentation: 'error' },
    session_unavailable: { phase: 'preflight', retryPolicy: 'never', recoveryAction: 'none', presentation: 'error' },
    unsupported_runtime: { phase: 'preflight', retryPolicy: 'user_action', recoveryAction: 'install_agent_runtime', presentation: 'error' },
    update_required: { phase: 'preflight', retryPolicy: 'user_action', recoveryAction: 'update_agent_runtime', presentation: 'error' },
    feature_unavailable: { phase: 'preflight', retryPolicy: 'never', recoveryAction: 'none', presentation: 'error' },
    // The only preflight refusal that used to project as a `notice`. A notice is
    // recoverable, and a recoverable failure reads as a graceful `disconnected`
    // end, which the surface renders as plain `idle` — so a Start the host
    // refused before any request showed the user nothing at all while its own
    // policy demands a `user_action` retry. It is visible like every other
    // preflight refusal; the retry affordance is what distinguishes it from a
    // credential or setup fault.
    service_temporarily_unavailable: { phase: 'preflight', retryPolicy: 'user_action', recoveryAction: 'retry', presentation: 'error' },
};

const VOICE_MACHINE_ERROR_KINDS = Object.keys(POLICY_BY_KIND) as ReadonlyArray<VoiceMachineErrorKind>;

export function isVoiceMachineErrorKind(value: unknown): value is VoiceMachineErrorKind {
    return typeof value === 'string' && (VOICE_MACHINE_ERROR_KINDS as ReadonlyArray<string>).includes(value);
}

/**
 * Canonical factory for {@link VoiceMachineError} values.
 *
 * Callers supply identity and a safe reason only; policy fields cannot be
 * overridden outside this owner.
 */
export function createVoiceMachineError(params: Readonly<{
    kind: VoiceMachineErrorKind;
    reason: string;
}>): VoiceMachineError {
    const policy = POLICY_BY_KIND[params.kind];
    return {
        kind: params.kind,
        reason: params.reason,
        ...policy,
        recoverable: policy.presentation === 'notice' || policy.presentation === 'permission_required',
    };
}

function readErrorReason(error: unknown, fallback: string): string {
    if (typeof error === 'string' && error.trim().length > 0) {
        return error;
    }
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    const candidate = error as { reason?: unknown; message?: unknown } | null;
    if (candidate && typeof candidate.reason === 'string' && candidate.reason.trim().length > 0) {
        return candidate.reason;
    }
    if (candidate && typeof candidate.message === 'string' && candidate.message.trim().length > 0) {
        return candidate.message;
    }
    return fallback;
}

function isAbortError(error: unknown): boolean {
    const candidate = error as { name?: unknown; message?: unknown } | null;
    if (candidate && candidate.name === 'AbortError') {
        return true;
    }
    const message = typeof candidate?.message === 'string'
        ? candidate.message
        : typeof error === 'string'
            ? error
            : '';
    return message.includes('turn_aborted');
}

/** Map a mic-session failure straight onto a machine error (mic kinds are a taxonomy subset). */
export function classifyMicSessionFailure(failure: MicSessionFailure): VoiceMachineError {
    return createVoiceMachineError({ kind: failure.kind, reason: failure.reason });
}

/** Classify a realtime transport/provider error (permission denial vs generic provider fault). */
export function classifyRealtimeProviderFailure(error: unknown): VoiceMachineError {
    if (isPermissionDeniedMicrophoneError(error)) {
        return createVoiceMachineError({
            kind: 'mic_permission_denied',
            reason: readErrorReason(error, 'realtime_mic_permission_denied'),
        });
    }
    return createVoiceMachineError({
        kind: 'provider_error',
        reason: readErrorReason(error, 'realtime_provider_error'),
    });
}

/**
 * Generic classifier for an unknown error at any voice boundary. Resolves the
 * most specific known kind (abort, permission denial) and otherwise falls back
 * to `provider_error`.
 */
export function classifyVoiceMachineError(
    error: unknown,
    fallback: Readonly<{ kind?: VoiceMachineErrorKind; reason?: string }> = {},
): VoiceMachineError {
    if (isAbortError(error)) {
        return createVoiceMachineError({
            kind: 'turn_aborted',
            reason: readErrorReason(error, 'turn_aborted'),
        });
    }
    if (isPermissionDeniedMicrophoneError(error)) {
        return createVoiceMachineError({
            kind: 'mic_permission_denied',
            reason: readErrorReason(error, 'mic_permission_denied'),
        });
    }
    const kind = fallback.kind ?? 'provider_error';
    return createVoiceMachineError({
        kind,
        reason: readErrorReason(error, fallback.reason ?? kind),
    });
}
