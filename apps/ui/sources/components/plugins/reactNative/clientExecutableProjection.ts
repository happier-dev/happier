import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { DaemonPluginUiArtifactByteIdentityV1Schema, type PluginProjectedDragSourceEntryV1, type PluginProjectedDropTargetEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginContributionClientPlatform } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    type PluginUiArtifactsManifestEntryV2,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginReactNativeExecutableModuleReference } from './loader';
import {
    getPluginUiClientExecutableTargetAddressKey,
    type PluginUiClientExecutableActivation,
    type PluginUiClientExecutableTarget,
} from './clientExecutableContributions';
import {
    isPluginProjectedActionExecutable,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    readPluginUiContributionOrigin,
    readPluginUiProjectionEntryExecutionOrigin,
    type PluginUiContributionOriginV1,
} from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

type UnknownRecord = Readonly<Record<string, unknown>>;
type ProjectedConversationVoiceProvider = Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>;

/**
 * A machine-scoped projection is already current at the direct currentness
 * owner. App unions carry the same fact on each contribution instead. These
 * are two input forms of one projection owner, not a local fallback.
 */
export type PluginUiClientExecutableProjectionSource = Readonly<{
    projection: PluginUiProjectionModel;
    directMachineAuthority?: Readonly<{
        machineId: string;
        serverId: string | null;
    }>;
}>;

export type PluginUiClientExecutableArtifactAnchor =
    | Readonly<{
        artifactOwnerKind: 'clientContribution';
        clientContribution: Readonly<{
            family: 'actions';
            action: Readonly<{
                pluginId: string;
                localId: string;
            }>;
        }>;
    }>
    | Readonly<{
        artifactOwnerKind: 'clientContribution';
        clientContribution: Readonly<{ family: 'dragSources' | 'dropTargets'; contribution: Readonly<{ pluginId: string; localId: string }> }>;
    }>
    | Readonly<{
        artifactOwnerKind: 'voiceProvider';
    }>;

/** Raw Voice facts retained only for the Voice-derived registration scope. */
export type PluginUiProjectedClientExecutableVoiceProvider = Readonly<{
    entry: PluginUiProjectionModel['voiceProvidersById'][string];
    declaration: ProjectedConversationVoiceProvider;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
}>;

/**
 * One fully normalized installed target. Projection owns all target/origin,
 * Artifact, cache, and family grouping decisions before activation sees it.
 */
export type PluginUiProjectedClientExecutableTarget = Readonly<{
    pluginId: string;
    occurrenceId: string;
    hostUiApiRange: string;
    pluginVersion?: string;
    immutableGenerationId?: string;
    actions: readonly PluginUiProjectionModel['actionsById'][string][];
    voiceProviders: readonly PluginUiProjectedClientExecutableVoiceProvider[];
    contributes: Readonly<Record<string, unknown>>;
    target: PluginUiClientExecutableTarget;
    /**
     * The materialization that owns effects, when the plugin has one. A
     * bundled or development plugin has none; `authority` (the projecting
     * daemon's transport) is then its only route, exactly as for bytes.
     */
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    projectionGeneration: number;
    authority: PluginUiClientExecutableActivation['authority'];
    artifactGraph: PluginUiArtifactsManifestEntryV2;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    moduleReference: PluginReactNativeExecutableModuleReference;
    artifactAnchor: PluginUiClientExecutableArtifactAnchor;
    artifactSelectionOwner?: 'accountRelease' | 'daemonProjection';
}>;

type ProjectedExecutableOrigin = Readonly<{
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    projectionGeneration: number;
    authority: PluginUiClientExecutableActivation['authority'];
}>;

