import {
    InstallableDependencyDescriptorSchema,
    PluginManagedDependencyContributionV2Schema,
    PluginSourceSpecV1Schema,
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    type PluginContributionIdentityV1,
    type PluginManagedDependencyContributionV2,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { ResolvedContributionRegistry, ResolvedInstallableContribution } from '@/plugins/projection/registry/types';

const MAX_V2_MANAGED_DEPENDENCIES_PER_GENERATION = 128;
const MAX_V2_MANAGED_DEPENDENCY_SOURCES = 8;
const MAX_V2_MANAGED_DEPENDENCY_DECLARATION_BYTES = 64 * 1024;
const MAX_V2_MANAGED_DEPENDENCY_ARCHITECTURES = 16;
const MAX_V2_MANAGED_DEPENDENCY_ARCHITECTURE_CODE_UNITS = 64;

type HostPlatform = 'darwin' | 'linux' | 'win32';
type DeclaredPlatform = NonNullable<PluginManagedDependencyContributionV2['platforms']>[number];
type V2Source = PluginManagedDependencyContributionV2['sources'][number];

export type ManagedDependencySourceModelEntry = Readonly<{
    sourceId: string;
    declarationIndex: number;
    kind: V2Source['kind'];
    version: string | null;
    updatePolicy: 'external' | 'managed' | 'manual';
    disposition: 'executable' | 'manual';
    declaration: V2Source;
}>;

export type ManagedDependencySourceModelDependency = Readonly<{
    generationId: string;
    provenance: ResolvedInstallableContribution['provenance'];
    identity: PluginContributionIdentityV1;
    qualifiedId: string;
    manifestPath: string;
    manifestDigest: string;
    pluginSource: NonNullable<ResolvedInstallableContribution['sourceSpec']>;
    definition: PluginManagedDependencyContributionV2;
    availability:
        | Readonly<{ state: 'available' }>
        | Readonly<{ state: 'unavailable'; code: 'plugin_managed_dependency_platform_unsupported' | 'plugin_managed_dependency_architecture_unsupported' }>;
    sources: readonly ManagedDependencySourceModelEntry[];
}>;

export type V2ManagedDependencySourceModel = Readonly<{
    generationId: string;
    snapshot(): Readonly<{
        generationId: string;
        retired: boolean;
        dependencies: readonly ManagedDependencySourceModelDependency[];
    }>;
    resolve(identity: PluginContributionIdentityV1): ManagedDependencySourceModelDependency;
    retireGeneration(generationId: string): void;
}>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function platformName(platform: HostPlatform): DeclaredPlatform {
    return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
}

function sourceVersion(source: V2Source): string | null {
    return source.kind === 'managedPypiWheelAsset'
        ? source.versionSpecifier
        : null;
}

function normalizeSources(
    qualifiedId: string,
    sources: readonly V2Source[],
): readonly ManagedDependencySourceModelEntry[] {
    if (sources.length > MAX_V2_MANAGED_DEPENDENCY_SOURCES) {
        return fail(
            'plugin_managed_dependency_source_capacity_exceeded',
            'Managed dependency declares too many sources',
        );
    }
    const normalized = sources.map((rawSource, declarationIndex) => {
        const source = rawSource;
        return Object.freeze({
            sourceId: `${qualifiedId}#${declarationIndex}`,
            declarationIndex,
            kind: source.kind,
            version: sourceVersion(source),
            updatePolicy: source.kind === 'system'
                ? 'external' as const
                : source.kind === 'vendorRecipe' || source.kind === 'manual'
                    ? 'manual' as const
                    : 'managed' as const,
            disposition: source.kind === 'vendorRecipe' || source.kind === 'manual' ? 'manual' as const : 'executable' as const,
            declaration: source,
        });
    });
    normalized.sort((left, right) => (
        (left.kind === 'system' ? 0 : 1) - (right.kind === 'system' ? 0 : 1)
        || left.declarationIndex - right.declarationIndex
    ));
    return Object.freeze(normalized);
}

type ResolvedV2ManagedDependencyContribution = Readonly<
    Omit<ResolvedInstallableContribution, 'definition'> & {
        definition: PluginManagedDependencyContributionV2;
    }
>;

export function createV2ManagedDependencySourceModel(params: Readonly<{
    generationId: string;
    platform: HostPlatform;
    architecture: string;
    contributions: readonly ResolvedInstallableContribution[];
}>): V2ManagedDependencySourceModel {
    const generationId = params.generationId;
    if (!generationId || generationId.trim() !== generationId) {
        return fail('plugin_managed_dependency_generation_invalid', 'Managed dependency generation identity is required');
    }
    if (
        !(['darwin', 'linux', 'win32'] as const).includes(params.platform)
        || !params.architecture
        || params.architecture.trim() !== params.architecture
        || params.architecture.length > MAX_V2_MANAGED_DEPENDENCY_ARCHITECTURE_CODE_UNITS
    ) {
        return fail('plugin_managed_dependency_source_invalid', 'Managed dependency host platform or architecture is invalid');
    }
    const candidates: ResolvedV2ManagedDependencyContribution[] = [];
    for (const candidate of params.contributions) {
        let legacy: ReturnType<typeof InstallableDependencyDescriptorSchema.safeParse>;
        let v2: ReturnType<typeof PluginManagedDependencyContributionV2Schema.safeParse>;
        try {
            legacy = InstallableDependencyDescriptorSchema.safeParse(candidate.definition);
            v2 = PluginManagedDependencyContributionV2Schema.safeParse(candidate.definition);
        } catch {
            return fail('plugin_managed_dependency_source_invalid', 'Managed dependency source definition is invalid');
        }
        if (legacy.success) continue;
        if (!v2.success) {
            return fail('plugin_managed_dependency_source_invalid', 'Managed dependency source definition is invalid');
        }
        candidates.push(candidate as ResolvedV2ManagedDependencyContribution);
    }
    if (candidates.length > MAX_V2_MANAGED_DEPENDENCIES_PER_GENERATION) {
        return fail('plugin_managed_dependency_capacity_exceeded', 'Managed dependency generation exceeds its capacity');
    }

    const dependencies: ManagedDependencySourceModelDependency[] = [];
    const byQualifiedId = new Map<string, ManagedDependencySourceModelDependency>();
    for (const candidate of candidates) {
        const parsed = PluginManagedDependencyContributionV2Schema.safeParse(candidate.definition);
        let parsedSource: ReturnType<typeof PluginSourceSpecV1Schema.safeParse> | null = null;
        try {
            parsedSource = candidate.sourceSpec
                ? PluginSourceSpecV1Schema.safeParse(candidate.sourceSpec)
                : null;
        } catch {
            return fail('plugin_managed_dependency_source_invalid', 'Managed dependency source provenance is incomplete or invalid');
        }
        if (
            !parsed.success
            || !candidate.pluginId
            || candidate.pluginId.trim() !== candidate.pluginId
            || !candidate.manifestPath
            || candidate.manifestPath.trim() !== candidate.manifestPath
            || !candidate.manifestDigest
            || candidate.manifestDigest.trim() !== candidate.manifestDigest
            || !parsedSource?.success
            || parsedSource.data.kind !== candidate.source.kind
        ) {
            return fail('plugin_managed_dependency_source_invalid', 'Managed dependency source provenance is incomplete or invalid');
        }
        if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > MAX_V2_MANAGED_DEPENDENCY_DECLARATION_BYTES) {
            return fail('plugin_managed_dependency_source_invalid', 'Managed dependency declaration exceeds its byte bound');
        }
        if (parsed.data.platforms && new Set(parsed.data.platforms).size !== parsed.data.platforms.length) {
            return fail('plugin_managed_dependency_source_invalid', 'Managed dependency platforms must be unique');
        }
        if (
            parsed.data.architectures
            && (
                parsed.data.architectures.length > MAX_V2_MANAGED_DEPENDENCY_ARCHITECTURES
                || new Set(parsed.data.architectures).size !== parsed.data.architectures.length
                || parsed.data.architectures.some((architecture) => (
                    architecture.length > MAX_V2_MANAGED_DEPENDENCY_ARCHITECTURE_CODE_UNITS
                ))
            )
        ) {
            return fail('plugin_managed_dependency_source_invalid', 'Managed dependency architectures are invalid or exceed their bounds');
        }
        let identity: PluginContributionIdentityV1;
        try {
            identity = createPluginContributionIdentity({ pluginId: candidate.pluginId, localId: parsed.data.id });
        } catch {
            return fail('plugin_managed_dependency_source_invalid', 'Managed dependency source identity is invalid');
        }
        const qualifiedId = buildQualifiedPluginContributionKey(identity);
        if (byQualifiedId.has(qualifiedId)) {
            return fail('plugin_managed_dependency_identity_conflict', 'Managed dependency qualified identity is duplicated');
        }
        const declaredPlatform = platformName(params.platform);
        const availability = parsed.data.platforms && !parsed.data.platforms.includes(declaredPlatform)
            ? Object.freeze({ state: 'unavailable' as const, code: 'plugin_managed_dependency_platform_unsupported' as const })
            : parsed.data.architectures && !parsed.data.architectures.includes(params.architecture)
                ? Object.freeze({ state: 'unavailable' as const, code: 'plugin_managed_dependency_architecture_unsupported' as const })
                : Object.freeze({ state: 'available' as const });
        const dependency = Object.freeze({
            generationId,
            provenance: candidate.provenance,
            identity,
            qualifiedId,
            manifestPath: candidate.manifestPath,
            manifestDigest: candidate.manifestDigest,
            pluginSource: parsedSource.data,
            definition: candidate.definition,
            availability,
            sources: normalizeSources(qualifiedId, parsed.data.sources),
        });
        byQualifiedId.set(qualifiedId, dependency);
        dependencies.push(dependency);
    }
    dependencies.sort((left, right) => left.qualifiedId.localeCompare(right.qualifiedId));
    let retired = false;

    function assertCurrent(): void {
        if (retired) {
            fail('plugin_managed_dependency_generation_retired', 'Managed dependency generation has retired');
        }
    }

    return Object.freeze({
        generationId,
        snapshot: () => Object.freeze({ generationId, retired, dependencies: Object.freeze([...dependencies]) }),
        resolve(identity) {
            assertCurrent();
            const parsedIdentity = createPluginContributionIdentity(identity);
            return byQualifiedId.get(buildQualifiedPluginContributionKey(parsedIdentity))
                ?? fail('plugin_managed_dependency_undeclared', 'Managed dependency is not declared for this plugin');
        },
        retireGeneration(candidateGenerationId) {
            if (candidateGenerationId !== generationId) {
                fail('plugin_managed_dependency_generation_mismatch', 'Managed dependency generation identity does not match');
            }
            retired = true;
        },
    });
}

export function createV2ManagedDependencySourceModelFromRegistry(params: Readonly<{
    registry: Pick<ResolvedContributionRegistry, 'generationId' | 'managedDependencies'>;
    platform: HostPlatform;
    architecture: string;
}>): V2ManagedDependencySourceModel {
    if (!params.registry.generationId) {
        return fail('plugin_managed_dependency_generation_invalid', 'Resolved contribution registry generation is required');
    }
    return createV2ManagedDependencySourceModel({
        generationId: params.registry.generationId,
        platform: params.platform,
        architecture: params.architecture,
        contributions: params.registry.managedDependencies ?? [],
    });
}
