import type { ScmWorkingSnapshot as ProtocolScmWorkingSnapshot } from '@happier-dev/protocol';

import type { ScmCapabilities, ScmStatus, ScmWorkingSnapshot as UiScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sessionScmStatusSnapshot } from '@/sync/ops';
import { createProjectKey } from '@/sync/runtime/orchestration/projectManager';
import { resolveProjectMachineScopeId } from '@/sync/runtime/orchestration/projectManager';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import {
    EMPTY_SCM_CAPABILITIES,
    mapProtocolSnapshotToUiSnapshot,
    mergeScmCapabilities,
} from '@/scm/core/snapshotMappers';

function isProtocolScmSnapshot(
    snapshot: UiScmWorkingSnapshot | ProtocolScmWorkingSnapshot
): snapshot is ProtocolScmWorkingSnapshot {
    const repo = (snapshot as ProtocolScmWorkingSnapshot).repo as ProtocolScmWorkingSnapshot['repo'] | undefined;
    return Boolean(repo && typeof repo === 'object' && 'isRepo' in repo);
}

export function normalizeWorkingSnapshotForUi(
    snapshot: UiScmWorkingSnapshot | ProtocolScmWorkingSnapshot,
    projectKey: string
): UiScmWorkingSnapshot {
    if (!isProtocolScmSnapshot(snapshot)) {
        const backendId = snapshot.repo.backendId ?? null;
        const capabilities = mergeScmCapabilities(snapshot.capabilities ?? {});
        return {
            ...snapshot,
            projectKey: snapshot.projectKey || projectKey,
            repo: {
                ...snapshot.repo,
                backendId,
                mode: snapshot.repo.mode ?? null,
            },
            capabilities,
        };
    }

    return mapProtocolSnapshotToUiSnapshot(snapshot, projectKey);
}

function createEmptyScmSnapshot(input: {
    projectKey: string;
    fetchedAt?: number;
    rootPath?: string | null;
}): UiScmWorkingSnapshot {
    return {
        projectKey: input.projectKey,
        fetchedAt: input.fetchedAt ?? Date.now(),
        repo: { isRepo: false, rootPath: input.rootPath ?? null, backendId: null, mode: null },
        capabilities: EMPTY_SCM_CAPABILITIES,
        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

export function snapshotToScmStatus(snapshot: UiScmWorkingSnapshot): ScmStatus {
    const modifiedCount = snapshot.entries.filter((entry) => entry.kind !== 'untracked').length;
    const untrackedCount = snapshot.entries.filter((entry) => entry.kind === 'untracked').length;
    const includedCount = snapshot.totals.includedFiles;
    const includedLinesAdded = snapshot.totals.includedAdded;
    const includedLinesRemoved = snapshot.totals.includedRemoved;
    const pendingLinesAdded = snapshot.totals.pendingAdded;
    const pendingLinesRemoved = snapshot.totals.pendingRemoved;
    const linesAdded = includedLinesAdded + pendingLinesAdded;
    const linesRemoved = includedLinesRemoved + pendingLinesRemoved;

    return {
        branch: snapshot.branch.head,
        isDirty: snapshot.entries.length > 0,
        modifiedCount,
        untrackedCount,
        includedCount,
        lastUpdatedAt: snapshot.fetchedAt,
        includedLinesAdded,
        includedLinesRemoved,
        pendingLinesAdded,
        pendingLinesRemoved,
        linesAdded,
        linesRemoved,
        linesChanged: linesAdded + linesRemoved,
        upstreamBranch: snapshot.branch.upstream,
        aheadCount: snapshot.branch.ahead,
        behindCount: snapshot.branch.behind,
        stashCount: snapshot.stashCount,
    };
}

export class ScmRepositoryService {
    async fetchSnapshotForSession(sessionId: string): Promise<UiScmWorkingSnapshot | null> {
        const state = storage.getState();
        const session = state.sessions[sessionId];
        if (!session?.metadata?.path) return null;

        const machineHomeDir = session.metadata.machineId
            ? state.machines?.[session.metadata.machineId]?.metadata?.homeDir
            : undefined;
        const resolvedSessionPath = resolveAbsolutePath(
            session.metadata.path,
            session.metadata.homeDir ?? machineHomeDir
        );
        const projectKey = createProjectKey(
            resolveProjectMachineScopeId(session.metadata),
            resolvedSessionPath
        );
        const projectKeyString = `${projectKey.machineId}:${projectKey.path}`;
        const fetchedAt = Date.now();

        // Session SCM RPC runs within the session working directory already. Passing an absolute
        // `cwd` is both redundant and brittle (tilde paths, symlink differences, etc.) because
        // the CLI security layer resolves `cwd` relative to the working directory.
        const response = await sessionScmStatusSnapshot(sessionId, {});
        if (
            !response
            || typeof response !== 'object'
            || typeof (response as { success?: unknown }).success !== 'boolean'
        ) {
            throw new Error('Invalid source-control status snapshot response');
        }
        if (!response.success) {
            const message = response.error || 'Failed to fetch source-control status snapshot';
            const err = new Error(message) as Error & { scmErrorCode?: string };
            if (typeof (response as { errorCode?: unknown }).errorCode === 'string') {
                err.scmErrorCode = (response as { errorCode?: string }).errorCode;
            }
            throw err;
        }

        if (!response.snapshot) {
            return createEmptyScmSnapshot({
                projectKey: projectKeyString,
                fetchedAt,
                rootPath: null,
            });
        }

        return normalizeWorkingSnapshotForUi(response.snapshot, projectKeyString);
    }
}

export const scmRepositoryService = new ScmRepositoryService();
