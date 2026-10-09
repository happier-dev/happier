import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import type { ProjectKeyV1, QualifiedProjectKeyV1, WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows, type ProjectAccountRowsSnapshot } from '@/sync/store/domains/projectAccountRows';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { Machine, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { isWorkspaceScopeReachableFromState } from '@/sync/domains/workspaces/workspaceReachability';

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
 * Nothing here probes. A project whose snapshot this client has never fetched
 * simply reports no `forge`, and a caller joining on forge identity does not
 * match it. Opening a directory, running `git remote`, or asking a machine for
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

export type ProjectsListResult = Readonly<{
    items: readonly ProjectsListItem[];
    /**
     * Whether a caller-supplied `limit` cut the answer short.
     *
     * There is no cap of this projection's own. The registry is
     * the opened Account row census — state this client already holds
     * resident and already renders elsewhere
     * (`components/projects/ProjectsListView.tsx`) — so walking it fetches
     * nothing and a row ceiling here would protect no measured resource while
     * silently making a partial answer look complete. Only an explicit `limit`
     * truncates a complete census, and incomplete/unavailable coverage also
     * reports truncation so callers cannot infer exactness from retained rows.
     */
    truncated: boolean;
    coverage: 'complete' | 'partial' | 'unknown';
}>;

export type ProjectsListItem = Readonly<{
    projectKey: ProjectKeyV1;
    project: QualifiedProjectKeyV1;
    workspaceAddress: WorkspaceAddressV1;
    hidden: boolean;
    pinned: boolean;
    serverId: string;
    machineId: string;
    rootPath: string;
    label?: string;
    reachable: boolean;
    forge?: Readonly<{ kind: string; deployment: string; repository: string }>;
    worktrees: readonly Readonly<{
        path: string;
        branch: string | null;
        isMain: boolean;
        isCurrent: boolean;
    }>[];
}>;


/**
 * The resolved forge identity, or nothing.
 *
 * All three components must be present. `nameWithOwner` is optional on
 * `ScmHostingProviderRef` — a recognized provider whose repository name could
 * not be resolved — and a partial identity joins to the wrong repository, so it
 * is reported as no identity at all.
 *
 * `deployment` comes from the incumbent identity owner
 * (`packages/protocol/src/scm/hostingRepositoryIdentity.ts`) rather than from a
 * base URL spelled here, so this projection adds no second canonicalization
 * rule. It is required because `id` is one constant per forge PLUGIN: without
 * it, two deployments of one forge that hold a repository at the same path are
 * one identity, and on Azure DevOps the organization or collection lives in the
 * base path, so that collision is ordinary rather than exotic.
 */
function forgeOf(snapshot: ScmWorkingSnapshot | null): ProjectsListItem['forge'] {
    const provider = snapshot?.hostingProvider;
    if (!provider) return undefined;
    const identity = readScmHostingRepositoryIdentity(provider);
    return identity ?? undefined;
}

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
 * `isMachineOnline` then owns liveness, including the two facts a bare
 * `active === true` misses: a REVOKED machine is never reachable however active
 * its last heartbeat claimed, and a machine within the online grace window
 * still is.
 */
function reachabilityOf(
    state: ProjectsListMachineInventory,
    ref: Readonly<{ serverId: string; machineId: string; rootPath: string }>,
    activeServerId: string,
): boolean {
    return isWorkspaceScopeReachableFromState(state, ref, activeServerId);
}

export async function listProjectsForActions(params: Readonly<{
    serverId?: string;
    machineId?: string;
    limit?: number;
    includeHidden?: boolean;
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
        workspaceRefs: rows?.workspaceRefs ?? [], organizations: rows?.organizations,
        coverage: rows?.status === 'ready' ? rows.coverage : 'unknown', normalizeServerId: resolveServerProfileScopeIdForIdentifier });
    for (const { ref, ...item } of projected.items) {
        const scope = { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath };
        const snapshot = readSnapshot ? readSnapshot(scope) : null;
        const forge = forgeOf(snapshot) ?? ref.repositoryIdentity;
        items.push({
            ...item,
            ...scope,
            ...(ref.label ? { label: ref.label } : {}),
            reachable: reachabilityOf(state, scope, activeServerId),
            ...(forge ? { forge } : {}),
            worktrees: worktreesOf(snapshot),
        });
    }
    return { items, truncated: projected.truncated, coverage: projected.coverage };
}
