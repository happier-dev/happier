import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';

import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import {
    createPluginReloadController,
    type PluginReloadController,
} from '@/plugins/runtime/reload/controller';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
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

type RuntimeOptions = Omit<
    NonNullable<Parameters<typeof resolveExecutablePluginRuntimeRegistry>[0]>,
    | 'happyHomeDir'
    | 'generation'
    | 'resolveDevelopmentSourceAuthority'
    | 'currentGlobalExternalSessionsRouter'
    | 'targetedContributions'
>;

type AuthoredAdmittedPluginRuntimeFixture = Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> & Readonly<{
    committed: NonNullable<Awaited<ReturnType<typeof readCurrentCommittedPluginGenerations>>>;
    modulesByPluginId: Map<string, PluginDaemonModuleNamespace>;
    preparedActivationGraphsByPluginId: Map<string, PreparedPluginActivationGraph>;
}>;

/** Exercises the real source-admission, activation, and publication owners. */
export async function createAdmittedPluginRuntimeFixture(params: Readonly<{
    happyHomeDir?: string;
    controller?: PluginReloadController;
    runtimeOptions?: RuntimeOptions;
}> = {}) {
    const ownsHome = params.happyHomeDir === undefined;
    const happyHomeDir = params.happyHomeDir
        ?? await mkdtemp(join(tmpdir(), 'happier-admitted-plugin-runtime-'));
    const controller = params.controller ?? createPluginReloadController({ happyHomeDir });
    const developmentRoots = createDaemonPluginDevelopmentRootsOwner({
        happyHomeDir,
        // These fixtures consume product-build membership for exact first-party
        // roots; they do not discover or adopt user development source changes.
        submitObservation: async () => {
            throw new Error('Unexpected development source observation in admitted runtime fixture');
        },
    });
    try {
        const lease = await controller.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
                ...params.runtimeOptions,
                happyHomeDir,
                generation: controller.getState().generation + 1,
                resolveDevelopmentSourceAuthority: developmentRoots.resolveDevelopmentSourceAuthority,
                currentGlobalExternalSessionsRouter: controller.currentGlobalExternalSessions,
                targetedContributions: controller.getTargetedContributionsOwner(),
            }),
        });
        if (lease.source !== 'active' || !controller.isRuntimeRegistryCurrent(lease.registry)) {
            await lease.release();
            throw new Error('Admitted runtime fixture did not publish a current registry');
        }
        let disposed = false;
        return {
            happyHomeDir,
            controller,
            lease,
            registry: lease.registry,
            async dispose() {
                if (disposed) return;
                disposed = true;
                try {
                    try {
                        await lease.release();
                    } finally {
                        await controller.shutdown();
                    }
                } finally {
                    await developmentRoots.stop();
                    if (ownsHome) await rm(happyHomeDir, { recursive: true, force: true });
                }
            },
        };
    } catch (error) {
        try {
            await controller.shutdown();
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
        files: Readonly<Record<string, string>>;
        instantiateCommittedModule?: (
            module: PluginDaemonModuleNamespace,
        ) => PluginDaemonModuleNamespace | Promise<PluginDaemonModuleNamespace>;
    }>[];
    happyHomeDir?: string;
    controller?: PluginReloadController;
    runtimeOptions?: RuntimeOptions;
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
                pluginIds: params.runtimeOptions?.pluginIds ?? manifests.map((manifest) => manifest.id),
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
