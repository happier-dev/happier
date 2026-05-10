export function buildNonPortableWorkspacePathError(relativePath: string): Error {
    return new Error(`Workspace transfer contains non-portable workspace path: ${relativePath}`);
}

export class WorkspaceTransferSourcePathError extends Error {
    public readonly code = 'source_path_unreadable';
    public readonly sourcePath: string;

    public constructor(params: Readonly<{
        sourcePath: string;
        cause: unknown;
    }>) {
        super(`Workspace transfer source path is not readable: ${params.sourcePath}`, {
            cause: params.cause,
        });
        this.name = 'WorkspaceTransferSourcePathError';
        this.sourcePath = params.sourcePath;
    }
}
