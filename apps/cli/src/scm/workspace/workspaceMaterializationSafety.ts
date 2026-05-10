import { isAbsolute, join, resolve, dirname } from 'node:path';

import { resolveWorkspaceRelativePath } from './workspaceExportPackaging/resolveWorkspaceRelativePath';

export function resolveContainedWorkspaceMaterializationPath(params: Readonly<{
    workspaceRoot: string;
    candidatePath: string;
    errorMessage: string;
}>): string {
    const resolvedPath = resolveWorkspaceRelativePath({
        workspaceRoot: params.workspaceRoot,
        candidatePath: params.candidatePath,
    });
    if (!resolvedPath.ok) {
        throw new Error(params.errorMessage);
    }
    return join(resolve(params.workspaceRoot), resolvedPath.relativePath);
}

export function assertWorkspaceMaterializationSymlinkTarget(params: Readonly<{
    workspaceRoot: string;
    linkPath: string;
    target: string;
}>): void {
    if (!params.target || isAbsolute(params.target)) {
        throw new Error(`Workspace transfer symlink target escapes target: ${params.target}`);
    }
    resolveContainedWorkspaceMaterializationPath({
        workspaceRoot: params.workspaceRoot,
        candidatePath: resolve(dirname(params.linkPath), params.target),
        errorMessage: `Workspace transfer symlink target escapes target: ${params.target}`,
    });
}
