import { router } from 'expo-router';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import type { ActionOperationReentryOrigin } from '@/components/inbox/actionOperations/actionOperationPresentationCoordinator';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { loadNewSessionDraft } from '@/sync/domains/state/persistence';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

function shouldReopenPersistedDraft(snapshot: ActionOperationSnapshotV1): boolean {
    if (snapshot.state === 'failed' || snapshot.state === 'cancelled') {
        return true;
    }
    if (snapshot.state !== 'succeeded' || !snapshot.requestId) {
        return false;
    }
    return actionOperationStore.getSnapshot().followUpAttentionByRequestId.has(snapshot.requestId);
}

/**
 * Re-entry stores only the persisted draft's bounded identity. The editable
 * content remains owned by persistence and is loaded afresh when Activity is
 * opened, so the coordinator never retains a form instance or its raw values.
 */
export function createNewSessionActionOperationOrigin(
    scope: ServerAccountScope,
): ActionOperationReentryOrigin {
    const persistedDraftScope = Object.freeze({
        serverId: scope.serverId,
        accountId: scope.accountId,
    });

    return Object.freeze({
        resolve(snapshot: ActionOperationSnapshotV1): (() => void) | null {
            if (!shouldReopenPersistedDraft(snapshot)) {
                return null;
            }
            if (!loadNewSessionDraft(persistedDraftScope)) {
                return null;
            }
            return () => router.push('/new' as never);
        },
    });
}
