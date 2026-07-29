import type { ScmBackendId, ScmCapabilities, ScmRepoMode } from '@happier-dev/protocol';

import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import type {
    ScmWorkspaceIntegrationCheckoutDiscovery,
    ScmWorkspaceIntegrationWorkspaceLocationInspection,
} from '../types';
import type { ScmWorkspaceIntegrationWorkspaceLocationInspection as ScmWorkspaceIntegrationWorkspaceInspection } from '../types';

export type ScmWorkspaceIntegrationWorkspaceLocationResult = Readonly<{
    backendId: ScmBackendId;
    mode: ScmRepoMode;
    capabilities: ScmCapabilities;
    inspection: ScmWorkspaceIntegrationWorkspaceLocationInspection;
    workspaceLocationScm?: Readonly<{
        provider: NonNullable<ScmWorkspaceIntegrationWorkspaceInspection['scmProvider']>;
        rootPath: string;
    }>;
    checkoutDiscovery: readonly ScmWorkspaceIntegrationCheckoutDiscovery[];
    checkoutProviderKinds: readonly NonNullable<ScmWorkspaceIntegrationWorkspaceInspection['checkoutProviderKinds']>[number][];
}>;

function normalizeCheckoutDiscovery(
    inspection: ScmWorkspaceIntegrationWorkspaceInspection,
): readonly ScmWorkspaceIntegrationCheckoutDiscovery[] {
    if (inspection.checkoutDiscovery) {
        return inspection.checkoutDiscovery;
    }

    return (inspection.checkoutProviderKinds ?? []).map((kind) => ({ kind }));
}

export async function inspectWorkspaceLocationWithScmWorkspace(input: Readonly<{
    candidatePath: string;
    registry?: ScmBackendRegistry;
}>): Promise<ScmWorkspaceIntegrationWorkspaceLocationResult | null> {
    return runWithScmBackendRegistryLease(input.registry, async (registry) => {
        const resolved = await resolveScmSelection({
            workingDirectory: input.candidatePath,
            cwd: input.candidatePath,
            registry,
        });
        if (!resolved) {
            return null;
        }

        const workspaceIntegration = resolved.selection.backend.workspaceIntegration;
        if (!workspaceIntegration?.inspectWorkspaceLocation) {
            return null;
        }

        const inspection = await workspaceIntegration.inspectWorkspaceLocation({
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
    });
}
