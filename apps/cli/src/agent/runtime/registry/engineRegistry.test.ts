import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '../../../extensions/store/state';

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
            'export async function bindTranscript() { return "ok"; }',
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
                    capabilities: ['providers', 'backends', 'hooks'],
                },
                targets: {
                    daemon: {
                        entry: './daemon.mjs',
                    },
                },
                permissions: [],
                contributions: [
                    {
                        kind: 'provider',
                        kindVersion: 1,
                        id: 'acme.runtime',
                        providerAgentId: 'customAcp',
                        display: {
                            name: 'Acme Runtime',
                            tags: ['plugin'],
                        },
                        ownedBackendIds: ['acme.runtime.backend'],
                    },
                    {
                        kind: 'backend',
                        kindVersion: 1,
                        id: 'acme.runtime.backend',
                        providerId: 'acme.runtime',
                        runtimeKind: 'acp',
                        capabilities: {},
                        runtimeAdapters: [],
                    },
                    {
                        kind: 'hook',
                        hookApiVersion: 1,
                        id: 'backend.terminalRuntime.bindTranscript',
                        category: 'integration',
                        scope: 'backend',
                        executionKind: 'integrate',
                        handler: {
                            target: 'plugin',
                            exportName: 'bindTranscript',
                        },
                    },
                ],
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
        expect(resolution?.engineAdapter.bindings.createSessionRuntime).toEqual(expect.any(Function));
        expect(resolution?.engineAdapter.bindings.createExecutionRunBackend).toEqual(expect.any(Function));
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
        expect(resolution?.engineAdapter.bindings.createSessionRuntime).toEqual(expect.any(Function));
        expect(resolution?.engineAdapter.bindings.createExecutionRunBackend).toEqual(expect.any(Function));
        await expect(access(sentinelPath, fsConstants.F_OK)).resolves.toBeUndefined();
    });
});
