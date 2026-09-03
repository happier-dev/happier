import * as React from 'react';
import { router } from 'expo-router';
import type { ActionOperationGetV1Response } from '@happier-dev/protocol';

import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { getCurrentAuth } from '@/auth/context/AuthContext';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import {
    useActionOperation,
    useActionOperationObservationForOperation,
} from '@/sync/domains/actionOperations/useActionOperations';
import {
    actionOperationStore,
    type ActionOperationStore,
} from '@/sync/domains/actionOperations/actionOperationStore';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { actionOperationReentry } from '@/sync/domains/actionOperations/actionOperationReentry';
import { acknowledgeActionOperationPresented } from '@/sync/domains/actionOperations/acknowledgeActionOperationPresented';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';

import { ActionOperationDetail } from './ActionOperationDetail';
import { useActionOperationStopControl } from './useActionOperationStopControl';

export type ActionOperationDetailModalProps = CustomModalInjectedProps & Readonly<{
    operationId: string;
    refreshDetail?: (operationId: string) => Promise<void>;
}>;

type GetActionOperation = (params: Readonly<{
    machineId: string;
    serverId?: string | null;
    operationId: string;
}>) => Promise<ActionOperationGetV1Response>;

export async function refreshActionOperationDetail(params: Readonly<{
    operationId: string;
    store?: ActionOperationStore;
    get?: GetActionOperation;
}>): Promise<void> {
    const store = params.store ?? actionOperationStore;
    const operation = store.getState().operationsById.get(params.operationId);
    if (!operation) return;
    const response = await (params.get ?? getActionOperation)({
        machineId: operation.scope.machineId,
        operationId: operation.operationId,
    });
    if (response.kind === 'found') {
        store.mergeFullSnapshot(response.operation);
        return;
    }
    store.markUnavailable(operation.operationId);
}

function ObservedActionOperationDetail(props: Readonly<{
    operation: NonNullable<ReturnType<typeof useActionOperation>>;
    onClose: () => void;
}>) {
    const navigateToSession = useNavigateToSession();
    const observation = useActionOperationObservationForOperation(props.operation);
    const stopControl = useActionOperationStopControl(props.operation);

    return (
        <ActionOperationDetail
            operation={props.operation}
            observation={observation}
            onClose={props.onClose}
            onCancel={stopControl.requestStop}
            cancelPending={stopControl.pending}
            cancelFailed={stopControl.failed}
            onOpenSession={(sessionId) => { void navigateToSession(sessionId); }}
        />
    );
}

export function ActionOperationDetailModal(props: ActionOperationDetailModalProps) {
    const operation = useActionOperation(props.operationId);
    React.useEffect(() => {
        const refresh = props.refreshDetail ?? ((operationId: string) => refreshActionOperationDetail({ operationId }));
        void refresh(props.operationId).catch(() => {
            // The shared machine observer owns reconnecting/unavailable transport projection.
            // Keep the last-known snapshot visible when this one-shot full hydration fails.
        });
    }, [props.operationId, props.refreshDetail]);

    React.useEffect(() => {
        if (
            operation?.state === 'succeeded'
            || operation?.state === 'failed'
            || operation?.state === 'cancelled'
        ) {
            acknowledgeActionOperationPresented(operation);
        }
    }, [operation?.operationId, operation?.state]);

    if (operation) {
        return <ObservedActionOperationDetail operation={operation} onClose={props.onClose} />;
    }
    return <ActionOperationDetail operation={null} observation="status_unavailable" onClose={props.onClose} />;
}

export function openActionOperationDetail(operationId: string): string | null {
    const operation = actionOperationStore.getState().operationsById.get(operationId);
    if (operation) {
        const target = actionOperationReentry.resolve(operation);
        if (target.kind === 'origin') {
            target.open();
            return null;
        }
        if (target.kind === 'new_session') {
            router.push({
                pathname: '/new',
                params: {
                    ...buildNewSessionLaunchRouteParams({
                        draftId: target.draftId,
                        targetServerId: target.draftScope.serverId,
                    }),
                    actionOperationId: target.operationId,
                },
            } as never);
            return null;
        }
        if (target.kind === 'session') {
            navigateToSessionRoute({
                router,
                sessionId: target.sessionId,
                serverId: target.serverId,
                refreshAuth: getCurrentAuth()?.refreshFromActiveServer ?? null,
            });
            acknowledgeActionOperationPresented(operation);
            return null;
        }
    }
    return Modal.show({
        component: ActionOperationDetailModal,
        props: { operationId },
        closeOnBackdrop: true,
    });
}
