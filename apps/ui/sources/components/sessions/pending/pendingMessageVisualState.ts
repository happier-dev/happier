import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { TranslationKeyNoParams } from '@/text';
import {
    isPendingDeliveryProviderEffectPossibleV1,
    type PendingDeliveryStatusV1,
} from '@happier-dev/protocol';

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
    iconName: 'cloud-upload-outline' | 'time-outline' | 'navigate-outline' | 'alert-circle-outline';
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

const blockedReasonLabelKeys = {
    terminal_composer_draft: 'session.pendingMessages.deliveryBlockedReasons.terminalComposerDraft',
    capture_style_unavailable: 'session.pendingMessages.deliveryBlockedReasons.captureStyleUnavailable',
    provider_unavailable_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerUnavailableBeforeAcceptance',
    ambiguous_terminal_delivery: 'session.pendingMessages.deliveryBlockedReasons.ambiguousTerminalDelivery',
    delivery_outcome_uncertain: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    terminal_host_unreachable: 'session.pendingMessages.deliveryBlockedReasons.terminalHostUnreachable',
    runtime_disposed_before_delivery: 'session.pendingMessages.deliveryBlockedReasons.runtimeDisposedBeforeDelivery',
    runtime_config_blocked: 'session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked',
    invalid_prompt_text: 'session.pendingMessages.deliveryBlockedReasons.invalidPromptText',
    manual_user_handled: 'session.pendingMessages.deliveryBlockedReasons.manualUserHandled',
    attempt_expired_before_write: 'session.pendingMessages.deliveryBlockedReasons.attemptExpiredBeforeWrite',
    provider_rejected_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerRejectedBeforeAcceptance',
    steering_unavailable: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    unsupported_action: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    payload_too_large: 'session.pendingMessages.deliveryBlockedReasons.payloadTooLarge',
    unknown: 'session.pendingMessages.deliveryBlockedReasons.unknown',
} satisfies Record<NonNullable<PendingMessage['pendingDeliveryBlockedReason']>, TranslationKeyNoParams>;

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
            iconName: 'navigate-outline',
        };
    }

    const hasDurableServerPendingTruth = message.source === 'server_pending';
    if (!hasDurableServerPendingTruth && message.pendingOutboxOperation === 'cancel') {
        return message.sendState === 'failed'
            ? { kind: 'cancel_failed', showSpinner: false, iconName: 'alert-circle-outline' }
            : { kind: 'cancelling', showSpinner: true, iconName: 'time-outline' };
    }
    if (!hasDurableServerPendingTruth && message.sendState === 'failed') {
        return {
            kind: 'send_failed',
            showSpinner: false,
            iconName: 'alert-circle-outline',
        };
    }
    if (!hasDurableServerPendingTruth && message.sendState === 'unconfirmed') {
        return {
            kind: 'send_unconfirmed',
            showSpinner: true,
            iconName: 'cloud-upload-outline',
        };
    }

    if (message.source === 'local_outbound' && message.deliveryStatus !== 'accepted') {
        return {
            kind: 'saving',
            showSpinner: true,
            iconName: 'cloud-upload-outline',
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
            iconName: 'alert-circle-outline',
            deliveryBlockedPresentation: getPendingDeliveryBlockedReasonPresentation(message),
            ...(deliveryMutationPolicy ? { deliveryMutationPolicy } : {}),
        };
    }

    if (message.pendingDeliveryStatus === 'external_handoff') {
        return {
            kind: 'delivering',
            showSpinner: false,
            iconName: 'navigate-outline',
            deliveryMutationPolicy: getDeliveryMutationPolicy({ status: 'external_handoff' }),
        };
    }

    if (message.pendingDeliveryStatus === 'server_delivering') {
        return {
            kind: 'delivering',
            showSpinner: true,
            iconName: 'navigate-outline',
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
                ? 'navigate-outline'
                : queuedReason === 'unsupported_action'
                    ? 'alert-circle-outline'
                    : 'time-outline',
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
