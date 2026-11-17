import { isSessionRuntimeRunningV1 } from '@happier-dev/protocol/sessions/awareness/runtime';

/** Native request summaries describe the publisher's prompts, which retire when its runtime detaches. */
export function readLiveNativeRequestCounts(
    row: Readonly<{
        active?: boolean | null;
        archivedAt?: Date | null;
        pendingPermissionRequestCount?: number | null;
        pendingUserActionRequestCount?: number | null;
    }>,
    hasLiveFacts: boolean,
) {
    const running = hasLiveFacts && isSessionRuntimeRunningV1({ active: row.active, presence: 'unknown' }, row.archivedAt != null);
    return {
        permission: running ? row.pendingPermissionRequestCount ?? 0 : 0,
        userAction: running ? row.pendingUserActionRequestCount ?? 0 : 0,
    };
}
