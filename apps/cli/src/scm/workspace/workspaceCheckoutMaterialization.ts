import type { ScmWorkspaceIntegrationWorkspaceCheckoutKind } from './workspaceCheckoutCreation';

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    sourcePath: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult = Readonly<{
    targetPath: string;
}>;

export function createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest(input: Readonly<{
    sourcePath: string;
    targetPath: string;
    checkoutCreation: Readonly<{
        kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
        displayName: string;
        baseRef?: string | null;
    }>;
}>): ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest {
    return {
        kind: input.checkoutCreation.kind,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        displayName: input.checkoutCreation.displayName,
        baseRef: input.checkoutCreation.baseRef ?? null,
    };
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationKind(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): ScmWorkspaceIntegrationWorkspaceCheckoutKind {
    return input.kind;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationSourcePath(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): string {
    return input.sourcePath;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationTargetPath(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): string {
    return input.targetPath;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationDisplayName(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): string {
    return input.displayName;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBaseRef(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): string | null {
    return input.baseRef;
}

export function createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
): ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult {
    return {
        targetPath: input.targetPath,
    };
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResultTargetPath(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
): string {
    return input.targetPath;
}
