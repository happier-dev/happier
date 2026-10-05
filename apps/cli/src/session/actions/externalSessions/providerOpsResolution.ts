import type {
    ExternalSessionsAgentId,
    ExternalSessionsSource,
    PluginSourceCustodyV1,
} from '@happier-dev/protocol';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { readCurrentExternalSessionAgentIdentity } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import type { ExternalSessionFollowResource } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type {
    OccurrenceBoundExternalSessionCandidateLifecycle,
} from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import {
    createExternalSessionSourceKeyOwnerFromAgentProjection,
    resolveExternalSessionSourceFromAgentProjection,
    type ResolvedExternalSessionSourceProjection,
} from '@/plugins/projection/registry/externalSessionSources';
import { resolveConfiguredExternalSessionSourceAtAdmission } from '@/session/external/configuredSourceMaterializer';
import {
    ExternalSessionFollowFailureError,
} from '@/session/external/externalSessionFollowFailure';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
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
    options: Readonly<{ activeServerDir?: string | null }> = {},
): Promise<
    | Readonly<{
        ok: true;
        source: ExternalSessionsSource;
        declaration: Extract<ResolvedExternalSessionSourceProjection, { ok: true }>['declaration'];
        providerOps: ExternalSessionExecutionSurface;
        currentAgent: NonNullable<ReturnType<typeof readCurrentExternalSessionAgentIdentity>>;
        /** Durable authority for persisted per-Agent host state. */
        agentSourceCustody: PluginSourceCustodyV1;
        /**
         * Host-synthesized Agent session-lifecycle controls for a resume-only
         * ACP source, absent for every plugin-contributed source. Deliberately
         * not part of `providerOps`: the External Sessions contribution owns
         * discovery and transcripts, never Agent session lifecycle.
         */
        candidateLifecycle: OccurrenceBoundExternalSessionCandidateLifecycle | null;
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
        // Raw machine calls go through the one host-owned connected-profile
        // materialization: the request receives the daemon's materialized home
        // and may not name a different one. Sources outside that family come
        // back unchanged.
        const materialized = resolveConfiguredExternalSessionSourceAtAdmission({
            agents: runtimeRegistryLease.registry.contributes.agents,
            ...(options.activeServerDir ? { activeServerDir: options.activeServerDir } : {}),
            agentId,
            source: projected.source,
        });
        if (!materialized.ok) return materialized;
        const currentAgent = readCurrentExternalSessionAgentIdentity(
            runtimeRegistryLease.registry.contributes.agentDefinitionsById.get(agentId),
        );
        const sourceKeyOwner = createExternalSessionSourceKeyOwnerFromAgentProjection(
            runtimeRegistryLease.registry.contributes,
            agentId,
            materialized.source,
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
        const runtimeLease = runtimeRegistryLease.registry.agentRuntimesByAgentId.get(agentId);
        if (!runtimeLease?.sourceCustody || !runtimeLease.isCurrent()) {
            return { ok: false, code: 'agent_unavailable' };
        }
        return Object.freeze({
            ok: true,
            source: materialized.source,
            declaration: materialized.declaration,
            providerOps: Object.freeze({ ...providerOps, contentSearch: materialized.declaration.contentSearch === true }),
            currentAgent,
            agentSourceCustody: runtimeLease.sourceCustody,
            candidateLifecycle:
                runtimeLease.externalSessionCandidateLifecycle ?? null,
            sourceKeyOwner,
        });
    } finally {
        await runtimeRegistryLease.release();
    }
}

export async function resolveOccurrenceBoundExternalSessionFollowSurface(
    agentId: ExternalSessionsAgentId,
    linkGeneration: string,
): Promise<Readonly<{
    providerOps: ExternalSessionExecutionSurface;
    resource: ExternalSessionFollowResource;
    sourceCustody: PluginSourceCustodyV1;
    occurrenceId: PluginRuntimeOccurrenceId;
}>> {
    const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        await activateAgentRuntimeContributionOnDemand(runtimeRegistryLease.registry, agentId);
        const runtimeLease = runtimeRegistryLease.registry.agentRuntimesByAgentId.get(agentId);
        const retirementSignal = runtimeLease?.retirementSignal;
        if (!runtimeLease || !retirementSignal || !runtimeLease.isCurrent() || retirementSignal.aborted) {
            throw new ExternalSessionFollowFailureError(
                'agent_unavailable',
                `Missing current external-session Agent occurrence for ${agentId}`,
            );
        }
        const agentIdentity = readCurrentExternalSessionAgentIdentity(
            runtimeRegistryLease.registry.contributes.agentDefinitionsById.get(agentId),
        );
        const sourceCustody = agentIdentity
            ? runtimeRegistryLease.registry.readPluginSourceCustody?.(agentIdentity.identity.pluginId) ?? null
            : null;
        const occurrenceId = agentIdentity
            ? runtimeRegistryLease.registry.readPluginOccurrenceId?.(agentIdentity.identity.pluginId) ?? null
            : null;
        if (!sourceCustody || !occurrenceId) {
            throw new ExternalSessionFollowFailureError(
                'agent_unavailable',
                `Missing current external-session Agent source custody for ${agentId}`,
            );
        }
        const providerOps = await resolveExternalSessionSurfaceOpsAfterDemand(
            agentId,
            runtimeRegistryLease.registry,
        );
        if (!runtimeLease.isCurrent() || retirementSignal.aborted) {
            throw new ExternalSessionFollowFailureError(
                'source_changed',
                `External-session Agent occurrence retired while resolving ${agentId}`,
            );
        }
        return {
            providerOps,
            sourceCustody,
            occurrenceId,
            resource: {
                linkGeneration,
                occurrenceId,
                retirementSignal,
            },
        };
    } finally {
        await runtimeRegistryLease.release();
    }
}
