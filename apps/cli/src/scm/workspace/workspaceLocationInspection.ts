import type { ScmBackendId, ScmCapabilities, ScmRepoMode } from '@happier-dev/protocol';
import { readScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';

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
    repositoryIdentity?: ScmHostingRepositoryIdentityV1;
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
    /** Accepted checkout registration requests hosting facts; ordinary location probes stay cheap. */
    includeRepositoryIdentity?: boolean;
    signal?: AbortSignal;
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
            context: { ...resolved.context, ...(input.signal ? { signal: input.signal } : {}) },
        });
        if (!inspection) {
            return null;
        }

        const checkoutDiscovery = normalizeCheckoutDiscovery(inspection);
        let repositoryIdentity: ScmHostingRepositoryIdentityV1 | null = null;
        if (input.includeRepositoryIdentity) {
            const status = await resolved.selection.backend.statusSnapshot({
                context: { ...resolved.context, ...(input.signal ? { signal: input.signal } : {}) },
                request: { cwd: input.candidatePath, includeWorktreeStatus: false },
            });
            const snapshot = status.success ? status.snapshot : undefined;
            if (snapshot?.repo.isRepo && snapshot.repo.rootPath
                && getPathRemainderWithinBase(snapshot.repo.rootPath, inspection.rootPath) === '') {
                repositoryIdentity = readScmHostingRepositoryIdentity(snapshot.hostingProvider);
            }
        }

        return {
            backendId: resolved.selection.backend.id,
            mode: resolved.selection.mode,
            capabilities: resolved.selection.backend.getCapabilities({
                mode: resolved.selection.mode,
            }),
            inspection,
            ...(repositoryIdentity ? { repositoryIdentity } : {}),
            workspaceLocationScm: inspection.scmProvider ? {
                provider: inspection.scmProvider,
                rootPath: inspection.rootPath,
            } : undefined,
            checkoutDiscovery,
            checkoutProviderKinds: checkoutDiscovery.map(({ kind }) => kind),
        };
    });
}
