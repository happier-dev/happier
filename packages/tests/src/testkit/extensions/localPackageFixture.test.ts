import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createLocalExtensionPackageManifest,
    createPluginActionContribution,
    writeLocalExtensionPackageFixture,
    writeRuntimeProjectionPluginFixture,
} from './localPackageFixture';

describe('localPackageFixture', () => {
    it('rejects retired and unknown contribution families instead of emitting invalid manifests', async () => {
        expect(() => createLocalExtensionPackageManifest({
            pluginId: 'acme.invalid-families',
            contributes: {
                agentSettings: [{ id: 'retired-agent-settings' }],
                lifecycleHandlers: [{ id: 'retired-lifecycle-handler' }],
                mysteryFamily: [{ id: 'unknown-family' }],
            },
        })).toThrow(
            'Unsupported plugin contribution families: agentSettings, lifecycleHandlers, mysteryFamily',
        );
    });

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
                    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
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

    it('authors runtime projection fixtures with canonical typed settings and resources', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-runtime-projection-fixture-'));

        try {
            await writeRuntimeProjectionPluginFixture({
                pluginRoot,
                pluginId: 'acme.runtime-projection',
                settingsId: 'preferences',
                resourceId: 'acme.runtime-projection.prompt',
            });

            const onDisk = JSON.parse(
                await readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
            ) as Record<string, unknown>;
            expect(onDisk.uses).toEqual(expect.arrayContaining(['actions', 'resources', 'settings']));
            expect(onDisk.contributes).toMatchObject({
                settings: [{
                    id: 'preferences',
                    target: { kind: 'plugin' },
                    scope: 'local',
                    fields: [{
                        id: 'enabled',
                        schema: { type: 'boolean' },
                    }],
                }],
                resources: [{
                    id: 'acme.runtime-projection.prompt',
                    resourceKind: 'prompt',
                }],
            });
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('seeds trusted local plugins through the current registry commit and immutable generation', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-local-package-fixture-state-plugin-'));
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-local-package-fixture-state-home-'));
        const { writeEnabledLocalExtensionPackageState } = await import('./localPackageFixture');

        try {
            await writeLocalExtensionPackageFixture({
                pluginRoot,
                daemonModuleContents: 'export async function activate() {}\n',
                manifest: createLocalExtensionPackageManifest({
                    pluginId: 'acme.local.state',
                    version: '1.2.3',
                }),
            });
            await writeEnabledLocalExtensionPackageState({
                happyHomeDir,
                pluginRoot,
                pluginId: 'acme.local.state',
                manifestVersion: '1.2.3',
            });

            const storeRoot = join(happyHomeDir, 'plugins', 'plugins');
            const registryCommit = JSON.parse(
                await readFile(join(storeRoot, 'state', 'plugin-registry-current.v1.json'), 'utf8'),
            ) as {
                installationState?: { revisionId?: string };
                pluginGenerations?: Record<string, { immutableGenerationId?: string }>;
            };
            const generationId = registryCommit.pluginGenerations?.['acme.local.state']?.immutableGenerationId;
            expect(generationId).toEqual(expect.any(String));
            expect(registryCommit.installationState?.revisionId).toEqual(expect.any(String));

            const installationState = JSON.parse(
                await readFile(
                    join(
                        storeRoot,
                        'state-revisions',
                        registryCommit.installationState!.revisionId!,
                        'plugin-installations.v1.json',
                    ),
                    'utf8',
                ),
            ) as {
                runtimeCatalog?: { plugins?: Record<string, unknown> };
            };
            expect(installationState.runtimeCatalog?.plugins?.['acme.local.state']).toEqual(
                expect.objectContaining({
                    source: expect.objectContaining({
                        locator: pluginRoot,
                        installPolicy: 'link',
                        resolvedPath: join(storeRoot, 'generations', generationId!),
                        devWatch: true,
                    }),
                    install: expect.objectContaining({
                        mode: 'managed_install',
                        manifestVersion: '1.2.3',
                        trust: expect.objectContaining({
                            pluginId: 'acme.local.state',
                            state: 'trusted',
                        }),
                    }),
                    state: expect.objectContaining({
                        enabled: true,
                    }),
                }),
            );
            const generationRecord = JSON.parse(
                await readFile(
                    join(storeRoot, 'generations', generationId!, 'plugin-generation.v1.json'),
                    'utf8',
                ),
            ) as { pluginId?: string; immutableGenerationId?: string };
            expect(generationRecord).toMatchObject({
                pluginId: 'acme.local.state',
                immutableGenerationId: generationId,
            });
            await expect(readFile(join(storeRoot, 'state', 'plugin-state.v1.json'), 'utf8'))
                .rejects
                .toMatchObject({ code: 'ENOENT' });
            await expect(readFile(join(happyHomeDir, 'extensions', 'plugins', 'state', 'plugin-state.v1.json'), 'utf8'))
                .rejects
                .toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('rejects retired action surfaces instead of rewriting them', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-local-package-fixture-action-'));
        const retiredAgentSurface = 'session_' + 'agent';

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
                    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
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
                    },
                },
            })).rejects.toThrow(/Unsupported.*surface/);
        } finally {
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });
});
