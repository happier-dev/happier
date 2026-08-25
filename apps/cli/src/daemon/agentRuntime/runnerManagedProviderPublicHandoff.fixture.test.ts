import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import type {
    ManagedProviderRuntime,
    ManagedProviderRuntimeContext } from '@happier-dev/plugin-sdk/providers';
import type {
    ManagedServiceHandle,
    ManagedServiceSnapshot,
    ManagedServiceSpec,
    ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';

import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import {
    commitPackedPublicHandoffFixture,
    createPublicHandoffArchiveChangeService,
    packPublicHandoffFixture,
    PUBLIC_HANDOFF_AGENT_ID,
    PUBLIC_HANDOFF_AGENT_PLUGIN_ID,
    PUBLIC_HANDOFF_PROVIDER_ENDPOINT_ID,
    PUBLIC_HANDOFF_PROVIDER_ID,
    PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID,
    PUBLIC_HANDOFF_PROVIDER_SERVICE_ID,
    writePublicHandoffAgentPluginFixture,
    writePublicHandoffProviderPluginFixture,
} from './runnerManagedProviderPublicHandoff.fixture';

describe('external Agent and managed Provider archive generations', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('writes external author fixtures against the declared public Plugin SDK root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-public-handoff-authoring-'));
        roots.push(root);
        const agentRoot = join(root, 'agent');
        const providerRoot = join(root, 'provider');

        await Promise.all([
            writePublicHandoffAgentPluginFixture({
                pluginRoot: agentRoot,
                version: '1.0.0',
                generation: 'G',
            }),
            writePublicHandoffProviderPluginFixture({
                pluginRoot: providerRoot,
                version: '1.0.0',
                generation: 'P',
            }),
        ]);

        for (const source of await Promise.all([
            readFile(join(agentRoot, 'index.ts'), 'utf8'),
            readFile(join(providerRoot, 'index.ts'), 'utf8'),
        ])) {
            expect(source).toContain("from '@happier-dev/plugin-sdk';");
            expect(source).not.toContain('@happier-dev/plugin-sdk/definePlugin.js');
        }
    });

    it('packs and commits separate G/P then H/Q definePlugin packages through the immutable store', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-public-handoff-archives-'));
        roots.push(root);
        const happyHomeDir = join(root, 'happy-home');
        const agentRoot = join(root, 'agent');
        const providerRoot = join(root, 'provider');
        const agentHRoot = join(root, 'agent-h');
        const providerQRoot = join(root, 'provider-q');
        await mkdir(happyHomeDir);
        const service = createPublicHandoffArchiveChangeService(happyHomeDir);

        await writePublicHandoffAgentPluginFixture({
            pluginRoot: agentRoot,
            version: '1.0.0',
            generation: 'G',
        });
        await writePublicHandoffProviderPluginFixture({
            pluginRoot: providerRoot,
            version: '1.0.0',
            generation: 'P',
        });
        const [agentGArchive, providerPArchive] = await Promise.all([
            packPublicHandoffFixture({
                archivePath: join(root, 'agent-g.tgz'),
                pluginId: PUBLIC_HANDOFF_AGENT_PLUGIN_ID,
                pluginRoot: agentRoot,
            }),
            packPublicHandoffFixture({
                archivePath: join(root, 'provider-p.tgz'),
                pluginId: PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID,
                pluginRoot: providerRoot,
            }),
        ]);
        const agentGPacked = await commitPackedPublicHandoffFixture({ changeService: service, packed: agentGArchive });
        const providerPPacked = await commitPackedPublicHandoffFixture({ changeService: service, packed: providerPArchive });

        const initial = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir }),
            { bundledArtifacts: [] },
        );
        const agentG = initial?.generations.get(PUBLIC_HANDOFF_AGENT_PLUGIN_ID);
        const providerP = initial?.generations.get(PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID);
        if (!agentG?.installation || !providerP?.installation) {
            throw new Error('Expected current archive installations for G and P');
        }
        expect(agentG.rootPath).not.toBe(providerP.rootPath);
        expect(agentG.immutableGenerationId).not.toBe(
            providerP.immutableGenerationId,
        );
        expect(agentGPacked).toMatchObject({
            pluginId: PUBLIC_HANDOFF_AGENT_PLUGIN_ID,
            version: '1.0.0',
            archiveDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            archiveIntegrity: expect.stringMatching(/^sha256-[A-Za-z0-9+/]+={0,2}$/u),
            immutableGenerationId: agentG.immutableGenerationId,
        });
        expect(providerPPacked).toMatchObject({
            pluginId: PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID,
            version: '1.0.0',
            archiveDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            archiveIntegrity: expect.stringMatching(/^sha256-[A-Za-z0-9+/]+={0,2}$/u),
            immutableGenerationId: providerP.immutableGenerationId,
        });

        await writePublicHandoffAgentPluginFixture({
            pluginRoot: agentHRoot,
            version: '2.0.0',
            generation: 'H',
        });
        await writePublicHandoffProviderPluginFixture({
            pluginRoot: providerQRoot,
            version: '2.0.0',
            generation: 'Q',
        });
        const [agentHArchive, providerQArchive] = await Promise.all([
            packPublicHandoffFixture({
                archivePath: join(root, 'agent-h.tgz'),
                pluginId: PUBLIC_HANDOFF_AGENT_PLUGIN_ID,
                pluginRoot: agentHRoot,
            }),
            packPublicHandoffFixture({
                archivePath: join(root, 'provider-q.tgz'),
                pluginId: PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID,
                pluginRoot: providerQRoot,
            }),
        ]);
        const agentHPacked = await commitPackedPublicHandoffFixture({ changeService: service, packed: agentHArchive });
        const providerQPacked = await commitPackedPublicHandoffFixture({ changeService: service, packed: providerQArchive });

        const current = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir }),
            { bundledArtifacts: [] },
        );
        const agentH = current?.generations.get(PUBLIC_HANDOFF_AGENT_PLUGIN_ID);
        const providerQ = current?.generations.get(PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID);
        if (!agentH?.installation || !providerQ?.installation) {
            throw new Error('Expected current archive installations for H and Q');
        }
        expect(agentH?.immutableGenerationId).not.toBe(
            agentG.immutableGenerationId,
        );
        expect(providerQ?.immutableGenerationId).not.toBe(
            providerP.immutableGenerationId,
        );
        expect(JSON.parse(await readFile(join(
            agentH!.rootPath,
            '.happier-plugin',
            'plugin.json',
        ), 'utf8'))).toMatchObject({
            id: PUBLIC_HANDOFF_AGENT_PLUGIN_ID,
            version: '2.0.0',
            contributes: {
                agents: [expect.objectContaining({
                    id: PUBLIC_HANDOFF_AGENT_ID,
                })],
            },
        });
        const providerQManifest = JSON.parse(await readFile(join(
            providerQ!.rootPath,
            '.happier-plugin',
            'plugin.json',
        ), 'utf8'));
        expect(providerQManifest).toMatchObject({
            id: PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID,
            version: '2.0.0',
        });
        expect(providerQManifest.contributes.providers).toHaveLength(1);
        expect(providerQManifest.contributes.providers[0]).toMatchObject({
            id: PUBLIC_HANDOFF_PROVIDER_ID,
            managedRuntime: { kind: 'managed' },
        });

        expect(agentH.installation.source.distribution)
            .toMatchObject({ kind: 'archive' });
        expect(providerQ.installation.source.distribution)
            .toMatchObject({ kind: 'archive' });
        expect(agentHPacked).toMatchObject({
            pluginId: PUBLIC_HANDOFF_AGENT_PLUGIN_ID,
            version: '2.0.0',
            immutableGenerationId: agentH.immutableGenerationId,
        });
        expect(providerQPacked).toMatchObject({
            pluginId: PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID,
            version: '2.0.0',
            immutableGenerationId: providerQ.immutableGenerationId,
        });
        for (const packed of [agentGPacked, providerPPacked, agentHPacked, providerQPacked]) {
            expect(packed).not.toHaveProperty('manifestDigest');
        }
        expect(agentG.installation.source.distribution).toMatchObject({
            kind: 'archive',
            integrity: agentGPacked.archiveIntegrity,
        });
        expect(providerP.installation.source.distribution).toMatchObject({
            kind: 'archive',
            integrity: providerPPacked.archiveIntegrity,
        });
        expect(agentH.installation.source.distribution).toMatchObject({
            kind: 'archive',
            integrity: agentHPacked.archiveIntegrity,
        });
        expect(providerQ.installation.source.distribution).toMatchObject({
            kind: 'archive',
            integrity: providerQPacked.archiveIntegrity,
        });
        for (const [generation, pluginId] of [
            [agentG, PUBLIC_HANDOFF_AGENT_PLUGIN_ID],
            [providerP, PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID],
            [agentH, PUBLIC_HANDOFF_AGENT_PLUGIN_ID],
            [providerQ, PUBLIC_HANDOFF_PROVIDER_PLUGIN_ID],
        ] as const) {
            expect(generation.record).toMatchObject({
                t: 'happier_plugin_generation_v1',
                schemaVersion: 1,
                pluginId,
                immutableGenerationId: generation.immutableGenerationId,
                manifestRelativePath: '.happier-plugin/plugin.json',
            });
        }

        expect(agentH.record.files.map((file) => file.relativePath))
            .toContain('dist/agentRuntime.js');
        expect(providerQ.record.files.map((file) => file.relativePath))
            .not.toContain('dist/agentRuntime.js');

        const agentActivation = await import(pathToFileURL(join(
            agentH.rootPath,
            'dist',
            'index.js',
        )).href) as Readonly<{
            activate(api: Readonly<{
                agents: Readonly<{
                    register(
                        localId: string,
                        factory: unknown,
                        options?: Readonly<{
                            sessionRunnerFactory?: Readonly<{
                                module: string;
                                export: string;
                                runtimeApiVersion: number;
                            }>;
                        }>,
                    ): void;
                }>;
            }>): void | Promise<void>;
        }>;
        const agentRunner = await import(pathToFileURL(join(
            agentH.rootPath,
            'dist',
            'agentRuntime.js',
        )).href) as Readonly<{
            publicHandoffAgentRuntimeFactory: unknown;
        }>;
        let registeredAgentLocalId: string | undefined;
        let registeredAgentFactory: unknown;
        let registeredRunnerLocator: Readonly<{
            module: string;
            export: string;
            runtimeApiVersion: number;
        }> | undefined;
        await agentActivation.activate({
            agents: {
                register(localId, factory, options) {
                    registeredAgentLocalId = localId;
                    registeredAgentFactory = factory;
                    registeredRunnerLocator = options?.sessionRunnerFactory;
                },
            },
        });
        expect(registeredAgentLocalId).toBe(PUBLIC_HANDOFF_AGENT_ID);
        expect(registeredAgentFactory).toBe(
            agentRunner.publicHandoffAgentRuntimeFactory,
        );
        expect(registeredRunnerLocator).toEqual({
            module: './agentRuntime.js',
            export: 'publicHandoffAgentRuntimeFactory',
            runtimeApiVersion: 1,
        });

        const providerActivation = await import(pathToFileURL(join(
            providerQ.rootPath,
            'dist',
            'index.js',
        )).href) as Readonly<{
            activate(api: Readonly<{
                providers: Readonly<{
                    register(localId: string, runtime: ManagedProviderRuntime): void;
                }>;
            }>): void | Promise<void>;
        }>;
        let registeredProviderLocalId: string | undefined;
        let registeredProviderRuntime: ManagedProviderRuntime | undefined;
        await providerActivation.activate({
            providers: {
                register(localId, runtime) {
                    registeredProviderLocalId = localId;
                    registeredProviderRuntime = runtime;
                },
            },
        });
        if (!registeredProviderRuntime) {
            throw new Error('Expected Q managed Provider runtime registration');
        }
        expect(registeredProviderLocalId).toBe(PUBLIC_HANDOFF_PROVIDER_ID);
        let supervisedSpec: ManagedServiceSpec | undefined;
        const healthySnapshot: ManagedServiceSnapshot = Object.freeze({
            id: PUBLIC_HANDOFF_PROVIDER_SERVICE_ID,
            state: 'healthy',
            mode: 'spawn',
            baseUrl: 'http://127.0.0.1:43210',
            startedAtMs: 1,
            lastHealthyAtMs: 1,
            diagnostics: [],
            diagnosticsTruncated: false,
        });
        const handle: ManagedServiceHandle = Object.freeze({
            snapshot: () => healthySnapshot,
            observe: () => Object.freeze({ dispose() {} }),
            waitUntilHealthy: async () => healthySnapshot,
            async request() {
                throw new Error('Unexpected managed service request');
            },
            stop: async () => Object.freeze({ status: 'stopped' as const }),
            dispose: async () => undefined,
        });
        const managedServices: ManagedServices = Object.freeze({
            dependencies: {} as ManagedServices['dependencies'],
            supervise: async (spec: ManagedServiceSpec) => {
                supervisedSpec = spec;
                return handle;
            },
        });
        const providerResult = await registeredProviderRuntime.start({
            reason: 'explicitStartLocal',
            endpointTemplateIds: [PUBLIC_HANDOFF_PROVIDER_ENDPOINT_ID],
        }, {
            connectedAccounts: {} as ManagedProviderRuntimeContext['connectedAccounts'],
            managedServices,
            signal: new AbortController().signal,
        });
        expect(supervisedSpec).toMatchObject({
            mode: {
                kind: 'spawn',
                launch: {
                    env: {
                        FIXTURE_PROVIDER_GENERATION: 'Q',
                    },
                },
            },
        });
        expect(providerResult.endpoints).toEqual([{
            endpointTemplateId: PUBLIC_HANDOFF_PROVIDER_ENDPOINT_ID,
            endpoint: { kind: 'servicePath', path: '/v1' },
        }]);
    }, 120_000);
});
