import { isDeepStrictEqual } from 'node:util';

import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type {
    InstallableDependencyDescriptor,
    InstallableRegistryContribution,
    InstallablesRegistry,
} from '@happier-dev/protocol/installables';
import { resolveEffectiveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';
import type {
    ManagedDependencyReady,
    ManagedDependencyStatus,
    ManagedDependenciesService,
} from '@happier-dev/plugin-sdk/managed-services';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import type { RuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import type {
    ManagedDependencySourceModelDependency,
    ManagedDependencySourceModelEntry,
    V2ManagedDependencySourceModel,
} from './managedDependencySourceModel';
import {
    mergeRunnerManagedDependencyRetentionV1,
    type RunnerManagedDependencySourceCandidateV1,
    type RunnerManagedDependencyRetentionV1,
} from '../../runner/runnerManagedDependencyRetention';
import type {
    AgentSessionRunnerBindingV1,
} from '../../runner/agentSessionRunnerFactoryBinding';
import type {
    PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

type ResolvedExecutableLease = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    release(): void;
}>;

export interface StablePluginManagedDependenciesHost {
    bind(pluginId: string): ManagedDependenciesService;
    resolveExecutable(executable: ManagedExecutableRef, requestingPluginId: string): Promise<ResolvedExecutableLease>;
    retireGeneration(generationId: string): Promise<void>;
    snapshotRunnerRetention(
        binding: AgentSessionRunnerBindingV1,
        hostAccessRequests: readonly Readonly<{
            request: PluginHostAccessRequestV2;
            required: boolean;
        }>[],
    ): RunnerManagedDependencyRetentionV1;
    reserveRunnerRetention(
        binding: AgentSessionRunnerBindingV1,
        hostAccessRequests: readonly Readonly<{
            request: PluginHostAccessRequestV2;
            required: boolean;
        }>[],
    ): Readonly<{
        retention: RunnerManagedDependencyRetentionV1;
        release(): void;
    }>;
}

type LegacyDescriptorOwner = Readonly<{
    kind: 'legacy';
    qualifiedKey: string;
    contribution: InstallableRegistryContribution;
}>;

type V2DescriptorOwner = Readonly<{
    kind: 'v2';
    qualifiedKey: string;
    dependency: ManagedDependencySourceModelDependency;
}>;

type DescriptorOwner = LegacyDescriptorOwner | V2DescriptorOwner;

type ResolvedOwnerAdapter = Readonly<{
    adapter: RuntimeInstallableAdapter;
    sourceId: string | null;
    source: ManagedDependencySourceModelEntry | null;
}>;

const UNKNOWN_VERSION = 'unknown';

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        fail('plugin_managed_dependency_aborted', 'Managed dependency operation was aborted');
    }
}

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    assertNotAborted(signal);
    if (!signal) return await promise;
    let listener: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
        listener = () => reject(new PluginError({
            code: 'plugin_managed_dependency_aborted',
            message: 'Managed dependency operation was aborted',
        }));
        signal.addEventListener('abort', listener, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        if (listener) signal.removeEventListener('abort', listener);
    }
}

function qualifiedKey(pluginId: string | undefined, localId: string): string {
    return pluginId ? `${pluginId}/${localId}` : localId;
}

export function resolveRunnerManagedDependencyQualifiedIds(
    binding: AgentSessionRunnerBindingV1,
    hostAccessRequests: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
    }>[],
): readonly string[] {
    return Object.freeze([
        ...new Set(hostAccessRequests.flatMap(
            ({ request }) => request.capability === 'process'
                ? request.scope.executables.flatMap((executable) => {
                    if (executable.kind !== 'managedDependency') {
                        return [];
                    }
                    const identity = typeof executable.id === 'string'
                        ? {
                            pluginId: binding.pluginId,
                            localId: executable.id,
                        }
                        : executable.id;
                    return [qualifiedKey(
                        identity.pluginId,
                        identity.localId,
                    )];
                })
                : [],
        )),
    ].sort());
}

function readRef(
    executable: Extract<ManagedExecutableRef, Readonly<{ kind: 'managedDependency' }>>,
    requestingPluginId: string,
): Readonly<{
    pluginId: string;
    localId: string;
}> {
    return typeof executable.id === 'string'
        ? Object.freeze({ pluginId: requestingPluginId, localId: executable.id })
        : executable.id;
}

function legacyUnsupportedCode(descriptor: InstallableDependencyDescriptor): string | null {
    if (descriptor.stability.supported === false) return 'plugin_managed_dependency_unsupported';
    switch (descriptor.source.kind) {
        case 'manual_only':
            return 'plugin_managed_dependency_manual_required';
        case 'vendor_recipe':
            return 'plugin_managed_dependency_vendor_recipe_required';
        case 'managed_package':
            return 'plugin_managed_dependency_source_unsupported';
        case 'github_release_binary':
        case 'managed_pypi_wheel_asset':
            return null;
    }
}

