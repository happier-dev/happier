import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
    getResolvedContributionRegistry,
    primeResolvedContributionRegistry,
    resolveMergedContributionRegistry,
} from './createResolvedContributionRegistry';

function createTestAgentContribution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'acme-agent',
        title: 'Acme Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
            surfaces: ['terminal'],
            sessions: {
                open: ['create'],
                delivery: ['newTurn'],
                cancel: true,
            },
        },
        ...overrides,
    };
}

function createResolvePrerequisitesHook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        hookApiVersion: 1,
        id: 'resolve-prerequisites',
        on: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        executionKind: 'decide',
        ...overrides,
    };
}

async function writePluginManifest(rootDir: string, manifestOverrides?: Record<string, unknown>): Promise<void> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(rootDir, 'daemon.js'), 'export async function launch() { return null; }\n', 'utf8');
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(
            createPluginManifestV2Fixture({
                schemaVersion: 2,
                id: 'acme.ohmypi',
                version: '1.0.0',
                displayName: 'Acme Oh My Pi',
                description: 'Adds Oh My Pi support',
                engines: {
                    happier: '^0.2.0',
                },
                entrypoints: {
                    daemon: './daemon.js',
                },
                activation: { events: [{ kind: 'startup' }] },
                hostAccess: { required: [], optional: [] },
                contributes: {
                    agents: [createTestAgentContribution()],
                    actions: [{
                        id: 'review-start',
                        title: 'Acme Review Start',
                        description: 'Starts a plugin-defined review workflow',
                        scopes: ['global'],
                        surfaces: ['cli'],
                        placement: 'commandPalette',
                        dangerLevel: 'safe',
                    }],
                    hooks: [createResolvePrerequisitesHook()],
                },
                ...(manifestOverrides ?? {}),
            }),
            null,
            2,
        ),
        'utf8',
    );
    await writeFile(
        join(rootDir, 'daemon.js'),
        [
            'export async function launch() { return null; }',
            'export async function resolveTranscriptBinding() { return null; }',
            'export default async function defaultHookHandler() { return null; }',
        ].join('\n'),
        'utf8',
    );
}

