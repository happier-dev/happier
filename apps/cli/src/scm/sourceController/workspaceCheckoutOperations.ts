import { defaultScmBackendRegistry } from '../defaultRegistry';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import {
    createScmSourceControllerWorkspaceCheckoutCreationRequestFromRealization,
    createScmSourceControllerWorkspaceCheckoutMaterializationRequestFromRealization,
    createScmSourceControllerWorkspaceCheckoutRealizationRequest,
    createScmSourceControllerWorkspaceCheckoutRealizationResult,
    type ScmSourceControllerWorkspaceCheckoutRealizationResult,
} from './workspaceCheckoutRealization';
import { resolveScmSourceControllerWorkspaceCheckoutMaterializationResultTargetPath } from './workspaceCheckoutMaterialization';
import type { ScmSourceControllerWorkspaceCheckoutCreationResult } from './workspaceCheckoutCreation';
import type { ScmSourceControllerWorkspaceCheckoutMaterializationInput } from '../types';

export async function materializeWorkspaceCheckoutWithSourceController(input: Readonly<{
    sourcePath: string;
    targetPath: string;
    checkoutCreation: Pick<
        ScmSourceControllerWorkspaceCheckoutMaterializationInput['workspaceCheckoutMaterialization'],
        'kind' | 'displayName' | 'baseRef'
    >;
    registry?: ScmBackendRegistry;
}>): Promise<boolean> {
    const result = await realizeWorkspaceCheckoutWithSourceController({
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        checkoutCreation: input.checkoutCreation,
        registry: input.registry,
    });

    return result !== null;
}

export async function realizeWorkspaceCheckoutWithSourceController(input: Readonly<{
    sourcePath: string;
    targetPath?: string;
    checkoutCreation: Pick<
        ScmSourceControllerWorkspaceCheckoutMaterializationInput['workspaceCheckoutMaterialization'],
        'kind' | 'displayName' | 'baseRef'
    >;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceCheckoutRealizationResult | null> {
    const resolved = await resolveScmSelection({
        workingDirectory: input.sourcePath,
        cwd: input.sourcePath,
        registry: input.registry ?? defaultScmBackendRegistry,
    });
    if (!resolved) {
        return null;
    }

    const sourceController = resolved.selection.backend.sourceController;
    if (!sourceController) {
        return null;
    }

    const workspaceCheckoutRealization = createScmSourceControllerWorkspaceCheckoutRealizationRequest({
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        checkoutCreation: input.checkoutCreation,
    });
    if (sourceController.realizeWorkspaceCheckout) {
        return await sourceController.realizeWorkspaceCheckout({
            context: resolved.context,
            workspaceCheckoutRealization,
        });
    }

    if (input.targetPath) {
        if (!sourceController.materializeWorkspaceCheckout) {
            return null;
        }

        const materialized = await sourceController.materializeWorkspaceCheckout({
            context: resolved.context,
            workspaceCheckoutMaterialization: createScmSourceControllerWorkspaceCheckoutMaterializationRequestFromRealization(
                workspaceCheckoutRealization,
            ),
        });

        return createScmSourceControllerWorkspaceCheckoutRealizationResult({
            kind: workspaceCheckoutRealization.kind,
            targetPath: materialized
                ? resolveScmSourceControllerWorkspaceCheckoutMaterializationResultTargetPath(materialized)
                : input.targetPath,
        });
    }

    if (!sourceController.createWorkspaceCheckout) {
        return null;
    }

    return await sourceController.createWorkspaceCheckout({
        context: resolved.context,
        workspaceCheckoutCreation: createScmSourceControllerWorkspaceCheckoutCreationRequestFromRealization(
            workspaceCheckoutRealization,
        ),
    });
}

export async function createWorkspaceCheckoutWithSourceController(input: Readonly<{
    sourcePath: string;
    checkoutCreation: Pick<
        ScmSourceControllerWorkspaceCheckoutMaterializationInput['workspaceCheckoutMaterialization'],
        'kind' | 'displayName' | 'baseRef'
    >;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceCheckoutCreationResult | null> {
    const result = await realizeWorkspaceCheckoutWithSourceController({
        sourcePath: input.sourcePath,
        checkoutCreation: input.checkoutCreation,
        registry: input.registry,
    });

    return result;
}
