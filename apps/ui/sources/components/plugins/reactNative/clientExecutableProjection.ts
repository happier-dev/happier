import {
    arePluginMachineExecutionOriginsEqual,
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    type PluginContributionClientPlatform,
    type PluginMachineExecutionOriginV1,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV1Schema,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    derivePluginUiFederatedContainerName,
    type RepackInstalledArtifactModuleReference,
} from './loader';
import {
    getPluginUiClientExecutableTargetAddressKey,
    type PluginUiClientExecutableActivation,
    type PluginUiClientExecutableTarget,
} from './clientExecutableContributions';
import {
    readPluginUiReactNativeBundleCacheIdentity,
} from '@/sync/domains/plugins/ui/artifactAdoption';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
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
    pluginVersion?: string;
    actions: readonly PluginUiProjectionModel['actionsById'][string][];
    voiceProviders: readonly PluginUiProjectedClientExecutableVoiceProvider[];
    contributes: Readonly<Record<string, unknown>>;
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1;
    projectionGeneration: number;
    authority: PluginUiClientExecutableActivation['authority'];
    artifactGraph: PluginUiArtifactsManifestEntryV1;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    moduleReference: RepackInstalledArtifactModuleReference;
    artifactAnchor: PluginUiClientExecutableArtifactAnchor;
}>;

type ProjectedExecutableOrigin = Readonly<{
    executionOrigin: PluginMachineExecutionOriginV1;
    projectionGeneration: number;
    authority: PluginUiClientExecutableActivation['authority'];
}>;

type ResolvedProjectedClientExecutableContribution = Readonly<{
    family: 'actions' | 'voiceProviders';
    localId: string;
    pluginId: string;
    pluginVersion?: string;
    target: PluginUiClientExecutableTarget;
    executionOrigin: PluginMachineExecutionOriginV1;
    projectionGeneration: number;
    authority: PluginUiClientExecutableActivation['authority'];
    artifactGraph: PluginUiArtifactsManifestEntryV1;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    moduleReference: RepackInstalledArtifactModuleReference;
    artifactAnchor: PluginUiClientExecutableArtifactAnchor;
    action?: PluginUiProjectionModel['actionsById'][string];
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
): origin is PluginUiContributionOriginV1 & Readonly<{
    generation: number;
    executionOrigin: PluginMachineExecutionOriginV1;
}> {
    return origin !== null
        && origin.phase === 'current'
        && origin.interactionEnabled
        && origin.executionOrigin !== null
        && typeof origin.generation === 'number'
        && Number.isInteger(origin.generation)
        && origin.generation >= 0
        && origin.executionOrigin.materializationRef.machineId === origin.machineId;
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
                projectionGeneration: unionOrigin.generation,
            }),
        });
    }

    const projectionGeneration = input.source.projection.generation;
    const executionOrigin = readPluginUiProjectionEntryExecutionOrigin(input.entry);
    if (
        !executionOrigin
        || typeof projectionGeneration !== 'number'
        || !Number.isInteger(projectionGeneration)
        || projectionGeneration < 0
        || executionOrigin.materializationRef.machineId !== directMachineAuthority.machineId
    ) {
        return null;
    }
    return Object.freeze({
        executionOrigin,
        projectionGeneration,
        authority: Object.freeze({
            serverId: directMachineAuthority.serverId,
            machineId: directMachineAuthority.machineId,
            projectionGeneration,
        }),
    });
}

function areProjectedExecutableOriginsEqual(
    left: ProjectedExecutableOrigin,
    right: ProjectedExecutableOrigin,
): boolean {
    return left.projectionGeneration === right.projectionGeneration
        && left.authority.serverId === right.authority.serverId
        && left.authority.machineId === right.authority.machineId
        && arePluginMachineExecutionOriginsEqual(left.executionOrigin, right.executionOrigin);
}

