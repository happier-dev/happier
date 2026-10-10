import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createPluginContributionIdentity,
    DaemonPluginUiTargetedContributionsReadResponseSchema,
    type DaemonPluginUiTargetedContributionsReadResponse,
    type PluginTargetedContributionV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
    loadBundledPluginLocators,
    type BundledPluginLocator,
} from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import {
    loadInstalledPlugins,
    type LoadInstalledPluginsResult,
} from '@/plugins/discovery/load/installed';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import {
    createPluginRuntimeOccurrenceId,
    type PluginRuntimeOccurrenceId,
} from '@/plugins/runtime/runtimeSlots';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import type {
    CurrentCommittedPluginGeneration,
    ImmutablePluginGenerationRecord,
} from '@/plugins/store/registry/generationStore';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { resolveExecutablePluginRuntimeRegistry, type PluginRuntimeGenerationAuthority } from './resolveExecutablePluginRuntimeRegistry';

const targetPluginId = 'examples.cold-target';
const contributorPluginId = 'examples.cold-contributor';
const pointId = 'providers';
const protocol = { id: 'provider', version: 1 } as const;

const coldTarget = definePlugin({
    id: targetPluginId,
    version: '1.0.0',
    displayName: 'Cold target fixture',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    hostAccess: { required: [], optional: [] },
    contributionPoints: {
        providers: defineContributionProtocol({
            ...protocol,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                    action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                },
            },
        }).point(),
    },
});
const coldTargetManifest = ingestCanonicalPluginManifest(coldTarget.manifest, { sourceProvenance: 'registryCustodied',
    manifestAuthority: 'external',
    enforceEngineCompatibility: false,
});
if (!coldTargetManifest.ok) throw new Error('cold_target_manifest_invalid');
const point = coldTargetManifest.manifest.contributes.pluginContributionPoints?.[0]
    ?? (() => { throw new Error('cold_target_point_missing'); })();

const contribution: PluginTargetedContributionV1 = {
    id: 'provider-a',
    target: { pluginId: targetPluginId, pointId },
    protocol,
    operations: { setup: 'arbitrary-action' },
};

function action(): ResolvedActionContribution {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: contributorPluginId,
        manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
        definition: {
            id: 'arbitrary-action',
            title: 'Arbitrary action',
            description: null,
            kindVersion: 1,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
                ui: false,
                voice: false,
                agent: false,
                mcp: false,
                cli: false,
                rpc: false,
                api: false,
                plugin: true,
            },
            inputHints: null,
            inputSchema: {},
            outputSchema: { type: 'object' },
            execution: { target: 'daemon' },
            scopes: ['global'],
            contributionSurfaces: ['plugin'],
            dangerLevel: 'safe',
        },
    } satisfies ResolvedActionContribution;
}

function currentGeneration(
    pluginId: string,
    immutableGenerationId: string,
): CurrentCommittedPluginGeneration {
    const record: ImmutablePluginGenerationRecord = { sourceProvenance: 'registryCustodied',
        t: 'happier_plugin_generation_v1',
        schemaVersion: 1,
        pluginId,
        immutableGenerationId,
        createdAtMs: 0,
        files: [{ relativePath: 'plugin.json', byteLength: 0 }],
        manifestRelativePath: 'plugin.json',
    };
    return {
        pluginId,
        immutableGenerationId,
        rootPath: process.cwd(),
        record,
    };
}

function fixtureGenerationAuthority(
    generations: readonly CurrentCommittedPluginGeneration[],
): PluginRuntimeGenerationAuthority {
    return {
        commit: null,
        generations: new Map(generations.map((generation) => [generation.pluginId, generation])),
        rejectedGenerations: new Map(),
        isCurrent: async () => true,
    };
}

function createProjectionRegistrar() {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
    return { handlers, registrar };
}

