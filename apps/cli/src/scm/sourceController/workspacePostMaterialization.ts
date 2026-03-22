import { defaultScmBackendRegistry } from '../defaultRegistry';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import { createScmSourceControllerCheckoutMaterializationRequest } from './checkoutMaterialization';
import type { ScmSourceControllerWorkspaceTransferMetadata } from './workspaceTransfer';

export async function reconcilePostMaterializationWithSourceController(input: Readonly<{
    targetPath: string;
    sourcePath?: string;
    previousTargetPath?: string;
    sourceControllerMetadata?: ScmSourceControllerWorkspaceTransferMetadata;
    registry?: ScmBackendRegistry;
}>): Promise<void> {
    const registry = input.registry ?? defaultScmBackendRegistry;
    const resolved = await resolveScmSelection({
        workingDirectory: input.targetPath,
        cwd: input.targetPath,
        registry,
    });
    const fallbackResolved = !resolved && input.previousTargetPath
        ? await resolveScmSelection({
            workingDirectory: input.previousTargetPath,
            cwd: input.previousTargetPath,
            registry,
        })
        : null;
    const sourceFallbackResolved = !resolved && !fallbackResolved && input.sourcePath
        ? await resolveScmSelection({
            workingDirectory: input.sourcePath,
            cwd: input.sourcePath,
            registry,
        })
        : null;
    const fallback = fallbackResolved ?? sourceFallbackResolved;
    const selected = resolved ?? (fallback ? {
        selection: fallback.selection,
        context: {
            ...fallback.context,
            cwd: input.targetPath,
            detection: {
                ...fallback.context.detection,
                rootPath: input.targetPath,
            },
        },
    } : null);
    if (!selected) {
        return;
    }

    await selected.selection.backend.sourceController?.reconcilePostMaterialization?.({
        context: selected.context,
        checkoutMaterialization: createScmSourceControllerCheckoutMaterializationRequest({
            targetPath: input.targetPath,
            sourcePath: input.sourcePath,
            previousTargetPath: input.previousTargetPath,
            sourceControllerMetadata: input.sourceControllerMetadata,
        }),
        sourcePath: input.sourcePath,
        previousTargetPath: input.previousTargetPath,
        sourceControllerMetadata: input.sourceControllerMetadata,
    });
}
