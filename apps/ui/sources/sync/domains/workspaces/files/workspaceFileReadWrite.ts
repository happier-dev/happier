import { workspaceWriteFile as writeWorkspaceFile, type WorkspaceWriteFileResponse } from '@/sync/ops/workspaceFileSystem/fileReadWrite';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { workspaceFileSystemTargetFromScope } from '@/sync/ops/workspaceFileSystem/workspaceTarget';

export type { WorkspaceWriteFileResponse, WorkspaceWriteFileFailureKind } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
export { classifyWorkspaceWriteFileFailure } from '@/sync/ops/workspaceFileSystem/fileReadWrite';

export async function workspaceWriteFile(params: Readonly<{
    scope: WorkspaceScopeBase;
    accountId?: string | null;
    path: string;
    content: string | Uint8Array;
    expectedHash?: string | null;
    signal?: AbortSignal | null;
    onApprovalPending?: (registration: ActionApprovalContinuation) => void;
}>): Promise<WorkspaceWriteFileResponse> {
    return await writeWorkspaceFile(
        workspaceFileSystemTargetFromScope(params.scope),
        params.path,
        params.content,
        params.expectedHash,
        { signal: params.signal, accountId: params.accountId, onApprovalPending: params.onApprovalPending },
    );
}
