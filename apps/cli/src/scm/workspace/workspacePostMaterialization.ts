import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import { resolveScmBackendById, type ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import { createScmWorkspaceIntegrationCheckoutMaterializationRequest } from './checkoutMaterialization';
import type { ScmWorkspaceIntegrationWorkspaceTransferMetadata } from './workspaceTransfer';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import type { ManagedSessionTarget } from '@/machines/managed/acquire';
import { runWithHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';

/** Native placement keeps the admitted SCM backend on its controller. */
export async function reconcileManagedWorkspacePostMaterialization(input: Readonly<{
    target: Pick<ManagedSessionTarget, 'id' | 'holderPath' | 'helperPath' | 'openChannel'>;
    targetPath: string;
    workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata;
    registry?: ScmBackendRegistry;
    signal: AbortSignal;
}>): Promise<void> {
    if (!input.workspaceIntegrationMetadata) return;
    await runWithHolderWorkspaceSource({ target: input.target, rootPath: input.targetPath, signal: input.signal }, () =>
        reconcilePostMaterializationWithScmWorkspace({ targetPath: input.targetPath,
            workspaceIntegrationMetadata: input.workspaceIntegrationMetadata, registry: input.registry }));
}

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
        const metadataProvider = typeof input.workspaceIntegrationMetadata?.provider === 'string'
            ? input.workspaceIntegrationMetadata.provider
            : null;
        const metadataBackend = metadataProvider
            ? resolveScmBackendById(registry.listBackends(), metadataProvider)
            : null;
        if (metadataProvider && !metadataBackend) {
            throw Object.assign(new Error('The source workspace integration backend is unavailable'), {
                code: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
            });
        }
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
        const backend = metadataBackend ?? selected?.selection.backend;
        if (!backend) {
            return;
        }
        const context = selected?.selection.backend === backend ? selected.context : {
            cwd: input.targetPath,
            projectKey: `workspace-materialization:${input.targetPath}`,
            detection: { isRepo: false, rootPath: input.targetPath, mode: null },
        };

        await backend.workspaceIntegration?.reconcilePostMaterialization?.({
            context,
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
