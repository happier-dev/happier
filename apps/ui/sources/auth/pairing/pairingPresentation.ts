import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

export type HomeEnrollmentPresentationPhase =
    | 'generating'
    | 'ready'
    | 'verifying'
    | 'adding'
    | 'retryable_error'
    | 'expired'
    | 'invalid_request'
    | 'update_required'
    | 'succeeded'
    | 'partial_commit';

export type HomeEnrollmentPresentationModel = Readonly<{
    phase: HomeEnrollmentPresentationPhase;
    primaryTranslationKey:
        | 'common.loading'
        | 'common.success'
        | 'connect.addPhoneQrInstructions'
        | 'connect.homeAddedPreservedFocusBody'
        | 'connect.homeEnrollmentPartialCommitBody'
        | 'connect.homeEnrollmentRetryBody'
        | 'connect.pairingAlreadyRequestedBody'
        | 'connect.pairingRejectedBody'
        | 'connect.pairingQrExpired'
        | 'connect.requesterDeviceAddedBody'
        | 'connect.requesterDeviceQrExpiredBody'
        | 'connect.requesterDeviceRequestInvalidBody'
        | 'connect.requesterDeviceRetryBody'
        | 'connect.requesterDeviceWrongHomeBody'
        | 'connect.scanComputerQrInstructions'
        | 'connect.scanComputerQrUnavailableBody'
        | 'connect.securingCredentials'
        | 'connect.showRequesterQrInstructions'
        | 'connect.unsupportedEnrollmentResponseBody'
        | 'connect.updateRequiredBody'
        | 'connect.wrongHomeBody'
        | 'errors.operationFailed'
        | 'terminal.invalidConnectionLinkDescription';
    contextualFacts: 'none' | 'target' | 'target_and_expiry' | 'target_and_requester';
    recoveryAction: 'none' | 'automatic_retry' | 'retry' | 'create_new_qr';
    liveRegion: 'none' | 'polite' | 'assertive';
    activity: boolean;
}>;

type HomeEnrollmentPresentationSource =
    | Readonly<{
        kind: 'trusted_home_display';
        phase: 'generating' | 'ready' | 'adding' | 'retryable_error' | 'expired' | 'invalid_request' | 'update_required' | 'succeeded';
    }>
    | Readonly<{
        kind: 'requester_display';
        phase: 'generating' | 'ready' | 'adding' | 'retryable_error' | 'expired' | 'invalid' | 'update_required' | 'succeeded';
        partialCommit?: boolean;
    }>
    | Readonly<{
        kind: 'scanner';
        phase: 'idle' | 'requesting' | 'securing';
        direction?: 'trusted_home_displays' | 'requester_displays';
        result?:
            | 'succeeded'
            | 'partial_commit'
            | 'retryable_error'
            | 'expired'
            | 'invalid_request'
            | 'already_requested'
            | 'rejected'
            | 'wrong_target'
            | 'malformed_response'
            | 'update_required';
    }>;

const TERMINAL_SCANNER_PRESENTATIONS: Readonly<Record<
    NonNullable<Extract<HomeEnrollmentPresentationSource, { kind: 'scanner' }>['result']>,
    HomeEnrollmentPresentationModel
