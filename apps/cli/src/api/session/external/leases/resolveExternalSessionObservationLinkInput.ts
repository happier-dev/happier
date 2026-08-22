import {
    ExternalAgentObservationResourceGroupingV1Schema,
    PluginBackendExternalSessionSourceDeclarationV1Schema,
    readLinkedExternalSessionV1FromMetadata,
    type PluginBackendExternalSessionSourceDeclarationV1,
    type ExternalAgentObservationTargetV1,
} from '@happier-dev/protocol';
import type {
    AgentExternalSessionObservationContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionSource,
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    resolveLinkedExternalSessionQualifiedIdentity,
    type CurrentExternalSessionAgentIdentity,
} from '@/api/session/external/linking/qualifiedLinkIdentity';
import {
    readCurrentExternalSessionAgentIdentity,
} from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import type {
    LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
    EXTERNAL_SESSIONS_INVOCATION_POLICY,
    type BoundedAgentExternalSessionsContribution,
} from '@/session/external/agentExternalSessionsInvocation';
import {
    preservesExternalSessionSourceIdentity,
} from '@/session/external/sourceIdentity';
import {
    resolveExternalSessionSourceConnectedServiceProfile,
} from '@/plugins/projection/registry/externalSessionSources';
import { fetchAccountProfile } from '@/api/accountProfile';
import { readStoredCredentials } from '@/persistence';

import type {
    ExternalSessionObservationLinkIdentity,
    ExternalSessionObservationResourceIdentity,
} from './createExternalSessionObservationReconciler';

export type ExternalSessionObservationLinkInput = Readonly<{
    resource: ExternalSessionObservationResourceIdentity;
    link: ExternalSessionObservationLinkIdentity;
    target: ExternalAgentObservationTargetV1;
}>;

export type ExternalSessionObservationLinkedSession = Pick<
    LoadedLinkedExternalSession,
    'agentId' | 'linkGeneration' | 'metadata' | 'remoteSessionId' | 'source'
>;

type ResolveExternalSessionObservationLinkInputParams = Readonly<{
    linked: ExternalSessionObservationLinkedSession;
    sessionId: string;
    signal?: AbortSignal;
    deadlineAtMs?: number;
    accountProjection?: ExternalSessionConnectedServiceAccountProjection | null;
}>;

type ExternalSessionConnectedServiceAccountProjection = Readonly<{
    connectedServicesV2: readonly Readonly<{
        serviceId: string;
        profiles: readonly Readonly<{
            profileId: string;
            status: string;
        }>[];
    }>[];
}>;

function isConnectedServiceProfileCurrent(
    projection: ExternalSessionConnectedServiceAccountProjection,
    reference: Readonly<{ serviceId: string; profileId: string }>,
): boolean {
    return projection.connectedServicesV2
        .find((service) => service.serviceId === reference.serviceId)
        ?.profiles.some(
            (profile) =>
                profile.profileId === reference.profileId
                && profile.status === 'connected',
        ) === true;
}

async function readCurrentAccountProjection(
    signal: AbortSignal,
): Promise<ExternalSessionConnectedServiceAccountProjection | null> {
    const credentials = await readStoredCredentials();
    if (!credentials || signal.aborted) return null;
    return await fetchAccountProfile({
        token: credentials.token,
        signal,
    });
}

/**
 * Resolves a persisted external-session link into the generation-bound input
 * consumed by the sole observation projection. This is the canonical bridge
 * shared by status reads and daemon status-demand admission.
 */
