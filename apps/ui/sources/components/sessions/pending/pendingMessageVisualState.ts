import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { TranslationKeyNoParams } from '@/text';
import { isPendingDeliveryProviderEffectPossibleV1, type PendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import type { SessionInputAdmissionRejectionCodeV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';

export type PendingMessageVisualStateKind =
    | 'saving'
    | 'send_unconfirmed'
    | 'send_failed'
    | 'cancelling'
    | 'cancel_failed'
    | 'queued'
    | 'delivering'
    | 'materializing'
    | 'blocked';

export type PendingMessageVisualState = Readonly<{
    kind: PendingMessageVisualStateKind;
    showSpinner: boolean;
    iconName: 'cloud-arrow-up' | 'clock' | 'navigation-arrow' | 'warning-circle';
    deliveryBlockedPresentation?: PendingDeliveryBlockedReasonPresentation;
    deliveryMutationPolicy?: 'effect_possible';
    queuedRequestedAction?: 'enqueue' | 'steer_if_active' | 'steer_now' | 'send_now';
    queuedReason?:
        | 'waiting_for_foreground_turn'
        | 'waiting_for_runtime_activity'
        | 'runtime_activity_unknown'
        | 'waiting_for_predecessor'
        | 'waiting_for_runtime'
        | 'unsupported_action';
}>;

export type PendingMessageQueuedStateOptions = Readonly<{
    hasEarlierRow?: boolean;
    hasProviderDeliveryInFlight?: boolean;
    runtimeReachable?: boolean;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
    deliveryTiming?: 'after_foreground_ready' | 'after_runtime_idle';
    runtimeActivity?: 'idle' | 'active' | 'unknown';
}>;

export type PendingDeliveryBlockedReasonPresentation = Readonly<{
    labelKey: TranslationKeyNoParams;
    isUnknown: boolean;
}>;

/**
 * The IN-FLOW chrome a pending row paints for its current delivery state — i.e. the only part of its
 * delivery presentation that can change the row's HEIGHT.
 *
 * F-P2 (2026-08-10). The status chip (`PendingMessagesTranscriptBlock` `pendingAffordanceChip`) is
 * `position: 'absolute'`, so every state that only swaps the chip's icon/spinner/label — including
 * the whole `queuedReason` vocabulary, which this block paints INSIDE that chip — leaves the row's
 * box byte-identical. `blockedDeliveryNotice` is the single in-flow status notice this block paints.
 * This matters because `ChatListInternal` wires Legend's vendored `getItemSizeVersion` to
 * `transcriptRowShellSignature`, and `validateItemSizeVersion` DELETES `sizesKnown` + `sizes`
 * whenever that version moves: keying the pending row on `visualState.kind` threw away its measured
 * height on every step of a send while the painted box never changed.
 *
 * The block SELECTS its notice from this descriptor, so there is one decision-maker rather than a
 * mapping restated in the renderer, the size key and the estimator. Counterpart of
 * `groupedToolCallRowPaintDependsOnGroupExpansion` for the pending row.
 */
export type PendingMessageHeightBearingChrome =
    /** Chip only — absolutely positioned, cannot move the row. */
    | 'none'
    /** `blockedDeliveryNotice`. */
    | 'blocked-notice';

export function resolvePendingMessageHeightBearingChrome(
    visualState: PendingMessageVisualState,
): PendingMessageHeightBearingChrome {
    // Read off the presentation the block itself renders the notice from, not off a list of kinds,
    // so a state that starts carrying a blocked presentation cannot drop out of the size version.
    return visualState.deliveryBlockedPresentation !== undefined ? 'blocked-notice' : 'none';
}

const blockedReasonLabelKeys = {
    terminal_composer_draft: 'session.pendingMessages.deliveryBlockedReasons.terminalComposerDraft',
    capture_style_unavailable: 'session.pendingMessages.deliveryBlockedReasons.captureStyleUnavailable',
    provider_unavailable_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerUnavailableBeforeAcceptance',
    ambiguous_terminal_delivery: 'session.pendingMessages.deliveryBlockedReasons.ambiguousTerminalDelivery',
    // An effect may already have started: this row must not read like the "nothing was sent" case.
    delivery_outcome_uncertain: 'session.pendingMessages.deliveryBlockedReasons.deliveryOutcomeUncertain',
    terminal_host_unreachable: 'session.pendingMessages.deliveryBlockedReasons.terminalHostUnreachable',
    runtime_disposed_before_delivery: 'session.pendingMessages.deliveryBlockedReasons.runtimeDisposedBeforeDelivery',
    session_input_target_unavailable: 'session.pendingMessages.deliveryBlockedReasons.targetUnavailable',
    runtime_config_blocked: 'session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked',
    invalid_prompt_text: 'session.pendingMessages.deliveryBlockedReasons.invalidPromptText',
    manual_user_handled: 'session.pendingMessages.deliveryBlockedReasons.manualUserHandled',
    attempt_expired_before_write: 'session.pendingMessages.deliveryBlockedReasons.attemptExpiredBeforeWrite',
    provider_rejected_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerRejectedBeforeAcceptance',
    steering_unavailable: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    conditional_steer_unavailable: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    unsupported_action: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    payload_too_large: 'session.pendingMessages.deliveryBlockedReasons.payloadTooLarge',
    unknown: 'session.pendingMessages.deliveryBlockedReasons.unknown',
} satisfies Record<NonNullable<PendingMessage['pendingDeliveryBlockedReason']>, TranslationKeyNoParams>;

/** Run-launch outcomes raised by the interactive draft before any Session input is admitted. */
export type ExecutionRunLaunchFailureCode =
    | 'execution_run_target_changed'
    | 'execution_run_secret_reference_overlay_update_required';

export type SessionInputFailureCode = SessionInputAdmissionRejectionCodeV1 | ExecutionRunLaunchFailureCode;

/**
 * The single code → copy owner for target-admission and Run-launch failures. Producers throw errors
 * carrying `code` (`sync/engine/pending/pendingQueueV2.ts`, the Run draft) and the presentation
 * boundary resolves copy here; a raw snake_case code is never user-facing text.
 */
const sessionInputFailureLabelKeys = {
    session_input_invalid: 'session.pendingMessages.admissionRejected.invalid',
    model_not_granted: 'session.pendingMessages.admissionRejected.modelNotGranted',
    permission_mode_not_granted: 'session.pendingMessages.admissionRejected.permissionModeNotGranted',
    session_input_archived: 'session.pendingMessages.admissionRejected.archived',
    session_input_unauthorized: 'session.pendingMessages.admissionRejected.unauthorized',
    session_input_target_unavailable: 'session.pendingMessages.admissionRejected.targetUnavailable',
    session_input_target_update_required: 'session.pendingMessages.admissionRejected.targetUpdateRequired',
    session_input_cancelled: 'session.pendingMessages.admissionRejected.cancelled',
    session_input_untrusted_assertion: 'session.pendingMessages.admissionRejected.untrustedAssertion',
    session_input_idempotency_conflict: 'session.pendingMessages.admissionRejected.idempotencyConflict',
    session_input_source_authority_mismatch: 'session.pendingMessages.admissionRejected.sourceAuthorityMismatch',
    session_input_permission_ceiling_rejected: 'session.pendingMessages.admissionRejected.permissionCeilingRejected',
    session_input_encryption_mode_mismatch: 'session.pendingMessages.admissionRejected.encryptionModeMismatch',
    execution_run_target_changed: 'sessionDrafts.executionRunStart.targetChanged',
    execution_run_secret_reference_overlay_update_required: 'sessionDrafts.executionRunStart.secretReferenceOverlayUpdateRequired',
} satisfies Record<SessionInputFailureCode, TranslationKeyNoParams>;

function isSessionInputFailureCode(value: unknown): value is SessionInputFailureCode {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(sessionInputFailureLabelKeys, value);
}

export function createSessionInputFailureError(code: SessionInputFailureCode): Error & { code: SessionInputFailureCode } {
    return Object.assign(new Error(code), { code });
}

/** The copy key for a coded failure, or `null` when the error carries no known code. */
export function getSessionInputFailureLabelKey(error: unknown): TranslationKeyNoParams | null {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return isSessionInputFailureCode(code) ? sessionInputFailureLabelKeys[code] : null;
}

function getDeliveryMutationPolicy(
    status: PendingDeliveryStatusV1,
): PendingMessageVisualState['deliveryMutationPolicy'] {
    return isPendingDeliveryProviderEffectPossibleV1(status) ? 'effect_possible' : undefined;
}

export function getPendingDeliveryBlockedReasonPresentation(
    message: Pick<PendingMessage, 'pendingDeliveryBlockedReason' | 'pendingDeliveryBlockedReasonRaw' | 'pendingDeliveryStatusRaw'>,
): PendingDeliveryBlockedReasonPresentation {
    const reason = message.pendingDeliveryBlockedReason ?? 'unknown';
    return {
        labelKey: blockedReasonLabelKeys[reason] ?? blockedReasonLabelKeys.unknown,
        isUnknown:
            reason === 'unknown'
            || typeof message.pendingDeliveryBlockedReasonRaw === 'string'
            || typeof message.pendingDeliveryStatusRaw === 'string',
    };
}

/**
 * Does a pending message row paint the IN-FLOW action row under its bubble?
 *
 * `PendingMessagesTranscriptBlock` renders `isWeb ? <copy/send actions> : canReorder ? <drag
 * handle> : null` — so a pending row on native paints nothing there unless the queue is reorderable,
 * which is exactly the shape a send creates. This is the single owner of that decision because it is
 * height-bearing: the size estimate modelled the row unconditionally 20px taller than native paints
 * it, and Legend accumulates that into a gap under the tail on every send.
 *
 * `canReorderPendingMessages` is decided PER ROW here, from that row's own delivery-mutation policy,
 * because this repo gates the reorder handle per row rather than for the whole block.
 */
export function paintsPendingMessageActionRow(params: Readonly<{
    platformIsWeb: boolean;
    canReorderPendingMessages: boolean;
}>): boolean {
    return params.platformIsWeb || params.canReorderPendingMessages;
}

export function isPendingMessageProviderDeliveryInFlight(message: PendingMessage): boolean {
    return message.pendingDeliveryStatus === 'server_delivering';
}

export function getPendingMessageVisualState(
    message: PendingMessage,
    options?: Readonly<{ materializingLocalIds?: ReadonlySet<string> }> & PendingMessageQueuedStateOptions,
): PendingMessageVisualState {
    const localId = typeof message.localId === 'string' ? message.localId : message.id;
    if (options?.materializingLocalIds?.has(localId)) {
        return {
            kind: 'materializing',
            showSpinner: true,
            iconName: 'navigation-arrow',
        };
    }

    const hasDurableServerPendingTruth = message.source === 'server_pending';
    if (!hasDurableServerPendingTruth && message.pendingOutboxOperation === 'cancel') {
        return message.sendState === 'failed'
            ? { kind: 'cancel_failed', showSpinner: false, iconName: 'warning-circle' }
            : { kind: 'cancelling', showSpinner: true, iconName: 'clock' };
    }
    if (!hasDurableServerPendingTruth && message.sendState === 'failed') {
        return {
            kind: 'send_failed',
            showSpinner: false,
            iconName: 'warning-circle',
        };
    }
    if (!hasDurableServerPendingTruth && message.sendState === 'unconfirmed') {
        return {
            kind: 'send_unconfirmed',
            showSpinner: true,
            iconName: 'cloud-arrow-up',
        };
    }

    if (message.source === 'local_outbound' && message.deliveryStatus !== 'accepted') {
        return {
            kind: 'saving',
            showSpinner: true,
            iconName: 'cloud-arrow-up',
        };
    }

    if (message.pendingDeliveryStatus === 'blocked') {
        const deliveryMutationPolicy = getDeliveryMutationPolicy({
            status: 'blocked',
            reason: message.pendingDeliveryBlockedReason ?? 'unknown',
        });
        return {
            kind: 'blocked',
            showSpinner: false,
            iconName: 'warning-circle',
            deliveryBlockedPresentation: getPendingDeliveryBlockedReasonPresentation(message),
            ...(deliveryMutationPolicy ? { deliveryMutationPolicy } : {}),
        };
    }

    if (message.pendingDeliveryStatus === 'external_handoff') {
        return {
            kind: 'delivering',
            showSpinner: false,
            iconName: 'navigation-arrow',
            deliveryMutationPolicy: getDeliveryMutationPolicy({ status: 'external_handoff' }),
        };
    }

    if (message.pendingDeliveryStatus === 'server_delivering') {
        return {
            kind: 'delivering',
            showSpinner: true,
            iconName: 'navigation-arrow',
            deliveryMutationPolicy: getDeliveryMutationPolicy({ status: 'delivering' }),
        };
    }

    const queuedRequestedAction = message.pendingRequestedAction?.kind ?? 'enqueue';
    const queuedReason = derivePendingMessageQueuedReason(message, {
        hasEarlierRow: options?.hasEarlierRow ?? false,
        hasProviderDeliveryInFlight: options?.hasProviderDeliveryInFlight ?? false,
        runtimeReachable: options?.runtimeReachable ?? true,
        foregroundState: options?.foregroundState ?? 'ready',
        deliveryTiming: options?.deliveryTiming ?? 'after_foreground_ready',
        runtimeActivity: options?.runtimeActivity ?? 'unknown',
    });
    return {
        kind: 'queued',
        showSpinner: false,
        iconName:
            queuedRequestedAction === 'steer_now'
            || queuedRequestedAction === 'send_now'
                ? 'navigation-arrow'
                : queuedReason === 'unsupported_action'
                    ? 'warning-circle'
                    : 'clock',
        queuedRequestedAction,
        ...(queuedReason ? { queuedReason } : {}),
    };
}

function derivePendingMessageQueuedReason(
    message: PendingMessage,
    context: Required<PendingMessageQueuedStateOptions>,
): PendingMessageVisualState['queuedReason'] {
    if (message.pendingRequestedActionMalformed === true) return 'unsupported_action';
    if (!context.runtimeReachable) return 'waiting_for_runtime';

    const action = message.pendingRequestedAction?.kind ?? 'enqueue';
    const isUrgent = action === 'send_now'
        || action === 'steer_now'
        || (action === 'steer_if_active' && context.foregroundState === 'active_steerable');
    if (context.hasProviderDeliveryInFlight) return 'waiting_for_predecessor';
    if (isUrgent) return undefined;
    if (context.hasEarlierRow) return 'waiting_for_predecessor';
    if (context.foregroundState !== 'ready') return 'waiting_for_foreground_turn';
    if (context.deliveryTiming !== 'after_runtime_idle') return undefined;
    if (context.runtimeActivity === 'active') return 'waiting_for_runtime_activity';
    if (context.runtimeActivity !== 'idle') return 'runtime_activity_unknown';
    return undefined;
}
