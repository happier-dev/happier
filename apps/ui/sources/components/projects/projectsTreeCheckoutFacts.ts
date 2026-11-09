import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import type { StorageState } from '@/sync/store/types';
import { areSessionMachineTargetInputsEqual, resolveDisplayIdentityForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    readSessionRuntimePresentationFreshnessExpirations,
} from '@/sync/domains/session/attention/runtimePresentation';
import { resolveInboxItemAttentionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { resolveProjectMobileSurfaceStorageKeys } from '@/sync/domains/settings/mobileSurfacePersistence';
import { projectLastMobileSurfaceState } from '@/sync/domains/state/navigationUiState';
import { buildWorkspaceCacheKey, normalizeWorkspaceRootPath } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { projectsTreeCheckoutKey, type ProjectsTreeCheckoutFacts } from './projectsTreeRows';

export type ProjectsTreeCheckoutFactsState = Pick<StorageState,
    'sessions' | 'sessionListRowsByServerId' | 'sessionListRenderableDelta' | 'machines' | 'machineListByServerId' | 'machineListStatusByServerId' | 'profileScope' | 'getWorkspaceScmSnapshot'
>;

export type ProjectsTreeCheckoutFactsSelector = {
    (state: ProjectsTreeCheckoutFactsState, nowMs: number, change?: ProjectsTreeCheckoutFactsChange): ReadonlyMap<string, ProjectsTreeCheckoutFacts>;
    getNextWakeAtMs(): number | null;
    getScmScopeKeys(): ReadonlySet<string>;
};

export type ProjectsTreeCheckoutFactsChange = Readonly<{
    reset?: boolean;
    scmScopeKey?: string;
    mobileSurfaceKey?: string;
}>;

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
    let previousState: ProjectsTreeCheckoutFactsState | null = null;
    let previousNowMs: number | null = null;
    let previousRevision: number | null = null;
    let nextWakeAtMs: number | null = null;
    const checkoutsByScope = new Map<string, { ref: WorkspaceRefV1; key: string; index: number }[]>();
    refs.forEach((ref, index) => {
        const scope = buildWorkspaceCacheKey(ref);
        let checkouts = checkoutsByScope.get(scope);
        if (!checkouts) checkoutsByScope.set(scope, checkouts = []);
        checkouts.push({ ref, key: checkoutKey(ref), index });
    });
    const scmScopeKeys = new Set(checkoutsByScope.keys());
    const serverIds = [...new Set(refs.map(ref => ref.serverId))];
    let mobileSurfaceKeys: readonly (string | null)[] = [];
    const scopesByMobileSurfaceKey = new Map<string, Set<string>>();
    // Retain input paths even outside saved checkouts: a later SCM discovery can
    // attribute these Sessions to a displayed repository without a census rebuild.
    const placementByAddress = new Map<string, { serverId: string; sessionId: string; machineId: string; rootPath: string; inputScopeKey: string; scopeKey: string }>();
    const addressesByInputScope = new Map<string, Set<string>>();
    const membersByScope = new Map<string, Set<string>>();
    const wakeAtByScope = new Map<string, number>();

    const removePlacement = (address: string, affected: Set<string>) => {
        const old = placementByAddress.get(address);
        if (!old) return;
        const members = membersByScope.get(old.scopeKey);
        members?.delete(address);
        if (members?.size === 0) membersByScope.delete(old.scopeKey);
        placementByAddress.delete(address);
        const inputs = addressesByInputScope.get(old.inputScopeKey);
        inputs?.delete(address);
        if (inputs?.size === 0) {
            addressesByInputScope.delete(old.inputScopeKey);
            if (!checkoutsByScope.has(old.inputScopeKey)) scmScopeKeys.delete(old.inputScopeKey);
        }
        if (checkoutsByScope.has(old.scopeKey)) affected.add(old.scopeKey);
    };

    const place = (state: ProjectsTreeCheckoutFactsState, serverId: string, sessionId: string, affected: Set<string>) => {
        const address = JSON.stringify([serverId, sessionId]);
        removePlacement(address, affected);
        const row = state.sessionListRowsByServerId[serverId]?.[sessionId];
        if (!row) return;
        const direct = state.sessions[sessionId];
        const metadata = direct && areServerProfileIdentifiersEquivalent(direct.serverId, serverId)
            ? readSessionOwnerMetadataView(direct) : row.metadata;
        if (readSessionDirectoryKind(metadata) === 'managed') return;
        const identity = resolveDisplayIdentityForSessionFromState({
            state, serverId, sessionId, metadata, preferProvidedMetadata: true,
        });
        if (!identity.machineId || !identity.basePath) return;
        const location = resolveSessionWorkspaceRootForMachine({
            metadata, machineId: identity.machineId, candidatePath: identity.basePath,
        });
        const rootPath = normalizeWorkspaceRootPath(location.machinePath, metadata?.homeDir ?? undefined);
        if (!rootPath) return;
        const target = { serverId, machineId: identity.machineId, rootPath };
        const snapshot = state.getWorkspaceScmSnapshot(target);
        const scopeKey = buildWorkspaceCacheKey({ ...target,
            rootPath: snapshot?.repo.isRepo && snapshot.repo.rootPath ? snapshot.repo.rootPath : rootPath });
        const inputScopeKey = buildWorkspaceCacheKey(target);
        placementByAddress.set(address, { ...target, sessionId, inputScopeKey, scopeKey });
        let inputs = addressesByInputScope.get(inputScopeKey);
        if (!inputs) addressesByInputScope.set(inputScopeKey, inputs = new Set());
        inputs.add(address);
        scmScopeKeys.add(inputScopeKey);
        if (!checkoutsByScope.has(scopeKey)) return;
        let members = membersByScope.get(scopeKey);
        if (!members) membersByScope.set(scopeKey, members = new Set());
        members.add(address);
        affected.add(scopeKey);
    };

    const select = (state: ProjectsTreeCheckoutFactsState, nowMs: number, change: ProjectsTreeCheckoutFactsChange = {}): ReadonlyMap<string, ProjectsTreeCheckoutFacts> => {
        if (change.reset || previousState === null || previousState.profileScope !== state.profileScope) {
            mobileSurfaceKeys = resolveProjectMobileSurfaceStorageKeys({
                workspaceRefs: refs, activeScope: state.profileScope, activeServerId: state.profileScope?.serverId,
            });
            scopesByMobileSurfaceKey.clear();
            for (const [scope, checkouts] of checkoutsByScope) for (const { index } of checkouts) {
                const key = mobileSurfaceKeys[index];
                if (!key) continue;
                let scopes = scopesByMobileSurfaceKey.get(key);
                if (!scopes) scopesByMobileSurfaceKey.set(key, scopes = new Set());
                scopes.add(scope);
            }
        }
        const affected = new Set<string>();
        const delta = state.sessionListRenderableDelta;
        // A different Home's arrivals do not change this tree's placement inputs.
        const rowsChanged = serverIds.some(serverId => previousState?.sessionListRowsByServerId[serverId] !== state.sessionListRowsByServerId[serverId])
            || previousState?.sessions !== state.sessions;
        const canApplyDelta = previousRevision !== null && delta.revision === previousRevision + 1;
        // Placement reads only the Machine facts its target resolver names; heartbeats and daemon
        // publications replace Machine records without moving any Session.
        const rebuild = change.reset || previousState === null
            || !areSessionMachineTargetInputsEqual(previousState.machines, state.machines)
            || serverIds.some(serverId => !areSessionMachineTargetInputsEqual(previousState?.machineListByServerId[serverId], state.machineListByServerId[serverId])
                || previousState?.machineListStatusByServerId[serverId] !== state.machineListStatusByServerId[serverId])
            || previousState.profileScope !== state.profileScope
            || previousState.getWorkspaceScmSnapshot !== state.getWorkspaceScmSnapshot
            || previousNowMs !== null && nowMs < previousNowMs
            // A published delta lists every changed row; an index rebuild alone moves no placement.
            || rowsChanged && !canApplyDelta;
        if (rebuild) {
            placementByAddress.clear();
            membersByScope.clear();
            addressesByInputScope.clear();
            scmScopeKeys.clear();
            wakeAtByScope.clear();
            nextWakeAtMs = null;
            for (const scope of checkoutsByScope.keys()) {
                affected.add(scope);
                scmScopeKeys.add(scope);
            }
            for (const serverId of serverIds) {
                for (const sessionId of Object.keys(state.sessionListRowsByServerId[serverId] ?? {})) place(state, serverId, sessionId, affected);
            }
        } else if (canApplyDelta) {
            for (const serverId of serverIds) {
                for (const sessionId of delta.removedSessionIds) place(state, serverId, sessionId, affected);
                for (const sessionId of delta.changedSessionIds) place(state, serverId, sessionId, affected);
                for (const sessionId of delta.hydratedSessionIds ?? []) place(state, serverId, sessionId, affected);
            }
        }
        if (!rebuild && change.scmScopeKey) {
            if (checkoutsByScope.has(change.scmScopeKey)) affected.add(change.scmScopeKey);
            for (const address of [...addressesByInputScope.get(change.scmScopeKey) ?? []]) {
                const placement = placementByAddress.get(address)!;
                place(state, placement.serverId, placement.sessionId, affected);
            }
        }
        if (change.mobileSurfaceKey) for (const scope of scopesByMobileSurfaceKey.get(change.mobileSurfaceKey) ?? []) affected.add(scope);
        if (nextWakeAtMs !== null && nextWakeAtMs <= nowMs) {
            for (const [scope, wakeAt] of wakeAtByScope) if (wakeAt <= nowMs) affected.add(scope);
        }
        let next: Map<string, ProjectsTreeCheckoutFacts> | null = null;
        let earliestWakeInvalidated = false;
        for (const scope of affected) for (const { ref, key, index } of checkoutsByScope.get(scope) ?? []) {
            const old = previous.get(key);
            let attention: ProjectsTreeCheckoutFacts['attention'] = null;
            let memberSnapshot: ScmWorkingSnapshot | null = null;
            let scopeWakeAtMs: number | null = null;
            for (const address of membersByScope.get(scope) ?? []) {
                const placement = placementByAddress.get(address)!;
                const row = state.sessionListRowsByServerId[placement.serverId]?.[placement.sessionId];
                if (!row) continue;
                const runtimeInput = { ...row, hasPendingUserMessages: (row.pendingCount ?? 0) > 0, nowMs };
                const status = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(
                    row.serverId === placement.serverId ? row : { ...row, serverId: placement.serverId }, nowMs,
                ) });
                const memberAttention = status.attentionType && resolveInboxItemAttentionV1(status.attentionType).interrupt
                    ? 'needs-you' : status.bucket === 'working' ? 'working' : null;
                if (memberAttention === 'needs-you' || attention !== 'needs-you' && memberAttention === 'working') attention = memberAttention;
                const snapshot = state.getWorkspaceScmSnapshot(placement);
                if (snapshot && (!memberSnapshot || snapshot.fetchedAt > memberSnapshot.fetchedAt)) memberSnapshot = snapshot;
                for (const expiry of readSessionRuntimePresentationFreshnessExpirations(runtimeInput, nowMs)) {
                    scopeWakeAtMs = Math.min(scopeWakeAtMs ?? Infinity, expiry);
                }
            }
            const oldWakeAtMs = wakeAtByScope.get(scope) ?? null;
            if (oldWakeAtMs !== scopeWakeAtMs) {
                if (oldWakeAtMs !== null && oldWakeAtMs === nextWakeAtMs) earliestWakeInvalidated = true;
                if (scopeWakeAtMs === null) wakeAtByScope.delete(scope);
                else {
                    wakeAtByScope.set(scope, scopeWakeAtMs);
                    nextWakeAtMs = Math.min(nextWakeAtMs ?? Infinity, scopeWakeAtMs);
                }
            }
            const workspaceSnapshot = state.getWorkspaceScmSnapshot(ref);
            const snapshot = !workspaceSnapshot || (memberSnapshot && memberSnapshot.fetchedAt > workspaceSnapshot.fetchedAt)
                ? memberSnapshot : workspaceSnapshot;
            const surfaceKey = mobileSurfaceKeys[index];
            const facts: ProjectsTreeCheckoutFacts = {
                ...readScmFacts(snapshot, ref.rootPath),
                attention,
                newFromSession: (membersByScope.get(scope)?.size ?? 0) > 0 && surfaceKey !== null && ref.lastOpenedAtMs == null
                    && (surfaceKey ? projectLastMobileSurfaceState.read(surfaceKey) ?? null : null) === null,
            };
            if (!sameFacts(old, facts)) {
                next ??= new Map(previous);
                next.set(key, facts);
            }
        }
        if (next) previous = next;
        if (earliestWakeInvalidated) {
            nextWakeAtMs = null;
            for (const wakeAt of wakeAtByScope.values()) nextWakeAtMs = Math.min(nextWakeAtMs ?? Infinity, wakeAt);
        }
        previousState = { sessions: state.sessions, sessionListRowsByServerId: state.sessionListRowsByServerId,
            sessionListRenderableDelta: state.sessionListRenderableDelta, machines: state.machines,
            machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId, profileScope: state.profileScope,
            getWorkspaceScmSnapshot: state.getWorkspaceScmSnapshot };
        previousNowMs = nowMs;
        previousRevision = delta.revision;
        return previous;
    };
    return Object.assign(select, { getNextWakeAtMs: () => nextWakeAtMs, getScmScopeKeys: () => scmScopeKeys });
}
