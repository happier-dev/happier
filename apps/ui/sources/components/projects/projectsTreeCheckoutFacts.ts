import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import type { StorageState } from '@/sync/store/types';
import { resolveDisplayIdentityForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    projectUiSessionRuntimeAwareness,
    readSessionRuntimePresentationFreshnessExpirations,
} from '@/sync/domains/session/attention/runtimePresentation';
import {
    readRealmQualifiedMobileSurface,
    resolveProjectMobileSurfaceStorageKey,
} from '@/sync/domains/settings/mobileSurfacePersistence';
import { buildWorkspaceCacheKey, normalizeWorkspaceRootPath } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

import { projectsTreeCheckoutKey, type ProjectsTreeCheckoutFacts } from './projectsTreeRows';

export type ProjectsTreeCheckoutFactsState = Pick<StorageState,
    'sessions' | 'sessionListRowsByServerId' | 'machines' | 'machineListByServerId' | 'profileScope' | 'getWorkspaceScmSnapshot'
> & Readonly<{ localSettings: Pick<LocalSettings, 'projectLastMobileSurfaceByWorkspaceRefId'> }>;

export type ProjectsTreeCheckoutFactsSelector = {
    (state: ProjectsTreeCheckoutFactsState, nowMs: number): ReadonlyMap<string, ProjectsTreeCheckoutFacts>;
    getNextWakeAtMs(): number | null;
};

function checkoutKey(ref: WorkspaceRefV1): string {
    return projectsTreeCheckoutKey({ refId: ref.id, workspaceAddress: workspaceAddressFromRefV1(ref) });
}

function readScmFacts(snapshot: ScmWorkingSnapshot | null, rootPath: string) {
    if (!snapshot?.repo.isRepo) return { branch: null, isWorktree: snapshot ? false : null };
    const worktree = snapshot.repo.worktrees?.find(row => normalizeWorkspaceRootPath(row.path) === normalizeWorkspaceRootPath(rootPath));
    return {
        branch: snapshot.branch.head?.trim() || null,
        isWorktree: typeof worktree?.isMain === 'boolean' ? !worktree.isMain : null,
    };
}

function sameFacts(left: ProjectsTreeCheckoutFacts | undefined, right: ProjectsTreeCheckoutFacts): boolean {
    return left !== undefined && left.branch === right.branch && left.isWorktree === right.isWorktree
        && left.attention === right.attention && left.newFromSession === right.newFromSession;
}

/**
 * The tree buys summaries, not Session records or transcript detail. Exact Session placement uses
 * the existing target resolver and observed SCM root; runtime classification stays in awareness.
 * Unchanged summaries keep their identities even when a title, seq or fetchedAt changes.
 */
export function createProjectsTreeCheckoutFactsSelector(refs: readonly WorkspaceRefV1[]): ProjectsTreeCheckoutFactsSelector {
    let previous: ReadonlyMap<string, ProjectsTreeCheckoutFacts> = new Map();
    let nextWakeAtMs: number | null = null;
    const refScopes = new Set(refs.map(ref => buildWorkspaceCacheKey(ref)));
    const serverIds = new Set(refs.map(ref => ref.serverId));
    const select = (state: ProjectsTreeCheckoutFactsState, nowMs: number): ReadonlyMap<string, ProjectsTreeCheckoutFacts> => {
        const summaries = new Map<string, { attention: ProjectsTreeCheckoutFacts['attention']; hasSession: boolean; snapshot: ScmWorkingSnapshot | null }>();
        nextWakeAtMs = null;
        for (const serverId of serverIds) {
            for (const row of Object.values(state.sessionListRowsByServerId[serverId] ?? {})) {
                const direct = state.sessions[row.id];
                const metadata = direct && areServerProfileIdentifiersEquivalent(direct.serverId, serverId)
                    ? readSessionOwnerMetadataView(direct) : row.metadata;
                if (readSessionDirectoryKind(metadata) === 'managed') continue;
                const identity = resolveDisplayIdentityForSessionFromState({
                    state, serverId, sessionId: row.id, metadata, preferProvidedMetadata: true,
                });
                if (!identity.machineId || !identity.basePath) continue;
                const location = resolveSessionWorkspaceRootForMachine({
                    metadata, machineId: identity.machineId, candidatePath: identity.basePath,
                });
                const rootPath = normalizeWorkspaceRootPath(location.machinePath, metadata?.homeDir ?? undefined);
                if (!rootPath) continue;
                const target = { serverId, machineId: identity.machineId, rootPath };
                const snapshot = state.getWorkspaceScmSnapshot(target);
                const scope = { ...target, rootPath: snapshot?.repo.isRepo && snapshot.repo.rootPath ? snapshot.repo.rootPath : target.rootPath };
                const scopeKey = buildWorkspaceCacheKey(scope);
                if (!refScopes.has(scopeKey)) continue;
                const runtimeInput = { ...row, hasPendingUserMessages: (row.pendingCount ?? 0) > 0, nowMs };
                const awareness = projectUiSessionRuntimeAwareness(runtimeInput);
                const reasons = awareness.operational.reasons;
                const attention = reasons.some(reason => reason === 'permission_required' || reason === 'action_required' || reason === 'blocked_input')
                    ? 'needs-you' : awareness.working ? 'working' : null;
                const old = summaries.get(scopeKey);
                summaries.set(scopeKey, {
                    attention: old?.attention === 'needs-you' || attention === 'needs-you' ? 'needs-you'
                        : old?.attention === 'working' || attention === 'working' ? 'working' : null,
                    hasSession: true,
                    snapshot: !old?.snapshot || (snapshot && snapshot.fetchedAt > old.snapshot.fetchedAt) ? snapshot : old.snapshot,
                });
                for (const expiry of readSessionRuntimePresentationFreshnessExpirations(runtimeInput, nowMs)) {
                    nextWakeAtMs = nextWakeAtMs === null ? expiry : Math.min(nextWakeAtMs, expiry);
                }
            }
        }
        const next = new Map<string, ProjectsTreeCheckoutFacts>();
        let unchanged = previous.size === refs.length;
        for (const ref of refs) {
            const key = checkoutKey(ref);
            const summary = summaries.get(buildWorkspaceCacheKey(ref));
            const workspaceSnapshot = state.getWorkspaceScmSnapshot(ref);
            const snapshot = !workspaceSnapshot || (summary?.snapshot && summary.snapshot.fetchedAt > workspaceSnapshot.fetchedAt)
                ? summary?.snapshot ?? null : workspaceSnapshot;
            const surfaceKey = resolveProjectMobileSurfaceStorageKey({
                workspaceRefs: refs, workspaceRefId: ref.id, activeScope: state.profileScope,
                activeServerId: state.profileScope?.serverId, targetServerId: ref.serverId,
            });
            const facts: ProjectsTreeCheckoutFacts = {
                ...readScmFacts(snapshot, ref.rootPath),
                attention: summary?.attention ?? null,
                newFromSession: summary?.hasSession === true && surfaceKey !== null && ref.lastOpenedAtMs == null
                    && readRealmQualifiedMobileSurface(state.localSettings.projectLastMobileSurfaceByWorkspaceRefId, surfaceKey) === null,
            };
            const old = previous.get(key);
            const stable = sameFacts(old, facts) ? old! : facts;
            next.set(key, stable);
            if (stable !== old) unchanged = false;
        }
        if (!unchanged) previous = next;
        return previous;
    };
    return Object.assign(select, { getNextWakeAtMs: () => nextWakeAtMs });
}