>> = {
    succeeded: {
        phase: 'succeeded',
        primaryTranslationKey: 'connect.homeAddedPreservedFocusBody',
        contextualFacts: 'target',
        recoveryAction: 'none',
        liveRegion: 'polite',
        activity: false,
    },
    partial_commit: {
        phase: 'partial_commit',
        primaryTranslationKey: 'connect.homeEnrollmentPartialCommitBody',
        contextualFacts: 'target',
        recoveryAction: 'none',
        liveRegion: 'assertive',
        activity: false,
    },
    retryable_error: {
        phase: 'retryable_error',
        primaryTranslationKey: 'connect.homeEnrollmentRetryBody',
        contextualFacts: 'target',
        recoveryAction: 'retry',
        liveRegion: 'polite',
        activity: false,
    },
    expired: {
        phase: 'expired',
        primaryTranslationKey: 'connect.pairingQrExpired',
        contextualFacts: 'target',
        recoveryAction: 'retry',
        liveRegion: 'assertive',
        activity: false,
    },
    invalid_request: {
        phase: 'invalid_request',
        primaryTranslationKey: 'terminal.invalidConnectionLinkDescription',
        contextualFacts: 'target',
        recoveryAction: 'retry',
        liveRegion: 'assertive',
        activity: false,
    },
    already_requested: {
        phase: 'invalid_request',
        primaryTranslationKey: 'connect.pairingAlreadyRequestedBody',
        contextualFacts: 'target',
        recoveryAction: 'retry',
        liveRegion: 'assertive',
        activity: false,
    },
    rejected: {
        phase: 'invalid_request',
        primaryTranslationKey: 'connect.pairingRejectedBody',
        contextualFacts: 'target',
        recoveryAction: 'retry',
        liveRegion: 'assertive',
        activity: false,
    },
    wrong_target: {
        phase: 'invalid_request',
        primaryTranslationKey: 'connect.wrongHomeBody',
        contextualFacts: 'target',
        recoveryAction: 'retry',
        liveRegion: 'assertive',
        activity: false,
    },
    malformed_response: {
        phase: 'invalid_request',
        primaryTranslationKey: 'connect.unsupportedEnrollmentResponseBody',
        contextualFacts: 'target',
        recoveryAction: 'retry',
        liveRegion: 'assertive',
        activity: false,
    },
    update_required: {
        phase: 'update_required',
        primaryTranslationKey: 'connect.updateRequiredBody',
        contextualFacts: 'target',
        recoveryAction: 'none',
        liveRegion: 'assertive',
        activity: false,
    },
};

/**
 * On the reverse direction the scanner is the approving, already-enrolled
 * device, so joiner/restore guidance is false for it. Results not listed here
 * (update_required) are direction-neutral; the approver never publishes the
 * joiner-only results (partial_commit, already_requested, rejected, ...).
 */
const APPROVER_SCANNER_TRANSLATION_KEYS: Readonly<Partial<Record<
    NonNullable<Extract<HomeEnrollmentPresentationSource, { kind: 'scanner' }>['result']>,
    HomeEnrollmentPresentationModel['primaryTranslationKey']
>>> = {
    succeeded: 'connect.requesterDeviceAddedBody',
    retryable_error: 'connect.requesterDeviceRetryBody',
    wrong_target: 'connect.requesterDeviceWrongHomeBody',
    expired: 'connect.requesterDeviceQrExpiredBody',
    invalid_request: 'connect.requesterDeviceRequestInvalidBody',
};

/**
 * Pure semantic projection shared by the three QR surfaces. It deliberately
 * contains no transport, protocol, secret, or workflow state ownership.
 */
