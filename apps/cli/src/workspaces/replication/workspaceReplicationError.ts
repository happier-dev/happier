export const workspaceReplicationErrorCodes = [
    'engine_initialization_failed',
    'job_not_found',
    'missing_cas_blob',
] as const;

export type WorkspaceReplicationErrorCode = (typeof workspaceReplicationErrorCodes)[number];

export class WorkspaceReplicationError extends Error {
    readonly code: WorkspaceReplicationErrorCode;

    constructor(input: Readonly<{
        code: WorkspaceReplicationErrorCode;
        message: string;
        cause?: unknown;
    }>) {
        super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
        this.name = 'WorkspaceReplicationError';
        this.code = input.code;
    }
}
