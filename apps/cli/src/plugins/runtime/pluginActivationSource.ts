import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
    resolvePluginAuthorStagingModule,
    type PreparedPluginDevelopmentActivationGraph,
} from '@/plugins/authoring/sourceModule';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import { resolvePluginStorePaths } from '../store/paths';
import {
    assertContainedRegularGenerationFile,
    persistValidatedAgentSessionRunnerFactories,
    type readCurrentCommittedPluginGenerations,
} from '../store/registry/generationStore';
import type { PluginActivationSource } from './activationSources';
import type { ActivationTarget } from './lifecycle/activation/targets';
import {
    loadPluginModule,
    resolvePluginModuleCandidatePaths,
    resolvePluginModuleLoadMode,
} from './loadPluginModule';
import { bindPluginRuntimeSourceAuthority } from './sourceAuthority';
import type { PluginDaemonModuleNamespace, PreparedPluginActivationGraph } from './types';

/**
 * The per-plugin activation-source factory: selects exactly one source for a
 * plugin — a prepared development graph, the bundled first-party packaged
 * runtime, or the plugin's committed managed immutable generation — and binds
 * its source authority. It owns no registry state; the executable-registry
 * composition root calls it once per activation target.
 */
export function createPluginActivationSourceResolver(deps: Readonly<{
    committed: NonNullable<Awaited<ReturnType<typeof readCurrentCommittedPluginGenerations>>> | null;
    resolveBundledActivationSource: (target: ActivationTarget) => PluginActivationSource<PluginDaemonModuleNamespace> | null;
    preparedActivationGraphsByPluginId?: ReadonlyMap<string, PreparedPluginActivationGraph>;
    preparedDevelopmentActivationGraphsByPluginId?: ReadonlyMap<string, PreparedPluginDevelopmentActivationGraph>;
    happyHomeDir?: string;
    /** Records which manifest authority each activated plugin was admitted under. */
    activatedManifestAuthorityByPluginId: Map<string, 'external' | 'bundled_first_party'>;
}>) {
    return (
        target: ActivationTarget,
        options: Readonly<{
            recordActivatedManifestAuthority?: boolean;
        }> = {},
    ): PluginActivationSource<PluginDaemonModuleNamespace> | null => {
        const development = deps.preparedDevelopmentActivationGraphsByPluginId?.get(target.pluginId);
        if (development) {
            if (
                realpathSync(resolve(development.rootPath)) !== development.sourceAuthority.canonicalRoot
                || realpathSync(resolve(development.entryPath)) !== realpathSync(resolve(target.devDaemonEntryPath ?? target.daemonEntryPath ?? ''))
            ) {
                throw new Error(`Prepared development activation graph identity does not match '${target.pluginId}'`);
            }
            return {
                kind: 'prepared',
                module: development.module,
                sourceAuthority: development.sourceAuthority,
                resolveRelativeModule: async (module) => await resolvePluginAuthorStagingModule({
                    graph: {
                        rootPath: development.rootPath,
                        entryPath: development.entryPath,
                        generationScope: development.candidateScope,
                    },
                    module,
                }),
            };
        }
        const bundled = deps.resolveBundledActivationSource(target);
        if (bundled) {
            if (options.recordActivatedManifestAuthority !== false) {
                deps.activatedManifestAuthorityByPluginId.set(
                    target.pluginId,
                    'bundled_first_party',
                );
            }
            return bundled;
        }
        if (!deps.committed) return null;
        const admitted = deps.committed.generations.get(target.pluginId);
        if (!admitted?.installation?.trust) return null;
        const installation = admitted.installation;
        const useDevelopmentEntry = target.sourceSpec?.devWatch === true && Boolean(target.devDaemonEntryPath);
        const targetEntryPath = useDevelopmentEntry
            ? target.devDaemonEntryPath
            : (target.daemonEntryPath ?? target.devDaemonEntryPath);
        if (!targetEntryPath) return null;
        const entryPath = realpathSync(resolve(targetEntryPath));
        const generationRootPath = realpathSync(admitted.rootPath);
        const relativeEntryPath = relative(generationRootPath, entryPath);
        if (
            entryPath === generationRootPath
            || !isCanonicalAbsolutePathInsideRoot(generationRootPath, entryPath)
        ) {
            throw new Error(`Committed plugin activation entry '${entryPath}' escapes immutable generation '${generationRootPath}' for '${target.pluginId}'`);
        }
        const portableEntryPath = relativeEntryPath.split(sep).join('/');
        if (!admitted.record.files.some((file) => file.relativePath === portableEntryPath)) {
            throw new Error(`Committed plugin activation entry is absent from immutable generation for '${target.pluginId}'`);
        }
        const committedAuthorization = Object.freeze({
            pluginId: target.pluginId,
            immutableGenerationId: admitted.immutableGenerationId,
        });
        const sourceAuthority = bindPluginRuntimeSourceAuthority({
            custody: {
                kind: 'managed',
                immutableGenerationId: admitted.immutableGenerationId,
                installSource: installation.source.distribution.kind,
            },
            resolvedRoot: generationRootPath,
        });
        const preparedActivationGraph = deps.preparedActivationGraphsByPluginId?.get(
            target.pluginId,
        );
        if (preparedActivationGraph && (
            preparedActivationGraph.immutableGenerationId !== admitted.immutableGenerationId
            || realpathSync(resolve(preparedActivationGraph.rootPath)) !== generationRootPath
            || realpathSync(resolve(preparedActivationGraph.entryPath)) !== entryPath
        )) {
            throw new Error(
                `Prepared plugin activation graph identity does not match admitted immutable generation for '${target.pluginId}'`,
            );
        }
        const resolveRelativeModule: NonNullable<
            PluginActivationSource<PluginDaemonModuleNamespace>['resolveRelativeModule']
        > = async (module) => {
            const candidateBase = resolve(dirname(entryPath), module);
            const loadMode = resolvePluginModuleLoadMode({
                entryPath,
                useDevelopmentEntry,
            });
            const extensionCandidates = resolvePluginModuleCandidatePaths({
                candidateBase,
                loadMode,
            });
            let modulePath: string | null = null;
            let lexicalModulePath: string | null = null;
            for (const candidate of extensionCandidates) {
                try {
                    const candidateMetadata = await lstat(candidate);
                    if (
                        !candidateMetadata.isSymbolicLink()
                        && !candidateMetadata.isFile()
                    ) {
                        continue;
                    }
                    modulePath = await realpath(candidate);
                    lexicalModulePath = candidate;
                    break;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
            if (!modulePath) {
                throw new Error(
                    `Runner module '${module}' was not found in immutable generation for '${target.pluginId}'`,
                );
            }
            if (!lexicalModulePath) {
                throw new Error(
                    `Runner module '${module}' lost its immutable path identity for '${target.pluginId}'`,
                );
            }
            const moduleMetadata = await lstat(lexicalModulePath);
            if (
                moduleMetadata.isSymbolicLink()
                || !moduleMetadata.isFile()
            ) {
                throw new Error(
                    `Runner module '${module}' must be a real immutable file for '${target.pluginId}'`,
                );
            }
            const relativeModulePath = relative(generationRootPath, modulePath);
            if (
                modulePath === generationRootPath
                || !isCanonicalAbsolutePathInsideRoot(generationRootPath, modulePath)
            ) {
                throw new Error(
                    `Runner module '${module}' escapes immutable generation for '${target.pluginId}'`,
                );
            }
            if (modulePath === entryPath) {
                throw new Error(
                    `Runner module '${module}' must be a leaf distinct from the plugin activation entry`,
                );
            }
            const normalizedModulePath = relativeModulePath.split(sep).join('/');
            const inventoryFile = admitted.record.files.find(
                (file) => file.relativePath === normalizedModulePath,
            );
            if (!inventoryFile) {
                throw new Error(
                    `Runner module '${module}' is absent from immutable generation inventory for '${target.pluginId}'`,
                );
            }
            await assertContainedRegularGenerationFile(
                generationRootPath,
                normalizedModulePath,
                `Runner module '${module}'`,
            );
            if (moduleMetadata.size !== inventoryFile.byteLength) {
                throw new Error(
                    `Runner module '${module}' failed immutable generation structural inventory verification for '${target.pluginId}'`,
                );
            }
            const resolvedLoadMode = resolvePluginModuleLoadMode({
                entryPath: modulePath,
                useDevelopmentEntry,
            });
            const moduleNamespace = await loadPluginModule({
                source: {
                    kind: 'file_backed',
                    entryPath: modulePath,
                    ...(useDevelopmentEntry
                        ? { devEntryPath: modulePath, useDevelopmentEntry: true }
                        : {}),
                    committedAuthorization,
                    ...(preparedActivationGraph
                        ? { generationScope: preparedActivationGraph.generationScope }
                        : {}),
                },
                ...(resolvedLoadMode === 'immutable-js'
                    ? { nativeFileUrlMode: 'canonical' as const }
                    : {}),
            });
            return Object.freeze({
                module: moduleNamespace,
                normalizedModulePath,
                loadMode: resolvedLoadMode,
            });
        };
        if (options.recordActivatedManifestAuthority !== false) {
            deps.activatedManifestAuthorityByPluginId.set(
                target.pluginId,
                'external',
            );
        }
        if (preparedActivationGraph) {
            return {
                kind: 'prepared',
                module: preparedActivationGraph.module,
                sourceAuthority,
                committedAuthorization,
                resolveRelativeModule,
                persistValidatedAgentSessionRunnerFactories: async (facts, options) => {
                    await persistValidatedAgentSessionRunnerFactories({
                        paths: resolvePluginStorePaths({
                            happyHomeDir: deps.happyHomeDir,
                        }),
                        record: admitted.record,
                        manifestAuthority: 'external',
                        factories: facts,
                        assertCurrent: options.assertCurrent,
                    });
                    return facts;
                },
            };
        }
        return {
            kind: 'file_backed',
            entryPath,
            sourceAuthority,
            ...(useDevelopmentEntry ? {
                devEntryPath: entryPath,
                useDevelopmentEntry: true,
            } : {}),
            trustPolicy: target.sourceSpec?.trustPolicy,
            committedAuthorization,
            resolveRelativeModule,
            persistValidatedAgentSessionRunnerFactories: async (facts, options) => {
                await persistValidatedAgentSessionRunnerFactories({
                    paths: resolvePluginStorePaths({
                        happyHomeDir: deps.happyHomeDir,
                    }),
                    record: admitted.record,
                    manifestAuthority: 'external',
                    factories: facts,
                    assertCurrent: options.assertCurrent,
                });
                return facts;
            },
        };
    };
}
