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
    it('writes a deterministic local-path plugin and enables its current registry generation', async () => {
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
            const storeRoot = join(happyHomeDir, 'plugins', 'plugins');
            const commit = JSON.parse(
                await readFile(join(storeRoot, 'state', 'plugin-registry-current.v1.json'), 'utf8'),
            ) as {
                installationState: { revisionId: string };
                pluginGenerations: Record<string, { immutableGenerationId: string }>;
            };
            expect(commit.pluginGenerations['acme.local-path.fixture']?.immutableGenerationId)
                .toEqual(expect.any(String));
            const installationState = JSON.parse(
                await readFile(
                    join(
                        storeRoot,
                        'state-revisions',
                        commit.installationState.revisionId,
                        'plugin-installations.v1.json',
                    ),
                    'utf8',
                ),
            ) as {
                runtimeCatalog?: { plugins?: Record<string, unknown> };
            };
            expect(installationState.runtimeCatalog?.plugins?.['acme.local-path.fixture']).toMatchObject({
                state: { enabled: true },
                source: { kind: 'path', devWatch: true },
                install: { mode: 'managed_install' },
            });
            await expect(readFile(join(storeRoot, 'state', 'plugin-state.v1.json'), 'utf8'))
                .rejects
                .toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
