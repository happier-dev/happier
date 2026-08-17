import {
    isExactPluginMachineMaterializationReleaseCorrespondenceV1,
    PluginMachineExecutionOriginV1Schema,
    type PluginMachineExecutionOriginV1,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import type { PluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability';
import {
    PluginUiArtifactsManifestEntryV1Schema,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    readPluginUiReactNativeBundleCacheIdentity,
} from '@/sync/domains/plugins/ui/artifactAdoption';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import type { PluginAccountAvailabilityReader } from './reader';

type CandidateCollectionReleaseExecutionTarget = Readonly<{
    availabilityCursor: number;
    facts: PluginReleaseFactsV1;
}>;

export type CandidateCollectionReleaseDaemonExecution = Readonly<{
    kind: 'daemon';
    /** The exact immutable Account release coordinate and read cursor. */
    release: CandidateCollectionReleaseExecutionTarget;
    origin: PluginMachineExecutionOriginV1;
    /** Active machine-RPC route paired with the origin-stamped projection. */
    serverId: string;
    artifactGraph: PluginUiArtifactsManifestEntryV1;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
}>;

export type CandidateCollectionReleaseExecutionResult =
    | Readonly<{ kind: 'available'; source: CandidateCollectionReleaseDaemonExecution }>
    | Readonly<{ kind: 'unavailable' }>;

function unavailable(): CandidateCollectionReleaseExecutionResult {
    return Object.freeze({ kind: 'unavailable' as const });
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function sameOrigin(
    left: PluginMachineExecutionOriginV1,
    right: PluginMachineExecutionOriginV1,
): boolean {
    return left.serverIdentityId === right.serverIdentityId
        && left.materializationRef.machineId === right.materializationRef.machineId
        && left.materializationRef.materializationId === right.materializationRef.materializationId
        && left.materializationRef.pluginId === right.materializationRef.pluginId;
}

function graphMatchesExactRelease(input: Readonly<{
    graph: PluginUiArtifactsManifestEntryV1;
    facts: PluginReleaseFactsV1;
}>): boolean {
    if (input.graph.tier !== 'reactNative' || input.graph.collectionMigrations === undefined) return false;
    return input.facts.uiSlots.some((slot) => (
        slot.contributionId === input.graph.contributionId
        && slot.tier === input.graph.tier
        && slot.platform === input.graph.platform
        && slot.artifactDigest === input.graph.digest
    ));
}

function current(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent: () => boolean;
}>): boolean {
    try {
        return input.accountLifetime.isCurrent() && input.isCurrent();
    } catch {
        return false;
    }
}

/**
 * Projects one daemon-owned candidate execution source from the already
 * generation-stamped raw PluginProjection V2. It selects neither an Account
 * release nor a machine: those remain Availability and Administration facts.
 */
export function resolveCandidateCollectionReleaseExecution(input: Readonly<{
    target: CandidateCollectionReleaseExecutionTarget;
    projection: PluginProjectionV2 | null;
    reader: PluginAccountAvailabilityReader | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    daemon: Readonly<{
        serverId: string | null;
        serverIdentityId: string | null;
        machineId: string | null;
    }>;
    /** The present-user action lifetime supplied by the Account selection caller. */
    isCurrent: () => boolean;
}>): CandidateCollectionReleaseExecutionResult {
    if (!current(input) || !input.projection || !input.reader) return unavailable();
    const serverId = input.daemon.serverId?.trim();
    const serverIdentityId = input.daemon.serverIdentityId?.trim();
    const machineId = input.daemon.machineId?.trim();
    if (!serverId || !serverIdentityId || !machineId) return unavailable();

    const candidateEntries = Object.values(input.projection.familiesById.pluginUi?.entriesById ?? {})
        .map(readRecord)
        .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null)
        .filter((entry) => (
            entry.pluginId === input.target.facts.ref.pluginId
            && entry.pluginVersion === input.target.facts.ref.version
            && entry.contributionKind === 'reactNativeBundle'
            && entry.generatedV2 === true
            && entry.generatedOwnerKind === 'collectionMigrations'
        ));
    if (candidateEntries.length !== 1) return unavailable();
    const entry = candidateEntries[0]!;
    const graph = PluginUiArtifactsManifestEntryV1Schema.safeParse(entry.artifactGraph);
    const runtime = readRecord(entry.runtime);
    const cacheIdentity = readPluginUiReactNativeBundleCacheIdentity(runtime?.cacheIdentity);
    const origin = PluginMachineExecutionOriginV1Schema.safeParse({
        serverIdentityId: entry.serverIdentityId,
        materializationRef: entry.materializationRef,
    });
    if (
        !graph.success
        || !cacheIdentity
        || !origin.success
        || entry.contributionId !== graph.data.contributionId
        || !graphMatchesExactRelease({ graph: graph.data, facts: input.target.facts })
        || cacheIdentity.pluginId !== input.target.facts.ref.pluginId
        || cacheIdentity.contributionId !== graph.data.contributionId
        || cacheIdentity.artifactDigest !== graph.data.digest
        || cacheIdentity.platform !== graph.data.platform
        || cacheIdentity.projectionGeneration !== input.projection.generation
        || origin.data.serverIdentityId !== serverIdentityId
        || origin.data.materializationRef.machineId !== machineId
        || origin.data.materializationRef.pluginId !== input.target.facts.ref.pluginId
    ) {
        return unavailable();
    }

    const materializations = input.reader.readMaterializations();
    if (materializations.kind !== 'available') return unavailable();
    const matchedMaterializations = materializations.materializations.filter((materialization) => (
        materialization.serverIdentityId === origin.data.serverIdentityId
        && materialization.machineId === origin.data.materializationRef.machineId
        && materialization.materializationId === origin.data.materializationRef.materializationId
        && materialization.pluginId === origin.data.materializationRef.pluginId
    ));
    if (matchedMaterializations.length !== 1) return unavailable();
    const materialization = matchedMaterializations[0]!;
    const materializationOrigin = PluginMachineExecutionOriginV1Schema.parse({
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: {
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        },
    });
    if (
        materialization.enabled !== true
        || materialization.trustState !== 'trusted'
        || !sameOrigin(origin.data, materializationOrigin)
        || !isExactPluginMachineMaterializationReleaseCorrespondenceV1(
            materialization,
            input.target.facts,
        )
        || !current(input)
    ) {
        return unavailable();
    }

    return Object.freeze({
        kind: 'available' as const,
        source: Object.freeze({
            kind: 'daemon' as const,
            release: Object.freeze({
                availabilityCursor: input.target.availabilityCursor,
                facts: input.target.facts,
            }),
            origin: origin.data,
            serverId,
            artifactGraph: graph.data,
            cacheIdentity,
        }),
    });
}