export function resolveHomeEnrollmentPresentation(
    source: HomeEnrollmentPresentationSource,
): HomeEnrollmentPresentationModel {
    if (source.kind === 'scanner') {
        if (source.direction === 'requester_displays' && source.result) {
            const approverTranslationKey = APPROVER_SCANNER_TRANSLATION_KEYS[source.result];
            if (approverTranslationKey) {
                return {
                    ...TERMINAL_SCANNER_PRESENTATIONS[source.result],
                    primaryTranslationKey: approverTranslationKey,
                };
            }
        }
        if (source.result) return TERMINAL_SCANNER_PRESENTATIONS[source.result];
        if (source.phase === 'idle') {
            return {
                phase: 'ready',
                primaryTranslationKey: 'connect.scanComputerQrInstructions',
                contextualFacts: 'none',
                recoveryAction: 'none',
                liveRegion: 'none',
                activity: false,
            };
        }
        return {
            phase: source.phase === 'requesting' ? 'verifying' : 'adding',
            primaryTranslationKey: source.phase === 'requesting' ? 'common.loading' : 'connect.securingCredentials',
            contextualFacts: 'target_and_expiry',
            recoveryAction: source.phase === 'requesting' ? 'automatic_retry' : 'none',
            liveRegion: 'polite',
            activity: true,
        };
    }

    if (source.kind === 'requester_display') {
        if (source.phase === 'generating') {
            return {
                phase: 'generating', primaryTranslationKey: 'common.loading', contextualFacts: 'none',
                recoveryAction: 'none', liveRegion: 'polite', activity: true,
            };
        }
        if (source.phase === 'ready') {
            return {
                phase: 'ready', primaryTranslationKey: 'connect.showRequesterQrInstructions', contextualFacts: 'target_and_expiry',
                recoveryAction: 'none', liveRegion: 'polite', activity: false,
            };
        }
        if (source.phase === 'adding') {
            return {
                phase: 'adding', primaryTranslationKey: 'connect.securingCredentials', contextualFacts: 'target_and_expiry',
                recoveryAction: 'none', liveRegion: 'polite', activity: true,
            };
        }
        if (source.phase === 'retryable_error') {
            return source.partialCommit
                ? {
                    phase: 'partial_commit', primaryTranslationKey: 'connect.homeEnrollmentPartialCommitBody', contextualFacts: 'target',
                    recoveryAction: 'none', liveRegion: 'assertive', activity: false,
                }
                : {
                    phase: 'retryable_error', primaryTranslationKey: 'connect.homeEnrollmentRetryBody', contextualFacts: 'target',
                    recoveryAction: 'retry', liveRegion: 'polite', activity: false,
                };
        }
        if (source.phase === 'expired') {
            return {
                phase: 'expired', primaryTranslationKey: 'connect.pairingQrExpired', contextualFacts: 'target',
                recoveryAction: 'create_new_qr', liveRegion: 'assertive', activity: false,
            };
        }
        if (source.phase === 'invalid') {
            return {
                phase: 'invalid_request', primaryTranslationKey: 'connect.scanComputerQrUnavailableBody', contextualFacts: 'target',
                recoveryAction: 'create_new_qr', liveRegion: 'assertive', activity: false,
            };
        }
        if (source.phase === 'update_required') {
            return {
                phase: 'update_required', primaryTranslationKey: 'connect.updateRequiredBody', contextualFacts: 'target',
                recoveryAction: 'none', liveRegion: 'assertive', activity: false,
            };
        }
        return {
            phase: 'succeeded', primaryTranslationKey: 'connect.homeAddedPreservedFocusBody', contextualFacts: 'target',
            recoveryAction: 'none', liveRegion: 'polite', activity: false,
        };
    }

    if (source.phase === 'generating') {
        return {
            phase: 'generating', primaryTranslationKey: 'common.loading', contextualFacts: 'none',
            recoveryAction: 'none', liveRegion: 'polite', activity: true,
        };
    }
    if (source.phase === 'ready') {
        return {
            phase: 'ready', primaryTranslationKey: 'connect.addPhoneQrInstructions', contextualFacts: 'target_and_expiry',
            recoveryAction: 'none', liveRegion: 'polite', activity: false,
        };
    }
    if (source.phase === 'adding' || source.phase === 'retryable_error') {
        return {
            phase: source.phase,
            primaryTranslationKey: source.phase === 'retryable_error' ? 'connect.homeEnrollmentRetryBody' : 'connect.securingCredentials',
            contextualFacts: 'target_and_requester',
            recoveryAction: source.phase === 'adding' ? 'none' : 'automatic_retry',
            liveRegion: 'polite',
            activity: true,
        };
    }
    if (source.phase === 'expired') {
        return {
            phase: 'expired', primaryTranslationKey: 'connect.pairingQrExpired', contextualFacts: 'target_and_expiry',
            recoveryAction: 'create_new_qr', liveRegion: 'assertive', activity: false,
        };
    }
    if (source.phase === 'invalid_request') {
        return {
            phase: 'invalid_request', primaryTranslationKey: 'errors.operationFailed', contextualFacts: 'none',
            recoveryAction: 'create_new_qr', liveRegion: 'assertive', activity: false,
        };
    }
    if (source.phase === 'update_required') {
        return {
            phase: 'update_required', primaryTranslationKey: 'connect.updateRequiredBody', contextualFacts: 'none',
            recoveryAction: 'none', liveRegion: 'assertive', activity: false,
        };
    }
    return {
        phase: 'succeeded', primaryTranslationKey: 'common.success', contextualFacts: 'target_and_requester',
        recoveryAction: 'none', liveRegion: 'polite', activity: false,
    };
}

export function formatHomeEnrollmentTargetLabel(descriptor: HomeConnectionDescriptorV1): string {
    try {
        return new URL(descriptor.canonicalServerUrl).host;
    } catch {
        return descriptor.canonicalServerUrl;
    }
}

export function formatEnrollmentExpiry(expiresAtMs: number): string {
    return new Date(expiresAtMs).toLocaleString();
}

/**
 * Time left on a live invite as `m:ss` ("New code in 4:32"). Rounds up, so the last second of a
 * working code reads 0:01 rather than 0:00; an expired invite reads 0:00.
 */
export function formatPairingCountdown(expiresAtMs: number, nowMs: number): string {
    const totalSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