type ResolvedProjectedClientExecutableContribution = Readonly<{
    family: 'actions' | 'voiceProviders' | 'dragSources' | 'dropTargets';
    localId: string;
    pluginId: string;
    occurrenceId: string;
    pluginVersion?: string;
    immutableGenerationId?: string;
    target: PluginUiClientExecutableTarget;
    /**
     * The materialization that owns effects, when the plugin has one. A
     * bundled or development plugin has none; `authority` (the projecting
     * daemon's transport) is then its only route, exactly as for bytes.
     */
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    projectionGeneration: number;
    authority: PluginUiClientExecutableActivation['authority'];
    artifactGraph: PluginUiArtifactsManifestEntryV2;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    moduleReference: PluginReactNativeExecutableModuleReference;
    artifactAnchor: PluginUiClientExecutableArtifactAnchor;
    artifactSelectionOwner?: 'accountRelease' | 'daemonProjection';
    action?: PluginUiProjectionModel['actionsById'][string];
    entityDeclaration?: PluginProjectedDragSourceEntryV1['definition'] | PluginProjectedDropTargetEntryV1['definition'];
    voiceProvider?: PluginUiProjectedClientExecutableVoiceProvider;
}>;

type ProjectedClientExecutableTargetGroup = {
    first: ResolvedProjectedClientExecutableContribution;
    technicalKey: string;
    contributions: ResolvedProjectedClientExecutableContribution[];
    conflict: boolean;
};

function asRecord(value: unknown): UnknownRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function isCurrentUnionOrigin(
    origin: PluginUiContributionOriginV1 | null,
): origin is PluginUiContributionOriginV1 & Readonly<{ generation: number }> {
    return origin !== null
        && origin.phase === 'current'
        && origin.interactionEnabled
        && typeof origin.generation === 'number'
        && Number.isInteger(origin.generation)
        && origin.generation >= 0
        // The projecting daemon is the route. A materialization, when the
        // plugin has one, must live on that same machine.
        && (origin.executionOrigin === null
            || getPluginMachineExecutionOriginRef(origin.executionOrigin).machineId === origin.machineId);
}

/** A materialization, when present, must belong to the plugin it serves. */
function originServesPlugin(origin: ProjectedExecutableOrigin, pluginId: string): boolean {
    return origin.executionOrigin === null
        || getPluginMachineExecutionOriginRef(origin.executionOrigin).pluginId === pluginId;
}

function readCurrentProjectedExecutableOrigin(input: Readonly<{
    entry: unknown;
    source: PluginUiClientExecutableProjectionSource;
}>): ProjectedExecutableOrigin | null {
    const directMachineAuthority = input.source.directMachineAuthority;
    if (!directMachineAuthority) {
        const unionOrigin = readPluginUiContributionOrigin(input.entry);
        if (!isCurrentUnionOrigin(unionOrigin)) return null;
        return Object.freeze({
            executionOrigin: unionOrigin.executionOrigin,
            projectionGeneration: unionOrigin.generation,
            authority: Object.freeze({
                serverId: unionOrigin.serverId,
                machineId: unionOrigin.machineId,
            }),
        });
    }

    const projectionGeneration = input.source.projection.generation;
    const executionOrigin = readPluginUiProjectionEntryExecutionOrigin(input.entry) ?? null;
    if (
        typeof projectionGeneration !== 'number'
        || !Number.isInteger(projectionGeneration)
        || projectionGeneration < 0
        || (executionOrigin !== null
            && getPluginMachineExecutionOriginRef(executionOrigin).machineId !== directMachineAuthority.machineId)
    ) {
        return null;
    }
    return Object.freeze({
        executionOrigin,
        projectionGeneration,
        authority: Object.freeze({
            serverId: directMachineAuthority.serverId,
            machineId: directMachineAuthority.machineId,
        }),
    });
}

function areProjectedExecutableOriginsEqual(
    left: ProjectedExecutableOrigin,
    right: ProjectedExecutableOrigin,
): boolean {
    return left.authority.serverId === right.authority.serverId
        && left.authority.machineId === right.authority.machineId
        && (left.executionOrigin === null || right.executionOrigin === null
            ? left.executionOrigin === right.executionOrigin
            : arePluginMachineExecutionOriginsEqual(left.executionOrigin, right.executionOrigin));
}

