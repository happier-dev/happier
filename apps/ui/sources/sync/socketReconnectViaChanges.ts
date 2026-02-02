import type { AuthCredentials } from '@/auth/tokenStorage';
import type { ChangeEntry } from '@happier-dev/protocol/changes';
import { planSyncActionsFromChanges, type PlannedChangeActions } from './changesPlanner';

export type FetchChangesFn = (params: {
    credentials: AuthCredentials;
    afterCursor: string | null;
    limit: number;
}) => Promise<
    | { status: 'ok'; changes: ChangeEntry[]; nextCursor: string }
    | { status: 'cursor-gone'; currentCursor: string }
    | { status: 'error' }
>;

export async function runSocketReconnectCatchUpViaChanges(params: {
    credentials: AuthCredentials | null;
    accountId: string | null;
    afterCursor: string | null;
    changesPageLimit: number;
    forceSnapshotRefresh: boolean;
    fetchChanges: FetchChangesFn;
    applyPlanned: (planned: PlannedChangeActions) => Promise<void>;
    snapshotRefresh: () => Promise<void>;
}): Promise<
    | { status: 'fallback' }
    | { status: 'ok'; nextCursor: string; shouldPersistCursor: boolean; flushCursorNow: boolean }
> {
    if (!params.credentials) {
        return { status: 'fallback' };
    }

    if (!params.accountId) {
        return { status: 'fallback' };
    }

    const afterCursor = params.afterCursor ?? '0';
    const result = await params.fetchChanges({
        credentials: params.credentials,
        afterCursor,
        limit: params.changesPageLimit,
    });

    if (result.status === 'cursor-gone') {
        await params.snapshotRefresh();
        return {
            status: 'ok',
            nextCursor: result.currentCursor,
            shouldPersistCursor: true,
            flushCursorNow: true,
        };
    }

    if (result.status !== 'ok') {
        return { status: 'fallback' };
    }

    const { changes, nextCursor } = result;

    if (params.forceSnapshotRefresh) {
        await params.snapshotRefresh();
        return {
            status: 'ok',
            nextCursor,
            shouldPersistCursor: nextCursor !== afterCursor,
            flushCursorNow: true,
        };
    }

    if (changes.length === 0) {
        return {
            status: 'ok',
            nextCursor,
            shouldPersistCursor: nextCursor !== afterCursor,
            flushCursorNow: false,
        };
    }

    if (changes.length >= params.changesPageLimit) {
        await params.snapshotRefresh();
        return { status: 'ok', nextCursor, shouldPersistCursor: true, flushCursorNow: true };
    }

    const planned = planSyncActionsFromChanges(changes);
    await params.applyPlanned(planned);

    return { status: 'ok', nextCursor, shouldPersistCursor: true, flushCursorNow: false };
}