export async function resolveExternalSessionObservationLinkInput(
    params: ResolveExternalSessionObservationLinkInputParams,
): Promise<ExternalSessionObservationLinkInput | null> {
    const persistedLink = readLinkedExternalSessionV1FromMetadata(params.linked.metadata);
    if (!persistedLink) return null;

    const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease()
        .catch(() => null);
    if (!runtimeRegistryLease) return null;
    let runtimeSnapshot: Readonly<{
        currentAgent: CurrentExternalSessionAgentIdentity;
        externalSessions: BoundedAgentExternalSessionsContribution;
        externalSessionObservation: AgentExternalSessionObservationContribution;
        pluginGeneration: string;
        sourceDeclaration: PluginBackendExternalSessionSourceDeclarationV1;
        retirementSignal?: AbortSignal;
    }> | null = null;
    try {
        await activateAgentRuntimeContributionOnDemand(
            runtimeRegistryLease.registry,
            params.linked.agentId,
        );
        const runtimeLease = runtimeRegistryLease.registry.agentRuntimesByAgentId.get(
            params.linked.agentId,
        );
        const agentDefinition =
            runtimeRegistryLease.registry.contributes.agentDefinitionsById.get(
                params.linked.agentId,
            );
        const currentAgent = readCurrentExternalSessionAgentIdentity(
            agentDefinition,
        );
        const sourceDeclarationCandidate =
            agentDefinition?.richDefinition?.definition.surfaces?.externalSession
                ?.sources.find((source) => source.sourceKind === params.linked.source.kind);
        const sourceDeclaration =
            PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse(
                sourceDeclarationCandidate,
            );
        if (
            !runtimeLease
            || !runtimeLease.isCurrent()
            || !runtimeLease.externalSessions
            || !runtimeLease.externalSessionObservation
            || !currentAgent
            || !sourceDeclaration.success
            || runtimeLease.pluginId !== currentAgent.identity.pluginId
        ) {
            return null;
        }
        runtimeSnapshot = {
            currentAgent,
            externalSessions: runtimeLease.externalSessions,
            externalSessionObservation: runtimeLease.externalSessionObservation,
            pluginGeneration: runtimeLease.generation,
            sourceDeclaration: sourceDeclaration.data,
            retirementSignal: runtimeLease.retirementSignal,
        };
    } catch {
        return null;
    } finally {
        await runtimeRegistryLease.release().catch(() => undefined);
    }
    if (!runtimeSnapshot) return null;

    try {
        const qualified = await resolveLinkedExternalSessionQualifiedIdentity(
            {
                ...persistedLink,
                source: params.linked.source,
                remoteSessionId: params.linked.remoteSessionId,
            },
            {
                resolveCurrentAgent: async () => runtimeSnapshot.currentAgent,
            },
        );
        if (!qualified.ok || !qualified.link.qualifiedIdentity) return null;
        const signal = params.signal ?? new AbortController().signal;
        const deadlineAtMs = params.deadlineAtMs
            ?? Date.now() + EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs;
        const resolved = await runtimeSnapshot.externalSessions.resolveLinkedIdentity({
            source: qualified.link.source as AgentExternalSessionSource,
            remoteSessionId: qualified.link.remoteSessionId,
            linkData: qualified.link.linkData ?? {},
            signal,
            deadlineAtMs,
            maxSerializedBytes:
                EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveLinkedIdentity.maxSerializedBytes,
        });
        if (
            !resolved.ok
            || resolved.value.remoteSessionId !== qualified.link.remoteSessionId
            || resolved.value.source.kind
                !== qualified.link.qualifiedIdentity.source.kind
            || !preservesExternalSessionSourceIdentity(
                qualified.link.source as AgentExternalSessionSource,
                resolved.value.source,
            )
        ) {
            return null;
        }
        const connectedServiceProfile =
            resolveExternalSessionSourceConnectedServiceProfile({
                declaration: runtimeSnapshot.sourceDeclaration,
                source: resolved.value.source,
            });
        if (connectedServiceProfile.kind === 'invalid') return null;
        if (connectedServiceProfile.kind === 'resolved') {
            const accountProjection = Object.hasOwn(params, 'accountProjection')
                ? params.accountProjection ?? null
                : await readCurrentAccountProjection(signal);
            if (
                !accountProjection
                || !isConnectedServiceProfileCurrent(
                    accountProjection,
                    connectedServiceProfile.profile,
                )
            ) {
                return null;
            }
        }

        const grouping = ExternalAgentObservationResourceGroupingV1Schema.parse(
            runtimeSnapshot.externalSessionObservation.describeResource(
                resolved.value,
            ),
        );
        return {
            resource: {
                pluginId: qualified.link.qualifiedIdentity.agent.pluginId,
                agentLocalId: qualified.link.qualifiedIdentity.agent.localId,
                pluginGeneration: runtimeSnapshot.pluginGeneration,
                resourceKey: grouping.resourceKey,
                ...(runtimeSnapshot.retirementSignal
                    ? { retirementSignal: runtimeSnapshot.retirementSignal }
                    : {}),
            },
            link: {
                sessionId: params.sessionId,
                linkGeneration: params.linked.linkGeneration,
                linkKey: grouping.linkKey,
                linkedSource: resolved.value,
            },
            target: {
                qualifiedLinkIdentity: qualified.link.qualifiedIdentity,
                linkGeneration: params.linked.linkGeneration,
            },
        };
    } catch {
        return null;
    }
}
