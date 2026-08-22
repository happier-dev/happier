import { describe, expect, it, vi } from 'vitest';
import type {
    AgentExternalSessionHooksContribution,
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import type { ActivationTarget } from './targets';
import { activateContributionModule } from './activateContributionModule';
import {
    createDeclarativeAcpAgentRuntimeRegistry,
    createTargetAgentRuntimeRegistry,
} from '../contributions/targetAgents';

const PLUGIN_ID = 'acme.external-session-hooks';
const AGENT_ID = 'assistant';

const agentRuntimeFactory: AgentRuntimeFactory = async () => ({
    sessions: {
        open: async () => ({
            send: async () => ({ status: 'admitted' }),
            watch: () => ({ dispose() {} }),
            dispose() {},
        }),
    },
});

const externalSessions: AgentExternalSessionsContribution = {
    resolveSource: async ({ source }) => ({ ok: true, value: { source } }),
    listCandidates: async () => ({
        ok: true,
        value: { candidates: [], nextCursor: null },
    }),
    resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        ok: true,
        value: { source, remoteSessionId, linkData: {} },
    }),
    resolveLinkedIdentity: async ({ source, remoteSessionId, linkData }) => ({
        ok: true,
        value: { source, remoteSessionId, linkData },
    }),
    pageTranscript: async () => ({
        ok: true,
        value: { items: [], nextCursor: null },
    }),
    readAfterTranscript: async () => ({
        ok: true,
        value: { outcome: 'already_current' },
    }),
};

function createHooks(): AgentExternalSessionHooksContribution {
    return {
        installationVariants: [{
            variantId: 'fixture-v1',
            targets: [{
                targetId: 'settings',
                format: 'hook_event_json_arrays_v1',
                collectionId: 'hooks',
            }],
            events: [{
                eventId: 'session-start',
                targetId: 'settings',
                nativeEventName: 'SessionStart',
                command: {
                    kind: 'happier_observation_v1',
                    shellDialect: 'posix',
                },
            }],
        }],
        resolveInstallation: async () => ({
            ok: true,
            value: {
                kind: 'supported',
                variantId: 'fixture-v1',
                targets: [{
                    targetId: 'settings',
                    absolutePath: '/var/lib/acme/settings.json',
                }],
                readiness: { kind: 'ready' },
            },
        }),
        mapHookEvent: async () => ({
            ok: true,
            value: { kind: 'ignored' },
        }),
    };
}

const observation: AgentExternalSessionObservationContribution = {
    describeResource: () => ({
        resourceKey: 'fixture-resource',
        linkKey: 'fixture-link',
        changeObservation: 'reconcile_only',
    }),
    observeResource: async () => ({ dispose() {} }),
    reconcileResource: async ({ purpose, links }) => (
        purpose === 'resource_descriptors'
            ? {
                purpose,
                outcomes: links.map(({ linkKey }) => ({
                    kind: 'unavailable' as const,
                    linkKey,
                })),
            }
            : {
                purpose,
                outcomes: links.map(({ linkKey }) => ({
                    linkKey,
                    facts: [],
                })),
            }
    ),
};

function externalSessionManifest(
    runtimeKind: 'custom' | 'acp' = 'custom',
    options: Readonly<{ includeExternalSessions?: boolean }> = {},
) {
    const includeExternalSessions = options.includeExternalSessions !== false;
    const result = ingestCanonicalPluginManifest({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'External Session Hooks',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.js' },
        contributes: {
            agents: [{
                id: AGENT_ID,
                title: 'Assistant',
                runtime: runtimeKind === 'custom'
                    ? { kind: 'custom' }
                    : {
                        kind: 'acp',
                        transport: {
                            kind: 'tcp',
                            host: '127.0.0.1',
                            port: 4242,
                        },
                },
                primary: 'sessions',
                capabilities: {
                    ...(includeExternalSessions
                        ? { surfaces: ['externalSessions'] }
                        : {}),
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
                ...(includeExternalSessions
                    ? {
                        surfaces: {
                            externalSession: {
                                externalLinkedTakeover: {
                                    writerSafety: 'unsupported',
                                },
                                sources: [{
                                    sourceKind: 'fixture',
                                    schema: {
                                        fields: [{
                                            name: 'kind',
                                            kind: 'literal',
                                            value: 'fixture',
                                        }],
                                    },
                                    key: {
                                        segments: [{
                                            kind: 'literal',
                                            value: 'fixture',
                                        }],
                                    },
                                    instances: [{
                                        kind: 'default',
                                        constants: {},
                                    }],
                                }],
                            },
                        },
                    }
                    : {}),
            }],
        },
    });
    if (!result.ok) {
        throw new Error(result.diagnostics.map(({ message }) => message).join('\n'));
    }
    return result.manifest;
}

function target(manifest: ReturnType<typeof externalSessionManifest>): ActivationTarget {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: PLUGIN_ID,
        manifestPath: `/plugins/${PLUGIN_ID}/plugin.json`,
        daemonEntryPath: `/plugins/${PLUGIN_ID}/daemon.js`,
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${PLUGIN_ID}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest,
    } as unknown as ActivationTarget;
}

