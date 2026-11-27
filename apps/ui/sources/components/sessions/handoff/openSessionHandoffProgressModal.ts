import { Modal } from '@/modal';
import type { BaseModalConfig } from '@/modal/types';
import { subscribeActionOperationByRequestId } from '@/sync/domains/actionOperations/subscribeActionOperationByRequestId';
import type { ActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ExecuteSessionHandoffActionResult } from '@/sync/domains/sessionHandoff/executeSessionHandoffAction';
import type { SessionHandoffActionResultV1 } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';

import { SessionHandoffProgressModal, type SessionHandoffMachineCreationProgress, type SessionHandoffRoute } from './SessionHandoffProgressModal';

export type SessionHandoffProgressPresentation = Readonly<{
    close: () => void;
    isAttached: () => boolean;
    showRequestFailure: (failure: Extract<ExecuteSessionHandoffActionResult, { ok: false }>) => void;
    showResult: (result: SessionHandoffActionResultV1) => void;
    showMachineCreation: (creation: SessionHandoffMachineCreationProgress) => void;
}>;

export function openObservedSessionHandoffProgressModal(params: Readonly<{
    commandBridge?: BaseModalConfig['commandBridge'];
    requestId: string;
    sessionId: string;
    serverId: string | null;
    accountId: string;
    targetMachineId?: string;
    workspaceSyncEnabled?: boolean;
    machineCreation?: SessionHandoffMachineCreationProgress;
    store?: ActionOperationStore;
    onOpenConflicts?: (blockedRelationshipId: string | null) => void;
    /** Runs the same selection again after a failure before anything moved (a new machine that wasn't created). */
    onRetry?: () => void;
    onDismiss?: () => void;
    route?: SessionHandoffRoute;
}>): SessionHandoffProgressPresentation {
    let attached = true;
    let unsubscribe = () => {};
    const detach = (): void => {
        if (!attached) return;
        attached = false;
        unsubscribe();
    };
    const modalId = Modal.show({
        commandBridge: params.commandBridge,
        component: SessionHandoffProgressModal,
        props: {
            serverId: params.serverId,
            sourceSessionId: params.sessionId,
            ...(params.targetMachineId ? { targetMachineId: params.targetMachineId } : {}),
            ...(params.workspaceSyncEnabled ? { workspaceSyncEnabled: true } : {}),
            ...(params.machineCreation ? { machineCreation: params.machineCreation } : {}),
            ...(params.onOpenConflicts ? { onOpenConflicts: params.onOpenConflicts } : {}),
            ...(params.onRetry ? { onRetry: params.onRetry } : {}),
            ...(params.route ? { route: params.route } : {}),
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
        showResult: (result) => {
            // Shared-Machine requesters do not receive the custodian's Account push.
            // The returned daemon status is the same authoritative terminal fact.
            if (attached) Modal.update(modalId, { requestResult: result });
        },
        showMachineCreation: (machineCreation) => {
            if (attached) Modal.update(modalId, { machineCreation });
        },
    });
}
