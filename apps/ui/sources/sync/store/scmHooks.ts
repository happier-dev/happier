import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { getStorage } from '@/sync/domains/state/storageStore';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveSessionScmScopeFromState } from './domains/managedSessionScmScope';
import type { StorageState } from './types';
import { readScmSnapshotCounts, retainScmEntriesDemand, type ScmEntriesDemandSlot } from '@/scm/refresh/scmEntriesDemand';
import { scmStatusSync } from '@/scm/scmStatusSync';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/** SCM facts are owned and published by ProjectManager, independently of Zustand state. */
function useScmValue<T>(scope: WorkspaceScopeBase | null, read: (state: StorageState) => T): T {
    const store = getStorage();
    const key = scope ? tryBuildWorkspaceCacheKey(scope) : null;
    const subscribe = React.useCallback((listener: () => void) =>
        projectManager.subscribeScmSnapshots(listener, new Set(key ? [key] : [])), [key]);
    const select = useShallow(read);
    const getSnapshot = () => select(store.getState());
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useSessionScmValue<T>(sessionId: string | null, serverId: string | null | undefined,
    read: (state: StorageState) => T): T {
    const scope = getStorage()(useShallow(state => {
        if (!sessionId) return null;
        return resolveSessionScmScopeFromState(state, sessionId, serverId)
            ?? (serverId == null ? state.getProjectForSession(sessionId)?.key ?? null : null);
    }));
    return useScmValue(scope, read);
}

function useProjectScmValue<T>(projectId: string | null, read: (state: StorageState) => T): T {
    const scope = getStorage()(useShallow(state => projectId ? state.getProject(projectId)?.key ?? null : null));
    return useScmValue(scope, read);
}

export function useProjectScmStatus(projectId: string | null) {
    return useProjectScmValue(projectId, state => projectId ? state.getProjectScmStatus(projectId) : null);
}

export function useProjectScmSnapshot(projectId: string | null) {
    return useProjectScmValue(projectId, state => projectId ? state.getProjectScmSnapshot(projectId) : null);
}

export function useSessionProjectScmStatus(sessionId: string | null, serverId?: string | null) {
    return useSessionScmValue(sessionId, serverId, state => sessionId ? state.getSessionProjectScmStatus(sessionId, serverId) : null);
}

/**
 * The Session's working snapshot with its changed-file list. Presenting this is list demand: the
 * repository refreshes with entries while presented. Mounted keeps the rows, also hidden; closing
 * releases them. A summary delivery reads as the rows this consumer last had or, with none, as not
 * yet loaded (null), never as a clean working copy. Readers of counts, branch or root use the
 * summary hooks.
 */
export function useSessionProjectScmSnapshot(sessionId: string | null, serverId?: string | null) {
    useScmEntriesDemand(sessionId ? readSessionEntriesDemandSlot(sessionId, serverId) : null, useLayoutPresentationActive());
    const snapshot = useSessionScmValue(sessionId, serverId, state => sessionId ? state.getSessionProjectScmSnapshot(sessionId, serverId) : null);
    return useHeldScmList(sessionId ? `${serverId ?? ''}:${sessionId}` : null, snapshot);
}

/** Counts, branch and repository facts (composer instrument, badges, summaries): no list demand. */
export function useSessionProjectScmSummarySnapshot(sessionId: string | null, serverId?: string | null) {
    return useSessionScmValue(sessionId, serverId, state => {
        const snapshot = sessionId ? state.getSessionProjectScmSnapshot(sessionId, serverId) : null;
        return snapshot ? readScmSnapshotCounts(snapshot) : null;
    });
}

function readSessionEntriesDemandSlot(sessionId: string, serverId: string | null | undefined): ScmEntriesDemandSlot {
    const scope = resolveSessionScmScopeFromState(getStorage().getState(), sessionId, serverId);
    return scope ? { kind: 'workspace', scope } : { kind: 'session', sessionId };
}

function useScmEntriesDemand(slot: ScmEntriesDemandSlot | null, presented: boolean): void {
    const key = slot ? (slot.kind === 'session' ? `session:${slot.sessionId}` : tryBuildWorkspaceCacheKey(slot.scope)) : null;
    const slotRef = React.useRef(slot);
    slotRef.current = slot;
    React.useEffect(() => {
        const current = slotRef.current;
        return key && current ? scmStatusSync.retainEntriesHold(current) : undefined;
    }, [key]);
    React.useEffect(() => {
        const current = slotRef.current;
        return key && presented && current ? retainScmEntriesDemand(current) : undefined;
    }, [key, presented]);
}

/** The rows this consumer last had, for a slot that now holds only counts; a different slot starts empty. */
function useHeldScmList(slotKey: string | null, snapshot: ScmWorkingSnapshot | null | undefined): ScmWorkingSnapshot | null {
    const held = React.useRef<Readonly<{ slotKey: string | null; list: ScmWorkingSnapshot | null }>>({ slotKey, list: null });
    if (held.current.slotKey !== slotKey || !snapshot) held.current = { slotKey, list: null };
    if (snapshot && !snapshot.detail) held.current = { slotKey, list: snapshot };
    return held.current.list;
}

/** File bases observe the repository root without subscribing to every file delta. */
export function useSessionProjectScmRootPath(sessionId: string | null, serverId?: string | null): string | undefined {
    return useSessionScmValue(sessionId, serverId, state => sessionId ? state.getSessionProjectScmSnapshot(sessionId, serverId)?.repo.rootPath ?? undefined : undefined);
}

/** Repository admission is a scalar subscription even while the full snapshot changes. */
export function useSessionProjectScmIsRepo(sessionId: string | null, serverId?: string | null): boolean | null {
    return useSessionScmValue(sessionId, serverId, state => {
        const snapshot = sessionId ? state.getSessionProjectScmSnapshot(sessionId, serverId) : null;
        return snapshot ? snapshot.repo.isRepo === true : null;
    });
}

export function useSessionProjectScmSnapshotError(sessionId: string | null, serverId?: string | null) {
    return useSessionScmValue(sessionId, serverId, state => sessionId ? state.getSessionProjectScmSnapshotError(sessionId, serverId) : null);
}

export function useWorkspaceScmStatus(scope: WorkspaceScopeBase | null) {
    return useScmValue(scope, state => scope ? state.getWorkspaceScmStatus(scope) : null);
}

/** The workspace snapshot with its changed-file list; presenting it is list demand (see the Session hook). */
export function useWorkspaceScmSnapshot(scope: WorkspaceScopeBase | null) {
    useScmEntriesDemand(scope ? { kind: 'workspace', scope } : null, useLayoutPresentationActive());
    const snapshot = useScmValue(scope, state => scope ? state.getWorkspaceScmSnapshot(scope) : null);
    return useHeldScmList(scope ? tryBuildWorkspaceCacheKey(scope) : null, snapshot);
}

/** Counts, branch and repository facts of a workspace (headers, Checkouts): no list demand. */
export function useWorkspaceScmSummarySnapshot(scope: WorkspaceScopeBase | null) {
    return useScmValue(scope, state => {
        const snapshot = scope ? state.getWorkspaceScmSnapshot(scope) : null;
        return snapshot ? readScmSnapshotCounts(snapshot) : null;
    });
}

/** This workspace's slot holds counts where a presented list consumer needs its rows. */
export function useWorkspaceScmSlotLacksList(scope: WorkspaceScopeBase | null): boolean {
    return useScmValue(scope, state => Boolean(scope && state.getWorkspaceScmSnapshot(scope)?.detail));
}

export function useWorkspaceScmSnapshotError(scope: WorkspaceScopeBase | null) {
    return useScmValue(scope, state => scope ? state.getWorkspaceScmSnapshotError(scope) : null);
}

export function useWorkspaceScmCommitSelectionPaths(scope: WorkspaceScopeBase | null) {
    return useScmValue(scope, state => scope ? state.getWorkspaceScmCommitSelectionPaths(scope) : []);
}

export function useWorkspaceScmCommitSelectionPatches(scope: WorkspaceScopeBase | null) {
    return useScmValue(scope, state => scope ? state.getWorkspaceScmCommitSelectionPatches(scope) : []);
}

export function useWorkspaceScmOperationLog(scope: WorkspaceScopeBase | null) {
    return useScmValue(scope, state => scope ? state.getWorkspaceScmOperationLog(scope) : []);
}

export function useWorkspaceScmInFlightOperation(scope: WorkspaceScopeBase | null) {
    return useScmValue(scope, state => scope ? state.getWorkspaceScmInFlightOperation(scope) : null);
}

export function useSessionProjectScmCommitSelectionPaths(sessionId: string | null, serverId?: string | null) {
    return useSessionScmValue(sessionId, serverId, state => sessionId ? state.getSessionProjectScmCommitSelectionPaths(sessionId, serverId) : []);
}

export function useSessionProjectScmCommitSelectionPatches(sessionId: string | null, serverId?: string | null) {
    return useSessionScmValue(sessionId, serverId, state => sessionId ? state.getSessionProjectScmCommitSelectionPatches(sessionId, serverId) : []);
}

export function useSessionProjectScmOperationLog(sessionId: string | null, serverId?: string | null) {
    return useSessionScmValue(sessionId, serverId, state => sessionId ? state.getSessionProjectScmOperationLog(sessionId, serverId) : []);
}

export function useSessionProjectScmInFlightOperation(sessionId: string | null, serverId?: string | null) {
    return useSessionScmValue(sessionId, serverId, state => sessionId ? state.getSessionProjectScmInFlightOperation(sessionId, serverId) : null);
}
