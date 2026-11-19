import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';

import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import {
    createPluginReloadController,
    type PluginReloadController,
    type PluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/controller';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { loadVerifiedPluginModule } from '@/plugins/runtime/loadPluginModule';
import {
    createPreparedPluginActivationGraph,
    type PluginDaemonModuleNamespace,
    type PreparedPluginActivationGraph,
} from '@/plugins/runtime/types';
import { resolvePluginStorePaths, PLUGIN_MANIFEST_RELATIVE_PATH } from '@/plugins/store/paths';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { assertContainedRegularGenerationFile, readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry, resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { PluginDaemonDatabaseQuiescence } from '@/plugins/runtime/context/daemonDatabase';

type RuntimeOptions = Omit<
    NonNullable<Parameters<typeof resolveExecutablePluginRuntimeRegistry>[0]>,
    | 'happyHomeDir'
    | 'generation'
    | 'resolveDevelopmentSourceAuthority'
    | 'currentGlobalExternalSessionsRouter'
    | 'targetedContributions'
>;

type PublishedFixtureRegistry = ResolvedExecutablePluginRuntimeRegistry & Readonly<{
    generation: number;
    targetActivationFacts: NonNullable<ResolvedExecutablePluginRuntimeRegistry['targetActivationFacts']>;
}>;

export interface AdmittedPluginRuntimeFixture {
    happyHomeDir: string;
    controller: PluginReloadController;
    lease: PluginRuntimeRegistryLease;
    registry: PublishedFixtureRegistry;
    dispose(): Promise<void>;
}

function assertPublishedFixtureFacts(
    registry: ResolvedExecutablePluginRuntimeRegistry,
): asserts registry is PublishedFixtureRegistry {
    if (registry.generation === undefined || registry.targetActivationFacts === undefined) {
        throw new Error('Admitted runtime fixture did not publish its generation and activation facts');
    }
}

type AuthoredAdmittedPluginRuntimeFixture = Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> & Readonly<{
    committed: NonNullable<Awaited<ReturnType<typeof readCurrentCommittedPluginGenerations>>>;
    modulesByPluginId: Map<string, PluginDaemonModuleNamespace>;
    preparedActivationGraphsByPluginId: Map<string, PreparedPluginActivationGraph>;
}>;

/** Retire a fixture's publication without ending the caller-owned daemon lifetime. */
/** Authored fixtures that ship a daemon module name its declared entry file; a manifest without one is a fixture error. */
export function requireDaemonEntrypoint(manifest: Readonly<{ entrypoints?: Readonly<{ daemon?: string }> }>): string {
    const daemon = manifest.entrypoints?.daemon;
    if (!daemon) throw new Error('Fixture manifest declares no daemon entrypoint');
    return daemon;
}

export async function retireAdmittedPluginRuntimeRegistry(params: Readonly<{
    controller: PluginReloadController;
    registry: ResolvedExecutablePluginRuntimeRegistry;
    happyHomeDir?: string;
    generationAuthority?: RuntimeOptions['generationAuthority'];
}>) {
    if (!params.controller.isRuntimeRegistryCurrent(params.registry)) return;
    await params.controller.adoptPreparedRuntimeRegistry({
        registry: await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: params.happyHomeDir,
            pluginIds: [],
            contributes: createResolvedContributionRegistry({}),
            // The empty retirement view has no Account work of its own.
            scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
            // Keep the fixture's isolated declarations paired with their
            // committed source authority, including its empty retirement view.
            generationAuthority: params.generationAuthority,
            currentGlobalExternalSessionsRouter: params.controller.currentGlobalExternalSessions,
            targetedContributions: params.controller.getTargetedContributionsOwner(),
        }),
        changedPluginIds: params.registry.contributes.activationTargets.map(target => target.pluginId),
        runningSessionDisposition: 'retainRunningSessions',
    });
}