type AgentRegistrationName =
    | 'runtime'
    | 'externalSessions'
    | 'hooks'
    | 'observation';

const REGISTRATION_NAMES: readonly AgentRegistrationName[] = [
    'runtime',
    'externalSessions',
    'hooks',
    'observation',
];

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
    if (values.length <= 1) return [values];
    return values.flatMap((value, index) =>
        permutations(values.filter((_, candidateIndex) => candidateIndex !== index))
            .map((tail) => [value, ...tail]));
}

function register(
    api: PluginApi,
    name: AgentRegistrationName,
    hooks: AgentExternalSessionHooksContribution,
): void {
    if (name === 'runtime') {
        api.agents.register(AGENT_ID, agentRuntimeFactory, {
            sessionRunnerFactory: {
                module: './agent-runtime.js',
                export: 'agentRuntimeFactory',
                runtimeApiVersion: 1,
                externalSessionsExport: 'externalSessions',
            },
        });
    } else if (name === 'externalSessions') {
        api.agents.registerExternalSessions(AGENT_ID, externalSessions);
    } else if (name === 'hooks') {
        api.agents.registerExternalSessionHooks(AGENT_ID, hooks);
    } else {
        api.agents.registerExternalSessionObservation(AGENT_ID, observation);
    }
}

describe('real-loader External Session hook aggregate conformance', () => {
    it('activates and preserves declarative ACP auxiliary facets without a primary factory or runner locator', async () => {
        const manifest = externalSessionManifest('acp');
        const hooks = createHooks();
        const resolveRelativeModule = vi.fn();
        const result = await activateContributionModule({
            pluginId: PLUGIN_ID,
            generation: 'generation-7',
            manifest,
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.agents.registerExternalSessions(
                        AGENT_ID,
                        externalSessions,
                    );
                    api.agents.registerExternalSessionHooks(AGENT_ID, hooks);
                    api.agents.registerExternalSessionObservation(
                        AGENT_ID,
                        observation,
                    );
                },
            },
            isGenerationCurrent: () => true,
            resolveRelativeModule,
        });

        expect(result.status).toBe('active');
        expect(result.validatedAgentSessionRunnerFactories).toEqual([]);
        expect(resolveRelativeModule).not.toHaveBeenCalled();
        expect(result.registrations).toEqual([
            expect.objectContaining({
                family: 'agents',
                localId: AGENT_ID,
                value: expect.objectContaining({
                    externalSessions: expect.any(Object),
                    externalSessionHooks: expect.any(Object),
                    externalSessionObservation: expect.any(Object),
                }),
            }),
        ]);
        expect(result.registrations[0]?.value).not.toHaveProperty('factory');
        expect(result.registrations[0]?.value).not.toHaveProperty(
            'sessionRunnerFactory',
        );

        const retirement = new AbortController();
        const immutableGenerationIdsByPluginId = new Map([
            [PLUGIN_ID, 'immutable-generation-7'],
        ]);
        const agents = [{
            id: AGENT_ID,
            identity: { pluginId: PLUGIN_ID, localId: AGENT_ID },
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            definition: {
                kindVersion: 1 as const,
                id: AGENT_ID,
                ownedBackendIds: [],
            },
            richDefinition: {
                provenance: 'external' as const,
                definition: manifest.contributes.agents![0]!,
            },
            pluginId: PLUGIN_ID,
            sourceSpec: {
                kind: 'path' as const,
                locator: `/plugins/${PLUGIN_ID}`,
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
                resolvedVersion: '1.0.0',
            },
        }];
        const registered = createTargetAgentRuntimeRegistry({
            agents,
            activationTargets: [target(manifest)],
            targetRegistrations: result.registrations.map((registration) => ({
                pluginId: PLUGIN_ID,
                generation: 'generation-7',
                registration,
            })),
            immutableGenerationIdsByPluginId,
            isGenerationActive: () => true,
            retirementSignal: retirement.signal,
            onDuplicate: vi.fn(),
        });
        const registry = createDeclarativeAcpAgentRuntimeRegistry({
            agents,
            registered,
            generation: 'generation-7',
            immutableGenerationIdsByPluginId,
            isGenerationActive: () => true,
            retirementSignal: retirement.signal,
        });
        const lease = registry.get(AGENT_ID);
        if (!lease?.hasPrimaryRuntime) {
            throw new Error('Expected a primary Agent runtime lease');
        }
        expect(lease.sessionRunnerFactoryBinding).toEqual({
            kind: 'host_declarative_acp_v1',
            v: 1,
            pluginId: PLUGIN_ID,
            pluginVersion: '1.0.0',
            agentId: AGENT_ID,
            qualifiedAgentId: `${PLUGIN_ID}/agents/${AGENT_ID}`,
            localAgentId: AGENT_ID,
            immutableGenerationId: 'immutable-generation-7',
        });
        expect(lease).not.toHaveProperty('issueRunnerExecutionGrant');
        expect(lease).not.toHaveProperty('manifestDigest');
        expect(lease?.externalSessions).toBe(
            registered.get(AGENT_ID)?.externalSessions,
        );
        expect(lease?.externalSessionHooks).toBe(
            registered.get(AGENT_ID)?.externalSessionHooks,
        );
        expect(lease?.externalSessionObservation).toBe(
            registered.get(AGENT_ID)?.externalSessionObservation,
        );
        await result.dispose();
    });

    it('rejects a competing primary factory for a declarative ACP auxiliary registration', async () => {
        const result = await activateContributionModule({
            pluginId: PLUGIN_ID,
            generation: 'generation-7',
            manifest: externalSessionManifest('acp'),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.agents.register(AGENT_ID, agentRuntimeFactory);
                    api.agents.registerExternalSessions(
                        AGENT_ID,
                        externalSessions,
                    );
                },
            },
            isGenerationCurrent: () => true,
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(result.validatedAgentSessionRunnerFactories).toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(/competing primary Agent runtime factory/iu),
            }),
        ]);
    });

    it.each(permutations(REGISTRATION_NAMES).map((order) => [
        order.join(' → '),
        order,
    ] as const))(
        'publishes the same immutable generation lease for legal order %s',
        async (_label, order) => {
            const manifest = externalSessionManifest();
            const mutableHooks = createHooks();
            const result = await activateContributionModule({
                pluginId: PLUGIN_ID,
                generation: 'generation-7',
                manifest,
                moduleNamespace: {
                    activate(api: PluginApi) {
                        for (const name of order) register(api, name, mutableHooks);
                    },
                },
                isGenerationCurrent: () => true,
                resolveRelativeModule: async (module) => {
                    expect(module).toBe('./agent-runtime.js');
                    return {
                        module: { agentRuntimeFactory, externalSessions },
                        normalizedModulePath: 'agent-runtime.js',
                        loadMode: 'immutable-js',
                    };
                },
            });

            expect(result.status).toBe('active');
            expect(result.registrations).toHaveLength(1);
            expect(result.registrations[0]).toMatchObject({
                family: 'agents',
                localId: AGENT_ID,
                value: {
                    factory: agentRuntimeFactory,
                    externalSessions: expect.any(Object),
                    externalSessionHooks: expect.any(Object),
                    externalSessionObservation: expect.any(Object),
                },
            });

            const mutableCommand =
                mutableHooks.installationVariants[0]!.events[0]!.command as {
                    timeoutMs?: number;
                };
            mutableCommand.timeoutMs = 99;
            const retirement = new AbortController();
            const registry = createTargetAgentRuntimeRegistry({
                agents: [{
                    id: AGENT_ID,
                    identity: { pluginId: PLUGIN_ID, localId: AGENT_ID },
                    pluginId: PLUGIN_ID,
                }],
                activationTargets: [target(manifest)],
                targetRegistrations: result.registrations.map((registration) => ({
                    pluginId: PLUGIN_ID,
                    generation: 'generation-7',
                    registration,
                })),
                isGenerationActive: () => !retirement.signal.aborted,
                retirementSignal: retirement.signal,
                onDuplicate: vi.fn(),
            });
            const lease = registry.get(AGENT_ID);
            expect(lease).toMatchObject({
                pluginId: PLUGIN_ID,
                agentId: AGENT_ID,
                generation: 'generation-7',
                hasPrimaryRuntime: true,
            });
            expect(Object.keys(lease?.externalSessionHooks ?? {})).toEqual([
                'installationVariants',
                'resolveInstallation',
                'mapHookEvent',
            ]);
            expect(
                lease?.externalSessionHooks
                    ?.installationVariants[0]?.events[0]?.command.timeoutMs,
            ).toBeUndefined();
            expect(Object.isFrozen(
                lease?.externalSessionHooks?.installationVariants,
            )).toBe(true);
            expect(Object.isFrozen(
                lease?.externalSessionHooks?.installationVariants[0]?.events[0]
                    ?.command,
            )).toBe(true);

            await result.dispose();
        },
    );

    it('attests the exact same-module External Sessions companion registered for the Agent', async () => {
        const locator = {
            module: './agent-runtime.js',
            export: 'agentRuntimeFactory',
            runtimeApiVersion: 1 as const,
            externalSessionsExport: 'externalSessions',
        };
        const resolveRelativeModule = vi.fn(async () => ({
            module: { agentRuntimeFactory, externalSessions },
            normalizedModulePath: 'agent-runtime.js',
            loadMode: 'immutable-js' as const,
        }));
        const persistValidatedAgentSessionRunnerFactories = vi.fn();

        const result = await activateContributionModule({
            pluginId: PLUGIN_ID,
            generation: 'generation-companion',
            manifest: externalSessionManifest(),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.agents.register(AGENT_ID, agentRuntimeFactory, {
                        sessionRunnerFactory: locator,
                    });
                    api.agents.registerExternalSessions(
                        AGENT_ID,
                        externalSessions,
                    );
                },
            },
            isGenerationCurrent: () => true,
            resolveRelativeModule,
            persistValidatedAgentSessionRunnerFactories,
        });

        expect(result.status, JSON.stringify(result.diagnostics)).toBe('active');
        expect(resolveRelativeModule).toHaveBeenCalledTimes(1);
        expect(result.validatedAgentSessionRunnerFactories).toEqual([{
            localAgentId: AGENT_ID,
            locator,
            normalizedModulePath: 'agent-runtime.js',
            loadMode: 'immutable-js',
        }]);
        expect(persistValidatedAgentSessionRunnerFactories).toHaveBeenCalledWith(
            result.validatedAgentSessionRunnerFactories,
        );
    });

    it('rejects a registered External Sessions companion whose runner locator omits its named export', async () => {
        const persistValidatedAgentSessionRunnerFactories = vi.fn();
        const result = await activateContributionModule({
            pluginId: PLUGIN_ID,
            generation: 'generation-companion-omitted-locator-export',
            manifest: externalSessionManifest(),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.agents.register(AGENT_ID, agentRuntimeFactory, {
                        sessionRunnerFactory: {
                            module: './agent-runtime.js',
                            export: 'agentRuntimeFactory',
                            runtimeApiVersion: 1,
                        },
                    });
                    api.agents.registerExternalSessions(
                        AGENT_ID,
                        externalSessions,
                    );
                },
            },
            isGenerationCurrent: () => true,
            resolveRelativeModule: async () => ({
                module: { agentRuntimeFactory, externalSessions },
                normalizedModulePath: 'agent-runtime.js',
                loadMode: 'immutable-js',
            }),
            persistValidatedAgentSessionRunnerFactories,
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(result.validatedAgentSessionRunnerFactories).toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(
                    /External Sessions.*externalSessionsExport/iu,
                ),
            }),
        ]);
        expect(persistValidatedAgentSessionRunnerFactories)
            .not.toHaveBeenCalled();
    });

    it('rejects a named companion locator when neither the Agent nor its runner leaf supplies it', async () => {
        const persistValidatedAgentSessionRunnerFactories = vi.fn();
        const result = await activateContributionModule({
            pluginId: PLUGIN_ID,
            generation: 'generation-companion-undefined-on-both-sides',
            manifest: externalSessionManifest('custom', {
                includeExternalSessions: false,
            }),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.agents.register(AGENT_ID, agentRuntimeFactory, {
                        sessionRunnerFactory: {
                            module: './agent-runtime.js',
                            export: 'agentRuntimeFactory',
                            runtimeApiVersion: 1,
                            externalSessionsExport: 'externalSessions',
                        },
                    });
                },
            },
            isGenerationCurrent: () => true,
            resolveRelativeModule: async () => ({
                module: { agentRuntimeFactory },
                normalizedModulePath: 'agent-runtime.js',
                loadMode: 'immutable-js',
            }),
            persistValidatedAgentSessionRunnerFactories,
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(result.validatedAgentSessionRunnerFactories).toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(/External Sessions.*does not match/iu),
            }),
        ]);
        expect(persistValidatedAgentSessionRunnerFactories)
            .not.toHaveBeenCalled();
    });

    it.each([
        ['missing', undefined],
        ['different object with the same callbacks', { ...externalSessions }],
        ['different', {
            ...externalSessions,
            resolveSource: async ({ source }: Parameters<
                AgentExternalSessionsContribution['resolveSource']
            >[0]) => ({ ok: true as const, value: { source } }),
        }],
    ] as const)(
        'rejects a %s same-module External Sessions companion export before persistence',
        async (_label, selectedCompanion) => {
            const persistValidatedAgentSessionRunnerFactories = vi.fn();
            const result = await activateContributionModule({
                pluginId: PLUGIN_ID,
                generation: 'generation-companion-mismatch',
                manifest: externalSessionManifest(),
                moduleNamespace: {
                    activate(api: PluginApi) {
                        api.agents.register(AGENT_ID, agentRuntimeFactory, {
                            sessionRunnerFactory: {
                                module: './agent-runtime.js',
                                export: 'agentRuntimeFactory',
                                runtimeApiVersion: 1,
                                externalSessionsExport: 'externalSessions',
                            },
                        });
                        api.agents.registerExternalSessions(
                            AGENT_ID,
                            externalSessions,
                        );
                    },
                },
                isGenerationCurrent: () => true,
                resolveRelativeModule: async () => ({
                    module: {
                        agentRuntimeFactory,
                        ...(selectedCompanion === undefined
                            ? {}
                            : { externalSessions: selectedCompanion }),
                    },
                    normalizedModulePath: 'agent-runtime.js',
                    loadMode: 'immutable-js',
                }),
                persistValidatedAgentSessionRunnerFactories,
            });

            expect(result.status).toBe('unavailable');
            expect(result.registrations).toEqual([]);
            expect(result.validatedAgentSessionRunnerFactories).toEqual([]);
            expect(result.diagnostics).toEqual([
                expect.objectContaining({
                    code: 'plugin_activation_failed',
                    message: expect.stringMatching(/External Sessions.*does not match/iu),
                }),
            ]);
            expect(persistValidatedAgentSessionRunnerFactories)
                .not.toHaveBeenCalled();
        },
    );

    it.each([
        [
            'missing manifest right',
            externalSessionManifest,
            (api: PluginApi) => {
                api.agents.registerExternalSessionHooks(AGENT_ID, createHooks());
            },
            true,
        ],
        [
            'duplicate hook registration',
            externalSessionManifest,
            (api: PluginApi) => {
                api.agents.registerExternalSessions(AGENT_ID, externalSessions);
                api.agents.registerExternalSessionHooks(AGENT_ID, createHooks());
                api.agents.registerExternalSessionHooks(AGENT_ID, createHooks());
            },
            false,
        ],
        [
            'malformed hook aggregate',
            externalSessionManifest,
            (api: PluginApi) => {
                api.agents.registerExternalSessions(AGENT_ID, externalSessions);
                Reflect.apply(
                    api.agents.registerExternalSessionHooks,
                    api.agents,
                    [AGENT_ID, {
                        ...createHooks(),
                        planConfiguration() {},
                    }],
                );
            },
            false,
        ],
        [
            'mismatched Agent local id',
            externalSessionManifest,
            (api: PluginApi) => {
                api.agents.registerExternalSessionHooks('other', createHooks());
            },
            false,
        ],
        [
            'missing six-method sibling',
            externalSessionManifest,
            (api: PluginApi) => {
                api.agents.register(AGENT_ID, agentRuntimeFactory);
                api.agents.registerExternalSessionHooks(AGENT_ID, createHooks());
            },
            false,
        ],
    ] as const)(
        'rejects %s without publishing a partial Agent registration',
        async (_label, createManifest, activate, missingRight) => {
            const manifest = missingRight
                ? ingestCanonicalPluginManifest({
                    schemaVersion: 2,
                    id: PLUGIN_ID,
                    version: '1.0.0',
                    displayName: 'No Rights',
                    engines: { happier: '^0.2.0' },
                    runtime: { apiVersion: 1 },
                    entrypoints: { daemon: './daemon.js' },
                    contributes: {},
                })
                : { ok: true as const, manifest: createManifest() };
            if (!manifest.ok) throw new Error('Expected valid manifest fixture');
            const result = await activateContributionModule({
                pluginId: PLUGIN_ID,
                generation: 'generation-7',
                manifest: manifest.manifest,
                moduleNamespace: { activate },
                isGenerationCurrent: () => true,
                ...(missingRight ? { forceActivation: true } : {}),
            });

            expect(result.status).toBe('unavailable');
            expect(result.registrations).toEqual([]);
            expect(result.diagnostics).toEqual([
                expect.objectContaining({
                    code: 'plugin_activation_failed',
                }),
            ]);
        },
    );
});
