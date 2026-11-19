import { Modal } from '@/modal';
import { subscribeActionOperationByRequestId } from '@/sync/domains/actionOperations/subscribeActionOperationByRequestId';
import type { ActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ExecuteSessionHandoffActionResult } from '@/sync/domains/sessionHandoff/executeSessionHandoffAction';

import { SessionHandoffProgressModal, type SessionHandoffMachineCreationProgress } from './SessionHandoffProgressModal';

export type SessionHandoffProgressPresentation = Readonly<{
    close: () => void;
    isAttached: () => boolean;
    showRequestFailure: (failure: Extract<ExecuteSessionHandoffActionResult, { ok: false }>) => void;
    showMachineCreation: (creation: SessionHandoffMachineCreationProgress) => void;
}>;

export function openObservedSessionHandoffProgressModal(params: Readonly<{
    requestId: string;
    sessionId: string;
    serverId: string | null;
    accountId: string;
    workspaceSyncEnabled?: boolean;
    machineCreation?: SessionHandoffMachineCreationProgress;
    store?: ActionOperationStore;
    onOpenConflicts?: (blockedRelationshipId: string | null) => void;
    onDismiss?: () => void;
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
            serverId: params.serverId,
            ...(params.workspaceSyncEnabled ? { workspaceSyncEnabled: true } : {}),
            ...(params.machineCreation ? { machineCreation: params.machineCreation } : {}),
            ...(params.onOpenConflicts ? { onOpenConflicts: params.onOpenConflicts } : {}),
        },
        onRequestClose: () => { detach(); params.onDismiss?.(); },
        closeOnBackdrop: false,
    });
    unsubscribe = subscribeActionOperationByRequestId({
        requestId: params.requestId,
        serverId: params.serverId,
        accountId: params.accountId,
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
        showRequestFailure: (failure) => {
            if (attached) Modal.update(modalId, { requestFailure: failure });
        },
        showMachineCreation: (machineCreation) => {
            if (attached) Modal.update(modalId, { machineCreation });
        },
    });
}