describe('resolveMergedContributionRegistry', () => {
    it('merges enabled plugin provider/backend/hook contributes without widening the built-in AGENTS facade', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-merged-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot);

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme-agent')).toMatchObject({
            id: 'acme-agent',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme-agent',
                ownedBackendIds: [],
            },
        });
        expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(registry).not.toHaveProperty('surfaceHandlersByBackendId');
        const externalAction = registry.actions.find((action) => action.pluginId === 'acme.ohmypi');
        expect(externalAction).toMatchObject({
            pluginId: 'acme.ohmypi',
            definition: expect.objectContaining({
                id: 'review-start',
            }),
        });
        expect(registry.activationTargets).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'acme.ohmypi',
                manifest: expect.objectContaining({
                    contributes: expect.objectContaining({
                        hooks: [expect.objectContaining({
                            id: 'resolve-prerequisites',
                            on: 'agent.resolvePrerequisites',
                        })],
                    }),
                }),
            }),
        ]));
        expect(registry.catalogEntriesById.codex?.id).toBe('codex');
        expect(registry.catalogEntriesById['acme.ohmypi']).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.ohmypi']).toEqual([]);
    });

    it('retains rich built-in and plugin definitions needed by merged projection consumers', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-rich-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-rich-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            contributes: {
                agents: [createTestAgentContribution({
                    description: 'Plugin Agent definition retained by the merged registry.',
                    metadata: { fixture: 'rich-definition' },
                    capabilities: {
                        surfaces: ['terminal'],
                        sessions: {
                            open: ['create', 'resume'],
                            delivery: ['newTurn', 'steer'],
                            cancel: true,
                        },
                    },
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('codex')).toMatchObject({
            id: 'codex',
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'codex',
                ownedBackendIds: ['codex'],
            },
            runtimeSpec: expect.objectContaining({
                id: 'codex',
                binaryName: 'codex',
            }),
            catalogEntry: expect.objectContaining({
                id: 'codex',
                cliSubcommand: 'codex',
            }),
            pluginId: 'happier.agent.codex',
        });
        expect(registry.agentDefinitionsById.get('codex')?.richDefinition).toMatchObject({
            provenance: 'first_party',
            definition: expect.objectContaining({
                id: 'codex',
                capabilities: expect.objectContaining({
                    surfaces: ['terminal', 'externalSessions'],
                }),
            }),
        });
        expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(registry.agentDefinitionsById.get('codex')).not.toHaveProperty('getRuntimeCore');
        expect(registry.agentDefinitionsById.get('acme-agent')).toMatchObject({
            richDefinition: {
                provenance: 'external',
                definition: expect.objectContaining({
                    id: 'acme-agent',
                    title: 'Acme Agent',
                    description: 'Plugin Agent definition retained by the merged registry.',
                    metadata: { fixture: 'rich-definition' },
                    capabilities: expect.objectContaining({ surfaces: ['terminal'] }),
                }),
            },
        });
        expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
    });

    it('promotes a primed merged registry snapshot to the active contribution registry cache', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-prime-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-merged-prime-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot);
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
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

        expect(getResolvedContributionRegistry().catalogEntriesById['acme.ohmypi']).toBeUndefined();

        const mergedRegistry = await primeResolvedContributionRegistry({ happyHomeDir });
        expect(mergedRegistry.catalogEntriesById['acme.ohmypi']).toBeUndefined();

        const activeRegistry = getResolvedContributionRegistry();
        expect(activeRegistry.catalogEntriesById['acme.ohmypi']).toBeUndefined();
    });

    it('records a diagnostic and excludes plugin agents using retired runtime-owner fields', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-invalid-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.invalid',
            displayName: 'Acme Invalid',
            description: 'Invalid agent runtime reference',
            contributes: {
                agents: [
                    createTestAgentContribution({
                        id: 'acme-invalid',
                        ownedBackendIds: ['acme.missing.runtime'],
                    }),
                ],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.invalid': {
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme-invalid')).toBeUndefined();
        expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(registry.pluginDiagnosticsByPluginId['acme.invalid']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_invalid',
            }),
        ]));
    });

    it('projects review-only execution-run agents without creating catalog entries', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-review-backend-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-review-backend-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.review.coderabbit',
            displayName: 'CodeRabbit Review',
            description: 'Review-only CodeRabbit engine',
            contributes: {
                agents: [
                    createTestAgentContribution({
                        id: 'acme-review',
                        title: 'Acme Review',
                        runtime: { kind: 'custom' },
                        primary: 'executionRuns',
                        capabilities: {
                            executionRuns: { open: ['create'], checkpoint: false, stop: true },
                        },
                    }),
                ],
                executionRunProfiles: [
                    {
                        id: 'review',
                        intent: 'review',
                        title: 'Acme review',
                        promptAsset: 'review-prompt',
                        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
                        compatibleAgents: ['acme-review'],
                    },
                ],
                resources: [{
                    id: 'review-prompt-resource',
                    kind: 'prompt',
                    path: './prompt.md',
                    contentType: 'text/markdown',
                }],
                promptAssets: [{
                    id: 'review-prompt',
                    kind: 'systemPrompt',
                    resource: 'review-prompt-resource',
                    target: { kind: 'agent', agent: 'acme-review' },
                }],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.review.coderabbit': {
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.pluginDiagnosticsByPluginId['acme.review.coderabbit']).toEqual([]);
        expect(registry.agentDefinitionsById.get('acme-review')).toMatchObject({
            id: 'acme-review',
            pluginId: 'acme.review.coderabbit',
            runtimeSpec: null,
        });
        expect(registry.catalogEntriesById['acme-review']).toBeUndefined();
        expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(registry.executionRunProfilesById?.get('acme.review.coderabbit/review')).toMatchObject({
            pluginId: 'acme.review.coderabbit',
            definition: expect.objectContaining({
                id: 'review',
                compatibleAgents: ['acme-review'],
            }),
        });
        expect(registry.pluginDiagnosticsByPluginId['acme.review.coderabbit']).toEqual([]);
    });

    it('records a diagnostic and excludes another plugin Agent using retired runtime-owner fields', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-orphaned-provider-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.orphaned',
            displayName: 'Acme Orphaned',
            description: 'Agent points at a missing runtime',
            contributes: {
                agents: [createTestAgentContribution({
                    id: 'acme-orphaned',
                    ownedBackendIds: ['acme.orphaned.backend'],
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.orphaned': {
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme-orphaned')).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.orphaned']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_invalid',
            }),
        ]));
    });

    it('keeps current hooks on the activation target instead of the retired static hook table', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-export-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.hook-export-missing',
            displayName: 'Acme Hook Export Missing',
            description: 'Current target-owned plugin hook',
            contributes: {
                hooks: [createResolvePrerequisitesHook()],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.hook-export-missing': {
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.activationTargets).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'acme.hook-export-missing',
                manifest: expect.objectContaining({
                    contributes: expect.objectContaining({
                        hooks: [expect.objectContaining({
                            id: 'resolve-prerequisites',
                            on: 'agent.resolvePrerequisites',
                        })],
                    }),
                }),
            }),
        ]));
        expect(registry.pluginDiagnosticsByPluginId['acme.hook-export-missing']).toEqual([]);
    });

    it('rejects retired flat backend contributions instead of normalizing owner aliases', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-backend-owner-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-backend-owner-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            contributes: [
                {
                    kind: 'backend',
                    kindVersion: 1,
                    id: 'acme.ohmypi.acp',
                    agentId: 'codex',
                    engine: { kind: 'acp' },
                    capabilities: {},
                    surfaceHandlers: [],
                },
            ],
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(registry.pluginDiagnosticsByPluginId['acme.ohmypi']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_invalid',
            }),
        ]));
    });

    it('rejects alias-shaped built-in compatibility ids under the strict current Agent schema', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-compat-ids-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-compat-ids-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            contributes: {
                agents: [createTestAgentContribution({
                    catalogAgentId: 'gpt',
                    iconAgentId: 'open-code',
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme-agent')).toBeUndefined();
        expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(registry.pluginDiagnosticsByPluginId['acme.ohmypi']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_invalid',
            }),
        ]));
    });

    it('keeps current plugin Agents visible without reviving the retired static runtime tables', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-runtime-gating-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-gating-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.runtime',
            displayName: 'Acme Runtime',
            description: 'Runtime without an exact built-in compatibility carrier',
            contributes: {
                agents: [createTestAgentContribution({
                    id: 'acme-runtime',
                    title: 'Acme Runtime',
                    metadata: { fixture: 'runtime-gating' },
                })],
            },
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme-runtime')).toMatchObject({
            id: 'acme-runtime',
            richDefinition: {
                provenance: 'external',
                definition: expect.objectContaining({
                    id: 'acme-runtime',
                    metadata: { fixture: 'runtime-gating' },
                }),
            },
        });
        expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(registry).not.toHaveProperty('surfaceHandlersByBackendId');
        expect(registry.pluginDiagnosticsByPluginId['acme.runtime']).toEqual([]);
    });

    it('rejects retired Agent CLI runtime facts outside the current Agent manifest contract', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-agent-cli-runtime-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-agent-cli-runtime-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.runtime',
            displayName: 'Acme Runtime',
            description: 'Runtime with plugin-authored agent CLI facts',
            contributes: {
                agents: [createTestAgentContribution({
                    id: 'acme-runtime',
                    agentCliRuntime: {
                        id: 'acme-runtime',
                        title: 'Acme Runtime',
                        binaryName: 'acme-runtime',
                        sourcePreferenceDefault: 'system-first',
                        managedInstall: null,
                        manualInstallKind: 'command',
                        manualInstallRecipes: null,
                        acceptsJavaScriptFileOverride: false,
                    },
                })],
            },
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

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });
        expect(registry.agentDefinitionsById.get('acme-runtime')).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.runtime']).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'plugin_manifest_invalid' }),
        ]));
    });
});
