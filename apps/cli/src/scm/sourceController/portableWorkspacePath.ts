export type ScmSourceControllerPortableWorkspacePathClassification = 'portable' | 'non_portable' | 'unknown';

export type ScmSourceControllerPortableWorkspacePathRequest = Readonly<{
    relativePath: string;
}>;

export function createScmSourceControllerPortableWorkspacePathRequest(
    input: ScmSourceControllerPortableWorkspacePathRequest,
): ScmSourceControllerPortableWorkspacePathRequest {
    return {
        relativePath: input.relativePath,
    };
}

export function resolveScmSourceControllerPortableWorkspacePathRelativePath(
    input: ScmSourceControllerPortableWorkspacePathRequest,
): string {
    return input.relativePath;
}
