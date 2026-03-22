import type { ScmBackendId, ScmCapabilities, ScmRepoMode } from '@happier-dev/protocol';

import { defaultScmBackendRegistry } from '../defaultRegistry';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import type {
    ScmSourceControllerCheckoutDiscovery,
    ScmSourceControllerWorkspaceLocationInspection,
} from '../types';
import type { ScmSourceControllerWorkspaceLocationInspection as ScmSourceControllerWorkspaceInspection } from '../types';

export type ScmSourceControllerWorkspaceLocationResult = Readonly<{
    backendId: ScmBackendId;
    mode: ScmRepoMode;
    capabilities: ScmCapabilities;
    inspection: ScmSourceControllerWorkspaceLocationInspection;
    workspaceLocationScm?: Readonly<{
        provider: NonNullable<ScmSourceControllerWorkspaceInspection['scmProvider']>;
        rootPath: string;
    }>;
    checkoutDiscovery: readonly ScmSourceControllerCheckoutDiscovery[];
    checkoutProviderKinds: readonly NonNullable<ScmSourceControllerWorkspaceInspection['checkoutProviderKinds']>[number][];
}>;

function normalizeCheckoutDiscovery(
    inspection: ScmSourceControllerWorkspaceInspection,
): readonly ScmSourceControllerCheckoutDiscovery[] {
    if (inspection.checkoutDiscovery) {
        return inspection.checkoutDiscovery;
    }

    return (inspection.checkoutProviderKinds ?? []).map((kind) => ({ kind }));
}

export async function inspectWorkspaceLocationWithSourceController(input: Readonly<{
    candidatePath: string;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceLocationResult | null> {
    const resolved = await resolveScmSelection({
        workingDirectory: input.candidatePath,
        cwd: input.candidatePath,
        registry: input.registry ?? defaultScmBackendRegistry,
    });
    if (!resolved) {
        return null;
    }

    const sourceController = resolved.selection.backend.sourceController;
    if (!sourceController) {
        return null;
    }

    const inspection = await sourceController.inspectWorkspaceLocation({
        context: resolved.context,
    });
    if (!inspection) {
        return null;
    }

    const checkoutDiscovery = normalizeCheckoutDiscovery(inspection);

    return {
        backendId: resolved.selection.backend.id,
        mode: resolved.selection.mode,
        capabilities: resolved.selection.backend.getCapabilities({
            mode: resolved.selection.mode,
        }),
        inspection,
        workspaceLocationScm: inspection.scmProvider ? {
            provider: inspection.scmProvider,
            rootPath: inspection.rootPath,
        } : undefined,
        checkoutDiscovery,
        checkoutProviderKinds: checkoutDiscovery.map(({ kind }) => kind),
    };
}