async function readMountedTargetedUiProjection(input: Readonly<{
    runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
    generation: number;
    mountedTarget: Readonly<{ pluginId: string; occurrenceId: PluginRuntimeOccurrenceId }>;
}>): Promise<Extract<DaemonPluginUiTargetedContributionsReadResponse, { status: 'current' }>> {
    const { handlers, registrar } = createProjectionRegistrar();
    const projectionModule = await import('@/rpc/handlers/daemonContributionRegistryProjection');
    projectionModule.invalidateDaemonContributionRegistryProjectionCache();
    projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
        resolveGeneration: async () => input.generation,
        resolveRuntimeRegistry: async () => input.runtime,
        resolvePluginProjectionExecutionOriginContext: async () => ({
            serverIdentityId: 'srv_targeted_semantics',
            machineId: 'machine_targeted_semantics',
        }),
    });
    const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
    if (!handler) throw new Error('targeted_contributions_read_handler_missing');
    const response = DaemonPluginUiTargetedContributionsReadResponseSchema.parse(await handler({
        machineId: 'machine_targeted_semantics',
        pluginId: input.mountedTarget.pluginId,
    }));
    if (response.status !== 'current') throw new Error(`targeted_contributions_read_${response.code}`);
    expect(response.targetedContributions.target.occurrenceId).toBe(input.mountedTarget.occurrenceId);
    return response;
}

function bundledFixtureManifest(pluginId: string) {
    const ingestion = ingestCanonicalPluginManifest({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Cold bundled fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/plugin.mjs' },
        hostAccess: { required: [], optional: [] },
        contributes: {},
    }, { sourceProvenance: 'registryCustodied' });
    if (!ingestion.ok) throw new Error('targeted_contribution_fixture_manifest_invalid');
    return ingestion.manifest;
}

function defineExternalSemanticTarget(pluginId: string) {
    return definePlugin({
        id: pluginId,
        version: '1.0.0',
        displayName: 'External semantic target',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        hostAccess: { required: [], optional: [] },
        contributionPoints: {
            providers: defineContributionProtocol({
                id: 'provider',
                version: 1,
                descriptor: defineProtocolObject({
                    providerId: defineProtocolString(),
                }, { policy: 'additive-open/drop' }),
                operations: {
                    setup: {
                        required: true,
                        input: { kind: 'contributorDefined' },
                        resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                        action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                    },
                },
                surfaces: {
                    detail: {
                        required: true,
                        inputSchema: defineProtocolObject({
                            reviewId: defineProtocolString(),
                        }, { policy: 'closed' }),
                        presentation: 'content',
                    },
                },
            }).point(),
        },
    });
}

function defineBundledSemanticTarget(pluginId: string) {
    return definePlugin({
        id: pluginId,
        version: '1.0.0',
        displayName: 'Bundled semantic target',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        hostAccess: { required: [], optional: [] },
        contributionPoints: {
            providers: defineContributionProtocol({
                id: 'provider',
                version: 1,
                descriptor: defineProtocolObject({
                    providerId: defineProtocolString(),
                }, { policy: 'additive-open/drop' }),
                operations: {
                    setup: {
                        required: true,
                        input: { kind: 'contributorDefined' },
                        resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                        action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                    },
                },
                surfaces: {
                    detail: {
                        required: true,
                        inputSchema: defineProtocolObject({
                            reviewId: defineProtocolString(),
                        }, { policy: 'closed' }),
                        presentation: 'content',
                    },
                },
            }).point(),
        },
    });
}

