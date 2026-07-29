import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import {
    createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequestFromRealization,
    createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequestFromRealization,
    createScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
    createScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
    type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
} from './workspaceCheckoutRealization';
import { resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResultTargetPath } from './workspaceCheckoutMaterialization';
import type { ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult } from './workspaceCheckoutCreation';
import type { ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationInput } from '../types';

export async function materializeWorkspaceCheckoutWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    targetPath: string;
    checkoutCreation: Pick<
        ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationInput['workspaceCheckoutMaterialization'],
        'kind' | 'displayName' | 'baseRef'
    >;
    registry?: ScmBackendRegistry;
}>): Promise<boolean> {
    const result = await realizeWorkspaceCheckoutWithScmWorkspace({
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        checkoutCreation: input.checkoutCreation,
        registry: input.registry,
    });

    return result !== null;
}

export async function realizeWorkspaceCheckoutWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    targetPath?: string;
    checkoutCreation: Pick<
        ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationInput['workspaceCheckoutMaterialization'],
        'kind' | 'displayName' | 'baseRef'
    >;
    registry?: ScmBackendRegistry;
}>): Promise<ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult | null> {
    return runWithScmBackendRegistryLease(input.registry, async (registry) => {
        const resolved = await resolveScmSelection({
            workingDirectory: input.sourcePath,
            cwd: input.sourcePath,
            registry,
        });
        if (!resolved) {
            return null;
        }

        const workspaceIntegration = resolved.selection.backend.workspaceIntegration;
        if (!workspaceIntegration) {
            return null;
        }

        const workspaceCheckoutRealization = createScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest({
            sourcePath: input.sourcePath,
            targetPath: input.targetPath,
            checkoutCreation: input.checkoutCreation,
        });
        if (workspaceIntegration.realizeWorkspaceCheckout) {
            return await workspaceIntegration.realizeWorkspaceCheckout({
                context: resolved.context,
                workspaceCheckoutRealization,
            });
        }

        if (input.targetPath) {
            if (!workspaceIntegration.materializeWorkspaceCheckout) {
                return null;
            }

            const materialized = await workspaceIntegration.materializeWorkspaceCheckout({
                context: resolved.context,
                workspaceCheckoutMaterialization: createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequestFromRealization(
                    workspaceCheckoutRealization,
                ),
            });

            return createScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult({
                kind: workspaceCheckoutRealization.kind,
                targetPath: materialized
                    ? resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResultTargetPath(materialized)
                    : input.targetPath,
            });
        }

        if (!workspaceIntegration.createWorkspaceCheckout) {
            return null;
        }

        return await workspaceIntegration.createWorkspaceCheckout({
            context: resolved.context,
            workspaceCheckoutCreation: createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequestFromRealization(
                workspaceCheckoutRealization,
            ),
        });
    });
}

export async function createWorkspaceCheckoutWithScmWorkspace(input: Readonly<{
    sourcePath: string;
    checkoutCreation: Pick<
        ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationInput['workspaceCheckoutMaterialization'],
        'kind' | 'displayName' | 'baseRef'
    >;
    registry?: ScmBackendRegistry;
}>): Promise<ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult | null> {
    const result = await realizeWorkspaceCheckoutWithScmWorkspace({
        sourcePath: input.sourcePath,
        checkoutCreation: input.checkoutCreation,
        registry: input.registry,
    });

    return result;
}
