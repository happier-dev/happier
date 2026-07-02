import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '../../../plugins/store/state';

import { resolveCliEngineRegistry } from './engineRegistry';

async function writePlugin(params: Readonly<{
    rootDir: string;
    sentinelPath: string;
}>): Promise<void> {
    const manifestDir = join(params.rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });

    await writeFile(
        join(params.rootDir, 'daemon.mjs'),
        [
            "import { appendFileSync } from 'node:fs';",
            `appendFileSync(${JSON.stringify(params.sentinelPath)}, 'loaded');`,
            'export async function activate(api) {',
            '  api.registerBackendEngine({',
            '    backendId: "acme.runtime.backend",',
            '    create: async () => ({',
            '      runtimeCore: {',
            '        createSessionRuntime: async () => ({ kind: "plugin-session-plan" }),',
            '        createExecutionRunBackend: async () => ({ kind: "plugin-execution-run-backend" }),',
            '      },',
            '    }),',
            '  });',
            '}',
            'export async function resolveTranscriptBinding() { return "ok"; }',
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
                    capabilities: ['agents', 'backends', 'hooks'],
                },
                targets: {
                    daemon: {
                        entry: './daemon.mjs',
                    },
                },
                capabilities: {
                    permissions: [],
                },
                contributes: {
                    agents: [
                        {
                        kindVersion: 1,
                        id: 'acme.runtime',
                        display: {
                            name: 'Acme Runtime',
                            tags: ['plugin'],
                        },
                        ownedBackendIds: ['acme.runtime.backend'],
                        },
                    ],
                    backends: [
                        {
                        kindVersion: 1,
                        id: 'acme.runtime.backend',
                        agentId: 'acme.runtime',
                        engine: {
                            kind: 'custom',
                        },
                        surfaceHandlers: [
                            {
                                surfaceApiVersion: 1,
                                id: 'acme.runtime.backend.terminal.resolveTranscriptBinding',
                                kind: 'terminalRuntime',
                                operation: 'resolveTranscriptBinding',
                                support: 'supported',
                                handler: {
                                    target: 'daemon',
                                    exportName: 'resolveTranscriptBinding',
                                },
                            },
                        ],
                        capabilities: {
                            executionRun: {
                                supported: false,
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

async function writePluginWithEngineSurface(params: Readonly<{
    rootDir: string;
}>): Promise<void> {
    const manifestDir = join(params.rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });

    await writeFile(
        join(params.rootDir, 'daemon.mjs'),
        [
            'export async function activate(api) {',
            '  api.registerBackendEngine({',
            '    backendId: "acme.runtime.backend",',
            '    create: async () => ({',
            '      runtimeCore: {',
            '        createSessionRuntime: async () => ({ kind: "plugin-session-plan" }),',
            '        createExecutionRunBackend: async () => ({ kind: "plugin-execution-run-backend" }),',
            '      },',
            '      forkSurface: {',
            '        evaluateAvailability: async (request) => ({',
            '          available: request.operation === "fork",',
            '        }),',
            '        fork: async (request) => ({',
            '          providerSessionId: `fork:${request.parentSessionId}`,',
            '          launch: {',
            '            directory: request.directory,',
            '            environmentVariables: { FROM_PLUGIN_FORK_SURFACE: "1" },',
            '          },',
            '        }),',
            '      },',
            '    }),',
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
                description: 'Runtime surface plugin',
                engines: {
                    happier: '^0.2.0',
                },
                runtime: {
                    apiVersion: 1,
                    capabilities: ['agents', 'backends'],
                },
                targets: {
                    daemon: {
                        entry: './daemon.mjs',
                    },
                },
                capabilities: {
                    permissions: [],
                },
                contributes: {
                    agents: [
                        {
                            kindVersion: 1,
                            id: 'acme.runtime',
                            display: {
                                name: 'Acme Runtime',
                                tags: ['plugin'],
                            },
                            ownedBackendIds: ['acme.runtime.backend'],
                        },
                    ],
                    backends: [
                        {
                            kindVersion: 1,
                            id: 'acme.runtime.backend',
                            agentId: 'acme.runtime',
                            engine: {
                                kind: 'custom',
                            },
                            surfaceHandlers: [
                                {
                                    surfaceApiVersion: 1,
                                    id: 'acme.runtime.backend.fork.evaluateAvailability',
                                    kind: 'fork',
                                    operation: 'evaluateAvailability',
                                    support: 'supported',
                                    handler: {
                                        target: 'daemon',
                                        exportName: 'evaluateAvailability',
                                    },
                                },
                                {
                                    surfaceApiVersion: 1,
                                    id: 'acme.runtime.backend.fork.fork',
                                    kind: 'fork',
                                    operation: 'fork',
                                    support: 'supported',
                                    handler: {
                                        target: 'daemon',
                                        exportName: 'fork',
                                    },
                                },
                            ],
                            capabilities: {
                                executionRun: {
                                    supported: false,
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

describe('resolveCliEngineRegistry', () => {
    it('does not eagerly load plugin daemon modules until a plugin backend actually needs them', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-registry-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-registry-plugin-'));
        const sentinelPath = join(pluginRoot, 'daemon-loaded.txt');
        const store = createPluginStateStore({ happyHomeDir });

        await writePlugin({
            rootDir: pluginRoot,
            sentinelPath,
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        await expect(access(sentinelPath, fsConstants.F_OK)).rejects.toMatchObject({
            code: 'ENOENT',
        });

        const registry = await resolveCliEngineRegistry({ happyHomeDir });
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
        const store = createPluginStateStore({ happyHomeDir });

        await writePlugin({
            rootDir: pluginRoot,
            sentinelPath,
        });

        const initialRegistry = await resolveCliEngineRegistry({ happyHomeDir });
        expect(await initialRegistry.resolveForBackendId('acme.runtime.backend')).toBeNull();

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const refreshedRegistry = await resolveCliEngineRegistry({ happyHomeDir });
        const resolution = await refreshedRegistry.resolveForBackendId('acme.runtime.backend');

        expect(resolution?.backendId).toBe('acme.runtime.backend');
        expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime).toEqual(expect.any(Function));
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend).toEqual(expect.any(Function));
        await expect(access(sentinelPath, fsConstants.F_OK)).resolves.toBeUndefined();
    });

    it('resolves a manifest-declared activation-time engine surface into execution surfaces', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-registry-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-registry-surface-plugin-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginWithEngineSurface({ rootDir: pluginRoot });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveCliEngineRegistry({ happyHomeDir });
        const resolution = await registry.resolveForBackendId('acme.runtime.backend');

        expect(resolution?.diagnostics).toEqual([]);
        const forkSurface = resolution?.executionSurfaces.fork;
        expect(forkSurface?.evaluateAvailability).toEqual(expect.any(Function));
        expect(forkSurface?.fork).toEqual(expect.any(Function));
        if (!forkSurface?.evaluateAvailability || !forkSurface.fork) {
            throw new Error('Expected activation-time plugin fork surface to materialize');
        }
        await expect(forkSurface.evaluateAvailability({
            operation: 'fork',
            parentSessionId: 'parent-1',
            parentMetadata: {},
            directory: '/repo',
            forkPoint: { kind: 'latest' },
        })).resolves.toEqual({ available: true });
        await expect(forkSurface.fork({
            parentSessionId: 'parent-1',
            parentMetadata: {},
            directory: '/repo',
            forkPoint: { kind: 'latest' },
        })).resolves.toEqual({
            providerSessionId: 'fork:parent-1',
            launch: {
                directory: '/repo',
                environmentVariables: { FROM_PLUGIN_FORK_SURFACE: '1' },
            },
        });
    });
});
