import {
    createScmSourceControllerWorkspaceCheckoutCreationRequest,
    type ScmSourceControllerWorkspaceCheckoutKind,
} from './workspaceCheckoutCreation';
import { createScmSourceControllerWorkspaceCheckoutMaterializationRequest } from './workspaceCheckoutMaterialization';

export type ScmSourceControllerWorkspaceCheckoutRealizationRequest = Readonly<{
    kind: ScmSourceControllerWorkspaceCheckoutKind;
    sourcePath: string;
    displayName: string;
    baseRef: string | null;
    targetPath: string | null;
}>;

export type ScmSourceControllerWorkspaceCheckoutRealizationResult = Readonly<{
    kind: ScmSourceControllerWorkspaceCheckoutKind;
    targetPath: string;
}>;

export function createScmSourceControllerWorkspaceCheckoutRealizationRequest(input: Readonly<{
    sourcePath: string;
    targetPath?: string;
    checkoutCreation: Readonly<{
        kind: ScmSourceControllerWorkspaceCheckoutKind;
        displayName: string;
        baseRef?: string | null;
    }>;
}>): ScmSourceControllerWorkspaceCheckoutRealizationRequest {
    return {
        kind: input.checkoutCreation.kind,
        sourcePath: input.sourcePath,
        displayName: input.checkoutCreation.displayName,
        baseRef: input.checkoutCreation.baseRef ?? null,
        targetPath: input.targetPath ?? null,
    };
}

export function resolveScmSourceControllerWorkspaceCheckoutRealizationKind(
    input: ScmSourceControllerWorkspaceCheckoutRealizationRequest,
): ScmSourceControllerWorkspaceCheckoutKind {
    return input.kind;
}

export function resolveScmSourceControllerWorkspaceCheckoutRealizationSourcePath(
    input: ScmSourceControllerWorkspaceCheckoutRealizationRequest,
): string {
    return input.sourcePath;
}

export function resolveScmSourceControllerWorkspaceCheckoutRealizationDisplayName(
    input: ScmSourceControllerWorkspaceCheckoutRealizationRequest,
): string {
    return input.displayName;
}

export function resolveScmSourceControllerWorkspaceCheckoutRealizationBaseRef(
    input: ScmSourceControllerWorkspaceCheckoutRealizationRequest,
): string | null {
    return input.baseRef;
}

export function resolveScmSourceControllerWorkspaceCheckoutRealizationTargetPath(
    input: ScmSourceControllerWorkspaceCheckoutRealizationRequest,
): string | null {
    return input.targetPath;
}

export function createScmSourceControllerWorkspaceCheckoutCreationRequestFromRealization(
    input: ScmSourceControllerWorkspaceCheckoutRealizationRequest,
) {
    return createScmSourceControllerWorkspaceCheckoutCreationRequest({
        sourcePath: input.sourcePath,
        checkoutCreation: {
            kind: input.kind,
            displayName: input.displayName,
            baseRef: input.baseRef,
        },
    });
}

export function createScmSourceControllerWorkspaceCheckoutMaterializationRequestFromRealization(
    input: ScmSourceControllerWorkspaceCheckoutRealizationRequest,
) {
    if (!input.targetPath) {
        throw new Error('Workspace checkout realization target path is required for materialization');
    }

    return createScmSourceControllerWorkspaceCheckoutMaterializationRequest({
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        checkoutCreation: {
            kind: input.kind,
            displayName: input.displayName,
            baseRef: input.baseRef,
        },
    });
}

export function createScmSourceControllerWorkspaceCheckoutRealizationResult(
    input: ScmSourceControllerWorkspaceCheckoutRealizationResult,
): ScmSourceControllerWorkspaceCheckoutRealizationResult {
    return {
        kind: input.kind,
        targetPath: input.targetPath,
    };
}

export function resolveScmSourceControllerWorkspaceCheckoutRealizationResultKind(
    input: ScmSourceControllerWorkspaceCheckoutRealizationResult,
): ScmSourceControllerWorkspaceCheckoutKind {
    return input.kind;
}

export function resolveScmSourceControllerWorkspaceCheckoutRealizationResultTargetPath(
    input: ScmSourceControllerWorkspaceCheckoutRealizationResult,
): string {
    return input.targetPath;
}
