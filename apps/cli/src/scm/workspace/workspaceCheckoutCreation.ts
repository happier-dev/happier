export type ScmWorkspaceIntegrationWorkspaceCheckoutKind = 'git_worktree';

export type ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    sourcePath: string;
    displayName: string;
    baseRef: string | null;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    targetPath: string;
}>;

export function createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest(input: Readonly<{
    sourcePath: string;
    checkoutCreation: Readonly<{
        kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
        displayName: string;
        baseRef?: string | null;
    }>;
}>): ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest {
    return {
        kind: input.checkoutCreation.kind,
        sourcePath: input.sourcePath,
        displayName: input.checkoutCreation.displayName,
        baseRef: input.checkoutCreation.baseRef ?? null,
    };
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationKind(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
): ScmWorkspaceIntegrationWorkspaceCheckoutKind {
    return input.kind;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationSourcePath(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
): string {
    return input.sourcePath;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationDisplayName(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
): string {
    return input.displayName;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationBaseRef(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
): string | null {
    return input.baseRef;
}
