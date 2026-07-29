import type {
    ExternalAgentObservationLeafFactV1,
    ExternalAgentObservationTargetV1,
    ExternalSessionsAgentId,
} from '@happier-dev/protocol';
import type {
    AgentExternalSessionLinkData,
    AgentExternalSessionSource,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import { executeExternalSessionLinkEnsureAction } from '@/session/actions/externalSessions/discoveryLinkActions';
import { resolveExternalSessionSourceKeyOwner } from '@/session/actions/externalSessions/providerOpsResolution';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { readCredentials } from '@/persistence';
import {
    loadCanonicalCurrentExternalSessionStatusDemandLink,
} from '@/api/session/external/leases/applyExternalSessionStatusDemandBatch';
import {
    resolveExternalSessionObservationLinkInput,
    type ExternalSessionObservationLinkInput,
} from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import {
    resolveExternalSessionTagLookupCandidates,
} from '@/api/session/external/linking/externalSessionTagLookupCandidates';
import {
    isCurrentExternalSessionLinkStorageState,
} from '@/api/session/external/linking/currentExternalSessionLinkStorageEligibility';
import {
    resolveExternalSessionIndexedTagLookup,
    type ExternalSessionIndexedTagLookupProof,
} from '@/api/session/external/linking/ensureExternalSessionLink';
import { loadLinkedExternalSessionFromRaw } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { deepEqual } from '@/utils/deterministicJson';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
    createQualifiedExternalSessionHookIngress,
    type QualifiedExternalSessionHookRuntimeLease,
} from './qualifiedExternalSessionHookIngress';
import {
    isExternalSessionHookAutoLinkPolicyCurrent,
    resolveExternalSessionHookAutoLinkPolicy,
} from './resolveExternalSessionHookAutoLinkPolicy';

type Projection = Readonly<{
    resolveQualifiedCurrentLink(input: Readonly<{
        qualifiedIdentity: ExternalAgentObservationTargetV1[
            'qualifiedLinkIdentity'
        ];
        source: AgentExternalSessionSource;
        remoteSessionId: string;
        linkData?: AgentExternalSessionLinkData;
    }>): Readonly<{
        sessionId: string;
        linkGeneration: string;
    }> | null;
    admitQualifiedFacts(input: Readonly<{
        sessionId: string;
        target: ExternalAgentObservationTargetV1;
        facts: readonly ExternalAgentObservationLeafFactV1[];
        shouldCommit?: () => boolean;
    }>): Promise<boolean>;
    admitQualifiedFactsForCurrentLink(input: Readonly<{
        resolved: ExternalSessionObservationLinkInput;
        facts: readonly ExternalAgentObservationLeafFactV1[];
        shouldCommit?: () => boolean;
    }>): Promise<boolean>;
}>;

type DurableCurrentLinkRequest = Readonly<{
    machineId: string;
    agentId: string;
    identity: Readonly<{
        qualifiedIdentity:
            ExternalAgentObservationTargetV1['qualifiedLinkIdentity'];
        source: AgentExternalSessionSource;
        remoteSessionId: string;
        linkData?: AgentExternalSessionLinkData;
    }>;
    sessionId?: string;
    signal: AbortSignal;
    deadlineAtMs: number;
}>;

type DurableCurrentLinkResolution =
    | ExternalSessionObservationLinkInput
    | Readonly<{
        state: 'absent';
        indexedTagLookupProof: ExternalSessionIndexedTagLookupProof;
    }>
    | Readonly<{ state: 'blocked' }>;

function matchesDurableCurrentLink(
    resolved: ExternalSessionObservationLinkInput,
    request: DurableCurrentLinkRequest,
): boolean {
    return (
        deepEqual(
            resolved.target.qualifiedLinkIdentity,
            request.identity.qualifiedIdentity,
        )
        && deepEqual(resolved.link.linkedSource.source, request.identity.source)
        && resolved.link.linkedSource.remoteSessionId
            === request.identity.remoteSessionId
        && deepEqual(
            resolved.link.linkedSource.linkData ?? {},
            request.identity.linkData ?? {},
        )
    );
}

async function loadDurableCurrentLinkBySessionId(
    request: DurableCurrentLinkRequest & Readonly<{ sessionId: string }>,
): Promise<ExternalSessionObservationLinkInput | null> {
    const current =
        await loadCanonicalCurrentExternalSessionStatusDemandLink({
            sessionId: request.sessionId,
            machineId: request.machineId,
            signal: request.signal,
            deadlineAtMs: request.deadlineAtMs,
        }).catch(() => null);
    if (
        !current
        || current.linked.agentId !== request.agentId
        || current.machineId !== request.machineId
    ) {
        return null;
    }
    const resolved = await resolveExternalSessionObservationLinkInput({
        linked: current.linked,
        sessionId: request.sessionId,
        signal: request.signal,
        deadlineAtMs: request.deadlineAtMs,
    }).catch(() => null);
    return resolved && matchesDurableCurrentLink(resolved, request)
        ? resolved
        : null;
}