/** Exercises the real source-admission, activation, and publication owners. */
export async function createAdmittedPluginRuntimeFixture(params: Readonly<{
    happyHomeDir?: string;
    controller?: PluginReloadController;
    runtimeOptions?: RuntimeOptions;
}> = {}): Promise<AdmittedPluginRuntimeFixture> {
    const ownsHome = params.happyHomeDir === undefined;
    const happyHomeDir = params.happyHomeDir
        ?? await mkdtemp(join(tmpdir(), 'happier-admitted-plugin-runtime-'));
    const controller = params.controller ?? createPluginReloadController({ happyHomeDir });
    const ownsController = params.controller === undefined;
    const developmentRoots = createDaemonPluginDevelopmentRootsOwner({
        happyHomeDir,
        // These fixtures consume product-build membership for exact first-party
        // roots; they do not discover or adopt user development source changes.
        submitObservation: async () => {
            throw new Error('Unexpected development source observation in admitted runtime fixture');
        },
    });
    let incumbentDatabaseQuiescence: PluginDaemonDatabaseQuiescence | null = null;
    const resumeIncumbentDatabases = async () => {
        const quiescence = incumbentDatabaseQuiescence;
        incumbentDatabaseQuiescence = null;
        await quiescence?.resume();
    };
    try {
        const resolveRuntimeRegistry = async () => {
            const registry = await resolveExecutablePluginRuntimeRegistry({
                ...params.runtimeOptions,
                ...(params.runtimeOptions?.contributes === undefined && params.runtimeOptions?.pluginIds !== undefined ? {
                    contributes: await resolveMergedContributionRegistry({ happyHomeDir, pluginIds: params.runtimeOptions.pluginIds }),
                } : {}),
                happyHomeDir,
                generation: controller.getState().generation + 1,
                resolveDevelopmentSourceAuthority: developmentRoots.resolveDevelopmentSourceAuthority,
                currentGlobalExternalSessionsRouter: controller.currentGlobalExternalSessions,
                runtimeRegistryController: controller,
                targetedContributions: controller.getTargetedContributionsOwner(),
            });
            // Authored modules carry the executable database callbacks. Prepare
            // those declarations through the same owner used by daemon reload,
            // before publication can start their continuous background work.
            const pluginIds = registry.contributes.activationTargets.filter(target =>
                target.manifest.contributes.daemonDatabases.length > 0
                && params.runtimeOptions?.preparedActivationGraphsByPluginId?.has(target.pluginId))
                .map(target => target.pluginId);
            if (pluginIds.length === 0) return registry;
            const incumbent = controller.getState().activeRegistry;
            const incumbentContractsByPluginId = new Map(pluginIds.map(pluginId => [pluginId,
                incumbent?.readPreparedDaemonDatabaseContracts?.(pluginId) ?? Object.freeze([])]));
            const incumbentPluginIds = pluginIds.filter(pluginId => incumbentContractsByPluginId.get(pluginId)!.length > 0);
            try {
                if (incumbent && incumbentPluginIds.length > 0) {
                    incumbentDatabaseQuiescence = await incumbent.quiesceDaemonDatabases(incumbentPluginIds);
                }
                await registry.prepareDaemonDatabases({ pluginIds, incumbentContractsByPluginId });
                return registry;
            } catch (error) {
                try { await registry.dispose(); }
                finally { await resumeIncumbentDatabases(); }
                throw error;
            }
        };
        if (params.controller && controller.getState().activeRegistry) {
            // Acquiring an active controller only leases its incumbent. An
            // authored fixture must publish its requested physical candidate
            // through that same owner before readers can observe the declaration.
            await controller.adoptPreparedRuntimeRegistry({
                registry: await resolveRuntimeRegistry(),
                changedPluginIds: params.runtimeOptions?.pluginIds ?? [],
                runningSessionDisposition: 'retainRunningSessions',
            });
        }
        const lease = await controller.acquireRuntimeRegistry({
            resolveRuntimeRegistry,
        });
        if (lease.source !== 'active' || !controller.isRuntimeRegistryCurrent(lease.registry)) {
            await lease.release();
            throw new Error('Admitted runtime fixture did not publish a current registry');
        }
        const registry = lease.registry;
        assertPublishedFixtureFacts(registry);
        incumbentDatabaseQuiescence = null;
        let disposed = false;
        return {
            happyHomeDir,
            controller,
            lease,
            registry,
            async dispose() {
                if (disposed) return;
                disposed = true;
                try {
                    try {
                        await lease.release();
                    } finally {
                        if (ownsController) {
                            await controller.shutdown();
                        } else {
                            await retireAdmittedPluginRuntimeRegistry({
                                controller, registry: lease.registry, happyHomeDir,
                                generationAuthority: params.runtimeOptions?.generationAuthority,
                            });
                        }
                    }
                } finally {
                    await developmentRoots.stop();
                    if (ownsHome) await rm(happyHomeDir, { recursive: true, force: true });
                }
            },
        };
    } catch (error) {
        try {
            try { await resumeIncumbentDatabases(); }
            finally { if (ownsController) await controller.shutdown(); }
        } finally {
            await developmentRoots.stop();
            if (ownsHome) await rm(happyHomeDir, { recursive: true, force: true });
        }
        throw error;
    }
}

/**
 * Admits the same physical manifest/module scope through the real committed
 * source and runtime owners. An optional imported module factory supplies
 * callback bodies for public-SDK UNIT tests; those bodies are not byte-integrity
 * evidence. Custody tests omit that hook and load the physical authored behavior.
 */
