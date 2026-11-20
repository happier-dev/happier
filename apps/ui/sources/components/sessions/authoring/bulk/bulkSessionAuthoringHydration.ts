import { isBundledAgentId, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';
import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { BulkSessionAuthoringHydration } from '@/sync/store/bulkSessionAuthoringFacts';
import { captureServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
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
            await runWithServerRequestAuthorityForServerAccountScope({ serverId, activeRequest: noActiveRequest, signal },
                async authority => {
                    const snapshots = await readSessionSnapshotsForAuthority({ authority,
                        sessionIds: homeTargets.map(target => target.sessionId), includeTurns: false, signal });
                    const projectionsByMachine = new Map<string, ReturnType<typeof loadDaemonMergedProjectionCacheEntry>>();
                    await Promise.all(homeTargets.map(async target => {
                        const key = sessionAddressKey(target);
                        const snapshot = snapshots.get(target.sessionId);
                        if (!snapshot?.ok) {
                            loaded.set(key, unavailable(snapshot && !snapshot.ok ? snapshot.error : null));
                            return;
                        }
                        const { session } = snapshot.snapshot;
                        const metadata = session.active ? null : readSessionOwnerMetadataView(session);
                        const agentId = resolveAgentIdFromSessionMetadata(metadata);
                        const machineId = resolveSessionMachineId(metadata);
                        const credentials = authority.context.credentials;
                        if (!agentId || isBundledAgentId(agentId) || !machineId || !credentials) {
                            loaded.set(key, { session, errorCode: null });
                            return;
                        }
                        // Retry projects the now-current Agent after cutover. The Session's Machine owns
                        // that Agent's lifecycle declaration, including whether it can resume or start.
                        let pending = projectionsByMachine.get(machineId);
                        if (!pending) {
                            const accountLifetime = captureServerCredentialAccountScopeLifetime({ kind: 'bound',
                                scope: authority.scope, credentialKey: resolveAuthCredentialsScopeKey(credentials) });
                            pending = loadDaemonMergedProjectionCacheEntry({ machineId, serverId: authority.scope.serverId,
                                accountLifetime, sections: ['agentsById'], reuseFreshReady: true, signal }).catch(() => null);
                            projectionsByMachine.set(machineId, pending);
                        }
                        const projection = await pending;
                        loaded.set(key, { session, errorCode: null, resumeOptions: {
                            currentAgentCapabilities: readCurrentProjectedAgentCapabilities({
                                projection: projection?.kind === 'ready' ? projection.inputs.pluginProjectionV2 : null,
                                agentId,
                            }),
                        } });
                    }));
                });
        } catch (error) {
            for (const target of homeTargets) loaded.set(sessionAddressKey(target), unavailable(error));
        }
    }));
    return loaded;
}
