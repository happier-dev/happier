import { useCallback, useRef } from 'react';
import type { Metadata } from '@happier-dev/session-core/state';
import { removeSessionPendingQueueHoldV1FromMetadata, writeSessionPendingQueueHoldV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionPendingQueueHoldV1';
import type { PendingMessageComposerEditState } from '@/components/sessions/shell/pendingMessageComposerEditSnapshot';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

const PENDING_MESSAGE_EDIT_DRAIN_HOLD_TTL_MS = 2 * 60 * 1000;

/** Serializes the mounted edit's acquire/release writes; liveness belongs to its Home socket. */
export function usePendingMessageEditDrainHold(sessionId: string, serverId?: string | null) {
    const pendingPatch = useRef<Promise<unknown>>(Promise.resolve());
    const patchMetadata = useCallback((
        updater: (metadata: Metadata) => Metadata,
        tag: string,
        accountLifetime: ServerAccountScopeLifetime | null,
    ) => {
        if (accountLifetime && !accountLifetime.isCurrent()) return;
        const run = pendingPatch.current
            .catch(() => undefined)
            .then(() => {
                if (accountLifetime && !accountLifetime.isCurrent()) return;
                return sync.patchSessionMetadataWithRetry(sessionId, updater, {
                    serverId,
                    ...(accountLifetime ? { accountLifetime } : {}),
                });
            });
        pendingPatch.current = run;
        fireAndForget(run, { tag });
    }, [serverId, sessionId]);
    const publish = useCallback((edit: PendingMessageComposerEditState) => {
        const nowMs = Date.now();
        patchMetadata(
            (metadata) => writeSessionPendingQueueHoldV1ToMetadata(metadata, {
                holdId: edit.holdId,
                localId: edit.pendingId,
                updatedAtMs: nowMs,
                expiresAtMs: nowMs + PENDING_MESSAGE_EDIT_DRAIN_HOLD_TTL_MS,
            }) as Metadata,
            'SessionView.pendingMessageEdit.hold.publish',
            edit.accountLifetime,
        );
    }, [patchMetadata]);
    const clear = useCallback((edit: PendingMessageComposerEditState) => {
        edit.releasePresence();
        if (edit.holdId.trim().length === 0) return;
        patchMetadata(
            (metadata) => removeSessionPendingQueueHoldV1FromMetadata(metadata, edit.holdId) as Metadata,
            'SessionView.pendingMessageEdit.hold.clear',
            edit.accountLifetime,
        );
    }, [patchMetadata]);
    return { publish, clear };
}