export async function createAuthoredAdmittedPluginRuntimeFixture(params: Readonly<{
    plugins: readonly Readonly<{
        manifest: unknown;
        files: Readonly<Record<string, string | Uint8Array>>;
        replaceExisting?: boolean;
        includeAvailability?: boolean;
        instantiateCommittedModule?: (
            module: PluginDaemonModuleNamespace,
        ) => PluginDaemonModuleNamespace | Promise<PluginDaemonModuleNamespace>;
    }>[];
    happyHomeDir?: string;
    controller?: PluginReloadController;
    runtimeOptions?: RuntimeOptions;
    /** Project an isolated declaration universe after these physical plugins are seeded. */
    resolveContributes?(happyHomeDir: string): Promise<NonNullable<RuntimeOptions['contributes']>>;
    /** Omit the explicit plugin scope to exercise normal demand-only startup. */
    coldStart?: boolean;
}>): Promise<AuthoredAdmittedPluginRuntimeFixture> {
    const directory = await mkdtemp(join(tmpdir(), 'happier-authored-plugin-runtime-'));
    const happyHomeDir = params.happyHomeDir ?? join(directory, 'home');
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
    try {
        const manifests = [];
        for (const [index, plugin] of params.plugins.entries()) {
            const ingestion = ingestPluginManifestV2(plugin.manifest);
            if (!ingestion.ok) throw new Error(`Authored runtime fixture manifest is invalid: ${ingestion.diagnostics.map(({ path, message }) => `${path?.join('.') ?? '<manifest>'}: ${message}`).join('; ')}`);
            const manifest = ingestion.manifest;
            manifests.push(manifest);
            const pluginRoot = join(directory, `plugin-${index}`);
            const manifestPath = join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH);
            await mkdir(dirname(manifestPath), { recursive: true });
            await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
            for (const [relativePath, contents] of Object.entries(plugin.files)) {
                const path = resolve(pluginRoot, relativePath);
                if (!isCanonicalAbsolutePathInsideRoot(pluginRoot, path) || path === manifestPath) {
                    throw new Error('Authored runtime fixture file must stay within its module scope');
                }
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, contents, 'utf8');
            }
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir, pluginRoot, pluginId: manifest.id, manifestVersion: manifest.version,
                replaceExisting: plugin.replaceExisting,
                includeAvailability: plugin.includeAvailability,
            });
        }
        const committed = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }));
        if (!committed) throw new Error('Authored runtime fixture has no committed source authority');
        const modulesByPluginId = new Map<string, PluginDaemonModuleNamespace>();
        const preparedActivationGraphsByPluginId = new Map<string, PreparedPluginActivationGraph>();
        for (const [index, plugin] of params.plugins.entries()) {
            const manifest = manifests[index]!;
            const generation = committed.generations.get(manifest.id);
            if (!generation) throw new Error('Authored runtime fixture generation was not admitted');
            const daemonEntry = manifest.entrypoints?.daemon;
            if (!daemonEntry) {
                if (plugin.instantiateCommittedModule) throw new Error('Callback unit fixture requires a declared daemon module');
                continue;
            }
            const entryPath = resolve(generation.rootPath, daemonEntry);
            if (!isCanonicalAbsolutePathInsideRoot(generation.rootPath, entryPath)) {
                throw new Error('Authored runtime fixture daemon entry escapes its committed module scope');
            }
            const relativeEntryPath = relative(generation.rootPath, entryPath).split(sep).join('/');
            if (!generation.record.files.some((file) => file.relativePath === relativeEntryPath)) {
                throw new Error('Authored runtime fixture daemon entry is absent from its committed inventory');
            }
            await assertContainedRegularGenerationFile(generation.rootPath, relativeEntryPath, 'Authored runtime fixture daemon entry');
            const generationScope = {};
            const importedModule = await loadVerifiedPluginModule({
                entryPath, loadMode: 'immutable-js', generationScope,
                cacheKey: generation.immutableGenerationId, nativeFileUrlMode: 'canonical',
            });
            const module = plugin.instantiateCommittedModule
                ? await plugin.instantiateCommittedModule(importedModule)
                : importedModule;
            modulesByPluginId.set(manifest.id, module);
            preparedActivationGraphsByPluginId.set(manifest.id, createPreparedPluginActivationGraph({
                module, generationScope, immutableGenerationId: generation.immutableGenerationId,
                rootPath: generation.rootPath, entryPath,
            }));
        }
        runtime = await createAdmittedPluginRuntimeFixture({
            happyHomeDir,
            ...(params.controller ? { controller: params.controller } : {}),
            runtimeOptions: {
                ...params.runtimeOptions,
                ...(params.resolveContributes ? {
                    contributes: await params.resolveContributes(happyHomeDir),
                    generationAuthority: committed,
                } : {}),
                // Use the installed fixture's real declaration producer without
                // activating unrelated bundled background services. Omit the
                // plugin-id scope so normal demand-only activation remains real.
                ...(params.coldStart && !params.runtimeOptions?.contributes && !params.resolveContributes ? {
                    contributes: createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir })),
                } : {}),
                ...(params.coldStart ? {} : { pluginIds: params.runtimeOptions?.pluginIds ?? manifests.map((manifest) => manifest.id) }),
                preparedActivationGraphsByPluginId,
            },
        });
        const admitted = runtime;
        let disposed = false;
        return {
            ...admitted, committed, modulesByPluginId, preparedActivationGraphsByPluginId,
            async dispose() {
                if (disposed) return;
                disposed = true;
                try {
                    await admitted.dispose();
                } finally {
                    await rm(directory, { recursive: true, force: true });
                }
            },
        };
    } catch (error) {
        try {
            await runtime?.dispose();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
        throw error;
    }
}
