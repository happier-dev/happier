import { router } from 'expo-router';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { acknowledgeActionOperationPresented } from '@/sync/domains/actionOperations/acknowledgeActionOperationPresented';

import { openActionOperationDetail } from './openActionOperationDetail';
import { createActionOperationPresentationCoordinator } from './actionOperationPresentationCoordinator';
import { readActionOperationDestinationServerId } from './actionOperationPresentation';

export const actionOperationPresentationCoordinator = createActionOperationPresentationCoordinator({
    openDetail: openActionOperationDetail,
    openDestination: (sessionId: string, snapshot: ActionOperationSnapshotV1) => {
        router.push(buildScopedSessionRouteHref({
            sessionId,
            serverId: readActionOperationDestinationServerId(snapshot),
        }) as never);
    },
    markPresented: (snapshot) => {
        acknowledgeActionOperationPresented(snapshot);
    },
});

export function openActionOperation(snapshot: ActionOperationSnapshotV1): void {
    actionOperationPresentationCoordinator.open(snapshot);
}