export async function resolveDurableCurrentLink(
    request: DurableCurrentLinkRequest,
): Promise<DurableCurrentLinkResolution | null> {
    if (request.sessionId) {
        return await loadDurableCurrentLinkBySessionId({
            ...request,
            sessionId: request.sessionId,
        });
    }
    const credentials = await readCredentials().catch(() => null);
    if (!credentials) return null;
    const sourceKeyOwner = await resolveExternalSessionSourceKeyOwner(
        request.agentId as ExternalSessionsAgentId,
        request.identity.source,
    ).catch(() => null);
    if (!sourceKeyOwner) return null;
    const releasedSourceKeys = sourceKeyOwner.resolvePersistedSourceKeys(
        request.identity.source,
    );
    if (!releasedSourceKeys) return null;
    const tagCandidates = resolveExternalSessionTagLookupCandidates({
        machineId: request.machineId,
        agentId: request.agentId as ExternalSessionsAgentId,
        source: request.identity.source,
        releasedPersistedSource: request.identity.source,
        remoteSessionId: request.identity.remoteSessionId,
        sourceKey: sourceKeyOwner.sourceKey,
        releasedSourceKeys,
    });
    const lookup = await resolveExternalSessionIndexedTagLookup({
        credentials,
        machineId: request.machineId,
        agentId: request.agentId as ExternalSessionsAgentId,
        remoteSessionId: request.identity.remoteSessionId,
        source: request.identity.source,
        tagCandidates,
        resolveSourceKey: sourceKeyOwner.resolveSourceKey,
        signal: request.signal,
        deadlineAtMs: request.deadlineAtMs,
    }).catch(() => null);
    if (!lookup || lookup.state !== 'available') {
        return { state: 'blocked' };
    }
    if (!lookup.existing) {
        return {
            state: 'absent',
            indexedTagLookupProof: lookup.proof,
        };
    }
    if (
        lookup.existing.kind !== 'external_link'
        || !isCurrentExternalSessionLinkStorageState(
            lookup.existing.currentStorageState,
        )
    ) {
        return { state: 'blocked' };
    }
    const loaded = await loadLinkedExternalSessionFromRaw({
        credentials,
        rawSession: lookup.existing.rawSession,
        machineId: request.machineId,
    }).catch(() => null);
    if (!loaded?.ok) return { state: 'blocked' };
    const resolved = await resolveExternalSessionObservationLinkInput({
        linked: loaded.session,
        sessionId: lookup.existing.sessionId,
        signal: request.signal,
        deadlineAtMs: request.deadlineAtMs,
    }).catch(() => null);
    return resolved && matchesDurableCurrentLink(resolved, request)
        ? resolved
        : { state: 'blocked' };
}

