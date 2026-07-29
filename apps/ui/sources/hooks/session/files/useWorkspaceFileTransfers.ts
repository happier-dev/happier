import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import {
    buildUploadEntryPlan as buildWorkspaceUploadEntryPlan,
    useWorkspaceFileTransfers as useWorkspaceFileTransfersImpl,
    type UploadConflictStrategy,
    type WorkspaceDownloadState,
    type WorkspaceTransferResult,
    type WorkspaceUploadEntry,
    type WorkspaceUploadState,
} from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';

export type { WorkspaceUploadEntry, UploadConflictStrategy, WorkspaceUploadState, WorkspaceDownloadState };

export async function buildUploadEntryPlan(input: Readonly<{
    sessionId: string;
    entries: readonly WorkspaceUploadEntry[];
    destinationDir: string;
    onResolveConflicts?: ((params: Readonly<{ conflictCount: number; totalCount: number }>) => Promise<UploadConflictStrategy>) | null;
}>): Promise<{ ok: true; tasks: Array<{ entry: WorkspaceUploadEntry; targetPath: string; overwrite: boolean; sizeBytes: number }> } | { ok: false; error: string }> {
    return await buildWorkspaceUploadEntryPlan({
        workspaceScope: resolveWorkspaceScopeForSession(input.sessionId),
        entries: input.entries,
        destinationDir: input.destinationDir,
        onResolveConflicts: input.onResolveConflicts ?? null,
    });
}

export function useWorkspaceFileTransfers(params: Readonly<{
    sessionId: string;
    maxConcurrentUploads?: number;
    onResolveUploadConflicts?: ((params: Readonly<{ conflictCount: number; totalCount: number }>) => Promise<UploadConflictStrategy>) | null;
    onAfterUploadSuccess?: (() => void) | null;
}>): Readonly<{
    uploadState: WorkspaceUploadState;
    downloadState: WorkspaceDownloadState;
    startUploads: (input: Readonly<{ entries: readonly WorkspaceUploadEntry[]; destinationDir: string }>) => Promise<WorkspaceTransferResult>;
    cancelUploads: () => void;
    startDownload: (input: Readonly<{ path: string; asZip: boolean }>) => Promise<WorkspaceTransferResult>;
    cancelDownload: () => void;
}> {
    const workspaceScope = resolveWorkspaceScopeForSession(params.sessionId);
    return useWorkspaceFileTransfersImpl({
        workspaceScope,
        maxConcurrentUploads: params.maxConcurrentUploads,
        onResolveUploadConflicts: params.onResolveUploadConflicts ?? null,
        onAfterUploadSuccess: params.onAfterUploadSuccess ?? null,
    });
}
