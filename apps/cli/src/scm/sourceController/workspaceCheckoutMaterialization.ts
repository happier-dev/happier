import type { ScmSourceControllerWorkspaceCheckoutKind } from './workspaceCheckoutCreation';

export type ScmSourceControllerWorkspaceCheckoutMaterializationRequest = Readonly<{
    kind: ScmSourceControllerWorkspaceCheckoutKind;
    sourcePath: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
}>;

export type ScmSourceControllerWorkspaceCheckoutMaterializationResult = Readonly<{
    targetPath: string;
}>;

export function createScmSourceControllerWorkspaceCheckoutMaterializationRequest(input: Readonly<{
    sourcePath: string;
    targetPath: string;
    checkoutCreation: Readonly<{
        kind: ScmSourceControllerWorkspaceCheckoutKind;
        displayName: string;
        baseRef?: string | null;
    }>;
}>): ScmSourceControllerWorkspaceCheckoutMaterializationRequest {
    return {
        kind: input.checkoutCreation.kind,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        displayName: input.checkoutCreation.displayName,
        baseRef: input.checkoutCreation.baseRef ?? null,
    };
}

export function resolveScmSourceControllerWorkspaceCheckoutMaterializationKind(
    input: ScmSourceControllerWorkspaceCheckoutMaterializationRequest,
): ScmSourceControllerWorkspaceCheckoutKind {
    return input.kind;
}

export function resolveScmSourceControllerWorkspaceCheckoutMaterializationSourcePath(
    input: ScmSourceControllerWorkspaceCheckoutMaterializationRequest,
): string {
    return input.sourcePath;
}

export function resolveScmSourceControllerWorkspaceCheckoutMaterializationTargetPath(
    input: ScmSourceControllerWorkspaceCheckoutMaterializationRequest,
): string {
    return input.targetPath;
}

export function resolveScmSourceControllerWorkspaceCheckoutMaterializationDisplayName(
    input: ScmSourceControllerWorkspaceCheckoutMaterializationRequest,
): string {
    return input.displayName;
}

export function resolveScmSourceControllerWorkspaceCheckoutMaterializationBaseRef(
    input: ScmSourceControllerWorkspaceCheckoutMaterializationRequest,
): string | null {
    return input.baseRef;
}

export function createScmSourceControllerWorkspaceCheckoutMaterializationResult(
    input: ScmSourceControllerWorkspaceCheckoutMaterializationResult,
): ScmSourceControllerWorkspaceCheckoutMaterializationResult {
    return {
        targetPath: input.targetPath,
    };
}

export function resolveScmSourceControllerWorkspaceCheckoutMaterializationResultTargetPath(
    input: ScmSourceControllerWorkspaceCheckoutMaterializationResult,
): string {
    return input.targetPath;
}
