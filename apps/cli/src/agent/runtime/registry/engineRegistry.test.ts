import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginReloadController } from '../../../plugins/runtime/reload/controller';
import { seedCurrentLocalPathPluginFixture } from '../../../plugins/store/registry/currentState.testkit';

let activePluginReloadController: PluginReloadController | null = null;

async function publishCurrentRuntimeRegistry(params: Readonly<{
    happyHomeDir: string;
    generation: number;
    changedPluginIds: readonly string[];
}>) {
    const [
        { pluginReloadController },
        { resolveExecutablePluginRuntimeRegistry },
    ] = await Promise.all([
        import('../../../plugins/runtime/reload/singleton'),
        import('../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry'),
    ]);
    const registry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: params.happyHomeDir,
        generation: params.generation,
    });
    const adoption = await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry,
        changedPluginIds: params.changedPluginIds,
        durableRevision: params.generation,
        runningSessionDisposition: 'retainRunningSessions',
    });
    if (!adoption.ok) {
        throw new Error(`Failed to publish plugin runtime registry generation ${params.generation}`);
    }
    activePluginReloadController = pluginReloadController;
    return registry;
}

async function writePlugin(params: Readonly<{
    rootDir: string;
    sentinelPath: string;
}>): Promise<void> {
    const manifestDir = join(params.rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });

    await writeFile(
        join(params.rootDir, 'agentRuntime.mjs'),
        [
            'export const acmeRuntimeFactory = async () => ({',
            '  sessions: {',
            '    open: async () => ({',
            '      send: async () => ({ status: "admitted" }),',
            '      stop: async () => ({ status: "requested" }),',
            '      watch: () => ({ dispose() {} }),',
            '      dispose: async () => {},',
            '    }),',
            '  },',
            '});',
            '',
        ].join('\n'),
        'utf8',
    );

    await writeFile(
        join(params.rootDir, 'daemon.mjs'),
        [
            "import { appendFileSync } from 'node:fs';",
            "import { acmeRuntimeFactory } from './agentRuntime.mjs';",
            `appendFileSync(${JSON.stringify(params.sentinelPath)}, 'loaded');`,
            'export async function activate(api) {',
            '  api.agents.register("acme-runtime", acmeRuntimeFactory, {',
            '    sessionRunnerFactory: {',
            '      module: "./agentRuntime.mjs",',
            '      export: "acmeRuntimeFactory",',
            '      runtimeApiVersion: 1,',
            '    },',
            '  });',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );

    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(
            {
                schemaVersion: 2,
                id: 'acme.runtime',
                version: '1.0.0',
                displayName: 'Acme Runtime',
                description: 'Runtime hook plugin',
                engines: {
                    happier: '^0.2.0',
                },
                runtime: {
                    apiVersion: 1,
                },
                entrypoints: {
                    daemon: './daemon.mjs',
                },
                hostAccess: {
                    required: [],
                    optional: [],
                },
                contributes: {
                    agents: [
                        {
                            id: 'acme-runtime',
                            title: 'Acme Runtime',
                            runtime: {
                                kind: 'custom',
                            },
                            primary: 'sessions',
                            capabilities: {
                                sessions: {
                                    open: ['create', 'resume'],
                                    delivery: ['newTurn', 'steer', 'followUp'],
                                    cancel: true,
                                },
                            },
                        },
                    ],
                },
            },
            null,
            2,
        ),
        'utf8',
    );
}

async function writeManifestOnlyAcpPlugin(rootDir: string): Promise<void> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify({
            schemaVersion: 2,
            id: 'acme.runtime',
            version: '1.0.0',
            displayName: 'Acme ACP Runtime',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            hostAccess: {
                required: [{
                    id: 'agent-process',
                    capability: 'process',
                    reason: 'Launch the declared ACP agent.',
                    scope: { executables: [{ kind: 'systemTool', id: 'acme-agent' }] },
                }],
                optional: [],
            },
            contributes: {
                agents: [{
                    id: 'acme-acp',
                    title: 'Acme ACP',
                    runtime: {
                        kind: 'acp',
                        transport: {
                            kind: 'stdio',
                            executable: { kind: 'systemTool', id: 'acme-agent' },
                        },
                    },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create', 'resume'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                }],
                systemTools: [{
                    id: 'acme-agent',
                    title: 'Acme Agent',
                    executableNames: ['acme-agent'],
                }],
            },
        }, null, 2),
        'utf8',
    );
}

