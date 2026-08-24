import type { ScmWorkspaceIntegrationWorkspaceCheckoutKind } from './workspaceCheckoutCreation';

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    sourcePath: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult = Readonly<{
    targetPath: string;
    branchName: string;
    created: boolean;
}>;

export function createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest(input: Readonly<{
    sourcePath: string;
    targetPath: string;
    checkoutCreation: Readonly<{
        kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
        displayName: string;
        baseRef?: string | null;
        branchMode: 'new' | 'existing';
    }>;
}>): ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest {
    return {
        kind: input.checkoutCreation.kind,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        displayName: input.checkoutCreation.displayName,
        baseRef: input.checkoutCreation.baseRef ?? null,
        branchMode: input.checkoutCreation.branchMode,
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

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBranchMode(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): 'new' | 'existing' {
    return input.branchMode;
}

export function createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
): ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult {
    return {
        targetPath: input.targetPath,
        branchName: input.branchName,
        created: input.created,
    };
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResultTargetPath(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
): string {
    return input.targetPath;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResultBranchName(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
): string {
    return input.branchName;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResultCreated(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
): boolean {
    return input.created;
}
