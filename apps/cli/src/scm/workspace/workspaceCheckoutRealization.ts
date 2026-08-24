import {
    createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
    type ScmWorkspaceIntegrationWorkspaceCheckoutKind,
} from './workspaceCheckoutCreation';
import { createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest } from './workspaceCheckoutMaterialization';

export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    sourcePath: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
    targetPath: string | null;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult = Readonly<{
    kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
    targetPath: string;
    branchName: string;
    created: boolean;
}>;

export function createScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest(input: Readonly<{
    sourcePath: string;
    targetPath?: string;
    checkoutCreation: Readonly<{
        kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
        displayName: string;
        baseRef?: string | null;
        branchMode: 'new' | 'existing';
    }>;
}>): ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest {
    return {
        kind: input.checkoutCreation.kind,
        sourcePath: input.sourcePath,
        displayName: input.checkoutCreation.displayName,
        baseRef: input.checkoutCreation.baseRef ?? null,
        branchMode: input.checkoutCreation.branchMode,
        targetPath: input.targetPath ?? null,
    };
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationKind(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): ScmWorkspaceIntegrationWorkspaceCheckoutKind {
    return input.kind;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationSourcePath(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): string {
    return input.sourcePath;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationDisplayName(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): string {
    return input.displayName;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBaseRef(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): string | null {
    return input.baseRef;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBranchMode(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): 'new' | 'existing' {
    return input.branchMode;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationTargetPath(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): string | null {
    return input.targetPath;
}

export function createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequestFromRealization(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
) {
    return createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest({
        sourcePath: input.sourcePath,
        checkoutCreation: {
            kind: input.kind,
            displayName: input.displayName,
            baseRef: input.baseRef,
            branchMode: input.branchMode,
        },
    });
}

export function createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequestFromRealization(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
) {
    if (!input.targetPath) {
        throw new Error('Workspace checkout realization target path is required for materialization');
    }

    return createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest({
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        checkoutCreation: {
            kind: input.kind,
            displayName: input.displayName,
            baseRef: input.baseRef,
            branchMode: input.branchMode,
        },
    });
}

export function createScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
): ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult {
    return {
        kind: input.kind,
        targetPath: input.targetPath,
        branchName: input.branchName,
        created: input.created,
    };
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationResultKind(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
): ScmWorkspaceIntegrationWorkspaceCheckoutKind {
    return input.kind;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationResultTargetPath(
    input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
): string {
    return input.targetPath;
}
