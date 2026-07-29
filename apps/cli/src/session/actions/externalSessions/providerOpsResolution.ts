import type {
    ExternalSessionsAgentId,
    ExternalSessionsSource,
} from '@happier-dev/protocol';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import type { ExternalSessionFollowResource } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
    createExternalSessionSourceKeyOwnerFromAgentProjection,
    resolveExternalSessionSourceFromAgentProjection,
    type ExternalSessionSourceKeyOwner,
    type ResolvedExternalSessionSourceProjection,
} from '@/plugins/projection/registry/externalSessionSources';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

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
        throw new Error(`Missing current external-session Agent operations for ${agentId}`);
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
        providerOps: ExternalSessionExecutionSurface;
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
            providerOps,
        });
    } finally {
        await runtimeRegistryLease.release();
    }
}

export async function resolveExternalSessionSourceKeyOwner(
    agentId: ExternalSessionsAgentId,
    source: ExternalSessionsSource,
): Promise<ExternalSessionSourceKeyOwner | null> {
    const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        return createExternalSessionSourceKeyOwnerFromAgentProjection(
            runtimeRegistryLease.registry.contributes,
            agentId,
            source,
        );
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
}>> {
    const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        await activateAgentRuntimeContributionOnDemand(runtimeRegistryLease.registry, agentId);
        const runtimeLease = runtimeRegistryLease.registry.agentRuntimesByAgentId.get(agentId);
        const retirementSignal = runtimeLease?.retirementSignal;
        if (!runtimeLease || !retirementSignal || !runtimeLease.isCurrent() || retirementSignal.aborted) {
            throw new Error(`Missing current external-session Agent generation for ${agentId}`);
        }
        const providerOps = await resolveExternalSessionSurfaceOpsAfterDemand(
            agentId,
            runtimeRegistryLease.registry,
        );
        if (!runtimeLease.isCurrent() || retirementSignal.aborted) {
            throw new Error(`External-session Agent generation retired while resolving ${agentId}`);
        }
        return {
            providerOps,
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
