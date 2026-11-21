import { readProjectRepositoryIdentityV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { ProjectsListOutputV1 } from '@happier-dev/protocol/projects/projectListProjectionV1';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows, type ProjectAccountRowsSnapshot } from '@/sync/store/domains/projectAccountRows';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { Machine, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { isWorkspaceScopeReachableFromState } from '@/sync/domains/workspaces/workspaceReachability';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * The Account's persisted projects, each with the two facts its SCM working
 * snapshot already resolved.
 *
 * This is a PROJECTION of two incumbent owners and builds no index of its own.
 * The opened Project Account rows hold the reader's accepted checkouts,
 * preserving opaque reference ids and qualified `(serverId, machineId, rootPath)`;
 * the `projectKey`-keyed working snapshot already holds that project's resolved
 * `hostingProvider` and its worktrees. Reading both and pairing them is the
 * whole implementation.
 *
 * Nothing here probes. An unloaded snapshot can use already retained accepted
 * repository identity; an observed absence cannot revive that metadata.
 * Without either fact the project reports no `forge`. Opening a directory,
 * running `git remote`, or asking a machine for
 * a repository it has not already reported would turn a registry read into a
 * discovery crawl across every machine the reader owns.
 *
 * Nothing here MATCHES either. It filters by machine and returns what the
 * registry holds; deciding which project a given repository corresponds to
 * belongs to the one caller-side owner of that rule, and repeating it here
 * would be a second matcher to keep in step.
 *
 * It also states whether what it returned is the WHOLE registry. A caller that
 * decides exactness — "exactly one reachable checkout, so launch there" —
 * cannot make that claim from a page, and a projection that silently stopped
 * short would let it: the row that proves the answer ambiguous is simply
 * missing. So `truncated` travels with the items and the caller refuses to be
 * exact when it is set.
 */

export type ProjectsListResult = ProjectsListOutputV1;
type ProjectsListItem = ProjectsListOutputV1['items'][number];


function worktreesOf(snapshot: ScmWorkingSnapshot | null): ProjectsListItem['worktrees'] {
    const worktrees = snapshot?.repo?.worktrees;
    if (!Array.isArray(worktrees)) return [];
    return worktrees.map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch ?? null,
        isMain: worktree.isMain === true,
        isCurrent: worktree.isCurrent === true,
    }));
}

type ProjectsListMachineInventory = Readonly<{
    machines?: Record<string, Machine | undefined>;
    machineListByServerId?: Record<string, Machine[] | null | undefined>;
}>;

/**
 * Whether a Session could start on this project's machine right now.
 *
 * Both halves go through their canonical owners rather than a local re-read.
 * `resolveExactServerScopedMachine` resolves the machine WITHIN the project's
 * own server scope: the predecessor here indexed the active server's map by
 * `machineId` alone, so a project on a second server matched whichever machine
 * happened to carry that id on the active one — and machine ids are not unique
 * across servers, so that is a wrong machine, not a missing one. It also never
 * saw a machine outside the active server at all, reporting every project on
 * another server as unreachable.
 *
 * The scoped reachability owner includes request failures and the facts a bare
 * `active === true` misses: a REVOKED machine is never reachable however active
 * its last heartbeat claimed, and a machine within the online grace window
 * still is.
 */
function reachabilityOf(
    state: ProjectsListMachineInventory,
    ref: Readonly<{ serverId: string; machineId: string; rootPath: string }>,
    activeServerId: string,
    accountScope: ServerAccountScope | null,
): boolean {
    return isWorkspaceScopeReachableFromState(state, ref, activeServerId, accountScope);
}

export async function listProjectsForActions(params: Readonly<{
    serverId?: string;
    machineId?: string;
    limit?: number;
    includeHidden?: boolean;
    includeUnlisted?: boolean;
}>, openedRows?: ProjectAccountRowsSnapshot): Promise<ProjectsListResult> {
    const state = storage.getState();
    const readSnapshot = typeof state.getWorkspaceScmSnapshot === 'function'
        ? state.getWorkspaceScmSnapshot.bind(state)
        : null;
    const activeServerId = String(getActiveServerSnapshot()?.serverId ?? '').trim();

    // Only an explicit request truncates. `Math.max(1, …)` keeps a caller that
    // asked for zero or a fraction from receiving an empty page labelled whole.
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
        ? Math.max(1, Math.floor(params.limit))
        : null;

    const items: ProjectsListItem[] = [];
    const rows = openedRows ?? readCurrentProjectAccountRows(state);
    const home = params.serverId ?? rows?.scope.serverId ?? activeServerId;
    if (rows && resolveServerProfileScopeIdForIdentifier(rows.scope.serverId) !== resolveServerProfileScopeIdForIdentifier(home)) {
        throw Object.assign(new Error('Project Account Home mismatch'), { code: 'server_scope_mismatch' });
    }
    const projected = projectProjectListV1({ ...params, ...(limit === null ? {} : { limit }), serverId: home,
        listing: params.includeUnlisted === true ? 'all' : 'listed',
        workspaceRefs: rows?.workspaceRefs ?? [], organizations: rows?.organizations,
        coverage: rows?.status === 'ready' ? rows.coverage : 'unknown', normalizeServerId: resolveServerProfileScopeIdForIdentifier });
    for (const { ref, ...item } of projected.items) {
        const managed = isManagedWorkspaceRefV2(ref);
        const scope = { serverId: ref.serverId, machineId: resolveWorkspaceSyncExecutionMachineIdV1(ref), rootPath: ref.rootPath };
        const snapshot = !managed && readSnapshot ? readSnapshot(scope) : null;
        const forge = readProjectRepositoryIdentityV1({ checkout: ref, snapshot });
        items.push({
            ...item,
            ...(ref.source ? { sourceId: ref.source.sourceId } : {}),
            reachable: reachabilityOf(state, scope, activeServerId, rows?.scope ?? null),
            ...(forge ? { forge } : {}),
            worktrees: worktreesOf(snapshot),
        });
    }
    return { items, truncated: projected.truncated, coverage: projected.coverage };
}