function readRuntimeFacts(bundle: UnknownRecord): Readonly<{
    state: string | null;
    source: string | null;
    artifactDigest: PluginUiArtifactDigestV1 | null;
}> {
    const runtime = asRecord(bundle.runtime);
    const decision = asRecord(runtime?.decision);
    const loadPolicy = asRecord(runtime?.loadPolicy);
    const identity = DaemonPluginUiArtifactByteIdentityV1Schema.safeParse(runtime?.cacheIdentity);
    return Object.freeze({
        state: typeof decision?.state === 'string' ? decision.state : null,
        source: typeof loadPolicy?.source === 'string' ? loadPolicy.source : null,
        artifactDigest: identity.success ? identity.data.artifactDigest : null,
    });
}

function readModuleReference(input: Readonly<{
    pluginId: string;
    artifactId: string;
    target: PluginUiClientExecutableTarget;
    artifactGraph: PluginUiArtifactsManifestEntryV2;
}>): PluginReactNativeExecutableModuleReference | null {
    return input.artifactGraph.tier === 'reactNative'
        && input.artifactGraph.artifactId === input.artifactId
        && input.artifactGraph.executable.exports.includes(input.target.exportName)
        ? Object.freeze({ exportName: input.target.exportName })
        : null;
}

function readInstalledPluginVersion(
    projection: PluginUiProjectionModel,
    pluginId: string,
): string | undefined {
    const version = projection.installedPackagesById[pluginId]?.version;
    return typeof version === 'string' && version.trim().length > 0 ? version : undefined;
}

/**
 * Equivalent target names share executable evaluation only when their byte and
 * ABI identities agree. Plugin/package occurrences select physical activation
 * lifetimes; they are deliberately absent from this byte-sharing key.
 */
function targetTechnicalKey(candidate: ResolvedProjectedClientExecutableContribution): string {
    return [
        candidate.cacheIdentity.artifactDigest,
        candidate.moduleReference.exportName,
        candidate.cacheIdentity.platform,
        candidate.artifactGraph.hostUiApiRange,
    ].join('\u0000');
}

function readActionCandidate(input: Readonly<{
    action: PluginUiProjectionModel['actionsById'][string];
    source: PluginUiClientExecutableProjectionSource;
    platform: PluginContributionClientPlatform;
}>): ResolvedProjectedClientExecutableContribution | null {
    const { action } = input;
    if (!isPluginProjectedActionExecutable(action) || action.execution.target !== 'client') return null;
    if (!action.execution.platforms.includes(input.platform)) return null;
    return readClientContributionCandidate({ ...input, family: 'actions', entry: action, localId: action.id,
        contributionId: action.id, client: action.execution.client, action });
}