function readVersion(status: unknown, ...keys: readonly string[]): string | null {
    if (!status || typeof status !== 'object') return null;
    const record = status as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

export function createStablePluginManagedDependenciesHost(params: Readonly<{
    installablesRegistry: InstallablesRegistry;
    sourceModel?: V2ManagedDependencySourceModel;
    immutableGenerationIdsByPluginId?:
        ReadonlyMap<string, string>;
    getSettings(): unknown;
    resolveAdapter(
        key: string,
        options: Readonly<{ installablesRegistry: InstallablesRegistry }>,
    ): Promise<RuntimeInstallableAdapter>;
    resolveSourceAdapter?(input: Readonly<{
        dependency: ManagedDependencySourceModelDependency;
        source: ManagedDependencySourceModelEntry;
        sourceInstallable?: InstallableDependencyDescriptor;
    }>): Promise<RuntimeInstallableAdapter>;
    removeManagedInstall(input: Readonly<{
        descriptor: InstallableDependencyDescriptor;
        signal?: AbortSignal;
    }>): Promise<void>;
    removeManagedSource?(input: Readonly<{
        dependency: ManagedDependencySourceModelDependency;
        source: ManagedDependencySourceModelEntry;
        adapter: RuntimeInstallableAdapter;
        signal?: AbortSignal;
    }>): Promise<void>;
    readLiveRunnerRetention?():
        Promise<RunnerManagedDependencyRetentionV1>;
    env?: NodeJS.ProcessEnv;
}>): StablePluginManagedDependenciesHost {
    function isCanonicalV2ManagedSource(
        owner: V2DescriptorOwner,
        source: ManagedDependencySourceModelEntry,
    ): boolean {
        if (source.declaration.kind !== 'managedPypiWheelAsset') return true;
        return sourceInstallableFor(owner, source) !== null;
    }

    function sourceInstallableFor(
        owner: V2DescriptorOwner,
        source: ManagedDependencySourceModelEntry,
    ): InstallableRegistryContribution | null {
        if (
            !params.sourceModel
            || source.declaration.kind !== 'managedPypiWheelAsset'
        ) return null;
        const winner = params.installablesRegistry.descriptorsByKey[
            source.declaration.installId
        ];
        const expectedProvenance = owner.dependency.provenance === 'first_party'
            ? 'bundled_first_party_plugin'
            : 'external_plugin';
        const descriptor = winner?.descriptor;
        const expectedSource = Object.freeze({
            kind: 'managed_pypi_wheel_asset' as const,
            distribution: source.declaration.distribution,
            versionSpecifier: source.declaration.versionSpecifier,
            assetPathByPlatform: source.declaration.assetPathByPlatform,
            executable: true as const,
            ...(source.declaration.compatibilityProbe
                ? { compatibilityProbe: source.declaration.compatibilityProbe }
                : {}),
            installConsent: source.declaration.installConsent,
            autoUpdateMode: source.declaration.autoUpdateMode,
            ...(source.declaration.trustedPublisher
                ? { trustedPublisher: source.declaration.trustedPublisher }
                : {}),
        });
        if (
            !winner
            || !descriptor
            || winner.owner.provenance !== expectedProvenance
            || winner.owner.pluginId !== owner.dependency.identity.pluginId
            || winner.owner.manifestPath !== owner.dependency.manifestPath
            || descriptor.id !== source.declaration.installId
            || descriptor.key !== source.declaration.installId
            || descriptor.capabilityId !== source.declaration.installId
            || descriptor.binary.commands.length !== 1
            || descriptor.binary.commands[0] !== owner.dependency.definition.executable
            || !isDeepStrictEqual(descriptor.source, expectedSource)
        ) return null;
        return winner;
    }

    const projectedV2RegistryContributions = new Map<
        InstallableRegistryContribution,
        V2DescriptorOwner
    >();
    for (const dependency of params.sourceModel?.snapshot().dependencies ?? []) {
        const owner = Object.freeze({
            kind: 'v2' as const,
            qualifiedKey: dependency.qualifiedId,
            dependency,
        });
        for (const source of dependency.sources) {
            const sourceInstallable = sourceInstallableFor(owner, source);
            if (sourceInstallable) {
                projectedV2RegistryContributions.set(sourceInstallable, owner);
            }
        }
    }

    const ownersByQualifiedKey = new Map<string, DescriptorOwner>();
    for (const contribution of params.installablesRegistry.descriptors) {
        if (projectedV2RegistryContributions.has(contribution)) continue;
        const key = qualifiedKey(contribution.owner.pluginId, contribution.descriptor.key);
        ownersByQualifiedKey.set(key, Object.freeze({ kind: 'legacy', qualifiedKey: key, contribution }));
        if (contribution.owner.provenance === 'built_in') {
            ownersByQualifiedKey.set(contribution.descriptor.key, Object.freeze({
                kind: 'legacy',
                qualifiedKey: contribution.descriptor.key,
                contribution,
            }));
        }
    }
    for (const dependency of params.sourceModel?.snapshot().dependencies ?? []) {
        if (ownersByQualifiedKey.has(dependency.qualifiedId)) {
            fail('plugin_managed_dependency_identity_conflict', 'Managed dependency identity exists in both source models');
        }
        ownersByQualifiedKey.set(dependency.qualifiedId, Object.freeze({
            kind: 'v2',
            qualifiedKey: dependency.qualifiedId,
            dependency,
        }));
    }
    const mutations = new Map<string, Readonly<{
        operation: 'ensure' | 'update';
        promise: Promise<ManagedDependencyReady>;
    }>>();
    const removals = new Map<string, Promise<void>>();
    const inspections = new Map<string, Promise<ManagedDependencyStatus>>();
    const activeLeases = new Map<string, number>();
    const pendingRunnerRetentionByQualifiedId =
        new Map<string, number>();
    const pendingRunnerRetentionBySourceGenerationId =
        new Map<string, number>();
    let pendingRunnerReservations = 0;
    let generationRetirementReserved = false;

    const snapshotRunnerRetention = (
        binding: AgentSessionRunnerBindingV1,
        hostAccessRequests: readonly Readonly<{
            request: PluginHostAccessRequestV2;
            required: boolean;
        }>[],
    ): RunnerManagedDependencyRetentionV1 => {
        const qualifiedDependencyIds =
            resolveRunnerManagedDependencyQualifiedIds(
                binding,
                hostAccessRequests,
            );
        const sourceCandidatesByIdentity = new Map<
            string,
            RunnerManagedDependencySourceCandidateV1
        >();
        const addSourceCandidate = (owner: V2DescriptorOwner): void => {
            const immutableGenerationId =
                params.immutableGenerationIdsByPluginId?.get(
                    owner.dependency.identity.pluginId,
                );
            if (!immutableGenerationId) {
                return fail(
                    'plugin_managed_dependency_retention_generation_unavailable',
                    'Managed dependency immutable source generation is unavailable',
                );
            }
            const sourceCandidate = Object.freeze({
                qualifiedDependencyId: owner.qualifiedKey,
                immutableGenerationId,
                manifestAuthority:
                    owner.dependency.provenance === 'first_party'
                        ? 'bundled_first_party' as const
                        : 'external' as const,
            });
            sourceCandidatesByIdentity.set(
                JSON.stringify([
                    sourceCandidate.qualifiedDependencyId,
                    sourceCandidate.immutableGenerationId,
                ]),
                sourceCandidate,
            );
        };
        for (const qualifiedId of qualifiedDependencyIds) {
            const owner = ownersByQualifiedKey.get(qualifiedId);
            if (!owner) {
                return fail(
                    'plugin_managed_dependency_undeclared',
                    'Retained Runner Agent declaration references an undeclared managed dependency',
                );
            }
            if (owner.kind !== 'v2') continue;
            addSourceCandidate(owner);
            for (const source of owner.dependency.sources) {
                if (
                    source.declaration.kind
                        !== 'managedPypiWheelAsset'
                ) continue;
                const winner = params.installablesRegistry.descriptorsByKey[
                    source.declaration.installId
                ];
                if (!winner) continue;
                const winnerOwner =
                    projectedV2RegistryContributions.get(winner);
                if (!winnerOwner) {
                    return fail(
                        'plugin_managed_dependency_retention_generation_unavailable',
                        'Managed dependency collision winner has no immutable source generation',
                    );
                }
                addSourceCandidate(winnerOwner);
            }
        }
        const sourceCandidates = [
            ...sourceCandidatesByIdentity.values(),
        ].sort((left, right) => (
            left.qualifiedDependencyId.localeCompare(
                right.qualifiedDependencyId,
            ) || left.immutableGenerationId.localeCompare(
                right.immutableGenerationId,
            ) || left.manifestAuthority.localeCompare(
                right.manifestAuthority,
            )
        ));
        const sourceGenerationIds = [
            ...new Set(sourceCandidates.map(
                ({ immutableGenerationId }) => immutableGenerationId,
            )),
        ].sort();
        return mergeRunnerManagedDependencyRetentionV1({
            v: 1,
            sourceGenerationIds,
            qualifiedDependencyIds: [...qualifiedDependencyIds],
            sourceCandidates,
        });
    };

    const readLiveRunnerRetention = async ():
    Promise<RunnerManagedDependencyRetentionV1> =>
        params.readLiveRunnerRetention
            ? await params.readLiveRunnerRetention()
            : mergeRunnerManagedDependencyRetentionV1();

    const reserveRunnerRetention = (
        binding: AgentSessionRunnerBindingV1,
        hostAccessRequests: readonly Readonly<{
            request: PluginHostAccessRequestV2;
            required: boolean;
        }>[],
    ): Readonly<{
        retention: RunnerManagedDependencyRetentionV1;
        release(): void;
    }> => {
        if (
            removals.size > 0
            || generationRetirementReserved
        ) {
            fail(
                'plugin_managed_dependency_busy',
                'Managed dependency retention cannot attach during destructive work',
            );
        }
        const retention = snapshotRunnerRetention(
            binding,
            hostAccessRequests,
        );
        pendingRunnerReservations += 1;
        for (
            const qualifiedId of
            retention.qualifiedDependencyIds
        ) {
            pendingRunnerRetentionByQualifiedId.set(
                qualifiedId,
                (
                    pendingRunnerRetentionByQualifiedId.get(
                        qualifiedId,
                    ) ?? 0
                ) + 1,
            );
        }
        for (
            const generationId of
            retention.sourceGenerationIds
        ) {
            pendingRunnerRetentionBySourceGenerationId.set(
                generationId,
                (
                    pendingRunnerRetentionBySourceGenerationId.get(
                        generationId,
                    ) ?? 0
                ) + 1,
            );
        }
        let released = false;
        return Object.freeze({
            retention,
            release() {
                if (released) return;
                released = true;
                pendingRunnerReservations -= 1;
                for (
                    const qualifiedId of
                    retention.qualifiedDependencyIds
                ) {
                    const next = (
                        pendingRunnerRetentionByQualifiedId.get(
                            qualifiedId,
                        ) ?? 1
                    ) - 1;
                    if (next <= 0) {
                        pendingRunnerRetentionByQualifiedId.delete(
                            qualifiedId,
                        );
                    } else {
                        pendingRunnerRetentionByQualifiedId.set(
                            qualifiedId,
                            next,
                        );
                    }
                }
                for (
                    const generationId of
                    retention.sourceGenerationIds
                ) {
                    const next = (
                        pendingRunnerRetentionBySourceGenerationId.get(
                            generationId,
                        ) ?? 1
                    ) - 1;
                    if (next <= 0) {
                        pendingRunnerRetentionBySourceGenerationId.delete(
                            generationId,
                        );
                    } else {
                        pendingRunnerRetentionBySourceGenerationId.set(
                            generationId,
                            next,
                        );
                    }
                }
            },
        });
    };

    const assertDependencyNotRunnerRetained = async (
        owner: DescriptorOwner,
    ): Promise<void> => {
        const retained = await readLiveRunnerRetention();
        if (
            (
                pendingRunnerRetentionByQualifiedId.get(
                    owner.qualifiedKey,
                ) ?? 0
            ) > 0
            ||
            retained.qualifiedDependencyIds.includes(
                owner.qualifiedKey,
            )
        ) {
            fail(
                'plugin_managed_dependency_in_use',
                'Managed dependency is retained by a live Agent runner',
            );
        }
    };

    function resolveOwner(pluginId: string, id: string): DescriptorOwner | null {
        return ownersByQualifiedKey.get(qualifiedKey(pluginId, id))
            ?? ownersByQualifiedKey.get(id)
            ?? null;
    }

    function requireOwner(pluginId: string, id: string): DescriptorOwner {
        return resolveOwner(pluginId, id) ?? fail(
            'plugin_managed_dependency_undeclared',
            'Managed dependency is not declared for this plugin',
        );
    }

    function assertV2Current(owner: DescriptorOwner): void {
        if (owner.kind === 'v2') params.sourceModel?.resolve(owner.dependency.identity);
    }

    function v2ExecutableSources(owner: V2DescriptorOwner): readonly ManagedDependencySourceModelEntry[] {
        return owner.dependency.sources.filter((source) => (
            source.disposition === 'executable'
            && isCanonicalV2ManagedSource(owner, source)
        ));
    }

    function v2ManualFallbackCode(owner: V2DescriptorOwner): string | null {
        const source = owner.dependency.sources
            .filter((candidate) => candidate.disposition === 'manual')
            .sort((left, right) => left.declarationIndex - right.declarationIndex)[0];
        return source?.kind === 'vendorRecipe'
            ? 'plugin_managed_dependency_vendor_recipe_required'
            : source?.kind === 'manual'
                ? 'plugin_managed_dependency_manual_required'
                : null;
    }

    function v2MutationRequiresHostConsent(owner: V2DescriptorOwner): boolean {
        return owner.dependency.sources.some((source) => (
            source.declaration.kind === 'managedPypiWheelAsset'
            && source.declaration.installConsent === 'host_managed_required'
        ));
    }

    function unsupportedCode(owner: DescriptorOwner): string | null {
        if (owner.kind === 'legacy') return legacyUnsupportedCode(owner.contribution.descriptor);
        if (owner.dependency.availability.state === 'unavailable') return owner.dependency.availability.code;
        if (v2ExecutableSources(owner).length > 0) return null;
        if (owner.dependency.sources.some((source) => (
            source.declaration.kind === 'managedPypiWheelAsset'
            && !isCanonicalV2ManagedSource(owner, source)
        ))) {
            return 'plugin_managed_dependency_source_conflict';
        }
        return v2ManualFallbackCode(owner) ?? 'plugin_managed_dependency_source_unsupported';
    }

    async function adapterCandidatesFor(owner: DescriptorOwner): Promise<readonly ResolvedOwnerAdapter[]> {
        assertV2Current(owner);
        const code = unsupportedCode(owner);
        if (code) fail(code, 'Managed dependency source requires an explicit host or user action');
        if (owner.kind === 'legacy') {
            try {
                return Object.freeze([Object.freeze({
                    adapter: await params.resolveAdapter(owner.contribution.descriptor.key, { installablesRegistry: params.installablesRegistry }),
                    sourceId: null,
                    source: null,
                })]);
            } catch {
                return fail(
                    'plugin_managed_dependency_source_unsupported',
                    'Managed dependency source is not executable by this host',
                );
            }
        }
        if (!params.resolveSourceAdapter) {
            return fail('plugin_managed_dependency_source_unsupported', 'Managed dependency source is not executable by this host');
        }
        const candidates: ResolvedOwnerAdapter[] = [];
        let sourceAdapterFailure: PluginError | null = null;
        for (const source of v2ExecutableSources(owner)) {
            try {
                const sourceInstallable = sourceInstallableFor(owner, source);
                candidates.push(Object.freeze({
                    adapter: await params.resolveSourceAdapter({
                        dependency: owner.dependency,
                        source,
                        ...(sourceInstallable
                            ? { sourceInstallable: sourceInstallable.descriptor }
                            : {}),
                    }),
                    sourceId: source.sourceId,
                    source,
                }));
            } catch (error) {
                if (!sourceAdapterFailure && isPluginError(error)) {
                    sourceAdapterFailure = error;
                }
                // A host may support only a subset of declared source kinds. Continue in source order.
            }
        }
        if (candidates.length === 0) {
            const manualFallback = owner.kind === 'v2' ? v2ManualFallbackCode(owner) : null;
            if (manualFallback) {
                return fail(manualFallback, 'Managed dependency source requires an explicit host or user action');
            }
            if (sourceAdapterFailure) throw sourceAdapterFailure;
            return fail(
                'plugin_managed_dependency_source_unsupported',
                'Managed dependency source is not executable by this host',
            );
        }
        return Object.freeze(candidates);
    }

    async function adapterIsReady(
        owner: DescriptorOwner,
        candidate: ResolvedOwnerAdapter,
    ): Promise<boolean> {
        try {
            const resolution = await candidate.adapter.detectLaunchResolution({ env: params.env });
            if (!resolution.availability.ok || !candidate.adapter.resolveLaunchCommand) return false;
            const launch = await candidate.adapter.resolveLaunchCommand({
                env: params.env,
                sourcePreference: owner.kind === 'legacy'
                    ? sourcePreference(owner.contribution.descriptor)
                    : 'system-first',
            });
            return launch.ok;
        } catch {
            return false;
        }
    }

    async function mutationAdapterFor(
        owner: DescriptorOwner,
        operation: 'ensure' | 'update' | 'remove',
    ): Promise<ResolvedOwnerAdapter> {
        const candidates = await adapterCandidatesFor(owner);
        if (owner.kind === 'legacy') return candidates[0]!;
        const managedCandidates = candidates.filter((candidate) => candidate.source?.kind !== 'system');
        if (operation !== 'ensure') {
            for (const candidate of managedCandidates) {
                if (await adapterIsReady(owner, candidate)) return candidate;
            }
        }
        return managedCandidates[0]
            ?? fail('plugin_managed_dependency_system_missing', 'System managed dependency is not installed');
    }

    function sourcePreference(descriptor: InstallableDependencyDescriptor): 'system-first' | 'managed-first' {
        return descriptor.binary.systemFirst === false ? 'managed-first' : 'system-first';
    }

    async function inspect(owner: DescriptorOwner, publicId: string, signal?: AbortSignal): Promise<ManagedDependencyStatus> {
        assertNotAborted(signal);
        assertV2Current(owner);
        const code = unsupportedCode(owner);
        if (code) return Object.freeze({ state: 'unsupported', id: publicId, code });
        let resolvedAdapters: readonly ResolvedOwnerAdapter[];
        try {
            resolvedAdapters = await adapterCandidatesFor(owner);
        } catch (error) {
            if (isPluginError(error)) {
                return Object.freeze({ state: 'unsupported', id: publicId, code: error.code });
            }
            return Object.freeze({ state: 'failed', id: publicId, code: 'plugin_managed_dependency_status_failed' });
        }
        assertNotAborted(signal);
        let sawMissing = false;
        let failureCode: string | null = null;
        for (const resolvedAdapter of resolvedAdapters) {
            try {
                const { adapter } = resolvedAdapter;
                const resolution = await adapter.detectLaunchResolution({ env: params.env });
                assertNotAborted(signal);
                if (!resolution.availability.ok) {
                    sawMissing = true;
                    continue;
                }
                const launch = adapter.resolveLaunchCommand
                    ? await adapter.resolveLaunchCommand({
                        env: params.env,
                        sourcePreference: owner.kind === 'legacy'
                            ? sourcePreference(owner.contribution.descriptor)
                            : 'system-first',
                    })
                    : null;
                assertNotAborted(signal);
                if (!launch?.ok) {
                    failureCode = 'plugin_managed_dependency_executable_unavailable';
                    continue;
                }
                const capabilityStatus = adapter.detectCapabilityStatus
                    ? await adapter.detectCapabilityStatus({ includeLatestVersion: true, onlyIfInstalled: true })
                    : null;
                const version = readVersion(capabilityStatus, 'version', 'installedVersion') ?? UNKNOWN_VERSION;
                const availableVersion = readVersion(capabilityStatus, 'availableVersion', 'latestVersion');
                const executable = Object.freeze({ kind: 'managedDependency' as const, id: publicId });
                if (availableVersion && availableVersion !== version) {
                    return Object.freeze({
                        state: 'updateAvailable', id: publicId, version, availableVersion,
                        sourceId: resolvedAdapter.sourceId ?? launch.source, executable,
                    });
                }
                return Object.freeze({
                    state: 'ready', id: publicId, version,
                    sourceId: resolvedAdapter.sourceId ?? launch.source, executable,
                });
            } catch (error) {
                if (signal?.aborted) {
                    return fail('plugin_managed_dependency_aborted', 'Managed dependency operation was aborted');
                }
                failureCode = isPluginError(error) ? error.code : 'plugin_managed_dependency_status_failed';
            }
        }
        if (sawMissing) {
            const manualFallback = owner.kind === 'v2' ? v2ManualFallbackCode(owner) : null;
            if (manualFallback) return Object.freeze({ state: 'unsupported', id: publicId, code: manualFallback });
            return Object.freeze({ state: 'missing', id: publicId, supported: true as const });
        }
        return Object.freeze({ state: 'failed', id: publicId, code: failureCode ?? 'plugin_managed_dependency_status_failed' });
    }

    async function mutate(
        owner: DescriptorOwner,
        publicId: string,
        operation: 'ensure' | 'update',
    ): Promise<ManagedDependencyReady> {
        if (removals.has(owner.qualifiedKey)) {
            return fail('plugin_managed_dependency_busy', 'Managed dependency is being removed');
        }
        const existing = mutations.get(owner.qualifiedKey);
        if (existing) {
            if (operation === 'ensure' || existing.operation === 'update') {
                return await existing.promise;
            }
            await existing.promise;
            if (mutations.get(owner.qualifiedKey) === existing) {
                mutations.delete(owner.qualifiedKey);
            }
            return await mutate(owner, publicId, operation);
        }
        const mutation = Promise.resolve().then(async () => {
            assertV2Current(owner);
            if (operation === 'ensure') {
                const before = await inspect(owner, publicId);
                if (before.state === 'ready') return before;
                if (before.state === 'updateAvailable') {
                    return Object.freeze({
                        state: 'ready' as const,
                        id: before.id,
                        version: before.version,
                        sourceId: before.sourceId,
                        ...(before.executable ? { executable: before.executable } : {}),
                    });
                }
                if (before.state !== 'missing') {
                    return fail(before.code, 'Managed dependency cannot be ensured');
                }
                if (owner.kind === 'legacy') {
                    const descriptor = owner.contribution.descriptor;
                    const settings = params.getSettings() ?? {};
                    const settingsRecord = settings && typeof settings === 'object' && !Array.isArray(settings)
                        ? settings as Record<string, unknown>
                        : {};
                    const machineId = typeof settingsRecord.machineId === 'string' ? settingsRecord.machineId : '';
                    const policy = resolveEffectiveInstallablePolicy({ settings, machineId, descriptor });
                    if (!policy.autoInstallWhenNeeded || descriptor.consent.install === 'required') {
                        return fail(
                            'plugin_managed_dependency_consent_required',
                            'Managed dependency installation requires an explicit user action',
                        );
                    }
                } else if (v2MutationRequiresHostConsent(owner)) {
                    return fail(
                        'plugin_managed_dependency_consent_required',
                        'Managed dependency installation requires an explicit user action',
                    );
                }
            } else if (owner.kind === 'legacy' && owner.contribution.descriptor.consent.update === 'required') {
                return fail(
                    'plugin_managed_dependency_consent_required',
                    'Managed dependency update requires an explicit user action',
                );
            }
            const selected = await mutationAdapterFor(owner, operation);
            if (
                operation === 'update'
                && owner.kind === 'v2'
                && v2MutationRequiresHostConsent(owner)
                && !await adapterIsReady(owner, selected)
            ) {
                return fail(
                    'plugin_managed_dependency_consent_required',
                    'Managed dependency installation requires an explicit user action',
                );
            }
            const installed = await selected.adapter.installOrUpgrade();
            if (!installed.ok) {
                return fail('plugin_managed_dependency_install_failed', 'Managed dependency installation failed');
            }
            const after = await inspect(owner, publicId);
            if (after.state !== 'ready' && after.state !== 'updateAvailable') {
                const code = after.state === 'missing'
                    ? 'plugin_managed_dependency_install_unverified'
                    : after.code;
                return fail(code, 'Managed dependency was not ready after installation');
            }
            if (operation === 'update' && after.state === 'updateAvailable') {
                return fail(
                    'plugin_managed_dependency_update_unverified',
                    'Managed dependency still reports an available update after installation',
                );
            }
            return Object.freeze({
                state: 'ready' as const,
                id: after.id,
                version: after.version,
                sourceId: after.sourceId,
                ...(after.executable ? { executable: after.executable } : {}),
            });
        }).catch((error: unknown) => {
            if (isPluginError(error)) throw error;
            return fail('plugin_managed_dependency_install_failed', 'Managed dependency installation failed');
        });
        const flight = Object.freeze({ operation, promise: mutation });
        mutations.set(owner.qualifiedKey, flight);
        try {
            return await mutation;
        } finally {
            if (mutations.get(owner.qualifiedKey) === flight) mutations.delete(owner.qualifiedKey);
        }
    }

    function bind(pluginId: string): ManagedDependenciesService {
        const service: ManagedDependenciesService = {
            async status(id, options) {
                assertNotAborted(options?.signal);
                const owner = resolveOwner(pluginId, id);
                if (!owner) {
                    return Object.freeze({
                        state: 'unsupported' as const,
                        id,
                        code: 'plugin_managed_dependency_undeclared',
                    });
                }
                try {
                    assertV2Current(owner);
                } catch (error) {
                    if (isPluginError(error) && error.code === 'plugin_managed_dependency_generation_retired') {
                        return Object.freeze({ state: 'unsupported' as const, id, code: error.code });
                    }
                    throw error;
                }
                const existing = inspections.get(owner.qualifiedKey);
                if (existing) return await waitWithAbort(existing, options?.signal);
                const inspection = Promise.resolve().then(async () => await inspect(owner, id));
                inspections.set(owner.qualifiedKey, inspection);
                const cleanup = () => {
                    if (inspections.get(owner.qualifiedKey) === inspection) {
                        inspections.delete(owner.qualifiedKey);
                    }
                };
                void inspection.then(cleanup, cleanup);
                return await waitWithAbort(inspection, options?.signal);
            },
            async ensure(id, options) {
                assertNotAborted(options?.signal);
                const owner = requireOwner(pluginId, id);
                return await waitWithAbort(mutate(owner, id, 'ensure'), options?.signal);
            },
            async update(id, options) {
                assertNotAborted(options?.signal);
                const owner = requireOwner(pluginId, id);
                return await waitWithAbort(mutate(owner, id, 'update'), options?.signal);
            },
            async remove(id, options) {
                assertNotAborted(options?.signal);
                const owner = requireOwner(pluginId, id);
                if ((activeLeases.get(owner.qualifiedKey) ?? 0) > 0) {
                    return fail('plugin_managed_dependency_in_use', 'Managed dependency is in use');
                }
                if (mutations.has(owner.qualifiedKey) || inspections.has(owner.qualifiedKey)) {
                    return fail('plugin_managed_dependency_busy', 'Managed dependency is being inspected, installed, or updated');
                }
                const existing = removals.get(owner.qualifiedKey);
                if (existing) return await waitWithAbort(existing, options?.signal);
                const removal = Promise.resolve().then(async () => {
                    await assertDependencyNotRunnerRetained(owner);
                    assertV2Current(owner);
                    if (owner.kind === 'legacy') {
                        await params.removeManagedInstall({ descriptor: owner.contribution.descriptor });
                        return;
                    }
                    const selected = await mutationAdapterFor(owner, 'remove');
                    const source = selected.source;
                    if (!source || !params.removeManagedSource) {
                        return fail('plugin_managed_dependency_source_unsupported', 'Managed dependency removal is not supported by this host');
                    }
                    await params.removeManagedSource({
                        dependency: owner.dependency,
                        source,
                        adapter: selected.adapter,
                    });
                }).catch((error: unknown) => {
                    if (isPluginError(error)) throw error;
                    return fail('plugin_managed_dependency_remove_failed', 'Managed dependency removal failed');
                });
                removals.set(owner.qualifiedKey, removal);
                const cleanup = () => {
                    if (removals.get(owner.qualifiedKey) === removal) {
                        removals.delete(owner.qualifiedKey);
                    }
                };
                void removal.then(cleanup, cleanup);
                await waitWithAbort(removal, options?.signal);
            },
        };
        return Object.freeze(service);
    }

    async function resolveExecutable(
        executable: ManagedExecutableRef,
        requestingPluginId: string,
    ): Promise<ResolvedExecutableLease> {
        if (executable.kind !== 'managedDependency') {
            return fail('plugin_managed_dependency_invalid_ref', 'Executable is not a managed dependency reference');
        }
        const ref = readRef(executable, requestingPluginId);
        const owner = requireOwner(ref.pluginId, ref.localId);
        activeLeases.set(owner.qualifiedKey, (activeLeases.get(owner.qualifiedKey) ?? 0) + 1);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            const next = (activeLeases.get(owner.qualifiedKey) ?? 1) - 1;
            if (next <= 0) activeLeases.delete(owner.qualifiedKey);
            else activeLeases.set(owner.qualifiedKey, next);
        };
        try {
            if (removals.has(owner.qualifiedKey)) {
                return fail('plugin_managed_dependency_busy', 'Managed dependency is being removed');
            }
            for (const resolvedAdapter of await adapterCandidatesFor(owner)) {
                if (!resolvedAdapter.adapter.resolveLaunchCommand) continue;
                try {
                    const launch = await resolvedAdapter.adapter.resolveLaunchCommand({
                        env: params.env,
                        sourcePreference: owner.kind === 'legacy'
                            ? sourcePreference(owner.contribution.descriptor)
                            : 'system-first',
                    });
                    if (!launch.ok) continue;
                    return Object.freeze({
                        command: launch.command,
                        args: Object.freeze([...(launch.args ?? [])]),
                        release,
                    });
                } catch {
                    // Source failures are isolated so deterministic fallback can continue.
                }
            }
            return fail('plugin_managed_dependency_executable_unavailable', 'Managed dependency executable is unavailable');
        } catch (error) {
            release();
            throw error;
        }
    }

    async function retireGeneration(generationId: string): Promise<void> {
        if (!params.sourceModel) return;
        if (generationRetirementReserved) {
            fail(
                'plugin_managed_dependency_busy',
                'Managed dependency generation retirement is already in progress',
            );
        }
        generationRetirementReserved = true;
        try {
            const retained = await readLiveRunnerRetention();
            const localImmutableSourceGenerationIds = new Set(
                params.sourceModel.snapshot().dependencies.flatMap(
                    (dependency) => {
                        const immutableGenerationId =
                            params.immutableGenerationIdsByPluginId?.get(
                                dependency.identity.pluginId,
                            );
                        return immutableGenerationId
                            ? [immutableGenerationId]
                            : [];
                    },
                ),
            );
            if (
                pendingRunnerReservations > 0
                || retained.sourceGenerationIds.some(
                    (immutableGenerationId) =>
                        localImmutableSourceGenerationIds.has(
                            immutableGenerationId,
                        ),
                )
            ) {
                fail(
                    'plugin_managed_dependency_in_use',
                    'Managed dependency generation is retained by a live Agent runner',
                );
            }
            const modelKeys = new Set(params.sourceModel.snapshot().dependencies.map((dependency) => dependency.qualifiedId));
            const busy = [...modelKeys].some((key) => (
                (activeLeases.get(key) ?? 0) > 0
                || mutations.has(key)
                || removals.has(key)
                || inspections.has(key)
            ));
            if (busy) fail('plugin_managed_dependency_in_use', 'Managed dependency generation is still in use');
            params.sourceModel.retire();
        } finally {
            generationRetirementReserved = false;
        }
    }

    return Object.freeze({
        bind,
        resolveExecutable,
        retireGeneration,
        snapshotRunnerRetention,
        reserveRunnerRetention,
    });
}
