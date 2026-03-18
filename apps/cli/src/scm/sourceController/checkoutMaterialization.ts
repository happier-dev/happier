import type { ScmSourceControllerWorkspaceTransferMetadata } from './workspaceTransfer';

export type ScmSourceControllerCheckoutMaterializationRequest = Readonly<{
    targetPath: string;
    sourcePath?: string;
    previousTargetPath?: string;
    sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata;
}>;

export function createScmSourceControllerCheckoutMaterializationRequest(input: ScmSourceControllerCheckoutMaterializationRequest): ScmSourceControllerCheckoutMaterializationRequest {
    return {
        targetPath: input.targetPath,
        sourcePath: input.sourcePath,
        previousTargetPath: input.previousTargetPath,
        sourceControllerMetadata: input.sourceControllerMetadata,
    };
}

export function resolveScmSourceControllerCheckoutMaterializationSourcePath(
    input: ScmSourceControllerCheckoutMaterializationRequest,
): string | undefined {
    return input.sourcePath;
}

export function resolveScmSourceControllerCheckoutMaterializationPreviousTargetPath(
    input: ScmSourceControllerCheckoutMaterializationRequest,
): string | undefined {
    return input.previousTargetPath;
}
