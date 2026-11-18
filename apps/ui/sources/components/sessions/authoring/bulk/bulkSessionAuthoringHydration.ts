import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';
import type { BulkSessionAuthoringHydration } from '@/sync/store/bulkSessionAuthoringFacts';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotsForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';

const noActiveRequest = async (): Promise<Response> => { throw new Error('Expected an exact Account request'); };

function unavailable(error: unknown): BulkSessionAuthoringHydration {
    return { session: null, errorCode: error instanceof SessionSnapshotReadError ? error.errorCode : 'snapshot_unavailable' };
}

export async function readBulkSessionAuthoringSnapshots(
    targets: readonly ActionSessionAddressV1[], signal?: AbortSignal,
): Promise<ReadonlyMap<string, BulkSessionAuthoringHydration>> {
    const byHome = new Map<string, ActionSessionAddressV1[]>();
    for (const target of targets) {
        const group = byHome.get(target.serverId) ?? [];
        group.push(target);
        byHome.set(target.serverId, group);
    }
    const loaded = new Map<string, BulkSessionAuthoringHydration>();
    await Promise.all([...byHome].map(async ([serverId, homeTargets]) => {
        try {
            const snapshots = await runWithServerRequestAuthorityForServerAccountScope(
                { serverId, activeRequest: noActiveRequest },
                authority => readSessionSnapshotsForAuthority({ authority, sessionIds: homeTargets.map(target => target.sessionId),
                    includeTurns: false, signal }),
            );
            for (const target of homeTargets) {
                const snapshot = snapshots.get(target.sessionId);
                loaded.set(sessionAddressKey(target), snapshot?.ok
                    ? { session: snapshot.snapshot.session, errorCode: null }
                    : unavailable(snapshot && !snapshot.ok ? snapshot.error : null));
            }
        } catch (error) {
            for (const target of homeTargets) loaded.set(sessionAddressKey(target), unavailable(error));
        }
    }));
    return loaded;
}