describe('resolveCliEngineRegistry', () => {
    const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(async () => {
        await activePluginReloadController?.shutdown();
        activePluginReloadController = null;
        if (originalHappyHomeDir === undefined) {
            delete process.env.HAPPIER_HOME_DIR;
        } else {
            process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
        }
    });

    it('does not eagerly load plugin daemon modules until a plugin backend actually needs them', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-registry-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-registry-plugin-'));
        const sentinelPath = join(pluginRoot, 'daemon-loaded.txt');
        process.env.HAPPIER_HOME_DIR = happyHomeDir;

        await writePlugin({
            rootDir: pluginRoot,
            sentinelPath,
        });

        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot,
            pluginId: 'acme.runtime',
            manifestVersion: '1.0.0',
        });

        await expect(access(sentinelPath, fsConstants.F_OK)).rejects.toMatchObject({
            code: 'ENOENT',
        });

        await publishCurrentRuntimeRegistry({
            happyHomeDir,
            generation: 1,
            changedPluginIds: ['acme.runtime'],
        });
        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('pi');

        expect(resolution?.backendId).toBe('pi');
        expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime).toEqual(expect.any(Function));
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend).toEqual(expect.any(Function));
        await expect(access(sentinelPath, fsConstants.F_OK)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('observes newly enabled plugin backends on a subsequent resolve with the same home dir', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-registry-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-registry-plugin-refresh-'));
        const sentinelPath = join(pluginRoot, 'daemon-loaded.txt');
        process.env.HAPPIER_HOME_DIR = happyHomeDir;

        await writePlugin({
            rootDir: pluginRoot,
            sentinelPath,
        });

        await publishCurrentRuntimeRegistry({
            happyHomeDir,
            generation: 1,
            changedPluginIds: [],
        });
        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const initialRegistry = await resolveCliEngineRegistry();
        expect(await initialRegistry.resolveForBackendId('acme-runtime')).toBeNull();

        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot,
            pluginId: 'acme.runtime',
            manifestVersion: '1.0.0',
        });

        const runtimeRegistry = await publishCurrentRuntimeRegistry({
            happyHomeDir,
            generation: 2,
            changedPluginIds: ['acme.runtime'],
        });
        const refreshedRegistry = await resolveCliEngineRegistry();
        const resolution = await refreshedRegistry.resolveForBackendId('acme-runtime');

        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.runtime']).toEqual([]);
        expect(runtimeRegistry.contributes.agentDefinitionsById.has('acme-runtime')).toBe(true);
        expect(runtimeRegistry.contributes).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(resolution?.backendId).toBe('acme-runtime');
        expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime).toEqual(expect.any(Function));
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend).toEqual(expect.any(Function));
        await expect(access(sentinelPath, fsConstants.F_OK)).resolves.toBeUndefined();
    });

    it('resolves a current manifest-only ACP Agent without reviving a runtime-definition registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-registry-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-registry-acp-plugin-'));
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        await writeManifestOnlyAcpPlugin(pluginRoot);
        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot,
            pluginId: 'acme.runtime',
            manifestVersion: '1.0.0',
        });

        await publishCurrentRuntimeRegistry({
            happyHomeDir,
            generation: 1,
            changedPluginIds: ['acme.runtime'],
        });
        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const registry = await resolveCliEngineRegistry();
        expect(registry.contributions.agentDefinitionsById.has('acme-acp')).toBe(true);
        expect(registry.contributions).not.toHaveProperty('agentRuntimeDefinitionsById');
        const resolution = await registry.resolveForBackendId('acme-acp');

        expect(resolution).toMatchObject({
            backendId: 'acme-acp',
            agentId: 'acme-acp',
            runtimeOwner: { selected: { kind: 'plugin_engine', pluginId: 'acme.runtime' } },
            engineAdapter: { runtimeCore: expect.any(Object) },
        });
        expect(() => resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: pluginRoot,
            backendId: 'acme-acp',
            permissionMode: 'read_only',
        })).toThrow(/Agent runtime 'acme-acp' does not support execution runs/i);
    });

});