/** The same artifact/currentness admission serves every client callback family. */
function readClientContributionCandidate(input: Readonly<{
    family: 'actions' | 'dragSources' | 'dropTargets';
    entry: UnknownRecord & Readonly<{ pluginId: string; occurrenceId?: string }>;
    localId: string;
    contributionId: string;
    client: Readonly<{ artifactId: string; exportName: string }>;
    source: PluginUiClientExecutableProjectionSource;
    platform: PluginContributionClientPlatform;
    action?: PluginUiProjectionModel['actionsById'][string];
    entityDeclaration?: PluginProjectedDragSourceEntryV1['definition'] | PluginProjectedDropTargetEntryV1['definition'];
}>): ResolvedProjectedClientExecutableContribution | null {
    const { entry, localId, contributionId, client } = input;
    if (!entry.occurrenceId) return null;
    const origin = readCurrentProjectedExecutableOrigin({ entry, source: input.source });
    if (!origin || !originServesPlugin(origin, entry.pluginId)) return null;
    const bundle = input.source.projection.reactNativeBundlesById[
        `reactNativeBundle:${entry.pluginId}:${contributionId}`
    ];
    if (
        !bundle
        || bundle.pluginId !== entry.pluginId
        || bundle.contributionId !== contributionId
        || bundle.generatedOwnerKind !== 'clientContribution'
    ) {
        return null;
    }
    const bundleOrigin = readCurrentProjectedExecutableOrigin({ entry: bundle, source: input.source });
    if (!bundleOrigin || !areProjectedExecutableOriginsEqual(origin, bundleOrigin)) return null;

    const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.safeParse(bundle.artifactGraph);
    const runtime = readRuntimeFacts(bundle);
    const cacheIdentity: PluginReactNativeBundleCacheIdentity | null = runtime.artifactDigest
        ? Object.freeze({
            pluginId: entry.pluginId,
            contributionId,
            artifactId: client.artifactId,
            artifactDigest: runtime.artifactDigest,
            platform: input.platform,
        })
        : null;
    if (
        !artifactGraph.success
        || runtime.state !== 'load'
        || runtime.source !== 'installedArtifact'
        || cacheIdentity === null
        || artifactGraph.data.tier !== 'reactNative'
        || artifactGraph.data.artifactId !== client.artifactId
        || cacheIdentity.pluginId !== entry.pluginId
        || cacheIdentity.contributionId !== contributionId
        || cacheIdentity.artifactDigest !== artifactGraph.data.digest
        || cacheIdentity.platform !== input.platform
        || (bundle.artifactSelectionOwner !== undefined
            && bundle.artifactSelectionOwner !== 'accountRelease'
            && bundle.artifactSelectionOwner !== 'daemonProjection')
    ) {
        return null;
    }
    const target = Object.freeze({
        artifactId: client.artifactId,
        exportName: client.exportName,
        platform: input.platform,
    });
    const moduleReference = readModuleReference({
        pluginId: entry.pluginId,
        artifactId: client.artifactId,
        target,
        artifactGraph: artifactGraph.data,
    });
    if (!moduleReference) return null;

    const artifactAnchor: PluginUiClientExecutableArtifactAnchor = input.family === 'actions'
        ? Object.freeze({
            artifactOwnerKind: 'clientContribution',
            clientContribution: Object.freeze({ family: 'actions', action: Object.freeze({ pluginId: entry.pluginId, localId }) }),
        })
        : Object.freeze({
            artifactOwnerKind: 'clientContribution',
            clientContribution: Object.freeze({ family: input.family, contribution: Object.freeze({ pluginId: entry.pluginId, localId }) }),
        });

    return Object.freeze({
        family: input.family,
        localId,
        pluginId: entry.pluginId,
        occurrenceId: entry.occurrenceId,
        immutableGenerationId: input.source.projection.installedPackagesById[entry.pluginId]?.immutableGenerationId,
        ...(readInstalledPluginVersion(input.source.projection, entry.pluginId) === undefined
            ? {}
            : { pluginVersion: readInstalledPluginVersion(input.source.projection, entry.pluginId) }),
        target,
        executionOrigin: origin.executionOrigin,
        projectionGeneration: origin.projectionGeneration,
        authority: origin.authority,
        artifactGraph: artifactGraph.data,
        cacheIdentity,
        moduleReference,
        artifactAnchor,
        ...(bundle.artifactSelectionOwner
            ? { artifactSelectionOwner: bundle.artifactSelectionOwner }
            : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.entityDeclaration ? { entityDeclaration: input.entityDeclaration } : {}),
    });
}

