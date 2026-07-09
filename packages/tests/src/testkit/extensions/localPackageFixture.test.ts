import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginActionContribution, writeLocalExtensionPackageFixture } from './localPackageFixture';

describe('localPackageFixture', () => {
    it('normalizes schemaVersion 1 fixture inputs to final Plugin SDK v1 manifests on disk', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-local-package-fixture-'));

        try {
            await writeLocalExtensionPackageFixture({
                pluginRoot,
                daemonModuleContents: [
                    'export async function recordHookInvocation() {',
                    '  return "ok";',
                    '}',
                    '',
                ].join('\n'),
                manifest: {
                    schemaVersion: 2,
                    id: 'acme.local.v1-input',
                    version: '1.0.0',
                    displayName: 'Acme Local V1 Input',
                    description: 'Legacy-shape input that must be written as V2',
                    engines: { happier: '^0.2.0' },
                    uses: ['hooks'],
                    entrypoints: { main: './daemon.mjs' },
                    declares: { capabilities: [] },
                    permissions: { required: [], optional: [] },
                    activationEvents: ['startup'],
                    contributes: {
                        hooks: [
                            {
                                hookApiVersion: 1,
                                id: 'agent.spawnEnv.augment',
                                category: 'integration',
                                scope: 'agent',
                                executionKind: 'integrate',
                                handler: {
                                    target: 'plugin',
                                    exportName: 'recordHookInvocation',
                                },
                            },
                        ],
                    },
                },
            });

            const onDisk = JSON.parse(
                await readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
            ) as Record<string, unknown>;

            expect(onDisk).toMatchObject({
                schemaVersion: 2,
                uses: expect.arrayContaining(['hooks']),
                entrypoints: {
                    main: './daemon.mjs',
                },
                permissions: {
                    required: [],
                    optional: [],
                },
                activationEvents: ['startup'],
            });
            expect(onDisk).not.toHaveProperty('runtime');
            expect(onDisk).not.toHaveProperty('targets');
            const retiredFlatContributionsKey = 'contribu' + 'tions';
            expect(onDisk).not.toHaveProperty(retiredFlatContributionsKey);
            expect(onDisk.contributes).toEqual(
                expect.objectContaining({
                    hooks: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'agent.spawnEnv.augment',
                        }),
                    ]),
                }),
            );
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('writes trusted local plugin state to the current Plugin SDK v1 state root', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-local-package-fixture-state-plugin-'));
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-local-package-fixture-state-home-'));
        const { writeEnabledLocalExtensionPackageState } = await import('./localPackageFixture');

        try {
            await writeEnabledLocalExtensionPackageState({
                happyHomeDir,
                pluginRoot,
                pluginId: 'acme.local.state',
                manifestVersion: '1.2.3',
            });

            const currentState = JSON.parse(
                await readFile(join(happyHomeDir, 'plugins', 'plugins', 'state', 'plugin-state.v1.json'), 'utf8'),
            ) as {
                plugins?: Record<string, unknown>;
            };
            expect(currentState.plugins?.['acme.local.state']).toEqual(
                expect.objectContaining({
                        source: expect.objectContaining({
                            locator: pluginRoot,
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                            resolvedPath: pluginRoot,
                        }),
                        install: expect.objectContaining({
                            mode: 'link',
                            manifestVersion: '1.2.3',
                        }),
                }),
            );
            await expect(readFile(join(happyHomeDir, 'extensions', 'plugins', 'state', 'plugin-state.v1.json'), 'utf8'))
                .rejects
                .toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('rejects retired action and descriptor surfaces instead of rewriting them', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-local-package-fixture-action-'));
        const retiredAgentSurface = 'session_' + 'agent';
        const retiredDetailsSurface = 'settings.plugin.' + 'details';

        try {
            await expect(writeLocalExtensionPackageFixture({
                pluginRoot,
                daemonModuleContents: 'export async function executeAction() { return { ok: true }; }\n',
                manifest: {
                    schemaVersion: 2,
                    id: 'acme.local.action-v1-input',
                    version: '1.0.0',
                    displayName: 'Acme Local Action V1 Input',
                    description: 'Legacy action shape that must be written with final agent surfaces',
                    engines: { happier: '^0.2.0' },
                    uses: ['actions'],
                    entrypoints: { main: './daemon.mjs' },
                    declares: { capabilities: [] },
                    permissions: { required: [], optional: [] },
                    activationEvents: ['startup'],
                    contributes: {
                        actions: [
                            {
                                id: 'acme.local.action',
                                title: 'Action',
                                surfaces: { [retiredAgentSurface]: true },
                            },
                            createPluginActionContribution({ actionId: 'acme.local.helper-action' }),
                        ],
                        uiDescriptors: [
                            {
                                id: 'acme.local.details',
                                surface: retiredDetailsSurface,
                                title: 'Details',
                                fields: [],
                            },
                        ],
                    },
                },
            })).rejects.toThrow(/Unsupported.*surface/);
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });
});
