import { rebasePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';

export function resolveSessionPathWithinWorktree(params: Readonly<{
    selectedPath: string;
    worktreePath: string;
    sourceRootPath: string;
}>): string {
    return rebasePathRelativeToRoot({
        path: params.selectedPath,
        sourceRoot: params.sourceRootPath,
        targetRoot: params.worktreePath,
    }) ?? params.worktreePath;
}