function readVoiceCandidate(input: Readonly<{
    entry: PluginUiProjectionModel['voiceProvidersById'][string];
    source: PluginUiClientExecutableProjectionSource;
    platform: PluginContributionClientPlatform;
}>): ResolvedProjectedClientExecutableContribution | null {
    const { entry } = input;
    const declaration = entry.definition;
    const occurrenceId = typeof entry.occurrenceId === 'string' && entry.occurrenceId.trim().length > 0
        ? entry.occurrenceId
        : null;
    if (
        declaration.kind !== 'conversation'
        || !declaration.platforms.includes(input.platform)
        || occurrenceId === null
    ) return null;
    const expectedId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
        pluginId: entry.pluginId,
        localId: declaration.id,
    }));
    if (entry.id !== expectedId || entry.contributionKey !== expectedId) return null;

    const origin = readCurrentProjectedExecutableOrigin({ entry, source: input.source });
    if (!origin || !originServesPlugin(origin, entry.pluginId)) return null;
    const bundle = input.source.projection.reactNativeBundlesById[
        `reactNativeBundle:${entry.pluginId}:${declaration.id}`
    ];
    if (
        !bundle
        || bundle.pluginId !== entry.pluginId
        || bundle.contributionId !== declaration.id
        || bundle.generatedOwnerKind !== 'voiceProvider'
    ) {
        return null;
    }
    const bundleOrigin = readCurrentProjectedExecutableOrigin({ entry: bundle, source: input.source });
    if (!bundleOrigin || !areProjectedExecutableOriginsEqual(origin, bundleOrigin)) return null;

    const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.safeParse(bundle.artifactGraph);
    const runtime = readRuntimeFacts(bundle);
    const cacheIdentity: PluginReactNativeBundleCacheIdentity | null = runtime.artifactDigest
        ? Object.freeze({
            pluginId: entry.pluginId,
            contributionId: declaration.id,
            artifactId: declaration.client.artifactId,
            artifactDigest: runtime.artifactDigest,
            platform: input.platform,
        })
        : null;
    if (
        !artifactGraph.success
        || runtime.state !== 'load'
        || runtime.source !== 'installedArtifact'
        || cacheIdentity === null
        || artifactGraph.data.tier !== 'reactNative'
        || artifactGraph.data.artifactId !== declaration.client.artifactId
        || cacheIdentity.pluginId !== entry.pluginId
        || cacheIdentity.contributionId !== declaration.id
        || cacheIdentity.artifactDigest !== artifactGraph.data.digest
        || cacheIdentity.platform !== input.platform
        || (bundle.artifactSelectionOwner !== undefined
            && bundle.artifactSelectionOwner !== 'accountRelease'
            && bundle.artifactSelectionOwner !== 'daemonProjection')
    ) {
        return null;
    }
    const target = Object.freeze({
        artifactId: declaration.client.artifactId,
        exportName: declaration.client.exportName,
        platform: input.platform,
    });
    const moduleReference = readModuleReference({
        pluginId: entry.pluginId,
        artifactId: declaration.client.artifactId,
        target,
        artifactGraph: artifactGraph.data,
    });
    if (!moduleReference) return null;

    return Object.freeze({
        family: 'voiceProviders',
        localId: declaration.id,
        pluginId: entry.pluginId,
        occurrenceId,
        immutableGenerationId: input.source.projection.installedPackagesById[entry.pluginId]?.immutableGenerationId,
        ...(readInstalledPluginVersion(input.source.projection, entry.pluginId) === undefined
            ? {}
            : { pluginVersion: readInstalledPluginVersion(input.source.projection, entry.pluginId) }),
        target,
        executionOrigin: origin.executionOrigin,
        projectionGeneration: origin.projectionGeneration,
        authority: origin.authority,
        artifactGraph: artifactGraph.data,
        cacheIdentity,
        moduleReference,
        artifactAnchor: Object.freeze({ artifactOwnerKind: 'voiceProvider' as const }),
        ...(bundle.artifactSelectionOwner
            ? { artifactSelectionOwner: bundle.artifactSelectionOwner }
            : {}),
        voiceProvider: Object.freeze({ entry, declaration, cacheIdentity }),
    });
}

function candidateSortKey(candidate: ResolvedProjectedClientExecutableContribution): string {
    return `${candidate.pluginId}\u0000${candidate.family}\u0000${candidate.localId}`;
}

/**
 * Resolves all installed external client executable families into one exact
 * target set. Voice-only targets intentionally reach this same projection;
 * app-bundled origin-less Voice keeps its separate approved bridge.
 */
