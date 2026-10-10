import { arePluginMachineExecutionOriginsEqual, arePluginMachineMaterializationRefsEqual, PluginMachineMaterializationExecutionOriginV1Schema, type PluginMachineMaterializationExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { isExactPluginMachineMaterializationReleaseCorrespondenceV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { resolvePluginCollectionMigrationArtifactOwnerV1 } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    type PluginUiArtifactsManifestEntryV2,
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
    origin: PluginMachineMaterializationExecutionOriginV1;
    /** Active machine-RPC route paired with the origin-stamped projection. */
    serverId: string;
    artifactGraph: PluginUiArtifactsManifestEntryV2;
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

function graphMatchesExactRelease(input: Readonly<{
    graph: PluginUiArtifactsManifestEntryV2;
    facts: PluginReleaseFactsV1;
}>): boolean {
    const owner = resolvePluginCollectionMigrationArtifactOwnerV1(
        input.facts.normalizedManifest.contributes.accountCollections,
    );
    if (
        !owner
        || input.graph.tier !== 'reactNative'
        || input.graph.artifactId !== owner.reference.artifactId
        || !input.graph.executable.exports.includes(owner.reference.exportName)
    ) return false;
    return input.facts.uiSlots.some((slot) => (
        slot.contributionId === owner.contributionId
        && slot.artifactId === input.graph.artifactId
        && slot.tier === input.graph.tier
        && slot.artifactDigest === input.graph.digest
        && slot.hostUiApiRange === input.graph.hostUiApiRange
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
    const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(entry.artifactGraph);
    const runtime = readRecord(entry.runtime);
    const contributionId = typeof entry.contributionId === 'string' ? entry.contributionId : '';
    const slot = graph.success ? input.target.facts.uiSlots.find((candidate) => (
        candidate.contributionId === contributionId
        && candidate.artifactId === graph.data.artifactId
        && candidate.artifactDigest === graph.data.digest
    )) : undefined;
    const cacheIdentity = graph.success && graph.data.tier === 'reactNative' && slot
        ? readPluginUiReactNativeBundleCacheIdentity(runtime?.cacheIdentity, {
            pluginId: input.target.facts.ref.pluginId,
            contributionId,
            artifactId: graph.data.artifactId,
            platform: slot.platform,
        })
        : null;
    const origin = PluginMachineMaterializationExecutionOriginV1Schema.safeParse({
        serverIdentityId: entry.serverIdentityId,
        materializationRef: entry.materializationRef,
    });
    if (
        !graph.success
        || !cacheIdentity
        || !origin.success
        || !graphMatchesExactRelease({ graph: graph.data, facts: input.target.facts })
        || cacheIdentity.pluginId !== input.target.facts.ref.pluginId
        || cacheIdentity.artifactDigest !== graph.data.digest
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
        && arePluginMachineMaterializationRefsEqual(materialization, origin.data.materializationRef)
    ));
    if (matchedMaterializations.length !== 1) return unavailable();
    const materialization = matchedMaterializations[0]!;
    const materializationOrigin = PluginMachineMaterializationExecutionOriginV1Schema.parse({
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
        || !arePluginMachineExecutionOriginsEqual(origin.data, materializationOrigin)
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
