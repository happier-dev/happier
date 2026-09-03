import { Modal } from '@/modal';
import { subscribeActionOperationByRequest } from '@/sync/domains/actionOperations/subscribeActionOperationByRequest';
import type { ActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

import { SessionHandoffProgressModal } from './SessionHandoffProgressModal';

export type SessionHandoffProgressPresentation = Readonly<{
    close: () => void;
    isAttached: () => boolean;
}>;

export function openObservedSessionHandoffProgressModal(params: Readonly<{
    requestId: string;
    sessionId: string;
    workspaceTransferEnabled?: boolean;
    store?: ActionOperationStore;
}>): SessionHandoffProgressPresentation {
    let attached = true;
    let unsubscribe = () => {};
    const detach = (): void => {
        if (!attached) return;
        attached = false;
        unsubscribe();
    };
    const modalId = Modal.show({
        component: SessionHandoffProgressModal,
        props: {
            ...(params.workspaceTransferEnabled ? { workspaceTransferEnabled: true } : {}),
        },
        onRequestClose: detach,
        closeOnBackdrop: false,
    });
    unsubscribe = subscribeActionOperationByRequest({
        actionId: 'session.handoff',
        requestId: params.requestId,
        sessionId: params.sessionId,
        ...(params.store ? { store: params.store } : {}),
        onUpdate: (operation) => {
            if (attached) Modal.update(modalId, { operation });
        },
    });
    return Object.freeze({
        close: () => {
            if (!attached) return;
            detach();
            Modal.hide(modalId);
        },
        isAttached: () => attached,
    });
}
