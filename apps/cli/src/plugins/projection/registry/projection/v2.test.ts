import { describe, expect, it } from 'vitest';
import {
    evaluatePluginActionPolicy,
    type PluginActionPresentUserGatePolicy,
} from '@happier-dev/protocol';

import { buildPluginProjectionV2 } from './v2';
import type {
    ResolvedActionContribution,
    ResolvedContributionRegistry,
    ResolvedTargetedPluginContributionDeclaration,
} from '../types';
import {
    PluginContributesV2Schema,
    PluginProjectionV2Schema,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';
import type { PluginTargetedContributionV1 } from '@happier-dev/protocol';
import { adaptTargetActivationFacts } from '@/plugins/projection/introspection/targetActivationFacts';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { buildPluginProjectionFamiliesByIdV2 } from '@/plugins/projection/families';
import { resolveBuiltInContributions } from '../resolveBuiltInContributions';
import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../resolvePluginContributions';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
    return {
        agents: [],
                providers: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        activationTargets: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
                catalogEntriesById: {},
        agentDefinitionsById: new Map(),
                providersByContributionKey: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

describe('buildPluginProjectionV2', () => {
    it('projects an attributed targeted-admission rejection through the canonical diagnostics record', () => {
        const contributorPluginId = 'examples.contributor';
        const targetPluginId = 'examples.absent-target';
        const declaration = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: contributorPluginId,
            pluginVersion: '1.2.3',
            identity: createPluginContributionIdentity({
                pluginId: contributorPluginId,
                localId: 'provider-a',
            }),
            manifestPath: '/plugins/examples.contributor/.happier-plugin/plugin.json',
            definition: {
                id: 'provider-a',
                target: { pluginId: targetPluginId, pointId: 'providers' },
                protocol: { id: 'provider', version: 1 },
                operations: {},
            } satisfies PluginTargetedContributionV1,
        } satisfies ResolvedTargetedPluginContributionDeclaration;
        const registry = createResolvedContributionRegistry({
            targetedPluginContributions: [declaration],
            immutableGenerationIdsByPluginId: {
                [contributorPluginId]: 'contributor-generation-a',
            },
        });

        const projection = buildPluginProjectionV2({ registry, generation: 7 });
        const diagnostic = projection.diagnostics.find((entry) => (
            entry.data.code === 'target_absent'
        ));

        expect(diagnostic).toMatchObject({
            data: {
                code: 'target_absent',
                message: 'Targeted contribution admission rejected (target_absent).',
                details: {
                    targetPluginId,
                    pointId: 'providers',
                    protocol: { id: 'provider', version: 1 },
                },
            },
            plugin: { id: contributorPluginId, version: '1.2.3', source: 'localPath' },
            contribution: { pluginId: contributorPluginId, localId: 'provider-a' },
            stage: 'normalization',
            generation: 'contributor-generation-a',
            host: 'daemon',
        });
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
    });

    it('projects an attributed cold target-semantic rejection from the canonical diagnostics map', () => {
        const contributorPluginId = 'examples.contributor';
        const targetPluginId = 'examples.target';
        const declaration = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: contributorPluginId,
            pluginVersion: '1.2.3',
            identity: createPluginContributionIdentity({
                pluginId: contributorPluginId,
                localId: 'provider-a',
            }),
            manifestPath: '/plugins/examples.contributor/.happier-plugin/plugin.json',
            definition: {
                id: 'provider-a',
                target: { pluginId: targetPluginId, pointId: 'providers' },
                protocol: { id: 'provider', version: 1 },
                operations: {},
            } satisfies PluginTargetedContributionV1,
        } satisfies ResolvedTargetedPluginContributionDeclaration;
        const registry = createResolvedContributionRegistry({
            targetedPluginContributions: [declaration],
            immutableGenerationIdsByPluginId: {
                [contributorPluginId]: 'contributor-generation-a',
            },
        });

        const projection = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginDiagnosticsByPluginId: {
                [contributorPluginId]: [{
                    code: 'descriptor_semantic_invalid',
                    message: 'Targeted contribution semantics rejected (descriptor_semantic_invalid).',
                    stage: 'normalization',
                    contribution: createPluginContributionIdentity({
                        pluginId: contributorPluginId,
                        localId: 'provider-a',
                    }),
                    details: {
                        targetPluginId,
                        pointId: 'providers',
                        protocol: { id: 'provider', version: 1 },
                    },
                }],
            },
        });

        expect(projection.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                data: expect.objectContaining({
                    code: 'descriptor_semantic_invalid',
                    message: 'Targeted contribution semantics rejected (descriptor_semantic_invalid).',
                    details: expect.objectContaining({
                        targetPluginId,
                        pointId: 'providers',
                        protocol: { id: 'provider', version: 1 },
                    }),
                }),
                plugin: { id: contributorPluginId, version: '1.2.3', source: 'localPath' },
                contribution: { pluginId: contributorPluginId, localId: 'provider-a' },
                stage: 'normalization',
                generation: 'contributor-generation-a',
                host: 'daemon',
            }),
        ]));
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
    });

    it('does not project a raw manifest digest as installed-package identity', () => {
        const projection = buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                immutableGenerationIdsByPluginId: {
                    'com.acme.plugin': 'committed-generation-a',
                },
                agents: [{
                    id: 'acme-agent',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'com.acme.plugin',
                    identity: createPluginContributionIdentity({
                        pluginId: 'com.acme.plugin',
                        localId: 'acme-agent',
                    }),
                    manifestPath: '/plugins/com.acme.plugin/.happier-plugin/plugin.json',
                    definition: {
                        kindVersion: 1,
                        id: 'acme-agent',
                        ownedBackendIds: [],
                    },
                }],
            },
            generation: 1,
        });

        expect(projection.installedPackagesById['com.acme.plugin']).toMatchObject({
            id: 'com.acme.plugin',
            immutableGenerationId: 'committed-generation-a',
            source: {
                kind: 'path',
                locator: '/plugins/com.acme.plugin/.happier-plugin/plugin.json',
            },
        });
        expect(projection.installedPackagesById['com.acme.plugin']).not.toHaveProperty('digest');
    });

    it('projects canonical exact action danger and localized confirmation metadata', () => {
        const confirmation = {
            title: { key: 'actions.publish.title', fallback: 'Publish changes?' },
            body: { key: 'actions.publish.body', fallback: 'This updates the remote workspace.' },
            confirmLabel: { key: 'actions.publish.confirm', fallback: 'Publish' },
        } as const;
        const action: ResolvedActionContribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.publish',
            definition: {
                kindVersion: 1,
                id: 'publish',
                title: 'Publish',
                description: null,
                safety: 'danger',
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false, plugin: false },
                inputHints: null,
                inputSchema: {},
                execution: { target: 'daemon' },
                scopes: ['workspace'],
                contributionSurfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'writesRemote',
                confirmation,
            },
        };
        const projection = buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), actions: [action] },
            generation: 1,
        });

        expect(projection.actionsById['acme.publish/publish']).toMatchObject({
            // The projected UI form must retain the declaration's semantic
            // scope. Deriving this from `surfaces.ui` would falsely turn a
            // workspace Action into a settings Action and strand the real
            // current qualified Action from its intended host surface.
            scopes: ['workspace'],
            dangerLevel: 'writesRemote',
            confirmation,
        });
        for (const dangerLevel of [
            'writesLocal',
            'writesRemote',
            'externalSideEffect',
            'destructive',
        ] as const) {
            const exact = buildPluginProjectionV2({
                registry: {
                    ...createEmptyResolvedContributionRegistry(),
                    actions: [{
                        ...action,
                        definition: { ...action.definition, dangerLevel, confirmation },
                    }],
                },
                generation: 1,
            });
            expect(exact.actionsById['acme.publish/publish']?.dangerLevel).toBe(dangerLevel);
        }
    });

    it('carries a manifest-declared Voice Action through the resolved registry to the final actions projection', () => {
        const pluginId = 'acme.voice-action';
        const plugin = {
            pluginId,
            pluginRootPath: `/plugins/${pluginId}`,
            manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
            daemonEntryPath: `/plugins/${pluginId}/dist/plugin.js`,
            devDaemonEntryPath: null,
            sourceSpec: {
                kind: 'path',
                locator: `/plugins/${pluginId}`,
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            manifest: normalizePluginManifestV2({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'Voice Action',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './dist/plugin.js' },
                contributes: {
                    actions: [{
                        id: 'open-context',
                        title: 'Open context',
                        scopes: ['session'],
                        surfaces: ['voice'],
                        execution: { target: 'daemon' },
                        dangerLevel: 'safe',
                    }],
                },
            }),
        } satisfies LoadedPlugin;
        const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} },
            provenance: 'external',
        }));

        const projection = buildPluginProjectionV2({ registry, generation: 1 });

        expect(projection.actionsById[`${pluginId}/open-context`]).toMatchObject({
            pluginId,
            id: 'open-context',
            surfaces: ['voice'],
        });
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
    });

    it('retains localized Action presentation through the canonical author-to-projection path', () => {
        const pluginId = 'acme.localized-action';
        const plugin = {
            pluginId,
            pluginRootPath: `/plugins/${pluginId}`,
            manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
            daemonEntryPath: `/plugins/${pluginId}/dist/plugin.js`,
            devDaemonEntryPath: null,
            sourceSpec: {
                kind: 'path',
                locator: `/plugins/${pluginId}`,
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            manifest: normalizePluginManifestV2({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'Localized Action',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './dist/plugin.js' },
                contributes: {
                    actions: [{
                        id: 'refresh',
                        title: { key: 'actions.refresh.title', fallback: 'Refresh preview' },
                        description: { key: 'actions.refresh.description', fallback: 'Refresh the active preview.' },
                        scopes: ['session'],
                        surfaces: ['ui', 'voice'],
                        execution: { target: 'daemon' },
                        placementBindings: ['commandPalette'],
                        dangerLevel: 'safe',
                        inputSchema: {
                            type: 'object',
                            properties: { note: { type: 'string' } },
                            additionalProperties: false,
                        },
                        inputHints: {
                            title: { key: 'actions.refresh.form.title', fallback: 'Refresh options' },
                            description: { key: 'actions.refresh.form.description', fallback: 'Choose refresh options.' },
                            submitLabel: { key: 'actions.refresh.form.submit', fallback: 'Refresh' },
                            fields: [{
                                path: 'note',
                                widget: 'textarea',
                                title: { key: 'actions.refresh.note.title', fallback: 'Note' },
                                placeholder: { key: 'actions.refresh.note.placeholder', fallback: 'Optional note' },
                            }],
                        },
                    }],
                },
            }),
        } satisfies LoadedPlugin;
        const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} },
            provenance: 'external',
        }));

        const projected = buildPluginProjectionV2({ registry, generation: 1 })
            .actionsById[`${pluginId}/refresh`];

        expect(projected).toMatchObject({
            title: { key: 'actions.refresh.title', fallback: 'Refresh preview' },
            description: { key: 'actions.refresh.description', fallback: 'Refresh the active preview.' },
            inputHints: {
                title: { key: 'actions.refresh.form.title', fallback: 'Refresh options' },
                description: { key: 'actions.refresh.form.description', fallback: 'Choose refresh options.' },
                submitLabel: { key: 'actions.refresh.form.submit', fallback: 'Refresh' },
                fields: [{
                    path: 'note',
                    title: { key: 'actions.refresh.note.title', fallback: 'Note' },
                    placeholder: { key: 'actions.refresh.note.placeholder', fallback: 'Optional note' },
                }],
            },
        });
    });

    it('preserves the canonical client Action execution target and stamps its exact producer origin', () => {
        const pluginId = 'acme.client-actions';
        const outputSchema = {
            type: 'object',
            properties: {
                summary: { type: 'string' },
            },
            required: ['summary'],
            additionalProperties: false,
        } as const;
        const execution: ResolvedActionContribution['definition']['execution'] = {
            target: 'client',
            client: {
                artifactId: 'client-actions',
                modulePath: './client-actions.js',
                exportName: 'activate',
            },
            platforms: ['web', 'ios'],
        };
        const origin = {
            serverIdentityId: 'srv_action_projection_fixture',
            materializationRef: {
                machineId: 'machine_action_projection_fixture',
                materializationId: 'materialization-action-a',
                pluginId,
            },
        } as const;
        const action: ResolvedActionContribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            definition: {
                kindVersion: 1,
                id: 'open-client-preview',
                title: 'Open client preview',
                description: null,
                safety: 'safe',
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false, plugin: false },
                inputHints: null,
                inputSchema: {},
                outputSchema,
                execution,
                scopes: ['session'],
                contributionSurfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
            },
        };
        const introspectionContribution = {
            pluginId,
            pluginVersion: '1.0.0',
            source: 'development' as const,
            family: 'actions',
            identity: { kind: 'localId' as const, localId: 'open-client-preview' },
            registration: 'required' as const,
            consumer: 'action-dispatch',
            platforms: ['cli' as const],
        };

        const projected = buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                actions: [action],
                introspectionContributions: [introspectionContribution],
            },
            generation: 1,
            pluginExecutionOriginsByPluginId: { [pluginId]: origin },
        }).actionsById[`${pluginId}/open-client-preview`];

        expect(projected).toMatchObject({
            execution,
            inputSchema: {},
            outputSchema,
            dangerLevel: 'safe',
            available: true,
            ...origin,
        });
        expect(projected?.execution).toEqual(execution);

        const unavailableProjection = buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                actions: [action],
                introspectionContributions: [introspectionContribution],
            },
            generation: 2,
            introspectionRuntimeSnapshot: adaptTargetActivationFacts({
                generation: 2,
                candidates: [introspectionContribution],
                plugins: [{ pluginId, pluginVersion: '1.0.0', source: 'development' }],
                targetActivationFacts: [{
                    pluginId,
                    pluginVersion: '1.0.0',
                    source: 'development',
                    generation: 'activation-2',
                    host: 'daemon',
                    platform: 'darwin',
                    occurredAtMs: 10,
                    status: 'unavailable',
                    required: [{ family: 'actions', localId: 'open-client-preview' }],
                    bound: [],
                    diagnostics: [{
                        code: 'plugin_activation_failed',
                        message: 'Activation failed',
                    }],
                }],
                runtimeState: 'current',
            }),
        }).actionsById[`${pluginId}/open-client-preview`];
        expect(unavailableProjection?.available).toBe(false);

        // Absence of an activation fact is the ordinary lazy-demand state,
        // already proven by the positive projection above.
    });

    it('projects only exact target-Action currentness facts when the runtime owner can resolve them', () => {
        const pluginId = 'acme.client-actions';
        const authorization = {
            generation: {
                targetGeneration: 'generation-7',
                desiredGeneration: 'generation-7',
                appliedGeneration: null,
                targetGenerationMode: 'current' as const,
            },
            resourceSelections: [],
            scopedGrants: [],
            serviceAvailability: [],
            operatingSystemAuthorization: [],
        } satisfies PluginActionPresentUserGatePolicy['authorization'];
        const action: ResolvedActionContribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            definition: {
                kindVersion: 1,
                id: 'open-client-preview',
                title: 'Open client preview',
                description: null,
                safety: 'safe',
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false, plugin: false },
                inputHints: null,
                inputSchema: {},
                execution: { target: 'client', client: { artifactId: 'client-actions', modulePath: './client-actions.js', exportName: 'activate' }, platforms: ['web'] },
                scopes: ['session'],
                contributionSurfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
            },
        };
        const resolveActionPresentUserGatePolicy = (candidatePluginId: string, localId: string) => {
            if (candidatePluginId !== pluginId || localId !== action.definition.id) return null;
            return {
                qualifiedId: `${candidatePluginId}/actions/${localId}`,
                generation: 'generation-7',
                dangerLevel: 'safe',
                scopes: ['session'],
                surfaces: ['ui'],
                authorization,
            } satisfies PluginActionPresentUserGatePolicy;
        };

        const projection = buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), actions: [action] },
            generation: 1,
            resolveActionPresentUserGatePolicy,
            pluginFinalPolicyCurrentGenerationsById: new Map([[pluginId, {
                immutableGenerationId: 'generation-7',
                desiredImmutableGenerationId: 'generation-7',
                appliedImmutableGenerationId: null,
                applied: false,
                selectedAccess: [],
            }]]),
        });
        const projected = projection.actionsById[`${pluginId}/open-client-preview`];

        expect(projected?.authorization).toEqual(authorization);
        expect(evaluatePluginActionPolicy({
            ...authorization,
            confirmation: 'notRequired',
        })).toEqual({
            outcome: 'unavailable',
            code: 'plugin_action_generation_not_applied',
            requiresCurrentIntent: false,
        });
        expect(buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), actions: [action] },
            generation: 1,
            resolveActionPresentUserGatePolicy,
        }).actionsById[`${pluginId}/open-client-preview`]).not.toHaveProperty('authorization');
    });

    it('leaves an Action producer origin absent when the projection lease has none', () => {
        const pluginId = 'acme.daemon-actions';
        const execution = { target: 'daemon' } as const;
        const action: ResolvedActionContribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            definition: {
                kindVersion: 1,
                id: 'refresh',
                title: 'Refresh',
                description: null,
                safety: 'safe',
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false, plugin: false },
                inputHints: null,
                inputSchema: {},
                execution,
                scopes: ['session'],
                contributionSurfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
            },
        };

        const projected = buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), actions: [action] },
            generation: 1,
        }).actionsById[`${pluginId}/refresh`];

        expect(projected).toMatchObject({ execution });
        expect(projected).not.toHaveProperty('serverIdentityId');
        expect(projected).not.toHaveProperty('materializationRef');
    });

    it('does not stamp an Action with an origin whose materialization belongs to another plugin', () => {
        const pluginId = 'acme.current-actions';
        const execution = { target: 'daemon' } as const;
        const action: ResolvedActionContribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            definition: {
                kindVersion: 1,
                id: 'refresh',
                title: 'Refresh',
                description: null,
                safety: 'safe',
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false, plugin: false },
                inputHints: null,
                inputSchema: {},
                execution,
                scopes: ['session'],
                contributionSurfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
            },
        };

        const projected = buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), actions: [action] },
            generation: 1,
            pluginExecutionOriginsByPluginId: {
                [pluginId]: {
                    serverIdentityId: 'srv_action_projection_fixture',
                    materializationRef: {
                        machineId: 'machine_action_projection_fixture',
                        materializationId: 'materialization-action-b',
                        pluginId: 'acme.other-actions',
                    },
                },
            },
        }).actionsById[`${pluginId}/refresh`];

        expect(projected).toMatchObject({ execution });
        expect(projected).not.toHaveProperty('serverIdentityId');
        expect(projected).not.toHaveProperty('materializationRef');
    });

    it('projects Action icon, priority, and every declared placement binding', () => {
        const action = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            definition: {
                kindVersion: 1,
                id: 'refresh-preview',
                title: 'Refresh preview',
                description: null,
                icon: 'magic-wand',
                safety: 'safe',
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false, plugin: false },
                inputHints: null,
                inputSchema: {},
                execution: { target: 'daemon' },
                scopes: ['session'],
                contributionSurfaces: ['ui'],
                placementBindings: ['primary', 'secondary'] as const,
                priority: -10,
                dangerLevel: 'safe' as const,
            },
        } satisfies ResolvedActionContribution & Readonly<{
            definition: Readonly<{ placementBindings: readonly ['primary', 'secondary'] }>;
        }>;

        const projection = buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), actions: [action] },
            generation: 1,
        });

        expect(projection.actionsById['acme.preview/refresh-preview']).toMatchObject({
          icon: 'magic-wand',
          priority: -10,
          placementBindings: ['primary', 'secondary'],
        });
    });

    it('projects plugin-only Actions without a CLI fallback or manufactured presentation', () => {
        const action: ResolvedActionContribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.provider',
            definition: {
                kindVersion: 1,
                id: 'refresh-provider-state',
                title: 'Refresh provider state',
                description: null,
                safety: 'danger',
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: false, rpc: false, api: false, plugin: true },
                inputHints: null,
                inputSchema: {},
                execution: { target: 'daemon' },
                operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
                scopes: ['session'],
                contributionSurfaces: ['plugin'],
                dangerLevel: 'writesRemote',
            },
        };

        const projection = buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), actions: [action] },
            generation: 1,
        });

        expect(projection.actionsById['acme.provider/refresh-provider-state']).toMatchObject({
            surfaces: ['plugin'],
            dangerLevel: 'writesRemote',
            inputSchema: {},
            operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
        });
        expect(projection.actionsById['acme.provider/refresh-provider-state']).not.toHaveProperty('placement');
        expect(projection.actionsById['acme.provider/refresh-provider-state']).not.toHaveProperty('confirmation');
    });

    it('projects plugin-local resource ids under qualified keys', () => {
        const resource = (pluginId: string) => ({
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            pluginId,
            definition: {
                kindVersion: 1 as const,
                id: 'review-prompt-resource',
                type: 'prompt',
                path: './resources/review-prompt.md',
            },
        });
        const projection = buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                resources: [resource('happier.review.coderabbit'), resource('happier.review.deepsec')],
            },
            generation: 1,
        });

        expect(Object.keys(projection.resourcesById).sort()).toEqual([
            'happier.review.coderabbit/review-prompt-resource',
            'happier.review.deepsec/review-prompt-resource',
        ]);
    });

    it('fails closed instead of relabeling an invalid resource kind as an asset', () => {
        expect(() => buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                resources: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.invalid-resource',
                    definition: {
                        kindVersion: 1,
                        id: 'executable',
                        type: 'executable',
                        path: './resources/tool',
                    },
                }],
            } as unknown as ResolvedContributionRegistry,
            generation: 1,
        })).toThrow(/invalid resource kind/i);
    });

    it('uses canonical diagnostic records without deduplicating equal messages from distinct stages', () => {
        const base = {
            version: 1 as const,
            data: { severity: 'error' as const, code: 'plugin_unavailable', message: 'Unavailable' },
            plugin: { id: 'acme.lifecycle', version: '1.0.0', source: 'development' as const },
            host: 'daemon' as const,
            platform: 'darwin',
            occurredAtMs: 10,
            resolution: { state: 'current' as const },
        };
        const diagnostics = [
            { ...base, id: 'discovery', stage: 'discovery' as const },
            { ...base, id: 'activation', stage: 'activation' as const },
        ];

        const projection = buildPluginProjectionV2({
            registry: createEmptyResolvedContributionRegistry(),
            generation: 2,
            introspectionRuntimeSnapshot: {
                generation: 2,
                runtimeState: 'current',
                runtimeFactsByQualifiedId: new Map(),
                diagnosticRecords: diagnostics,
            },
        });

        expect(projection.diagnostics).toEqual(diagnostics);
        expect(projection.contributionIntrospection?.diagnostics).toEqual(diagnostics);
    });

    it('projects catalog lifecycle truth without inferring runtime binding or activation', () => {
        const projection = buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                introspectionContributions: [{
                    pluginId: 'acme.lifecycle',
                    pluginVersion: '1.0.0',
                    source: 'development',
                    family: 'actions',
                    identity: { kind: 'localId', localId: 'run' },
                    registration: 'required',
                    consumer: 'action-dispatch',
                    platforms: ['cli'],
                }],
            },
            generation: 2,
        });

        expect(projection.contributionIntrospection?.contributions).toMatchObject([{
            contribution: { qualifiedId: 'acme.lifecycle/actions/run' },
            registration: { requirement: 'required', state: 'unbound' },
            activation: { state: 'dormant' },
        }]);
    });

    it('joins exact T4 activation facts into the current generation projection', () => {
        const candidate = {
            pluginId: 'acme.lifecycle', pluginVersion: '1.0.0', source: 'development' as const,
            family: 'actions', identity: { kind: 'localId' as const, localId: 'run' },
            registration: 'required' as const,
            consumer: 'action-dispatch', platforms: ['cli' as const],
        };
        const introspectionRuntimeSnapshot = adaptTargetActivationFacts({
            generation: 4, candidates: [candidate], runtimeState: 'current',
            plugins: [{ pluginId: 'acme.lifecycle', pluginVersion: '1.0.0', source: 'development' }],
            targetActivationFacts: [{
                pluginId: 'acme.lifecycle', pluginVersion: '1.0.0', source: 'development',
                generation: '4', host: 'daemon', platform: 'darwin', occurredAtMs: 10,
                status: 'active',
                required: [{ family: 'actions', localId: 'run' }],
                bound: [{ family: 'actions', localId: 'run' }], diagnostics: [],
            }],
        });
        const projection = buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), introspectionContributions: [candidate] },
            generation: 4,
            introspectionRuntimeSnapshot,
        });

        expect(projection.contributionIntrospection?.contributions).toEqual([
            expect.objectContaining({
                registration: { requirement: 'required', state: 'bound', generation: '4' },
                activation: { state: 'active', generation: '4' },
            }),
        ]);
    });

    it('projects voice model packs under qualified identities', () => {
        const pack = PluginContributesV2Schema.parse({ voiceModelPacks: [{
            id: 'english-small', schemaVersion: 1, executionHosts: ['daemon'],
            manifest: {
                schemaVersion: 1, kind: 'stt_sherpa', model: 'english-small', version: '1.0.0',
                runtime: {
                    family: 'sherpa_zipformer_streaming',
                    artifacts: {
                        encoder: { type: 'file', path: 'encoder.onnx' }, decoder: { type: 'file', path: 'decoder.onnx' },
                        joiner: { type: 'file', path: 'joiner.onnx' }, tokens: { type: 'file', path: 'tokens.txt' },
                    },
                    abiVersion: 1, minHostVersion: '1.0.0', platforms: ['darwin'], architectures: ['arm64'],
                },
                provenance: { source: 'https://models.example.test/english-small', publisher: 'Acme' },
                license: { id: 'Apache-2.0', title: 'Apache License 2.0', url: 'https://models.example.test/license', requiresAcceptance: false },
                files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((path, index) => ({
                    path, url: `https://models.example.test/english-small/${path}`, sha256: String(index + 1).repeat(64), sizeBytes: 4,
                })),
            },
        }] }).voiceModelPacks[0]!;
        const owned = <T extends { id: string }>(definition: T) => ({
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            pluginId: 'com.acme.voice',
            identity: createPluginContributionIdentity({ pluginId: 'com.acme.voice', localId: definition.id }),
            manifestPath: '/plugins/com.acme.voice/plugin.json',
            definition,
        });
        const projection = buildPluginProjectionV2({
            registry: { ...createEmptyResolvedContributionRegistry(), voiceModelPacks: [owned(pack)] },
            generation: 7,
        });

        expect(projection.familiesById.voiceModelPacks?.entriesById['com.acme.voice/english-small']).toMatchObject({
            id: 'com.acme.voice/english-small', pluginId: 'com.acme.voice', generation: 7,
        });
    });
    it('projects executable voice providers under qualified identities', () => {
        const provider = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Acme Conversation',
            kind: 'conversation',
            roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
            platforms: ['web'],
            capabilities: {
                turn: { cancelResponse: true, bargeIn: true },
            },
            client: { artifactId: 'voice-ui', modulePath: './voice.js', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        const identity = createPluginContributionIdentity({ pluginId: 'com.acme.voice', localId: provider.id });
        const projection = buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                voiceProviders: [{
                    provenance: 'external', source: { kind: 'path' }, pluginId: 'com.acme.voice', identity,
                    manifestPath: '/plugins/com.acme.voice/plugin.json', definition: provider,
                }],
            },
            generation: 8,
        });

        expect(projection.familiesById.voiceProviders?.entriesById['com.acme.voice/conversation']).toMatchObject({
            id: 'com.acme.voice/conversation', pluginId: 'com.acme.voice', generation: 8,
            contributionKey: 'com.acme.voice/conversation', definition: provider,
        });
    });
    it('projects only bounded provider-owned environment key names from accepted agent contributions', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            agents: [{
                id: 'acme-agent',
                identity: { pluginId: 'acme.agent', localId: 'acme-agent' },
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.agent',
                cliMetadata: {
                    executable: {
                        binaryName: 'acme',
                        sourcePreference: 'system-first' as const,
                    },
                    install: {
                        manual: { kind: 'none' as const },
                    },
                    auth: {
                        support: 'login_terminal' as const,
                        probe: {
                            parser: 'unknown' as const,
                            backgroundChecks: 'safe' as const,
                        },
                        loginLaunches: [
                            { kind: 'primary' as const, args: ['login'] },
                            { kind: 'device_code' as const, args: ['login', '--device-code'] },
                        ],
                    },
                },
                catalogEntry: {
                    id: 'acme-agent',
                    cliSubcommand: 'acme-agent',
                    vendorResumeSupport: 'unsupported',
                    connectedServiceIds: ['openai-codex'],
                },
                definition: {
                    kindVersion: 1 as const,
                    id: 'acme-agent',
                    ownedBackendIds: [],
                    providerRequirements: {
                        acceptsProtocols: ['openai-responses'],
                        required: { streaming: true, toolRoundTrips: true },
                        credentialSupport: { supportsNoAuth: false, apiKeyTransports: [] },
                        authIsolation: {
                            suppressConnectedServiceIds: ['openai-codex'],
                            ownedEnvKeys: ['ACME_PROVIDER_KEY'],
                        },
                        materialization: 'spawnEnv',
                        applyPolicy: 'restart_session',
                        supportsFreeformModelIds: true,
                    },
                },
            }],
        } satisfies ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 9 });
        expect(projection.agentsById['acme-agent']).toMatchObject({
            id: 'acme-agent',
            providerOwnedEnvironmentKeys: ['ACME_PROVIDER_KEY'],
            connectedServiceIds: ['openai-codex'],
            cli: {
                executable: { binaryName: 'acme', sourcePreference: 'system-first' },
                auth: {
                    support: 'login_terminal',
                    loginLaunches: [
                        { kind: 'primary', args: ['login'] },
                        { kind: 'device_code', args: ['login', '--device-code'] },
                    ],
                },
            },
        });
        expect(PluginProjectionV2Schema.parse(projection).agentsById['acme-agent']?.connectedServiceIds)
            .toEqual(['openai-codex']);
        expect(projection.agentsById['acme-agent']).not.toHaveProperty('providerSupport');
        expect(projection.agentsById['acme-agent']).not.toHaveProperty('providerRequirements');
        expect(buildPluginProjectionV2({
            registry: createEmptyResolvedContributionRegistry(),
            generation: 10,
        }).agentsById['acme-agent']).toBeUndefined();
    });

    it('projects generation-pinned external-session operations and sources from a qualified Agent declaration', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'acme-agent',
                title: 'Acme Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    surfaces: ['externalSessions'],
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
                surfaces: {
                    externalSession: {
                        sources: [{
                            sourceKind: 'acmeArchive',
                            schema: {
                                fields: [{ name: 'kind', kind: 'literal', value: 'acmeArchive' }],
                            },
                            key: { segments: [{ kind: 'literal', value: 'acmeArchive' }] },
                            instances: [{ kind: 'default', constants: {} }],
                        }],
                    },
                },
            }],
        }).agents[0]!;
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            agents: [{
                id: definition.id,
                identity: createPluginContributionIdentity({
                    pluginId: 'acme.external-sessions',
                    localId: definition.id,
                }),
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.external-sessions',
                definition: {
                    kindVersion: 1 as const,
                    id: definition.id,
                    ownedBackendIds: [],
                },
                richDefinition: {
                    provenance: 'external' as const,
                    definition,
                },
            }],
        } satisfies ResolvedContributionRegistry;

        expect(buildPluginProjectionV2({ registry, generation: 17 }).agentsById['acme-agent']?.externalSessions)
            .toEqual({
                agent: {
                    pluginId: 'acme.external-sessions',
                    localId: 'acme-agent',
                },
                generation: 17,
                operations: {
                    listCandidates: true,
                    resolveLinkIdentity: true,
                    pageTranscript: true,
                    readAfterTranscript: true,
                },
                sources: definition.surfaces?.externalSession?.sources,
            });
    });

    it('retains the normalized external Agent lifecycle declaration instead of a presentation fallback', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'acme-lifecycle',
                title: 'Acme Lifecycle',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    surfaces: ['terminal'],
                    sessions: {
                        open: ['create', 'resume', 'fork'],
                        delivery: ['newTurn', 'steer', 'followUp'],
                        cancel: true,
                        conversationRollback: true,
                        usageLimitRecovery: {
                            active: ['checkNow'],
                            inactive: ['checkNow', 'consumeResetCredit'],
                        },
                    },
                    executionRuns: {
                        open: ['create', 'resume', 'fork'],
                        checkpoint: true,
                        stop: true,
                    },
                },
            }],
        }).agents[0]!;
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            agents: [{
                id: definition.id,
                identity: createPluginContributionIdentity({
                    pluginId: 'acme.lifecycle',
                    localId: definition.id,
                }),
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.lifecycle',
                // These presentation-compatible fields must not become the
                // lifecycle authority for this external Agent.
                definition: {
                    kindVersion: 1 as const,
                    id: definition.id,
                    ownedBackendIds: [],
                    catalogAgentId: 'codex',
                },
                richDefinition: {
                    provenance: 'external' as const,
                    definition,
                },
            }],
        } satisfies ResolvedContributionRegistry;

        expect(buildPluginProjectionV2({ registry, generation: 18 }).agentsById['acme-lifecycle'])
            .toMatchObject({
                id: 'acme-lifecycle',
                identity: {
                    pluginId: 'acme.lifecycle',
                    localId: 'acme-lifecycle',
                },
                capabilities: {
                    surfaces: ['terminal'],
                    sessions: {
                        open: ['create', 'resume', 'fork'],
                        delivery: ['newTurn', 'steer', 'followUp'],
                        cancel: true,
                        conversationRollback: true,
                        usageLimitRecovery: {
                            active: ['checkNow'],
                            inactive: ['checkNow', 'consumeResetCredit'],
                        },
                    },
                    executionRuns: {
                        open: ['create', 'resume', 'fork'],
                        checkpoint: true,
                        stop: true,
                    },
                },
            });
    });

    it('projects declared built-in external-session Agents and omits unsupported Agent packages', () => {
        const builtIns = resolveBuiltInContributions();
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            ...builtIns,
        } satisfies ResolvedContributionRegistry;
        const projection = buildPluginProjectionV2({ registry, generation: 21 });

        expect(projection.agentsById.codex?.capabilities).toMatchObject({
            sessions: {
                startupInstructions: { versions: [1] },
            },
        });
        expect(projection.agentsById.ohMyPi?.identity).toEqual({
            pluginId: 'happier.agent.ohmypi',
            localId: 'ohmypi',
        });

        for (const agentId of ['pi', 'antigravity']) {
            const externalSessions = projection.agentsById[agentId]?.externalSessions;
            expect(externalSessions).toMatchObject({
                generation: 21,
                operations: {
                    listCandidates: true,
                    resolveLinkIdentity: true,
                    pageTranscript: true,
                    readAfterTranscript: true,
                },
            });
            expect(projection.installedPackagesById[externalSessions!.agent.pluginId]?.enabled).toBe(true);
        }
        for (const agentId of ['auggie', 'cursor', 'copilot']) {
            expect(projection.agentsById[agentId]?.externalSessions).toBeUndefined();
        }
    });

    it('fails closed when an Agent lacks its manifest-qualified identity', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            agents: [{
                id: 'identityless-agent',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: 'identityless-agent',
                    ownedBackendIds: [],
                },
            }],
        } satisfies ResolvedContributionRegistry;

        expect(() => buildPluginProjectionV2({ registry, generation: 21 }))
            .toThrow(/qualified identity/i);
    });

    it('projects bounded provider definitions under qualified contribution keys', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            providers: [{
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.gateway',
                manifestPath: '/plugins/acme.gateway/plugin.json',
                daemonEntryPath: null,
                identity: {
                    pluginId: 'acme.gateway',
                    localId: 'main',
                },
                definition: {
                    v: 1 as const,
                    id: 'main',
                    name: 'Acme Gateway',
                    kind: 'cloud' as const,
                    endpointTemplates: [{
                        id: 'responses',
                        protocol: 'openai-responses' as const,
                        baseUrl: 'https://gateway.example/v1',
                        capabilities: {
                            streaming: 'unknown' as const,
                            toolRoundTrips: 'unknown' as const,
                            statefulResponses: 'unknown' as const,
                            reasoningControls: 'unknown' as const,
                        },
                    }],
                    catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
                },
            }],
        } satisfies ResolvedContributionRegistry;
        const projection = buildPluginProjectionV2({ registry, generation: 7 });

        expect(projection.familiesById.providers?.entriesById['acme.gateway/main']).toMatchObject({
            id: 'acme.gateway/main',
            pluginId: 'acme.gateway',
            generation: 7,
            definition: { id: 'main', name: 'Acme Gateway' },
        });
    });

    it('does not allow callers to override catalog-owned projection families', () => {
        type ProjectionFamilyResult = Readonly<{
            family: string;
            entriesById: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
        }>;
        type ProjectionFamilyDescriptor = Readonly<{
            family: string;
            project: (context: Readonly<{
                registry: ResolvedContributionRegistry;
                generation: number;
            }>) => ProjectionFamilyResult;
        }>;
        type ProjectionWithFamilies = ReturnType<typeof buildPluginProjectionV2> & Readonly<{
            familiesById: Readonly<Record<string, ProjectionFamilyResult>>;
        }>;
        type BuildProjectionWithFamilies = (
            params: Parameters<typeof buildPluginProjectionV2>[0] & Readonly<{
                familyDescriptors: readonly ProjectionFamilyDescriptor[];
            }>
        ) => ProjectionWithFamilies;

        const projectWithFamilies = buildPluginProjectionV2 as BuildProjectionWithFamilies;
        const projection = projectWithFamilies({
            registry: createEmptyResolvedContributionRegistry(),
            generation: 5,
            familyDescriptors: [
                {
                    family: 'scmHostingProviders',
                    project: ({ generation }) => ({
                        family: 'scmHostingProviders',
                        entriesById: {
                            github: {
                                id: 'github',
                                pluginId: 'acme.scm',
                                generation,
                                hostPattern: 'github.com',
                            },
                        },
                    }),
                },
            ],
        });

        expect(projection.familiesById.scmHostingProviders?.entriesById).toEqual({});
        expect(PluginProjectionV2Schema.parse(projection).familiesById).toEqual(projection.familiesById);
        expect(() => buildPluginProjectionFamiliesByIdV2({
            registry: createEmptyResolvedContributionRegistry(),
            generation: 5,
        }, [])).toThrow(/missing:/);
        expect(projection.agentsById).toEqual({});
        expect(projection.backendsById).toEqual({});
    });

    it('keeps the retired backend projection empty for mixed-version readers', () => {
        const projection = buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                agents: [
                    {
                        id: 'acme.provider',
                        identity: { pluginId: 'acme.plugin', localId: 'acme.provider' },
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.provider',
                            ownedBackendIds: ['acme.backend'],
                        },
                    },
                ],
            },
            generation: 1,
        });

        expect(projection.backendsById).toEqual({});
    });

    it('projects static MCP contribution families through the canonical projection family surface', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            mcpServers: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.mcp',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    definition: {
                        id: 'acme-server',
                        title: 'Acme hosted',
                        kind: 'static',
                        transport: { kind: 'http', url: 'https://mcp.example.test/' },
                    },
                },
            ],
            mcpDiscoverySources: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.mcp',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    definition: {
                        id: 'acme-discovery',
                        title: 'Acme discovery',
                        metadata: { agentId: 'acme' },
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 6,
        });

        expect(projection.familiesById.mcp?.entriesById['server:acme-server']).toMatchObject({
            id: 'server:acme-server',
            pluginId: 'acme.mcp',
            contributionKind: 'server',
            title: 'Acme hosted',
            transport: { kind: 'http', url: 'https://mcp.example.test/' },
        });
        expect(projection.familiesById.mcp?.entriesById['discoverySource:acme-discovery']).toMatchObject({
            id: 'discoverySource:acme-discovery',
            pluginId: 'acme.mcp',
            contributionKind: 'discoverySource',
            title: 'Acme discovery',
        });
        expect(projection.familiesById.mcp?.entriesById['backendClient:acme.backendClient']).toBeUndefined();
        expect(projection.familiesById.mcp?.entriesById['tool:acme.tool']).toBeUndefined();
        expect('mcpBackendClients' in projection).toBe(false);
        expect('mcpTools' in projection).toBe(false);
    });

    it('does not project the retired static hook-registration collection', () => {
        const registry = {
            agents: [],
                        actions: [],
            tools: [],
            commands: [],
            resources: [],
            activationTargets: [],
            hookRegistrations: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.reload',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/acme',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        hookApiVersion: 1,
                        id: 'session.spawned',
                        category: 'lifecycle',
                        scope: 'backend',
                        executionKind: 'observe',
                    },
                },
            ],
            actionsById: new Map(),
            toolsById: new Map(),
            commandsById: new Map(),
            resourcesById: new Map(),
                        catalogEntriesById: {},
            agentDefinitionsById: new Map(),
                        pluginDiagnosticsByPluginId: {},
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 4,
        });

        expect(projection).not.toHaveProperty('hooksById');
    });

    it("projects built-in contributes as bundled sources so first-party plugins don't look like external installs", () => {
        const registry: ResolvedContributionRegistry = {
            agents: [{
                id: 'happier.bundled',
                identity: { pluginId: 'happier.bundled', localId: 'happier.bundled' },
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: 'happier.bundled',
                    ownedBackendIds: [],
                },
                // PS-02/PS-06: bundled first-party contributes carry a plugin id, but must not
                // be projected as if they were installed from a path/archive.
                pluginId: 'happier.bundled',
            }],
                        actions: [],
            tools: [],
            commands: [],
            resources: [],
            activationTargets: [],
            actionsById: new Map(),
            toolsById: new Map(),
            commandsById: new Map(),
            resourcesById: new Map(),
                        catalogEntriesById: {},
            agentDefinitionsById: new Map(),
                        pluginDiagnosticsByPluginId: {},
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 1,
            installedPackages: [],
        });

        expect(projection.installedPackagesById).toEqual({
            'happier.bundled': expect.objectContaining({
                id: 'happier.bundled',
                source: {
                    kind: 'bundled',
                    locator: 'happier.bundled',
                },
            }),
        });
    });

    it('projects first-party provider settings backend ids for bundled multi-backend agents', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            agents: [{
                id: 'antigravity',
                identity: { pluginId: 'happier.agent.antigravity', localId: 'antigravity' },
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: 'antigravity',
                    ownedBackendIds: ['antigravity-localharness', 'antigravity-terminal'],
                    settingsBackendId: 'antigravity-localharness',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                },
                pluginId: 'happier.agent.antigravity',
            }],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 1,
            installedPackages: [],
        });

        expect(projection.agentsById.antigravity).toEqual(expect.objectContaining({
            settingsBackendId: 'antigravity-localharness',
            catalogAgentId: 'antigravity',
            iconAgentId: 'antigravity',
        }));
        expect(projection.backendsById).toEqual({});
    });

    it('projects generic daemon settings for a plugin without losing explicit secret custody', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            settings: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.hooks',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/acme',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        id: 'settings',
                        version: 1,
                        title: {
                            key: 'plugins.acme.settings.title',
                            fallback: 'Acme settings',
                        },
                        target: { kind: 'plugin' },
                        scope: 'daemon',
                        fields: [
                            {
                                id: 'api-token',
                                title: {
                                    key: 'plugins.acme.apiToken.label',
                                    fallback: 'API token',
                                },
                                description: {
                                    key: 'plugins.acme.apiToken.description',
                                    fallback: 'Used to authenticate requests.',
                                },
                                schema: { type: 'string', minLength: 1 },
                                secret: { custody: 'daemon' },
                            },
                            {
                                id: 'enabled',
                                title: 'Enabled',
                                schema: { type: 'boolean' },
                                availability: {},
                                default: true,
                            },
                        ],
                        presentation: { sections: [], subagentSections: [] },
                    },
                },
            ],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 9,
            installedPackages: [],
        });

        expect(projection.settingsById['acme.hooks/settings']).toEqual({
            id: 'settings',
            pluginId: 'acme.hooks',
            version: 1,
            title: 'Acme settings',
            scope: { kind: 'daemon' },
            presentation: {
                sections: [],
                subagentSections: [],
            },
            target: { kind: 'plugin' },
            fields: [
                expect.objectContaining({
                    id: 'api-token',
                    version: '1.0.0',
                    control: 'password',
                    secretCustody: 'daemon',
                    redaction: 'secret',
                    clearWhenEmpty: 'omit',
                    displayKey: 'API token',
                    descriptionKey: 'Used to authenticate requests.',
                }),
                expect.objectContaining({
                    id: 'enabled',
                    control: 'switch',
                    secretCustody: null,
                    defaultBooleanValue: true,
                }),
            ],
        });
        expect(projection.settingsById['acme.hooks/settings']?.fields.map((field) => field.id)).toEqual([
            'api-token',
            'enabled',
        ]);
        expect(projection.settingsById['acme.hooks/settings']?.fields[0]?.valueSchema).toEqual({
            type: 'string',
            minLength: 1,
        });
        expect(projection.settingsById['acme.hooks/settings']?.fields[0]).not.toHaveProperty('default');

        const settingsDeclarations = registry.settings;
        expect(settingsDeclarations).toBeDefined();
        if (!settingsDeclarations) throw new Error('settings declarations fixture is missing');
        const agentProjection = buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: settingsDeclarations.map((entry) => ({
                    ...entry,
                    definition: {
                        ...entry.definition,
                        target: { kind: 'agent' as const, agent: 'reviewer' },
                    },
                })),
            },
            generation: 9,
            installedPackages: [],
        });
        expect(agentProjection.settingsById['acme.hooks/settings']?.target).toEqual({
            kind: 'agent',
            agent: { pluginId: 'acme.hooks', localId: 'reviewer' },
        });
    });

    it('projects notification channel configuration through canonical settings without exposing secret material', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            notificationChannels: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.notifications',
                definition: {
                    id: 'webhook',
                    kind: 'webhook',
                    title: 'Webhook',
                    configurable: true,
                    settings: [{
                        id: 'endpoint',
                        title: 'Endpoint',
                        schema: { type: 'string', minLength: 1 },
                        default: 'https://example.invalid/hook',
                    }, {
                        id: 'token',
                        title: 'Token',
                        schema: { type: 'string', minLength: 1 },
                        secret: true,
                    }],
                },
            }],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 10,
            installedPackages: [],
        });

        const settings = projection.settingsById['acme.notifications/notification-channel/webhook'];
        expect(settings).toMatchObject({
            id: 'notification-channel/webhook',
            pluginId: 'acme.notifications',
            scope: { kind: 'account' },
            target: { kind: 'plugin' },
            presentation: {
                sections: [{
                    id: 'configuration',
                    fields: ['webhook.endpoint', 'webhook.token'],
                }],
            },
        });
        expect(settings?.fields).toEqual([
            expect.objectContaining({
                id: 'webhook.endpoint',
                groupId: 'configuration',
                control: 'text',
                secretCustody: null,
                redaction: 'none',
                defaultValue: 'https://example.invalid/hook',
            }),
            expect.objectContaining({
                id: 'webhook.token',
                groupId: 'configuration',
                control: 'password',
                secretCustody: 'account',
                redaction: 'secret',
                clearWhenEmpty: 'omit',
            }),
        ]);
        expect(settings?.fields[1]).not.toHaveProperty('defaultValue');
    });

    it('projects the complete synced Agent settings contract through the generic settings front door', () => {
        const registry = createEmptyResolvedContributionRegistry();
        const projection = buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.agent',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/acme',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        id: 'agent-settings',
                        version: 1,
                        title: 'Agent settings',
                        target: { kind: 'agent', agent: 'reviewer' },
                        scope: 'account',
                        presentation: {
                            icon: {
                                ionName: 'sparkles-outline',
                                color: { kind: 'theme', token: 'orange' },
                            },
                            sections: [{
                                id: 'runtime',
                                title: 'Runtime',
                                fields: ['runtimeMode', 'debugCategories'],
                            }],
                            subagentSections: [{
                                id: 'teams',
                                title: 'Teams',
                                items: [{
                                    id: 'teammates',
                                    title: 'Teammates',
                                }],
                            }],
                        },
                        fields: [{
                            id: 'runtimeMode',
                            title: 'Runtime mode',
                            schema: { type: 'string', enum: ['remote', 'terminal'] },
                            default: 'remote',
                            presentation: {
                                control: 'select',
                                options: [
                                    { value: 'remote', title: 'Remote' },
                                    { value: 'terminal', title: 'Terminal' },
                                ],
                            },
                        }, {
                            id: 'debugCategories',
                            title: 'Debug categories',
                            schema: {
                                type: 'array',
                                items: { type: 'string', enum: ['api', 'hooks'] },
                            },
                            default: [],
                            presentation: {
                                control: 'multiSelect',
                                options: [
                                    { value: 'api', title: 'API' },
                                    { value: 'hooks', title: 'Hooks' },
                                ],
                            },
                        }],
                    },
                }],
            },
            generation: 10,
            installedPackages: [],
        });

        expect(projection.settingsById['acme.agent/agent-settings']).toMatchObject({
            id: 'agent-settings',
            pluginId: 'acme.agent',
            version: 1,
            scope: { kind: 'account' },
            target: {
                kind: 'agent',
                agent: { pluginId: 'acme.agent', localId: 'reviewer' },
            },
            presentation: {
                sections: [{
                    id: 'runtime',
                    fields: ['runtimeMode', 'debugCategories'],
                }],
                subagentSections: [{
                    id: 'teams',
                    items: [{
                        id: 'teammates',
                    }],
                }],
            },
            fields: [{
                id: 'runtimeMode',
                valueSchema: { type: 'string', enum: ['remote', 'terminal'] },
                control: 'select',
                defaultValue: 'remote',
                presentation: {
                    control: 'select',
                    options: [
                        { value: 'remote', title: 'Remote' },
                        { value: 'terminal', title: 'Terminal' },
                    ],
                },
            }, {
                id: 'debugCategories',
                valueSchema: {
                    type: 'array',
                    items: { type: 'string', enum: ['api', 'hooks'] },
                },
                control: 'multiSelect',
                defaultValue: [],
            }],
        });
    });

    it.each(['number', 'integer', 'array', 'object', 'null'] as const)(
        "projects the canonical '%s' value type without narrowing its schema",
        (type) => {
            const registry = createEmptyResolvedContributionRegistry();
            const projection = buildPluginProjectionV2({
                registry: {
                    ...registry,
                    settings: [{
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.unsupported',
                        definition: {
                            id: 'settings',
                            version: 1,
                            title: 'Unsupported settings',
                            target: { kind: 'plugin' },
                            scope: 'daemon',
                            fields: [{ id: 'value', title: 'Value', schema: { type } }],
                            presentation: { sections: [], subagentSections: [] },
                        },
                    }],
                },
                generation: 10,
            });
            expect(projection.settingsById['acme.unsupported/settings']?.fields[0]).toMatchObject({
                id: 'value',
                valueSchema: { type },
                control: type === 'number' || type === 'integer' ? 'number' : 'json',
            });
        },
    );

    it('preserves a nullable integer schema when the declared control is numeric', () => {
        const registry = createEmptyResolvedContributionRegistry();
        const projection = buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.numeric',
                    definition: {
                        id: 'settings',
                        version: 1,
                        title: 'Numeric settings',
                        target: { kind: 'plugin' },
                        scope: 'account',
                        fields: [{
                            id: 'limit',
                            title: 'Limit',
                            schema: {
                                anyOf: [{ type: 'integer' }, { type: 'null' }],
                            },
                            default: null,
                            presentation: { control: 'number' },
                        }],
                        presentation: { sections: [], subagentSections: [] },
                    },
                }],
            },
            generation: 10,
        });

        expect(projection.settingsById['acme.numeric/settings']?.fields[0]).toMatchObject({
            id: 'limit',
            valueType: 'integer',
            valueSchema: {
                anyOf: [{ type: 'integer' }, { type: 'null' }],
            },
            control: 'number',
            defaultValue: null,
        });
    });

    it('fails closed with contribution and field context for an ambiguous settings schema', () => {
        const registry = createEmptyResolvedContributionRegistry();
        const invalidDefinition = {
            id: 'settings',
            version: 1 as const,
            title: 'Ambiguous settings',
            target: { kind: 'plugin' as const },
            scope: 'daemon' as const,
            fields: [{
                id: 'ambiguous',
                title: 'Ambiguous',
                schema: { anyOf: [{ type: 'string' as const }, { type: 'number' as const }] },
            }],
            presentation: { sections: [], subagentSections: [] },
        };

        expect(() => buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.ambiguous',
                    definition: invalidDefinition,
                }],
            },
            generation: 10,
        })).toThrowError(expect.objectContaining({
            name: 'PluginSettingsProjectionError',
            code: 'PLUGIN_SETTINGS_PROJECTION_INVALID',
            pluginId: 'acme.ambiguous',
            contributionId: 'settings',
            fieldId: 'ambiguous',
        }));
    });

    it.each([
        {
            name: 'schema that AJV cannot compile',
            field: {
                id: 'invalid-pattern',
                title: 'Invalid pattern',
                schema: { type: 'string' as const, pattern: '[' },
            },
        },
        {
            name: 'default that violates its declared schema',
            field: {
                id: 'invalid-default',
                title: 'Invalid default',
                schema: { type: 'boolean' as const },
                default: 'true',
            },
        },
    ])('fails closed before projection for a $name', ({ field }) => {
        const registry = createEmptyResolvedContributionRegistry();

        expect(() => buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.invalid-declaration',
                    definition: {
                        id: 'settings',
                        version: 1,
                        title: 'Invalid settings',
                        target: { kind: 'plugin' },
                        scope: 'daemon',
                        fields: [field],
                        presentation: { sections: [], subagentSections: [] },
                    },
                }],
            },
            generation: 10,
        })).toThrowError(expect.objectContaining({
            name: 'PluginSettingsProjectionError',
            code: 'PLUGIN_SETTINGS_PROJECTION_INVALID',
            pluginId: 'acme.invalid-declaration',
            contributionId: 'settings',
            fieldId: field.id,
        }));
    });

    it.each([
        {
            name: 'nullable',
            schema: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }] },
        },
        {
            name: 'partially untyped',
            schema: { anyOf: [{ type: 'string' as const }, {}] },
        },
    ])('fails closed when a $name settings schema can accept values outside its projected scalar type', ({ schema }) => {
        const registry = createEmptyResolvedContributionRegistry();

        expect(() => buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.lossy',
                    definition: {
                        id: 'settings',
                        version: 1,
                        title: 'Lossy settings',
                        target: { kind: 'plugin' },
                        scope: 'daemon',
                        fields: [{ id: 'value', title: 'Value', schema }],
                        presentation: { sections: [], subagentSections: [] },
                    },
                }],
            },
            generation: 10,
        })).toThrowError(expect.objectContaining({
            name: 'PluginSettingsProjectionError',
            code: 'PLUGIN_SETTINGS_PROJECTION_INVALID',
            pluginId: 'acme.lossy',
            contributionId: 'settings',
            fieldId: 'value',
        }));
    });

    it('fails closed when allOf narrows a oneOf exclusivity contradiction to no values', () => {
        const registry = createEmptyResolvedContributionRegistry();

        expect(() => buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.contradictory',
                    definition: {
                        id: 'settings',
                        version: 1,
                        title: 'Contradictory settings',
                        target: { kind: 'plugin' },
                        scope: 'daemon',
                        fields: [{
                            id: 'value',
                            title: 'Value',
                            schema: {
                                allOf: [
                                    { oneOf: [{}, { type: 'string' }] },
                                    { type: 'string' },
                                ],
                            },
                        }],
                        presentation: { sections: [], subagentSections: [] },
                    },
                }],
            },
            generation: 10,
        })).toThrowError(expect.objectContaining({
            name: 'PluginSettingsProjectionError',
            code: 'PLUGIN_SETTINGS_PROJECTION_INVALID',
            pluginId: 'acme.contradictory',
            contributionId: 'settings',
            fieldId: 'value',
        }));
    });

    it('projects settings availability for the canonical UI policy evaluator', () => {
        const registry = createEmptyResolvedContributionRegistry();

        const projection = buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.conditional',
                    definition: {
                        id: 'settings',
                        version: 1,
                        title: 'Conditional settings',
                        target: { kind: 'plugin' },
                        scope: 'daemon',
                        fields: [{
                            id: 'enabled',
                            title: 'Enabled',
                            schema: { type: 'boolean' },
                            availability: {
                                when: { fact: 'host.feature', operator: 'enabled', value: 'plugin-settings' },
                            },
                        }],
                        presentation: { sections: [], subagentSections: [] },
                    },
                }],
            },
            generation: 10,
        });
        expect(projection.settingsById['acme.conditional/settings']?.fields[0]?.availability).toEqual({
            when: { fact: 'host.feature', operator: 'enabled', value: 'plugin-settings' },
        });
    });

    it('fails closed instead of silently dropping a settings contribution without a plugin owner', () => {
        const registry = createEmptyResolvedContributionRegistry();

        expect(() => buildPluginProjectionV2({
            registry: {
                ...registry,
                settings: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        id: 'settings',
                        version: 1,
                        title: 'Unowned settings',
                        target: { kind: 'plugin' },
                        scope: 'daemon',
                        fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }],
                        presentation: { sections: [], subagentSections: [] },
                    },
                }],
            },
            generation: 10,
        })).toThrowError(expect.objectContaining({
            name: 'PluginSettingsProjectionError',
            code: 'PLUGIN_SETTINGS_PROJECTION_INVALID',
            pluginId: '<missing>',
            contributionId: 'settings',
        }));
    });

});
