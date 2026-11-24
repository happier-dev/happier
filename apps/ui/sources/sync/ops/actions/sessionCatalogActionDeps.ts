import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { routeSessionCatalogControl, unavailableSessionCatalog, type SessionCatalogControlOperation } from '@happier-dev/session-core/state';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import type { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import type { LazyActionAccountContext } from './actionAccountContext';
import { withActionAccountRequestSignal } from './actionAccountContext';

type CatalogPort = NonNullable<ActionExecutorDeps['sessionSkillCatalogList']>;

export function createUiSessionCatalogActionDeps(
    account: LazyActionAccountContext | undefined,
    sessionRpc: typeof sessionRpcWithServerScope,
): Pick<ActionExecutorDeps, 'sessionSkillCatalogList' | 'sessionVendorPluginCatalogList'> {
    const read = (operation: SessionCatalogControlOperation): CatalogPort => async ({ sessionId, cwd, serverId }) => {
        if (!account) return unavailableSessionCatalog(operation, 'not_authenticated');
        if (serverId && !areServerProfileIdentifiersEquivalent(serverId, account.serverId)) {
            return unavailableSessionCatalog(operation, 'session_not_found');
        }
        return withActionAccountRequestSignal(account, account.invocationSignal, signal =>
            runWithServerRequestAuthorityForServerAccountScope({
                scope: account.accountLifetime.scope, activeRequest: account.request,
            }, async authority => {
                const snapshot = await readSessionSnapshotForAuthority({
                    authority, sessionId, signal, isCurrent: account.accountLifetime.isCurrent,
                    includeTurns: false, includeMetadataTupleMutationSnapshot: false,
                }).catch((error: unknown) => {
                    if (error instanceof SessionSnapshotReadError && error.httpStatus === 404) return null;
                    throw error;
                });
                if (!snapshot) return unavailableSessionCatalog(operation, 'session_not_found');
                const { session } = snapshot;
                const method = operation === 'vendorPlugins'
                    ? SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST : SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST;
                return await routeSessionCatalogControl({
                    operation, active: session.active, metadataAvailable: readSessionOwnerMetadataView(session) !== null,
                    callLiveSessionRpc: () => sessionRpc({
                        sessionId: session.id, serverId: account.serverId, method, signal,
                        payload: cwd?.trim() ? { cwd: cwd.trim() } : {},
                    }),
                });
            }));
    };
    return { sessionSkillCatalogList: read('skills'), sessionVendorPluginCatalogList: read('vendorPlugins') };
}