export function resolveProjectedPluginUiClientExecutables(input: Readonly<{
    actionProjection?: PluginUiClientExecutableProjectionSource | null;
    voiceProjection?: PluginUiClientExecutableProjectionSource | null;
    platform: PluginContributionClientPlatform;
}>): readonly PluginUiProjectedClientExecutableTarget[] {
    const candidates: ResolvedProjectedClientExecutableContribution[] = [];
    if (input.actionProjection) {
        for (const family of ['dragSources', 'dropTargets'] as const) {
            const entries = family === 'dragSources' ? input.actionProjection.projection.dragSourcesById : input.actionProjection.projection.dropTargetsById;
            for (const entry of Object.values(entries ?? {})) {
                if (!entry.definition.platforms.includes(input.platform)) continue;
                const candidate = readClientContributionCandidate({ family, entry, localId: entry.definition.id,
                    contributionId: `${family}/${entry.definition.id}`, client: entry.definition.client,
                    entityDeclaration: entry.definition, source: input.actionProjection, platform: input.platform });
                if (candidate) candidates.push(candidate);
            }
        }
        for (const action of Object.values(input.actionProjection.projection.actionsById)) {
            const candidate = readActionCandidate({
                action,
                source: input.actionProjection,
                platform: input.platform,
            });
            if (candidate) candidates.push(candidate);
        }
    }
    if (input.voiceProjection) {
        for (const entry of Object.values(input.voiceProjection.projection.voiceProvidersById)) {
            const candidate = readVoiceCandidate({
                entry,
                source: input.voiceProjection,
                platform: input.platform,
            });
            if (candidate) candidates.push(candidate);
        }
    }

    const grouped = new Map<string, ProjectedClientExecutableTargetGroup>();
    for (const candidate of candidates.sort((left, right) => (
        candidateSortKey(left).localeCompare(candidateSortKey(right))
    ))) {
        const groupKey = getPluginUiClientExecutableTargetAddressKey(candidate);
        const technicalKey = targetTechnicalKey(candidate);
        const existing = grouped.get(groupKey);
        if (!existing) {
            grouped.set(groupKey, {
                first: candidate,
                technicalKey,
                contributions: [candidate],
                conflict: false,
            });
            continue;
        }
        existing.contributions.push(candidate);
        if (
            existing.technicalKey !== technicalKey
            || existing.first.occurrenceId !== candidate.occurrenceId
        ) {
            // A declared target name never permits mixing distinct bytes or
            // physical plugin occurrences into one activate(api) transaction.
            existing.conflict = true;
        }
    }

    return Object.freeze([...grouped.values()]
        .filter((group) => !group.conflict)
        .map((group) => {
            const contributions = group.contributions;
            const actions = Object.freeze(contributions.flatMap((candidate) => (
                candidate.action ? [candidate.action] : []
            )));
            const voiceProviders = Object.freeze(contributions.flatMap((candidate) => (
                candidate.voiceProvider ? [candidate.voiceProvider] : []
            )));
            const contributes = Object.freeze({
                ...Object.fromEntries((['dragSources', 'dropTargets'] as const).map(family => [family,
                    Object.freeze(contributions.flatMap(candidate => candidate.family === family && candidate.entityDeclaration ? [candidate.entityDeclaration] : []))])),
                ...(actions.length > 0 ? { actions } : {}),
                ...(voiceProviders.length > 0
                    ? { voiceProviders: Object.freeze(voiceProviders.map((provider) => provider.declaration)) }
                    : {}),
            });
            const first = group.first;
            return Object.freeze({
                pluginId: first.pluginId,
                occurrenceId: first.occurrenceId,
                hostUiApiRange: first.artifactGraph.hostUiApiRange,
                ...(first.pluginVersion === undefined ? {} : { pluginVersion: first.pluginVersion }),
                ...(first.immutableGenerationId === undefined ? {} : { immutableGenerationId: first.immutableGenerationId }),
                actions,
                voiceProviders,
                contributes,
                target: first.target,
                executionOrigin: first.executionOrigin,
                projectionGeneration: first.projectionGeneration,
                authority: first.authority,
                artifactGraph: first.artifactGraph,
                cacheIdentity: first.cacheIdentity,
                moduleReference: first.moduleReference,
                artifactAnchor: first.artifactAnchor,
                ...(first.artifactSelectionOwner
                    ? { artifactSelectionOwner: first.artifactSelectionOwner }
                    : {}),
            });
        })
        .sort((left, right) => (
            getPluginUiClientExecutableTargetAddressKey(left).localeCompare(
                getPluginUiClientExecutableTargetAddressKey(right),
            )
        )));
}
