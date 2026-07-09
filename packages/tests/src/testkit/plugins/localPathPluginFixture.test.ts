import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createLocalExtensionPackageManifest,
    writeEnabledLocalPathPluginState,
    writeLocalPathPluginFixture,
} from './localPathPluginFixture';

describe('localPathPluginFixture', () => {
    it('writes a deterministic local-path plugin manifest and enabled plugin-state record', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-local-path-plugin-root-'));
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-local-path-plugin-home-'));

        try {
            await writeLocalPathPluginFixture({
                pluginRoot,
                daemonModuleContents: [
                    'export async function recordHookInvocation() {',
                    '  return "plugin-hook-fired";',
                    '}',
                    '',
                ].join('\n'),
                manifest: createLocalExtensionPackageManifest({
                    pluginId: 'acme.local-path.fixture',
                    displayName: 'Local Path Fixture',
                    description: 'Deterministic local-path plugin fixture for tests',
                    contributes: {
                        hooks: [{
                            hookApiVersion: 1,
                            id: 'session.spawned',
                            category: 'lifecycle',
                            scope: 'session',
                            executionKind: 'observe',
                            handler: {
                                target: 'plugin',
                                exportName: 'recordHookInvocation',
                            },
                        }],
                    },
                }),
            });

            await writeEnabledLocalPathPluginState({
                happyHomeDir,
                pluginRoot,
                pluginId: 'acme.local-path.fixture',
            });

            await expect(readFile(join(pluginRoot, 'daemon.mjs'), 'utf8')).resolves.toContain('plugin-hook-fired');
            await expect(readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8')).resolves.toContain('"acme.local-path.fixture"');
            const stateJson = JSON.parse(await readFile(join(happyHomeDir, 'plugins', 'plugins', 'state', 'plugin-state.v1.json'), 'utf8')) as Record<string, unknown>;
            expect(stateJson).toMatchObject({
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
            });
            const plugins = stateJson.plugins as Record<string, unknown>;
            const pluginState = plugins['acme.local-path.fixture'] as Record<string, unknown>;
            expect(pluginState).toMatchObject({
                state: {
                    enabled: true,
                },
                source: {
                    kind: 'path',
                },
                install: {
                    mode: 'link',
                },
            });
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
