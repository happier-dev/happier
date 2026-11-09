import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { WorkspaceFileOpenOptions, WorkspaceFileOpenTarget } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { isAbsoluteLocalPath, normalizeLocalPathForComparison, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';

export function resolveReviewCommentFileOpen(comment: Pick<ReviewCommentV1, 'anchor' | 'workspace'>, context: Readonly<{
    serverId?: string;
    sessionId?: string;
    workspaceRefId?: string;
    workspace?: Readonly<{ machineId: string; path: string }>;
}>): Readonly<{ target: WorkspaceFileOpenTarget; options: WorkspaceFileOpenOptions }> | null {
    if (!context.serverId || !('filePath' in comment.anchor)) return null;
    const workspace = comment.workspace ?? context.workspace;
    const rawPath = comment.anchor.filePath;
    const normalized = normalizeLocalPathForComparison(rawPath);
    const path = normalized && isAbsoluteLocalPath(normalized)
        ? workspace ? resolvePathRelativeToRoot({ path: rawPath, root: workspace.path, preservePathSpelling: true }) : null
        : rawPath;
    if (!path || !isSafeWorkspaceRelativePath(path)) return null;
    const target: WorkspaceFileOpenTarget | null = context.sessionId
        ? { kind: 'session', sessionId: context.sessionId, serverId: context.serverId, path }
        : context.workspaceRefId && workspace
            ? { kind: 'project', workspaceRefId: context.workspaceRefId, serverId: context.serverId,
                machineId: workspace.machineId, rootPath: workspace.path, path }
            : null;
    if (!target) return null;
    const anchor = comment.anchor.kind === 'line' || comment.anchor.kind === 'range'
        ? { ...comment.anchor, filePath: path } : undefined;
    return { target, options: { view: 'changes', ...(anchor ? { anchor, anchorSource: 'diff' } : {}) } };
}
