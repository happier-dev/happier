export type ScmWorkspaceIntegrationPortableWorkspacePathClassification = 'portable' | 'non_portable' | 'unknown';

export type ScmWorkspaceIntegrationPortableWorkspacePathRequest = Readonly<{
    relativePath: string;
}>;

export function createScmWorkspaceIntegrationPortableWorkspacePathRequest(
    input: ScmWorkspaceIntegrationPortableWorkspacePathRequest,
): ScmWorkspaceIntegrationPortableWorkspacePathRequest {
    return {
        relativePath: input.relativePath,
    };
}

export function resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath(
    input: ScmWorkspaceIntegrationPortableWorkspacePathRequest,
): string {
    return input.relativePath;
}
