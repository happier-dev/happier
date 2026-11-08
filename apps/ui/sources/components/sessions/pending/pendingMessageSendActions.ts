import type { DiscardedPendingMessage, PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import { canSteerUserMessageNow } from '@/sync/domains/session/control/submitMode';
import { projectUiSessionRuntimeAwareness } from '@/sync/domains/session/attention/runtimePresentation';
import { readLatestLocalOutboundPendingUserMessageAt } from '@/sync/domains/messages/outgoingUserMessageActivity';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { Modal } from '@/modal';
import { t } from '@/text';
import { canUseDirectPendingDeliveryActions, type PendingMessagesPresentation } from './pendingMessageVisualState';

export function getPendingMaterializingKey(message: Pick<PendingMessage, 'id' | 'localId'>): string {
    return typeof message.localId === 'string' && message.localId.length > 0 ? message.localId : message.id;
}

export function getPendingMessageSendPresentation(session: Session | null) {
    const canSteerNow = canSteerUserMessageNow({ session });
    const backgroundActive = derivePendingMessagesRuntimePresentation(session).backgroundActive;
    return {
        sendNowActionLabel: canSteerNow ? t('session.pendingMessages.actions.sendNowInterrupt')
            : backgroundActive ? t('session.pendingMessages.actions.sendToAgentNow') : t('session.pendingMessages.actions.sendNow'),
        sendNowConfirmationTitle: canSteerNow ? t('session.pendingMessages.sendConfirm.interruptTitle')
            : backgroundActive ? t('session.pendingMessages.sendConfirm.backgroundTitle') : t('session.pendingMessages.sendConfirm.title'),
        sendNowConfirmationBody: session?.presence !== 'online' ? t('session.pendingMessages.sendConfirm.resumeBody')
            : backgroundActive ? t('session.pendingMessages.sendConfirm.backgroundBody') : t('session.pendingMessages.sendConfirm.body'),
    };
}

/** UI presentation for the canonical retained-input Action. */
export async function sendPendingMessageWithIntent(opts: {
    sessionId: string;
    serverId?: string;
    expectedAccountId: string;
    executor: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>;
    isCurrent?: () => boolean;
    session: Session | null;
    message: PendingMessage | DiscardedPendingMessage;
    deliveryIntent: 'steer_now' | 'interrupt_and_send';
}): Promise<void> {
    const { message } = opts;
    if (opts.isCurrent?.() === false) return;
    const discarded = 'discardedAt' in message;
    if (!discarded && !canUseDirectPendingDeliveryActions(message, undefined, opts.session)) return;
    if (opts.deliveryIntent === 'interrupt_and_send') {
        const presentation = getPendingMessageSendPresentation(opts.session);
        if (!await Modal.confirm(presentation.sendNowConfirmationTitle, presentation.sendNowConfirmationBody,
            { confirmText: presentation.sendNowActionLabel })) return;
    }
    if (opts.isCurrent?.() === false) return;
    try {
        const result = await opts.executor.execute('session.pending.sendNow', {
            sessionId: opts.sessionId, localId: getPendingMaterializingKey(message), serverId: opts.serverId,
            ...(message.recipient ? { targetExecutionRunId: message.recipient.runId } : {}),
            deliveryIntent: opts.deliveryIntent,
        }, { surface: 'ui', authority: 'present_user', defaultSessionId: opts.sessionId,
            serverId: opts.serverId, expectedAccountId: opts.expectedAccountId });
        if (!result.ok && !isActionApprovalDeclinedErrorCode(result.errorCode)) throw new Error(result.error);
    } catch (error) {
        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('session.pendingMessages.errors.sendFailed'));
    }
}

export function derivePendingMessagesRuntimePresentation(
    session: Session | null,
    pendingMessages: ReadonlyArray<PendingMessage> = [],
    queueContext?: Pick<PendingMessagesPresentation, 'latestLocalOutboundPendingUserMessageAt'>,
) {
    return projectUiSessionRuntimeAwareness({
        id: session?.id,
        serverId: session?.serverId,
        active: session?.active,
        activeAt: session?.activeAt,
        presence: session?.presence,
        thinking: session?.thinking,
        thinkingAt: session?.thinkingAt,
        optimisticThinkingAt: session?.optimisticThinkingAt ?? (queueContext
            ? queueContext.latestLocalOutboundPendingUserMessageAt : readLatestLocalOutboundPendingUserMessageAt(pendingMessages)),
        hasPendingUserMessages: (session?.pendingCount ?? pendingMessages.length) > 0,
        latestTurnStatus: session?.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session?.latestTurnStatusObservedAt ?? null,
        runtimeActivityState: session?.runtimeActivityState ?? null,
        runtimeActivityActiveCount: session?.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: session?.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session?.runtimeActivityRevision ?? null,
        meaningfulActivityAt: session?.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session?.lastRuntimeIssue ?? null,
    });
}

