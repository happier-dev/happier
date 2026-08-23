import type {
    ExternalSessionsAgentId,
    ExternalSessionsSource,
} from '@happier-dev/protocol';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { readCurrentExternalSessionAgentIdentity } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import type { ExternalSessionFollowResource } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
    createExternalSessionSourceKeyOwnerFromAgentProjection,
    resolveExternalSessionSourceFromAgentProjection,
    type ResolvedExternalSessionSourceProjection,
} from '@/plugins/projection/registry/externalSessionSources';
import {
    ExternalSessionFollowFailureError,
} from '@/session/external/externalSessionFollowFailure';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
export {
    resolveExternalSessionSourceKeyOwner,
} from '@/session/external/resolveExternalSessionSourceKeyOwner';

async function resolveExternalSessionSurfaceOpsAfterDemand(
    agentId: ExternalSessionsAgentId,
    registry: ResolvedExecutablePluginRuntimeRegistry,
): Promise<ExternalSessionExecutionSurface> {
    const runtimeLease = registry.agentRuntimesByAgentId.get(agentId);
    const retirementSignal = runtimeLease?.retirementSignal;
    if (
        !runtimeLease?.externalSessions
        || !retirementSignal
        || !runtimeLease.isCurrent()
        || retirementSignal.aborted
    ) {
        throw new ExternalSessionFollowFailureError(
            'agent_unavailable',
            `Missing current external-session Agent operations for ${agentId}`,
        );
    }
    return createAgentExternalSessionsExecutionSurface(
        runtimeLease.externalSessions,
        'unsupported',
    );
}

export async function resolveExternalSessionSurfaceOps(agentId: ExternalSessionsAgentId): Promise<ExternalSessionExecutionSurface> {
    const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        await activateAgentRuntimeContributionOnDemand(runtimeRegistryLease.registry, agentId);
        return await resolveExternalSessionSurfaceOpsAfterDemand(agentId, runtimeRegistryLease.registry);
    } finally {
        await runtimeRegistryLease.release();
    }
}

export async function resolveExternalSessionSourceSurface(
    agentId: ExternalSessionsAgentId,
    source: ExternalSessionsSource,
): Promise<
    | Readonly<{
        ok: true;
        source: ExternalSessionsSource;
        declaration: Extract<ResolvedExternalSessionSourceProjection, { ok: true }>['declaration'];
        providerOps: ExternalSessionExecutionSurface;
        currentAgent: NonNullable<ReturnType<typeof readCurrentExternalSessionAgentIdentity>>;
        /**
         * Immutable generation of the Agent plugin that will serve this request,
         * so persisted per-Agent host state can be qualified by the code behind
         * the contribution rather than only by the contribution's identity.
         */
        agentRuntimeGeneration: string | null;
        sourceKeyOwner: NonNullable<ReturnType<typeof createExternalSessionSourceKeyOwnerFromAgentProjection>>;
    }>
    | Extract<ResolvedExternalSessionSourceProjection, { ok: false }>
> {
    const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        const projected = resolveExternalSessionSourceFromAgentProjection(
            runtimeRegistryLease.registry.contributes,
            agentId,
            source,
        );
        if (!projected.ok) return projected;
        const currentAgent = readCurrentExternalSessionAgentIdentity(
            runtimeRegistryLease.registry.contributes.agentDefinitionsById.get(agentId),
        );
        const sourceKeyOwner = createExternalSessionSourceKeyOwnerFromAgentProjection(
            runtimeRegistryLease.registry.contributes,
            agentId,
            projected.source,
        );
        if (!currentAgent || !sourceKeyOwner) {
            return { ok: false, code: 'agent_unavailable' };
        }
        await activateAgentRuntimeContributionOnDemand(runtimeRegistryLease.registry, agentId);
        let providerOps: ExternalSessionExecutionSurface;
        try {
            providerOps = await resolveExternalSessionSurfaceOpsAfterDemand(
                agentId,
                runtimeRegistryLease.registry,
            );
        } catch {
            return { ok: false, code: 'agent_unavailable' };
        }
        return Object.freeze({
            ok: true,
            source: projected.source,
            declaration: projected.declaration,
            providerOps,
            currentAgent,
            agentRuntimeGeneration:
                runtimeRegistryLease.registry.agentRuntimesByAgentId
                    .get(agentId)?.immutableGenerationId ?? null,
            sourceKeyOwner,
        });
    } finally {
        await runtimeRegistryLease.release();
    }
}

export async function resolveGenerationBoundExternalSessionFollowSurface(
    agentId: ExternalSessionsAgentId,
    linkGeneration: string,
): Promise<Readonly<{
    providerOps: ExternalSessionExecutionSurface;
    resource: ExternalSessionFollowResource;
    immutablePluginGenerationId: string | null;
}>> {
    const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        await activateAgentRuntimeContributionOnDemand(runtimeRegistryLease.registry, agentId);
        const runtimeLease = runtimeRegistryLease.registry.agentRuntimesByAgentId.get(agentId);
        const retirementSignal = runtimeLease?.retirementSignal;
        if (!runtimeLease || !retirementSignal || !runtimeLease.isCurrent() || retirementSignal.aborted) {
            throw new ExternalSessionFollowFailureError(
                'agent_unavailable',
                `Missing current external-session Agent generation for ${agentId}`,
            );
        }
        const providerOps = await resolveExternalSessionSurfaceOpsAfterDemand(
            agentId,
            runtimeRegistryLease.registry,
        );
        if (!runtimeLease.isCurrent() || retirementSignal.aborted) {
            throw new ExternalSessionFollowFailureError(
                'source_changed',
                `External-session Agent generation retired while resolving ${agentId}`,
            );
        }
        return {
            providerOps,
            immutablePluginGenerationId:
                runtimeLease.immutableGenerationId ?? null,
            resource: {
                linkGeneration,
                pluginGeneration: runtimeLease.generation,
                retirementSignal,
            },
        };
    } finally {
        await runtimeRegistryLease.release();
    }
}
