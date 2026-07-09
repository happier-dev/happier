import { isPermissionDeniedMicrophoneError } from '@/utils/platform/microphonePermissions';
import type { MicSessionFailure } from '@/voice/runtime/mic/MicSession';

import type {
    VoiceMachineError,
    VoiceMachineErrorKind,
} from './voiceConversationRuntimeTypes';

export type { VoiceMachineError, VoiceMachineErrorKind };

/**
 * Single source of truth for whether a given error kind is recoverable.
 *
 * Permission denial is the only non-recoverable boundary by default — the user
 * must re-grant microphone access before another attempt can succeed. Every
 * other boundary is transient and can be retried by re-arming the runtime.
 * Call sites may still pass an explicit `recoverable` to override per case.
 */
const RECOVERABLE_BY_KIND: Readonly<Record<VoiceMachineErrorKind, boolean>> = {
    mic_permission_denied: false,
    mic_ended: true,
    mic_plateau: true,
    transport_disconnect: true,
    provider_error: true,
    audio_context_suspended: true,
    stt_timeout: true,
    tts_failed: true,
    turn_aborted: true,
};

const VOICE_MACHINE_ERROR_KINDS = Object.keys(RECOVERABLE_BY_KIND) as ReadonlyArray<VoiceMachineErrorKind>;

export function isVoiceMachineErrorKind(value: unknown): value is VoiceMachineErrorKind {
    return typeof value === 'string' && (VOICE_MACHINE_ERROR_KINDS as ReadonlyArray<string>).includes(value);
}

/**
 * Canonical factory for {@link VoiceMachineError} values.
 *
 * `recoverable` is optional: when omitted it is resolved from the per-kind
 * {@link RECOVERABLE_BY_KIND} table so every minting site agrees on
 * recoverability without re-deriving it.
 */
export function createVoiceMachineError(params: Readonly<{
    kind: VoiceMachineErrorKind;
    reason: string;
    recoverable?: boolean;
}>): VoiceMachineError {
    return {
        kind: params.kind,
        reason: params.reason,
        recoverable: params.recoverable ?? RECOVERABLE_BY_KIND[params.kind],
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
