import { router } from 'expo-router';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import type { ActionOperationReentryOrigin } from '@/components/inbox/actionOperations/actionOperationPresentationCoordinator';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationRequestAddressKey } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { interceptNewSessionEntry } from './newSessionEntry';

function shouldReopenPersistedDraft(snapshot: ActionOperationSnapshotV1, scope: ServerAccountScope): boolean {
    if (snapshot.state === 'failed' || snapshot.state === 'cancelled') {
        return true;
    }
    if (snapshot.state !== 'succeeded' || !snapshot.requestId) {
        return false;
    }
    return actionOperationStore.getSnapshot().followUpAttentionByRequestKey.has(actionOperationRequestAddressKey({
        serverId: scope.serverId,
        accountId: scope.accountId,
        requestId: snapshot.requestId,
    }));
}

/**
 * Re-entry stores only the persisted draft's bounded identity. The editable
 * content remains owned by persistence and is loaded afresh when Activity is
 * opened, so the coordinator never retains a form instance or its raw values.
 */
export function createNewSessionActionOperationOrigin(
    scope: ServerAccountScope,
    draftId: string,
): ActionOperationReentryOrigin {
    const persistedDraftScope = Object.freeze({
        serverId: scope.serverId,
        accountId: scope.accountId,
    });
    const persistedDraftId = draftId;

    return Object.freeze({
        resolve(snapshot: ActionOperationSnapshotV1): (() => void) | null {
            if (!shouldReopenPersistedDraft(snapshot, persistedDraftScope)) {
                return null;
            }
            if (!getSessionDraftSnapshot(persistedDraftScope, { kind: 'newSession', draftId: persistedDraftId })) {
                return null;
            }
            return () => {
                const href = { pathname: '/new', params: { draftId: persistedDraftId } } as const;
                if (!interceptNewSessionEntry(href)) router.push(href);
            };
        },
    });
}
