import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol/installables/descriptor';
import type { InstallableDependencyDescriptor, InstallableRegistryContribution, InstallablesRegistry } from '@happier-dev/protocol/installables';
import { resolveInstallablesRegistry } from '@happier-dev/protocol/installables/registry';
import { PluginManagedDependencyContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/managedDependencies';
import type { PluginManagedDependencyContributionV2 } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';

import type { ResolvedAgentContribution, ResolvedInstallableContribution } from './types';

/** Process grants permit alternate modes; only the selected transport requires its executable for setup. */
export function resolveAgentRuntimeManagedDependencyId(
    agent: Pick<ResolvedAgentContribution, 'pluginId' | 'richDefinition'>,
): string | null {
    const definition = agent.richDefinition?.definition;
    const runtime = definition && 'runtime' in definition ? definition.runtime : undefined;
    if (runtime?.kind !== 'acp' || runtime.transport.kind !== 'stdio'
        || runtime.transport.executable.kind !== 'managedDependency') return null;
    const reference = runtime.transport.executable.id;
    if (typeof reference !== 'string') return buildQualifiedPluginContributionKey(reference);
    return agent.pluginId
        ? buildQualifiedPluginContributionKey(qualifyPluginContributionReferenceV1(reference, agent.pluginId))
        : null;
}

export type ResolvedExecutableManagedDependency = Readonly<
    Omit<ResolvedInstallableContribution, 'definition'> & {
        definition: InstallableDependencyDescriptor;
    }
>;

type ManagedPypiWheelAssetSourceV2 = Extract<
    PluginManagedDependencyContributionV2['sources'][number],
    { kind: 'managedPypiWheelAsset' }
>;

type PinnedArchiveSourceV2 = Extract<
    PluginManagedDependencyContributionV2['sources'][number],
    { kind: 'pinnedArchive' }
>;

export type ManagedDependencyProjectionHost = Readonly<{
    platform: NodeJS.Platform;
    architecture: string;
}>;

type ManagedDependencyProjectionInput<TSource> = Readonly<{
    definition: PluginManagedDependencyContributionV2;
    source: TSource;
    pluginId?: string;
    manifestPath?: string;
    host?: ManagedDependencyProjectionHost;
}>;

type ManagedPypiWheelAssetProjectionInput = ManagedDependencyProjectionInput<ManagedPypiWheelAssetSourceV2>;
type PinnedArchiveProjectionInput = ManagedDependencyProjectionInput<PinnedArchiveSourceV2>;

type GitHubReleaseBinarySourceV2 = Extract<
    PluginManagedDependencyContributionV2['sources'][number],
    { kind: 'githubReleaseBinary' }
>;

export function projectGitHubReleaseBinaryInstallableDescriptor(
    input: ManagedDependencyProjectionInput<GitHubReleaseBinarySourceV2>,
): InstallableDependencyDescriptor | null {
    const gate = resolveManagedDependencyProjectionGate(input);
    if (!gate) return null;
    const { kind: _kind, installId, ...source } = input.source;
    const key = installId.slice('dep.'.length);
    const parsed = InstallableDependencyDescriptorSchema.safeParse({
        id: key, key, kind: 'dep', version: '1', capabilityId: installId,
        display: { name: gate.title }, description: gate.description,
        source: { ...source, kind: 'github_release_binary' },
        binary: { commands: [gate.executable], systemFirst: true, managedFallback: true },
        defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' },
        consent: { install: 'not_required', update: 'not_required' },
        stability: { experimental: true, supported: true },
    });
    return parsed.success ? parsed.data : null;
}

/**
 * Host and declaration facts every managed executable source must satisfy
 * before it may claim an installables descriptor. Incomplete immutable manifest
 * facts and hosts the declaration does not cover stay out of the registry.
 */
type ManagedDependencyProjectionGate = Readonly<{
    platformKey: string;
    title: string;
    description: string;
    executable: string;
}>;

function localizedFallback(
    value: PluginManagedDependencyContributionV2['title'] | PluginManagedDependencyContributionV2['description'],
): string | null {
    if (typeof value === 'string') return value;
    return value?.fallback ?? null;
}

function declaredPlatform(platform: NodeJS.Platform): 'macos' | 'linux' | 'windows' | null {
    if (platform === 'darwin') return 'macos';
    if (platform === 'linux') return 'linux';
    if (platform === 'win32') return 'windows';
    return null;
}

function managedAssetPlatformKey(host: ManagedDependencyProjectionHost): string | null {
    if (host.architecture !== 'arm64' && host.architecture !== 'x64') return null;
    if (host.platform !== 'darwin' && host.platform !== 'linux' && host.platform !== 'win32') return null;
    return `${host.platform}-${host.architecture}`;
}

function resolveManagedDependencyProjectionGate(
    input: ManagedDependencyProjectionInput<unknown>,
): ManagedDependencyProjectionGate | null {
    const host = input.host ?? { platform: process.platform, architecture: process.arch };
    const platform = declaredPlatform(host.platform);
    const platformKey = managedAssetPlatformKey(host);
    if (
        !input.pluginId
        || !input.manifestPath
        || !platform
        || !platformKey
        || (input.definition.platforms && !input.definition.platforms.includes(platform))
        || (input.definition.architectures && !input.definition.architectures.includes(host.architecture))
    ) {
        return null;
    }
    const title = localizedFallback(input.definition.title);
    const executable = input.definition.executable;
    if (!title || !executable) return null;
    return {
        platformKey,
        title,
        executable,
        description: localizedFallback(input.definition.description)
            ?? `Managed runtime for ${input.pluginId}/${input.definition.id}`,
    };
}

/**
 * Projects a complete Manifest V2 managed PyPI wheel source into the existing
 * installables descriptor contract. This is intentionally partial: incomplete
 * immutable manifest facts, unsupported hosts, and every non-executable source
 * kind stay out of the installables registry rather than being coerced.
 */
export function projectManagedPypiWheelAssetInstallableDescriptor(
    input: ManagedPypiWheelAssetProjectionInput,
): InstallableDependencyDescriptor | null {
    const gate = resolveManagedDependencyProjectionGate(input);
    if (!gate || !input.source.assetPathByPlatform[gate.platformKey]) return null;
    const { title, description } = gate;
    const parsed = InstallableDependencyDescriptorSchema.safeParse({
        id: input.source.installId,
        key: input.source.installId,
        kind: 'dep',
        version: '1',
        capabilityId: input.source.installId,
        display: { name: title },
        description,
        source: {
            kind: 'managed_pypi_wheel_asset',
            distribution: input.source.distribution,
            versionSpecifier: input.source.versionSpecifier,
            assetPathByPlatform: input.source.assetPathByPlatform,
            executable: true,
            ...(input.source.compatibilityProbe ? { compatibilityProbe: input.source.compatibilityProbe } : {}),
            installConsent: input.source.installConsent,
            autoUpdateMode: input.source.autoUpdateMode,
            ...(input.source.trustedPublisher ? { trustedPublisher: input.source.trustedPublisher } : {}),
        },
        binary: {
            commands: [input.definition.executable],
            systemFirst: false,
            managedFallback: true,
        },
        defaultPolicy: {
            autoInstallWhenNeeded: true,
            autoUpdateMode: input.source.autoUpdateMode,
        },
        consent: {
            install: 'required',
            update: 'required',
            commandsPreviewRequired: true,
        },
        stability: {
            experimental: true,
            supported: true,
        },
    });
    return parsed.success ? parsed.data : null;
}

/**
 * Projects a complete Manifest V2 pinned-archive source into the same
 * installables descriptor contract, so a declarative managed executable is
 * reachable from capability status/install and from the UI installables
 * registry. The immutable digest-pinned artifact has no update discovery, so
 * the descriptor declares no auto-update mode; the pinned-archive installer
 * itself stays the single install owner.
 */
export function projectPinnedArchiveInstallableDescriptor(
    input: PinnedArchiveProjectionInput,
): InstallableDependencyDescriptor | null {
    const gate = resolveManagedDependencyProjectionGate(input);
    const asset = gate
        ? input.source.assetsByPlatform[gate.platformKey as keyof PinnedArchiveSourceV2['assetsByPlatform']]
        : undefined;
    if (!gate || !asset) return null;
    const parsed = InstallableDependencyDescriptorSchema.safeParse({
        id: input.source.installId,
        key: input.source.installId,
        kind: 'dep',
        version: '1',
        capabilityId: input.source.installId,
        display: { name: gate.title },
        description: gate.description,
        source: {
            kind: 'pinned_archive',
            version: input.source.version,
            ...(input.source.archiveExtractionLimits
                ? { archiveExtractionLimits: input.source.archiveExtractionLimits }
                : {}),
            assetsByPlatform: input.source.assetsByPlatform,
        },
        binary: {
            commands: [gate.executable],
            systemFirst: false,
            managedFallback: true,
        },
        defaultPolicy: {
            autoInstallWhenNeeded: true,
            autoUpdateMode: 'off',
        },
        consent: {
            install: 'not_required',
            update: 'not_required',
            commandsPreviewRequired: false,
        },
        stability: {
            experimental: true,
            supported: true,
        },
    });
    return parsed.success ? parsed.data : null;
}

export function isExecutableManagedDependency(
    contribution: ResolvedInstallableContribution,
): contribution is ResolvedExecutableManagedDependency {
    return InstallableDependencyDescriptorSchema.safeParse(contribution.definition).success;
}

/**
 * Manifest V2 managed-dependency contributions describe dependency requests.
 * Each complete host-managed executable source (managed PyPI wheel asset,
 * pinned archive) projects through the canonical installables descriptor
 * owner; all other V2 source kinds remain request-only and must never be
 * coerced into executable descriptors.
 */
export function selectExecutableManagedDependencies(
    contributions: readonly ResolvedInstallableContribution[],
    host?: ManagedDependencyProjectionHost,
): readonly ResolvedExecutableManagedDependency[] {
    const executable: ResolvedExecutableManagedDependency[] = [];
    for (const contribution of contributions) {
        if (isExecutableManagedDependency(contribution)) {
            executable.push(contribution);
            continue;
        }
        const parsed = PluginManagedDependencyContributionV2Schema.safeParse(contribution.definition);
        if (!parsed.success) continue;
        for (const source of parsed.data.sources) {
            if (source.kind !== 'managedPypiWheelAsset' && source.kind !== 'pinnedArchive' && source.kind !== 'githubReleaseBinary') continue;
            const common = {
                definition: parsed.data,
                ...(contribution.pluginId ? { pluginId: contribution.pluginId } : {}),
                ...(contribution.manifestPath ? { manifestPath: contribution.manifestPath } : {}),
                ...(host ? { host } : {}),
            };
            const descriptor = source.kind === 'managedPypiWheelAsset'
                ? projectManagedPypiWheelAssetInstallableDescriptor({ ...common, source })
                : source.kind === 'pinnedArchive'
                    ? projectPinnedArchiveInstallableDescriptor({ ...common, source })
                    : projectGitHubReleaseBinaryInstallableDescriptor({ ...common, source });
            if (!descriptor) continue;
            executable.push(Object.freeze({
                ...contribution,
                definition: descriptor,
            }));
        }
    }
    return Object.freeze(executable);
}

export function toExecutableManagedDependencyRegistryContribution(
    candidate: ResolvedExecutableManagedDependency,
): InstallableRegistryContribution {
    const isHostBuiltIn = candidate.provenance === 'first_party'
        && !candidate.manifestPath
        && !candidate.daemonEntryPath
        && !candidate.sourceSpec;
    return Object.freeze({
        owner: Object.freeze({
            provenance: isHostBuiltIn
                ? 'built_in'
                : candidate.provenance === 'first_party'
                    ? 'bundled_first_party_plugin'
                    : 'external_plugin',
            ownerId: candidate.pluginId ?? `${candidate.provenance}:${candidate.definition.key}`,
            ...(candidate.pluginId ? { pluginId: candidate.pluginId } : {}),
            ...(candidate.manifestPath ? { manifestPath: candidate.manifestPath } : {}),
        }),
        descriptor: candidate.definition,
    });
}

export function resolveExecutableManagedDependenciesRegistry(
    contributions: readonly ResolvedInstallableContribution[],
    host?: ManagedDependencyProjectionHost,
): InstallablesRegistry {
    const builtIns: InstallableRegistryContribution[] = [];
    const bundledFirstPartyPlugins: InstallableRegistryContribution[] = [];
    const externalPlugins: InstallableRegistryContribution[] = [];

    for (const candidate of selectExecutableManagedDependencies(contributions, host)) {
        const contribution = toExecutableManagedDependencyRegistryContribution(candidate);
        if (contribution.owner.provenance === 'built_in') {
            builtIns.push(contribution);
        } else if (contribution.owner.provenance === 'bundled_first_party_plugin') {
            bundledFirstPartyPlugins.push(contribution);
        } else {
            externalPlugins.push(contribution);
        }
    }

    return resolveInstallablesRegistry({
        builtIns,
        bundledFirstPartyPlugins,
        externalPlugins,
    });
}
