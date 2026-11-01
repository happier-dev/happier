import type { DiscardedPendingMessage, PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import { canSteerUserMessageNow } from '@/sync/domains/session/control/submitMode';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { canUseDirectPendingDeliveryActions } from './pendingMessageVisualState';

export function getPendingMaterializingKey(message: Pick<PendingMessage, 'id' | 'localId'>): string {
    return typeof message.localId === 'string' && message.localId.length > 0 ? message.localId : message.id;
}

export function getPendingMessageSendPresentation(session: Session | null) {
    const canSteerNow = canSteerUserMessageNow({ session });
    const backgroundActive = deriveSessionRuntimePresentationState(session ?? {}, Date.now()).backgroundActive;
    return {
        sendNowActionLabel: canSteerNow ? t('session.pendingMessages.actions.sendNowInterrupt')
            : backgroundActive ? t('session.pendingMessages.actions.sendToAgentNow') : t('session.pendingMessages.actions.sendNow'),
        sendNowConfirmationTitle: canSteerNow ? t('session.pendingMessages.sendConfirm.interruptTitle')
            : backgroundActive ? t('session.pendingMessages.sendConfirm.backgroundTitle') : t('session.pendingMessages.sendConfirm.title'),
        sendNowConfirmationBody: session?.presence !== 'online' ? t('session.pendingMessages.sendConfirm.resumeBody')
            : backgroundActive ? t('session.pendingMessages.sendConfirm.backgroundBody') : t('session.pendingMessages.sendConfirm.body'),
    };
}

/** Resubmit the existing durable identity, then remove only a directly committed legacy row. */
export async function sendPendingMessageWithIntent(opts: {
    sessionId: string;
    session: Session | null;
    message: PendingMessage | DiscardedPendingMessage;
    deliveryIntent: 'steer_now' | 'interrupt_and_send';
}): Promise<void> {
    const { message } = opts;
    const discarded = 'discardedAt' in message;
    if (!discarded && !canUseDirectPendingDeliveryActions(message)) return;
    if (opts.deliveryIntent === 'interrupt_and_send') {
        const presentation = getPendingMessageSendPresentation(opts.session);
        if (!await Modal.confirm(presentation.sendNowConfirmationTitle, presentation.sendNowConfirmationBody,
            { confirmText: presentation.sendNowActionLabel })) return;
    }
    try {
        const result = await sync.sendPendingMessageNow(opts.sessionId, {
            localId: getPendingMaterializingKey(message), createdAt: message.createdAt, rawRecord: message.rawRecord,
            text: message.text, displayText: message.displayText, deliveryIntent: opts.deliveryIntent,
        });
        if (result.type === 'committed' && result.persistence === 'provider_direct' && result.providerAcceptancePending !== true) {
            if (discarded) await sync.deleteDiscardedPendingMessage(opts.sessionId, message.id);
            else await sync.deletePendingMessage(opts.sessionId, message.id);
        }
    } catch (error) {
        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('session.pendingMessages.errors.sendFailed'));
    }
}
