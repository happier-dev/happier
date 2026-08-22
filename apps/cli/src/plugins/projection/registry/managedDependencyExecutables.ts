import {
    InstallableDependencyDescriptorSchema,
    type InstallableDependencyDescriptor,
    type InstallableRegistryContribution,
    type InstallablesRegistry,
    resolveInstallablesRegistry,
} from '@happier-dev/protocol/installables';
import {
    PluginManagedDependencyContributionV2Schema,
    type PluginManagedDependencyContributionV2,
} from '@happier-dev/protocol';

import type { ResolvedInstallableContribution } from './types';

export type ResolvedExecutableManagedDependency = Readonly<
    Omit<ResolvedInstallableContribution, 'definition'> & {
        definition: InstallableDependencyDescriptor;
    }
>;

type ManagedPypiWheelAssetSourceV2 = Extract<
    PluginManagedDependencyContributionV2['sources'][number],
    { kind: 'managedPypiWheelAsset' }
>;

export type ManagedDependencyProjectionHost = Readonly<{
    platform: NodeJS.Platform;
    architecture: string;
}>;

type ManagedPypiWheelAssetProjectionInput = Readonly<{
    definition: PluginManagedDependencyContributionV2;
    source: ManagedPypiWheelAssetSourceV2;
    pluginId?: string;
    manifestPath?: string;
    host?: ManagedDependencyProjectionHost;
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

function managedPypiAssetPlatformKey(host: ManagedDependencyProjectionHost): string | null {
    if (host.architecture !== 'arm64' && host.architecture !== 'x64') return null;
    if (host.platform !== 'darwin' && host.platform !== 'linux' && host.platform !== 'win32') return null;
    return `${host.platform}-${host.architecture}`;
}

/**
 * Projects the one currently supported Manifest V2 managed source into the
 * existing installables descriptor contract. This is intentionally partial:
 * incomplete immutable manifest facts, unsupported hosts, and every other
 * source kind stay out of the installables registry rather than being coerced.
 */
export function projectManagedPypiWheelAssetInstallableDescriptor(
    input: ManagedPypiWheelAssetProjectionInput,
): InstallableDependencyDescriptor | null {
    const host = input.host ?? { platform: process.platform, architecture: process.arch };
    const platform = declaredPlatform(host.platform);
    const platformKey = managedPypiAssetPlatformKey(host);
    if (
        !input.pluginId
        || !input.manifestPath
        || !platform
        || !platformKey
        || (input.definition.platforms && !input.definition.platforms.includes(platform))
        || (input.definition.architectures && !input.definition.architectures.includes(host.architecture))
        || !input.source.assetPathByPlatform[platformKey]
    ) {
        return null;
    }

    const title = localizedFallback(input.definition.title);
    if (!title || !input.definition.executable) return null;
    const description = localizedFallback(input.definition.description)
        ?? `Managed runtime for ${input.pluginId}/${input.definition.id}`;
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

export function isExecutableManagedDependency(
    contribution: ResolvedInstallableContribution,
): contribution is ResolvedExecutableManagedDependency {
    return InstallableDependencyDescriptorSchema.safeParse(contribution.definition).success;
}

/**
 * Manifest V2 managed-dependency contributions describe dependency requests.
 * Each complete managed-PyPI source projects through the canonical
 * installables descriptor owner; all other V2 source kinds remain request-only
 * and must never be coerced into executable descriptors.
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
            if (source.kind !== 'managedPypiWheelAsset') continue;
            const descriptor = projectManagedPypiWheelAssetInstallableDescriptor({
                definition: parsed.data,
                source,
                ...(contribution.pluginId ? { pluginId: contribution.pluginId } : {}),
                ...(contribution.manifestPath ? { manifestPath: contribution.manifestPath } : {}),
                ...(host ? { host } : {}),
            });
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