export function createQualifiedExternalSessionHookDaemonIngress(input: Readonly<{
    machineId: string;
    projection: Projection;
    isFeatureEnabled(): boolean;
    shouldCommit?: () => boolean;
    readAccountScopeKey?: () => string | null;
    resolveDurableCurrentLink?: (
        request: DurableCurrentLinkRequest,
    ) => Promise<DurableCurrentLinkResolution | null>;
    acquireRuntime?: (request: Readonly<{
        qualifiedContributionId:
            ExternalAgentObservationTargetV1['qualifiedLinkIdentity']['agent'];
        agentId: string;
        pluginGeneration: string;
        variantId: string;
    }>) => Promise<QualifiedExternalSessionHookRuntimeLease | null>;
}>) {
    const resolveDurable = input.resolveDurableCurrentLink
        ?? resolveDurableCurrentLink;
    return createQualifiedExternalSessionHookIngress({
        readAccountScopeKey: input.readAccountScopeKey ?? (() =>
            getActiveAccountSettingsSnapshot()?.scopeKey?.trim() || null),
        shouldCommit: () => (
            input.isFeatureEnabled()
            && (input.shouldCommit?.() ?? true)
        ),
        acquireRuntime: input.acquireRuntime ?? (async (request) => {
            if (!input.isFeatureEnabled()) return null;
            const registryLease =
                await acquireAuthoritativePluginRuntimeRegistryLease()
                    .catch(() => null);
            if (!registryLease) return null;
            const definition = registryLease.registry.contributes
                .agentDefinitionsById.get(request.agentId);
            const runtime = registryLease.registry.agentRuntimesByAgentId
                .get(request.agentId);
            if (
                definition?.identity?.pluginId
                    !== request.qualifiedContributionId.pluginId
                || definition.identity.localId
                    !== request.qualifiedContributionId.localId
                || runtime?.pluginId
                    !== request.qualifiedContributionId.pluginId
                || runtime.agentId !== request.agentId
                || runtime.generation !== request.pluginGeneration
                || !runtime.externalSessions
                || !runtime.externalSessionHooks
                || !runtime.retirementSignal
                || runtime.retirementSignal.aborted
                || !runtime.isCurrent()
                || !runtime.externalSessionHooks.installationVariants.some(
                    (variant) => variant.variantId === request.variantId,
                )
            ) {
                await registryLease.release().catch(() => undefined);
                return null;
            }
            return {
                hooks: runtime.externalSessionHooks,
                externalSessions: runtime.externalSessions,
                generation: runtime.generation,
                retirementSignal: runtime.retirementSignal,
                isCurrent: () => (
                    runtime.isCurrent()
                    && !runtime.retirementSignal!.aborted
                ),
                release: async () =>
                    await registryLease.release().catch(() => undefined),
            };
        }),
        resolveCurrentLink: async ({
            machineId,
            agentId,
            identity,
            sessionId,
            signal,
            deadlineAtMs,
        }) => {
            if (!input.isFeatureEnabled()) return null;
            const projected = input.projection.resolveQualifiedCurrentLink({
                qualifiedIdentity: identity.qualifiedIdentity,
                source: identity.source,
                remoteSessionId: identity.remoteSessionId,
                ...(identity.linkData
                    ? { linkData: identity.linkData }
                    : {}),
            });
            if (projected) return { state: 'linked' as const, ...projected };
            const durable = await resolveDurable({
                machineId,
                agentId,
                identity,
                ...(sessionId ? { sessionId } : {}),
                signal,
                deadlineAtMs,
            });
            if (!durable) return { state: 'blocked' as const };
            if ('state' in durable) return durable;
            return {
                    state: 'linked' as const,
                    sessionId: durable.link.sessionId,
                    linkGeneration: durable.link.linkGeneration,
                };
        },
        admitFacts: async (request) => {
            if (!input.isFeatureEnabled()) {
                throw new Error(
                    'Qualified External Session hook feature is disabled',
                );
            }
            const admitted =
                await input.projection.admitQualifiedFacts(request);
            if (admitted) return;
            const durable = await resolveDurable({
                machineId: input.machineId,
                agentId: request.agentId,
                identity: request.identity,
                sessionId: request.sessionId,
                signal: request.signal,
                deadlineAtMs: request.deadlineAtMs,
            });
            const admittedFromDurable = durable
                && 'link' in durable
                && durable.link.linkGeneration === request.target.linkGeneration
                && deepEqual(durable.target, request.target)
                ? await input.projection.admitQualifiedFactsForCurrentLink({
                    resolved: durable,
                    facts: request.facts,
                    ...(request.shouldCommit
                        ? { shouldCommit: request.shouldCommit }
                        : {}),
                })
                : false;
            if (!admittedFromDurable) {
                throw new Error(
                    'Qualified External Session hook target is stale',
                );
            }
        },
        readAutoLinkPolicy: async (request) =>
            input.isFeatureEnabled()
                ? await resolveExternalSessionHookAutoLinkPolicy(request, {
                    resolveSourceKeyOwner: async (agentId, source) =>
                        await resolveExternalSessionSourceKeyOwner(
                            agentId,
                            source,
                        ),
                    })
                : null,
        isAutoLinkPolicyCurrent: (request) =>
            input.isFeatureEnabled()
            && isExternalSessionHookAutoLinkPolicyCurrent(request),
        ensureLink: async (request) => {
            if (
                !input.isFeatureEnabled()
                ||
                request.machineId !== input.machineId
                || request.storageMode !== 'machine_only'
            ) {
                throw new Error(
                    'Qualified External Session hook link scope mismatch',
                );
            }
            const result = await executeExternalSessionLinkEnsureAction(
                {
                    machineId: request.machineId,
                    agentId: request.agentId,
                    source: request.source,
                    remoteSessionId: request.remoteSessionId,
                    ...(request.linkData ? { linkData: request.linkData } : {}),
                },
                {
                    expectedSourceKey: request.expectedSourceKey,
                    requireIndexedTagLookup: true,
                    signal: request.signal,
                    deadlineAtMs: request.deadlineAtMs,
                    ...(request.indexedTagLookupProof
                        ? {
                            indexedTagLookupProof:
                                request.indexedTagLookupProof,
                        }
                        : {}),
                    ...(request.shouldCommit
                        ? { shouldCommit: request.shouldCommit }
                        : {}),
                },
            );
            if (!result.ok) {
                throw new Error(
                    'Qualified External Session hook link ensure failed',
                );
            }
            return {
                sessionId: result.sessionId,
                created: result.created,
            };
        },
    });
}
