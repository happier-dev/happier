export type ScmSourceControllerWorkspaceCheckoutKind = 'git_worktree';

export type ScmSourceControllerWorkspaceCheckoutCreationRequest = Readonly<{
    kind: ScmSourceControllerWorkspaceCheckoutKind;
    sourcePath: string;
    displayName: string;
    baseRef: string | null;
}>;

export type ScmSourceControllerWorkspaceCheckoutCreationResult = Readonly<{
    kind: ScmSourceControllerWorkspaceCheckoutKind;
    targetPath: string;
}>;

export function createScmSourceControllerWorkspaceCheckoutCreationRequest(input: Readonly<{
    sourcePath: string;
    checkoutCreation: Readonly<{
        kind: ScmSourceControllerWorkspaceCheckoutKind;
        displayName: string;
        baseRef?: string | null;
    }>;
}>): ScmSourceControllerWorkspaceCheckoutCreationRequest {
    return {
        kind: input.checkoutCreation.kind,
        sourcePath: input.sourcePath,
        displayName: input.checkoutCreation.displayName,
        baseRef: input.checkoutCreation.baseRef ?? null,
    };
}

export function resolveScmSourceControllerWorkspaceCheckoutCreationKind(
    input: ScmSourceControllerWorkspaceCheckoutCreationRequest,
): ScmSourceControllerWorkspaceCheckoutKind {
    return input.kind;
}

export function resolveScmSourceControllerWorkspaceCheckoutCreationSourcePath(
    input: ScmSourceControllerWorkspaceCheckoutCreationRequest,
): string {
    return input.sourcePath;
}

export function resolveScmSourceControllerWorkspaceCheckoutCreationDisplayName(
    input: ScmSourceControllerWorkspaceCheckoutCreationRequest,
): string {
    return input.displayName;
}

export function resolveScmSourceControllerWorkspaceCheckoutCreationBaseRef(
    input: ScmSourceControllerWorkspaceCheckoutCreationRequest,
): string | null {
    return input.baseRef;
}
