import { join } from 'node:path';

import { resolveInstallablesRegistry } from '@happier-dev/protocol/installables';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import { readPluginManifest } from '@/plugins/manifest/read';
import type {
    ResolvedInstallableContribution,
} from '@/plugins/projection/registry/types';
import type { PluginStorePaths } from '@/plugins/store/paths';
import {
    readPreparedImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import type {
    AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type {
    RunnerManagedDependencySourceCandidateV1,
    RunnerManagedDependencyRetentionV1,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';

import {
    resolveExecutableManagedDependenciesRegistry,
} from '@/plugins/projection/registry/managedDependencyExecutables';
import {
    createStablePluginManagedDependenciesHost,
    resolveRunnerManagedDependencyQualifiedIds,
    type StablePluginManagedDependenciesHost,
} from './managedDependencies';
import {
    createProductionManagedDependencySourceAdapter,
} from './managedDependencySourceAdapters';
import {
    createV2ManagedDependencySourceModel,
} from './managedDependencySourceModel';

function unavailable(): never {
    throw new PluginError({
        code:
            'plugin_services_retained_managed_dependency_unavailable',
        message:
            'Exact retained Runner Agent managed-dependency authority is unavailable',
    });
}

function sourceSpec(
    pluginId: string,
    rootPath: string,
    manifestAuthority: 'external' | 'bundled_first_party',
) {
    return manifestAuthority === 'bundled_first_party'
        ? Object.freeze({
            kind: 'bundled' as const,
            locator: pluginId,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
        })
        : Object.freeze({
            kind: 'path' as const,
            locator: rootPath,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
        });
}

export async function createRetainedRunnerManagedDependenciesHost(
    params: Readonly<{
        paths: PluginStorePaths;
        binding: AgentSessionRunnerBindingV1;
        hostAccessRequests: readonly Readonly<{
            request: PluginHostAccessRequestV2;
            required: boolean;
        }>[];
        retention: RunnerManagedDependencyRetentionV1;
        agentManifestAuthority:
            'external' | 'bundled_first_party';
        env?: NodeJS.ProcessEnv;
    }>,
): Promise<Pick<StablePluginManagedDependenciesHost, 'resolveExecutable'>> {
    const expectedQualifiedIds =
        resolveRunnerManagedDependencyQualifiedIds(
            params.binding,
            params.hostAccessRequests,
        );
    if (
        JSON.stringify(expectedQualifiedIds)
            !== JSON.stringify(
                params.retention.qualifiedDependencyIds,
            )
    ) {
        return unavailable();
    }
    if (expectedQualifiedIds.length === 0) {
        if (
            params.retention.sourceGenerationIds.length !== 0
            || (params.retention.sourceCandidates?.length ?? 0) !== 0
        ) {
            return unavailable();
        }
        return createStablePluginManagedDependenciesHost({
            installablesRegistry: resolveInstallablesRegistry({}),
            getSettings: () => ({}),
            resolveAdapter: async () => unavailable(),
            removeManagedInstall: async () => unavailable(),
            ...(params.env ? { env: params.env } : {}),
        });
    }

    const sourceCandidates = params.retention.sourceCandidates;
    if (!sourceCandidates || sourceCandidates.length === 0) {
        return unavailable();
    }
    const expectedQualifiedIdSet = new Set(expectedQualifiedIds);
    const sourceCandidateQualifiedIds = sourceCandidates.map(
        ({ qualifiedDependencyId }) => qualifiedDependencyId,
    );
    if (
        expectedQualifiedIds.some(
            (qualifiedId) =>
                !sourceCandidateQualifiedIds.includes(qualifiedId),
        )
        || JSON.stringify([
            ...new Set(sourceCandidates.map(
                ({ immutableGenerationId }) =>
                    immutableGenerationId,
            )),
        ].sort()) !== JSON.stringify(
            params.retention.sourceGenerationIds,
        )
    ) {
        return unavailable();
    }
    const sourceCandidatesByGenerationId = new Map<
        string,
        RunnerManagedDependencySourceCandidateV1[]
    >();
    for (const sourceCandidate of sourceCandidates) {
        const existing = sourceCandidatesByGenerationId.get(
            sourceCandidate.immutableGenerationId,
        ) ?? [];
        existing.push(sourceCandidate);
        sourceCandidatesByGenerationId.set(
            sourceCandidate.immutableGenerationId,
            existing,
        );
    }

    const registryCandidates: ResolvedInstallableContribution[] = [];
    const immutableGenerationIdsByPluginId = new Map<string, string>();
    try {
        for (
            const immutableGenerationId
            of params.retention.sourceGenerationIds
        ) {
            const generation =
                await readPreparedImmutablePluginGeneration({
                    paths: params.paths,
                    immutableGenerationId,
                });
            const pluginId = generation.record.pluginId;
            const candidatesForGeneration =
                sourceCandidatesByGenerationId.get(
                    immutableGenerationId,
                );
            if (
                !candidatesForGeneration
                || candidatesForGeneration.length === 0
                || immutableGenerationIdsByPluginId.has(pluginId)
            ) {
                return unavailable();
            }
            const candidateQualifiedIds = new Set<string>();
            let manifestAuthority:
                'external' | 'bundled_first_party' | null = null;
            for (const candidate of candidatesForGeneration) {
                const separator =
                    candidate.qualifiedDependencyId.indexOf('/');
                if (
                    separator <= 0
                    || separator
                        === candidate.qualifiedDependencyId.length - 1
                    || candidate.qualifiedDependencyId.slice(
                        0,
                        separator,
                    ) !== pluginId
                    || (
                        manifestAuthority !== null
                        && manifestAuthority
                            !== candidate.manifestAuthority
                    )
                ) {
                    return unavailable();
                }
                candidateQualifiedIds.add(
                    candidate.qualifiedDependencyId,
                );
                manifestAuthority = candidate.manifestAuthority;
            }
            if (!manifestAuthority) return unavailable();
            if (
                immutableGenerationId
                    === params.binding.immutableGenerationId
                && pluginId === params.binding.pluginId
                && manifestAuthority
                    !== params.agentManifestAuthority
            ) {
                return unavailable();
            }
            const manifestPath = join(
                generation.rootPath,
                ...generation.record.manifestRelativePath.split('/'),
            );
            const manifest = await readPluginManifest({
                manifestPath,
                manifestAuthority,
            });
            if (
                !manifest.ok
                || manifest.manifest.id !== pluginId
            ) {
                return unavailable();
            }
            const dependencyDefinitions =
                manifest.manifest.contributes.managedDependencies
                ?? [];
            for (const definition of dependencyDefinitions) {
                const qualifiedId = `${pluginId}/${definition.id}`;
                if (!candidateQualifiedIds.has(qualifiedId)) continue;
                registryCandidates.push(Object.freeze({
                    provenance:
                        manifestAuthority === 'bundled_first_party'
                            ? 'first_party' as const
                            : 'external' as const,
                    source: Object.freeze({
                        kind:
                            manifestAuthority
                                === 'bundled_first_party'
                                ? 'bundled' as const
                                : 'path' as const,
                    }),
                    pluginId,
                    manifestPath,
                    daemonEntryPath: null,
                    sourceSpec: sourceSpec(
                        pluginId,
                        generation.rootPath,
                        manifestAuthority,
                    ),
                    definition,
                }));
            }
            immutableGenerationIdsByPluginId.set(
                pluginId,
                immutableGenerationId,
            );
        }
    } catch {
        return unavailable();
    }

    const resolvedCandidateQualifiedIds = registryCandidates.map(
        (contribution) =>
            `${contribution.pluginId}/${contribution.definition.id}`,
    ).sort();
    if (
        JSON.stringify(resolvedCandidateQualifiedIds)
            !== JSON.stringify([...sourceCandidateQualifiedIds].sort())
        || immutableGenerationIdsByPluginId.size
            !== sourceCandidatesByGenerationId.size
    ) {
        return unavailable();
    }
    const requestedContributions = registryCandidates.filter(
        (contribution) => expectedQualifiedIdSet.has(
            `${contribution.pluginId}/${contribution.definition.id}`,
        ),
    );
    if (requestedContributions.length !== expectedQualifiedIds.length) {
        return unavailable();
    }

    try {
        const sourceModel = createV2ManagedDependencySourceModel({
            platform: process.platform === 'darwin'
                ? 'darwin'
                : process.platform === 'win32'
                    ? 'win32'
                    : 'linux',
            architecture: process.arch,
            contributions: requestedContributions,
        });
        return createStablePluginManagedDependenciesHost({
            installablesRegistry:
                resolveExecutableManagedDependenciesRegistry(
                    registryCandidates,
                    {
                        platform: process.platform,
                        architecture: process.arch,
                    },
                ),
            sourceModel,
            immutableGenerationIdsByPluginId,
            getSettings: () => ({}),
            resolveAdapter: async () => unavailable(),
            resolveSourceAdapter:
                createProductionManagedDependencySourceAdapter,
            removeManagedInstall: async () => unavailable(),
            removeManagedSource: async () => unavailable(),
            ...(params.env ? { env: params.env } : {}),
        });
    } catch {
        return unavailable();
    }
}
