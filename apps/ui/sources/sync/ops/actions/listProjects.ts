import {
    readScmHostingRepositoryIdentity,
    WorkspaceRefV1Schema,
    type ProjectKeyV1,
    type WorkspaceRefV1,
} from '@happier-dev/protocol';

import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { Machine, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

/**
 * The Account's persisted projects, each with the two facts its SCM working
 * snapshot already resolved.
 *
 * This is a PROJECTION of two incumbent owners and builds no index of its own.
 * `workspaceRefsV1` in Account Settings
 * (`packages/protocol/src/workspaces/workspaceRefV1.ts`) already holds every
 * project the reader has opened, keyed by `(serverId, machineId, rootPath)`;
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
     * `workspaceRefsV1` in Account Settings — state this client already holds
     * resident and already renders in full elsewhere
     * (`components/projects/ProjectsListView.tsx`) — so walking it fetches
     * nothing and a row ceiling here would protect no measured resource while
     * silently making a partial answer look complete. Only an explicit `limit`
     * truncates, and when it does the result says so.
     */
    truncated: boolean;
}>;

export type ProjectsListItem = Readonly<{
    projectKey: ProjectKeyV1;
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


function readWorkspaceRefs(state: unknown): readonly WorkspaceRefV1[] {
    const settings = (state as { settings?: { workspaceRefsV1?: unknown } } | null)?.settings;
    const raw = settings?.workspaceRefsV1;
    if (!Array.isArray(raw)) return [];
    const refs: WorkspaceRefV1[] = [];
    for (const candidate of raw) {
        const parsed = WorkspaceRefV1Schema.safeParse(candidate);
        if (parsed.success) refs.push(parsed.data);
    }
    return refs;
}

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
    ref: Readonly<{ serverId: string; machineId: string }>,
    activeServerId: string,
): boolean {
    const machine = resolveExactServerScopedMachine<Machine>({
        machineId: ref.machineId,
        serverId: ref.serverId,
        activeServerId,
        activeMachines: Object.values(state.machines ?? {}).filter(
            (candidate): candidate is Machine => candidate !== undefined,
        ),
        machineListByServerId: state.machineListByServerId ?? {},
    });
    return machine ? isMachineOnline(machine) : false;
}

export async function listProjectsForActions(params: Readonly<{
    machineId?: string;
    limit?: number;
}>): Promise<ProjectsListResult> {
    const state = storage.getState() as unknown as ProjectsListMachineInventory & {
        getWorkspaceScmSnapshot?: (
            scope: Readonly<{ serverId: string; machineId: string; rootPath: string }>,
        ) => ScmWorkingSnapshot | null;
    };
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
    let truncated = false;
    for (const ref of readWorkspaceRefs(state)) {
        if (params.machineId !== undefined && ref.machineId !== params.machineId) continue;
        if (limit !== null && items.length >= limit) {
            // A row this projection matched and then declined to send is the
            // whole reason the answer is not exact. Saying so is what stops a
            // caller reading the page as the registry.
            truncated = true;
            break;
        }

        const scope = { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath };
        const snapshot = readSnapshot ? readSnapshot(scope) : null;
        const forge = forgeOf(snapshot);
        items.push({
            projectKey: { id: ref.id },
            ...scope,
            ...(ref.label ? { label: ref.label } : {}),
            reachable: reachabilityOf(state, scope, activeServerId),
            ...(forge ? { forge } : {}),
            worktrees: worktreesOf(snapshot),
        });
    }
    return { items, truncated };
}
