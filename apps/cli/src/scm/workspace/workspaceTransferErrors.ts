export function buildNonPortableWorkspacePathError(relativePath: string): Error {
    return new Error(`Workspace transfer contains non-portable workspace path: ${relativePath}`);
}

/** A selected repository boundary cannot be returned without its own ignore policy. */
export class WorkspaceTransferUnsupportedPathError extends Error {
    public readonly code = 'workspace_file_unsupported';

    public constructor(public readonly path: string) {
        super(`Nested repository ${path} requires a manual file return`);
        this.name = 'WorkspaceTransferUnsupportedPathError';
    }
}

export function readWorkspaceTransferUnsupportedPath(error: unknown): string | undefined {
    return error instanceof WorkspaceTransferUnsupportedPathError ? error.path : undefined;
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