function bundledLocator(input: Readonly<{
    pluginId: string;
    manifest: unknown;
    daemonEntryPath?: string | null;
}>): BundledPluginLocator {
    return {
        pluginId: input.pluginId,
        manifest: input.manifest,
        manifestPath: `bundled:${input.pluginId}`,
        daemonEntryPath: input.daemonEntryPath ?? null,
        sourceSpec: {
            kind: 'bundled',
            locator: '@happier-dev/plugin-targeted-fixture',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
    };
}

function externalSemanticTargetModuleSource(params: Readonly<{
    topLevelMarker: string;
    activationMarker: string;
}>): string {
    return [
        `globalThis[${JSON.stringify(params.topLevelMarker)}] = (globalThis[${JSON.stringify(params.topLevelMarker)}] ?? 0) + 1;`,
        'export function activate() {',
        `  globalThis[${JSON.stringify(params.activationMarker)}] = (globalThis[${JSON.stringify(params.activationMarker)}] ?? 0) + 1;`,
        '}',
        '',
    ].join('\n');
}

describe('executable targeted contribution admission', () => {
    it('does not publish a targeted snapshot before either plugin has an admitted occurrence', async () => {
        const contributes = createResolvedContributionRegistry({
            actions: [action()],
            pluginContributionPoints: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: targetPluginId,
                identity: createPluginContributionIdentity({ pluginId: targetPluginId, localId: pointId }),
                manifestPath: '/plugins/target/.happier-plugin/plugin.json',
                definition: point,
            }],
            targetedPluginContributions: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: contributorPluginId,
                identity: createPluginContributionIdentity({ pluginId: contributorPluginId, localId: contribution.id }),
                manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
                definition: contribution,
            }],
            activationTargets: [],
        });
        const generationAuthority = fixtureGenerationAuthority([
            currentGeneration(targetPluginId, 'target-immutable-a'),
            currentGeneration(contributorPluginId, 'contributor-immutable-a'),
        ]);

        const runtime = await resolveExecutablePluginRuntimeRegistry({
            contributes,
            generation: 23,
            generationAuthority,
        });
        try {
            expect(runtime.activatedPluginIds).toEqual(new Set());
            expect(runtime.readAdmittedTargetedContributions?.({
                targetPluginId,
                pointId,
                protocol,
            })).toBeNull();
        } finally {
            await runtime.dispose();
        }
    });

    it('projects an external target from its committed manifest without module execution', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-external-targeted-home-'));
        const targetRoot = await mkdtemp(join(tmpdir(), 'happier-external-targeted-target-'));
        const contributorRoot = await mkdtemp(join(tmpdir(), 'happier-external-targeted-contributor-'));
        const externalTargetPluginId = 'acme.external-semantic-target';
        const externalContributorPluginId = 'acme.external-semantic-contributor';
        const topLevelMarker = '__HAPPIER_EU26_EXTERNAL_TARGET_TOP_LEVEL_EXECUTIONS__';
        const activationMarker = '__HAPPIER_EU26_EXTERNAL_TARGET_ACTIVATIONS__';
        const globalValues = globalThis as typeof globalThis & Record<string, unknown>;
        const target = defineExternalSemanticTarget(externalTargetPluginId);
        globalValues[topLevelMarker] = 0;
        globalValues[activationMarker] = 0;

        await mkdir(join(targetRoot, '.happier-plugin'), { recursive: true });
        await writeFile(
            join(targetRoot, '.happier-plugin', 'plugin.json'),
            JSON.stringify(target.manifest),
            'utf8',
        );
        await writeFile(
            join(targetRoot, 'daemon.mjs'),
            externalSemanticTargetModuleSource({
                topLevelMarker,
                activationMarker,
            }),
            'utf8',
        );
        await mkdir(join(contributorRoot, '.happier-plugin'), { recursive: true });
        await writeFile(
            join(contributorRoot, '.happier-plugin', 'plugin.json'),
            JSON.stringify({
                schemaVersion: 2,
                id: externalContributorPluginId,
                version: '1.0.0',
                displayName: 'External semantic contributor',
                engines: { happier: '^0.2.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                hostAccess: { required: [], optional: [] },
                contributes: {
                    actions: [{
                        id: 'setup',
                        title: 'Setup',
                        scopes: ['global'],
                        surfaces: ['plugin'],
                        execution: { target: 'daemon' },
                        dangerLevel: 'safe',
                        resultSchema: { type: 'object' },
                    }],
                    ui: {
                        renderers: [{
                            id: 'provider-detail',
                            kind: 'declarative',
                            root: { kind: 'text', text: 'External provider detail' },
                        }],
                    },
                    targetedPluginContributions: [{
                        id: 'github',
                        target: {
                            pluginId: externalTargetPluginId,
                            pointId: 'providers',
                        },
                        protocol,
                        descriptor: {
                            providerId: 'github',
                            ignoredByTargetParser: true,
                        },
                        operations: { setup: 'setup' },
                        surfaces: { detail: { renderer: 'provider-detail' } },
                    }],
                },
            }),
            'utf8',
        );
        await writeFile(
            join(contributorRoot, 'daemon.mjs'),
            'export function activate() { throw new Error(\'contributor activation is not part of cold semantic projection\'); }\n',
            'utf8',
        );

        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot: targetRoot,
            pluginId: externalTargetPluginId,
            manifestVersion: '1.0.0',
        });
        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot: contributorRoot,
            pluginId: externalContributorPluginId,
            manifestVersion: '1.0.0',
        });

        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            const loaded = await loadInstalledPlugins({ happyHomeDir });
            const contributes = createResolvedContributionRegistry(
                projectLoadedPluginContributes({
                    loadResult: loaded,
                    provenance: 'external',
                    existingAgentIds: new Set(),
                }),
            );
            const generationAuthority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                {},
            );
            if (!generationAuthority) {
                throw new Error('Expected committed external semantic generation authority');
            }

            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                generation: 41,
                generationAuthority,
            });

            expect(runtime.activatedPluginIds).toEqual(new Set());
            expect(globalValues[topLevelMarker]).toBe(0);
            expect(globalValues[activationMarker]).toBe(0);
            const admitted = runtime.contributes.readAdmittedTargetedContributions?.({
                targetPluginId: externalTargetPluginId,
                pointId: 'providers',
                protocol,
            });
            const admittedContribution = admitted?.contributions[0];
            const admittedSurface = admittedContribution?.surfaces[0];
            const occurrenceId = runtime.contributes.occurrenceIdsByPluginId?.[
                externalTargetPluginId
            ];
            if (!admittedContribution || !admittedSurface || !occurrenceId) {
                throw new Error('Expected current external targeted semantic admission');
            }
            expect(admitted?.contributions).toEqual([expect.objectContaining({
                descriptor: { providerId: 'github' },
                operations: [expect.objectContaining({ role: 'setup' })],
                surfaces: [expect.objectContaining({ role: 'detail' })],
            })]);

            const response = await readMountedTargetedUiProjection({
                runtime,
                generation: 41,
                mountedTarget: {
                    pluginId: externalTargetPluginId,
                    occurrenceId,
                },
            });
            const projectedContribution = response.targetedContributions
                ?.points[0]?.protocols[0]?.contributions[0];
            const projectedSurface = projectedContribution?.surfaces[0];
            const projectedMount = response.targetedSurfaceMounts?.[0];

            // The RPC response consumed by the UI is a projection of the one
            // current semantic admission, not a second target decoder.
            expect(response.targetedContributions?.target).toEqual({
                pluginId: externalTargetPluginId,
                occurrenceId,
                sourceCustody: expect.objectContaining({ kind: expect.any(String) }),
            });
            expect(projectedContribution?.descriptor).toEqual(admittedContribution.descriptor);
            expect(projectedSurface).toEqual({
                point: { pointId: 'providers', protocol },
                // The projected identity also carries the contributor's
                // current source custody, which the wire identity requires.
                contributor: {
                    ...admittedSurface.contributor,
                    sourceCustody: expect.objectContaining({ kind: expect.any(String) }),
                },
                role: admittedSurface.role,
                presentation: admittedSurface.presentation,
            });
            expect(projectedMount).toMatchObject({
                target: response.targetedContributions?.target,
                point: projectedSurface?.point,
                contributor: projectedSurface?.contributor,
                role: projectedSurface?.role,
                presentation: projectedSurface?.presentation,
                inputSchema: admittedSurface.inputSchema,
            });
            // Public target handles intentionally omit the private role schema;
            // private mounts intentionally omit descriptor semantics. The UI
            // receives the already-admitted pair, not executable target refs.
            expect(projectedContribution?.descriptor).not.toHaveProperty('ignoredByTargetParser');
            expect(projectedSurface).not.toHaveProperty('inputSchema');
            expect(projectedMount).not.toHaveProperty('descriptor');
            expect(projectedMount).not.toHaveProperty('operations');
            expect(projectedMount).not.toHaveProperty('semanticPointRefs');
            expect(globalValues[topLevelMarker]).toBe(0);
            expect(globalValues[activationMarker]).toBe(0);
        } finally {
            await runtime?.dispose();
            delete globalValues[topLevelMarker];
            delete globalValues[activationMarker];
        }
    });

    it('does not admit an arbitrary bundled target without a canonical bundled slot', async () => {
        const bundledTargetPluginId = 'happier.bundled-semantic-target';
        const bundledContributorPluginId = 'happier.bundled-semantic-contributor';
        const target = defineBundledSemanticTarget(bundledTargetPluginId);
        const contributorManifest = {
            schemaVersion: 2,
            id: bundledContributorPluginId,
            version: '1.0.0',
            displayName: 'Bundled semantic contributor',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                actions: [{
                    id: 'setup',
                    title: 'Setup',
                    scopes: ['global'],
                    surfaces: ['plugin'],
                    execution: { target: 'daemon' },
                    dangerLevel: 'safe',
                    resultSchema: { type: 'object' },
                }],
                ui: {
                    renderers: [{
                        id: 'provider-detail',
                        kind: 'declarative',
                        root: { kind: 'text', text: 'Bundled provider detail' },
                    }],
                },
                targetedPluginContributions: [{
                    id: 'github',
                    target: {
                        pluginId: bundledTargetPluginId,
                        pointId: 'providers',
                    },
                    protocol,
                    descriptor: {
                        providerId: 'github',
                        ignoredByTargetParser: true,
                    },
                    operations: { setup: 'setup' },
                    surfaces: { detail: { renderer: 'provider-detail' } },
                }],
            },
        };
        const loadedPlugins = loadBundledPluginLocators([
            bundledLocator({
                pluginId: bundledTargetPluginId,
                manifest: target.manifest,
            }),
            bundledLocator({
                pluginId: bundledContributorPluginId,
                manifest: contributorManifest,
                daemonEntryPath: './daemon.mjs',
            }),
        ]);
        const loadResult: LoadInstalledPluginsResult = {
            loadedPlugins,
            diagnosticsByPluginId: {},
            materializationIdsByPluginId: {
                [bundledContributorPluginId]: 'bundled-contributor-materialization',
            },
        };
        const projected = projectLoadedPluginContributes({
            loadResult,
            provenance: 'first_party',
            existingAgentIds: new Set(),
        });
        const targetPoint = projected.pluginContributionPoints?.find(
            (candidate) => candidate.pluginId === bundledTargetPluginId,
        );
        expect(targetPoint).toBeDefined();
        expect(targetPoint).not.toHaveProperty('semanticPointRefs');

        const runtime = await resolveExecutablePluginRuntimeRegistry({
            contributes: createResolvedContributionRegistry(projected),
            generation: 42,
            generationAuthority: fixtureGenerationAuthority([
                currentGeneration(bundledTargetPluginId, 'bundled-target-generation'),
                currentGeneration(bundledContributorPluginId, 'bundled-contributor-generation'),
            ]),
        });
        try {
            expect(runtime.activatedPluginIds).toEqual(new Set());
            expect(runtime.contributes.readAdmittedTargetedContributions?.({
                targetPluginId: bundledTargetPluginId,
                pointId: 'providers',
                protocol,
            })).toBeNull();
            expect(runtime.contributes.occurrenceIdsByPluginId?.[
                bundledTargetPluginId
            ]).toBeUndefined();
        } finally {
            await runtime.dispose();
        }
    });

    it('publishes admitted bundled source custody without a managed generation', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { generationAuthority: fixtureGenerationAuthority([]) },
        });
        const pluginId = 'happier.scm.forge.github';
        try {
            const runtime = fixture.registry;
            const occurrenceId = runtime.readPluginOccurrenceId?.(pluginId);
            const sourceCustody = runtime.readPluginSourceCustody?.(pluginId);
            expect(occurrenceId).toBeTruthy();
            expect(sourceCustody).toMatchObject({ kind: 'development' });
            expect(runtime.activatedPluginIds.has(pluginId)).toBe(true);
            expect(runtime.pluginFinalPolicyCurrentRuntimesById?.get(pluginId)).toEqual(
                expect.objectContaining({ occurrenceId, sourceCustody, applied: true }),
            );
            const projection = buildPluginProjectionV2({
                registry: runtime.contributes,
                generation: fixture.controller.getState().generation,
                pluginFinalPolicyCurrentRuntimesById: runtime.pluginFinalPolicyCurrentRuntimesById,
            });
            expect(projection.installedPackagesById[pluginId]).toMatchObject({
                occurrenceId,
                sourceCustody,
            });
        } finally {
            await fixture.dispose();
        }
    });

    it('does not synthesize final-policy runtime authority from a legacy bundled generation alone', async () => {
        const bundledPluginId = 'examples.cold-bundled';
        const runtime = await resolveExecutablePluginRuntimeRegistry({
            contributes: createResolvedContributionRegistry({
                activationTargets: [{
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: bundledPluginId,
                    manifestPath: '@examples/cold-bundled',
                    daemonEntryPath: null,
                    sourceSpec: {
                        kind: 'bundled',
                        locator: '@examples/cold-bundled',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    activationEvents: [],
                    manifest: bundledFixtureManifest(bundledPluginId),
                }],
            }),
            generation: 24,
            generationAuthority: fixtureGenerationAuthority([
                currentGeneration(bundledPluginId, 'bundled-immutable-a'),
            ]),
        });
        try {
            expect(runtime.pluginFinalPolicyCurrentRuntimesById?.get(bundledPluginId))
                .toBeUndefined();
        } finally {
            await runtime.dispose();
        }
    });
});
