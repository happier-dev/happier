import { router } from 'expo-router';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

import { openActionOperationDetail } from './openActionOperationDetail';
import { createActionOperationPresentationCoordinator } from './actionOperationPresentationCoordinator';

export const actionOperationPresentationCoordinator = createActionOperationPresentationCoordinator({
    openDetail: openActionOperationDetail,
    openDestination: (sessionId: string, snapshot: ActionOperationSnapshotV1) => {
        router.push(buildScopedSessionRouteHref({ sessionId, serverId: null }) as never);
    },
});

export function openActionOperation(snapshot: ActionOperationSnapshotV1): void {
    actionOperationPresentationCoordinator.open(snapshot);
}