function readRuntimeFacts(bundle: UnknownRecord): Readonly<{
    state: string | null;
    source: string | null;
    cacheIdentity: PluginReactNativeBundleCacheIdentity | null;
}> {
    const runtime = asRecord(bundle.runtime);
    const decision = asRecord(runtime?.decision);
    const loadPolicy = asRecord(runtime?.loadPolicy);
    return Object.freeze({
        state: typeof decision?.state === 'string' ? decision.state : null,
        source: typeof loadPolicy?.source === 'string' ? loadPolicy.source : null,
        cacheIdentity: readPluginUiReactNativeBundleCacheIdentity(runtime?.cacheIdentity),
    });
}

function readModuleReference(input: Readonly<{
    pluginId: string;
    artifactId: string;
    target: PluginUiClientExecutableTarget;
    artifactGraph: PluginUiArtifactsManifestEntryV1;
}>): RepackInstalledArtifactModuleReference | null {
    const moduleReference = input.artifactGraph.repack
        ? Object.freeze({
            containerName: input.artifactGraph.repack.containerName,
            modulePath: input.artifactGraph.repack.modulePath,
            exportName: input.artifactGraph.repack.exportName,
        })
        : Object.freeze({
            containerName: derivePluginUiFederatedContainerName({
                pluginId: input.pluginId,
                contributionId: input.artifactId,
            }),
            modulePath: input.target.modulePath,
            exportName: input.target.exportName,
        });
    return moduleReference.modulePath === input.target.modulePath
        && moduleReference.exportName === input.target.exportName
        ? moduleReference
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
 * Equivalent target names are not sufficient to share one activation: the
 * Artifact bytes, host compatibility, module entry, and package version must
 * all agree. Contribution id and generation select the individual producer,
 * not the executable bytes.
 */
function targetTechnicalKey(candidate: ResolvedProjectedClientExecutableContribution): string {
    const identity = candidate.cacheIdentity;
    return [
        candidate.artifactGraph.digest,
        candidate.moduleReference.containerName,
        candidate.moduleReference.modulePath,
        candidate.moduleReference.exportName,
        identity.pluginId,
        identity.artifactDigest,
        identity.hostAppVersion,
        identity.hostUiApiVersion,
        identity.reactVersion,
        identity.reactNativeVersion,
        identity.expoRuntimeVersion ?? '',
        identity.hermesVersion ?? '',
        identity.platform,
        identity.channel,
        identity.nativeCapabilitiesDigest,
        candidate.pluginVersion ?? '',
    ].join('\u0000');
}

function readActionCandidate(input: Readonly<{
    action: PluginUiProjectionModel['actionsById'][string];
    source: PluginUiClientExecutableProjectionSource;
    platform: PluginContributionClientPlatform;
}>): ResolvedProjectedClientExecutableContribution | null {
    const { action } = input;
    if (action.available !== true || action.execution.target !== 'client') return null;
    if (!action.execution.platforms.includes(input.platform)) return null;

    const origin = readCurrentProjectedExecutableOrigin({ entry: action, source: input.source });
    if (!origin || origin.executionOrigin.materializationRef.pluginId !== action.pluginId) return null;
    const bundle = input.source.projection.reactNativeBundlesById[
        `reactNativeBundle:${action.pluginId}:${action.id}`
    ];
    if (
        !bundle
        || bundle.pluginId !== action.pluginId
        || bundle.contributionId !== action.id
        || bundle.generatedOwnerKind !== 'clientContribution'
    ) {
        return null;
    }
    const bundleOrigin = readCurrentProjectedExecutableOrigin({ entry: bundle, source: input.source });
    if (!bundleOrigin || !areProjectedExecutableOriginsEqual(origin, bundleOrigin)) return null;

    const artifactGraph = PluginUiArtifactsManifestEntryV1Schema.safeParse(bundle.artifactGraph);
    const runtime = readRuntimeFacts(bundle);
    const cacheIdentity = runtime.cacheIdentity;
    if (
        !artifactGraph.success
        || runtime.state !== 'load'
        || runtime.source !== 'installedArtifact'
        || cacheIdentity === null
        || artifactGraph.data.contributionId !== action.execution.client.artifactId
        || artifactGraph.data.platform !== input.platform
        || cacheIdentity.pluginId !== action.pluginId
        || cacheIdentity.contributionId !== action.id
        || cacheIdentity.artifactDigest !== artifactGraph.data.digest
        || cacheIdentity.platform !== input.platform
        || cacheIdentity.projectionGeneration !== origin.projectionGeneration
    ) {
        return null;
    }
    const target = Object.freeze({
        artifactId: action.execution.client.artifactId,
        modulePath: action.execution.client.modulePath,
        exportName: action.execution.client.exportName,
        platform: input.platform,
    });
    const moduleReference = readModuleReference({
        pluginId: action.pluginId,
        artifactId: action.execution.client.artifactId,
        target,
        artifactGraph: artifactGraph.data,
    });
    if (!moduleReference) return null;

    return Object.freeze({
        family: 'actions',
        localId: action.id,
        pluginId: action.pluginId,
        ...(readInstalledPluginVersion(input.source.projection, action.pluginId) === undefined
            ? {}
            : { pluginVersion: readInstalledPluginVersion(input.source.projection, action.pluginId) }),
        target,
        executionOrigin: origin.executionOrigin,
        projectionGeneration: origin.projectionGeneration,
        authority: origin.authority,
        artifactGraph: artifactGraph.data,
        cacheIdentity,
        moduleReference,
        artifactAnchor: Object.freeze({
            artifactOwnerKind: 'clientContribution' as const,
            clientContribution: Object.freeze({
                family: 'actions' as const,
                action: Object.freeze({ pluginId: action.pluginId, localId: action.id }),
            }),
        }),
        action,
    });
}

function readVoiceCandidate(input: Readonly<{
    entry: PluginUiProjectionModel['voiceProvidersById'][string];
    source: PluginUiClientExecutableProjectionSource;
    platform: PluginContributionClientPlatform;
}>): ResolvedProjectedClientExecutableContribution | null {
    const { entry } = input;
    const declaration = entry.definition;
    if (declaration.kind !== 'conversation' || !declaration.platforms.includes(input.platform)) return null;
    const expectedId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
        pluginId: entry.pluginId,
        localId: declaration.id,
    }));
    if (entry.id !== expectedId || entry.contributionKey !== expectedId) return null;

    const origin = readCurrentProjectedExecutableOrigin({ entry, source: input.source });
    if (
        !origin
        || origin.executionOrigin.materializationRef.pluginId !== entry.pluginId
        || entry.generation !== origin.projectionGeneration
    ) return null;
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

    const artifactGraph = PluginUiArtifactsManifestEntryV1Schema.safeParse(bundle.artifactGraph);
    const runtime = readRuntimeFacts(bundle);
    const cacheIdentity = runtime.cacheIdentity;
    if (
        !artifactGraph.success
        || runtime.state !== 'load'
        || runtime.source !== 'installedArtifact'
        || cacheIdentity === null
        || artifactGraph.data.contributionId !== declaration.client.artifactId
        || artifactGraph.data.platform !== input.platform
        || cacheIdentity.pluginId !== entry.pluginId
        || cacheIdentity.contributionId !== declaration.id
        || cacheIdentity.artifactDigest !== artifactGraph.data.digest
        || cacheIdentity.platform !== input.platform
        || cacheIdentity.projectionGeneration !== origin.projectionGeneration
    ) {
        return null;
    }
    const target = Object.freeze({
        artifactId: declaration.client.artifactId,
        modulePath: declaration.client.modulePath,
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
        if (existing.technicalKey !== technicalKey) {
            // A declared target name never permits mixing distinct bytes or
            // package contracts into one activate(api) transaction.
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
                ...(actions.length > 0 ? { actions } : {}),
                ...(voiceProviders.length > 0
                    ? { voiceProviders: Object.freeze(voiceProviders.map((provider) => provider.declaration)) }
                    : {}),
            });
            const first = group.first;
            return Object.freeze({
                pluginId: first.pluginId,
                ...(first.pluginVersion === undefined ? {} : { pluginVersion: first.pluginVersion }),
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
            });
        })
        .sort((left, right) => (
            getPluginUiClientExecutableTargetAddressKey(left).localeCompare(
                getPluginUiClientExecutableTargetAddressKey(right),
            )
        )));
}
