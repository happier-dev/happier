import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import { createScmWorkspaceIntegrationCheckoutMaterializationRequest } from './checkoutMaterialization';
import type { ScmWorkspaceIntegrationWorkspaceTransferMetadata } from './workspaceTransfer';

export async function reconcilePostMaterializationWithScmWorkspace(input: Readonly<{
    targetPath: string;
    sourcePath?: string;
    previousTargetPath?: string;
    workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata;
    registry?: ScmBackendRegistry;
}>): Promise<void> {
    await runWithScmBackendRegistryLease(input.registry, async (registry) => {
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

        await selected.selection.backend.workspaceIntegration?.reconcilePostMaterialization?.({
            context: selected.context,
            checkoutMaterialization: createScmWorkspaceIntegrationCheckoutMaterializationRequest({
                targetPath: input.targetPath,
                sourcePath: input.sourcePath,
                previousTargetPath: input.previousTargetPath,
                workspaceIntegrationMetadata: input.workspaceIntegrationMetadata,
            }),
            sourcePath: input.sourcePath,
            previousTargetPath: input.previousTargetPath,
            workspaceIntegrationMetadata: input.workspaceIntegrationMetadata,
        });
    });
}
