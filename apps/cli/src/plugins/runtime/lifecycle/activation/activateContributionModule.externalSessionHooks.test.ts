import { describe, expect, it, vi } from 'vitest';
import type {
    AgentExternalSessionHooksContribution,
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import type {
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import type { ActivationTarget } from './targets';
import { activateContributionModule } from './activateContributionModule';
import {
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

function externalSessionManifest() {
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
                        externalLinkedTakeover: {
                            writerSafety: 'unsupported',
                        },
                        sources: [{
                            sourceKind: 'fixture',
                            schema: {
                                passthrough: false,
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
        manifestDigest: 'fixture-manifest-digest',
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
        api.agents.register(AGENT_ID, agentRuntimeFactory);
    } else if (name === 'externalSessions') {
        api.agents.registerExternalSessions(AGENT_ID, externalSessions);
    } else if (name === 'hooks') {
        api.agents.registerExternalSessionHooks(AGENT_ID, hooks);
    } else {
        api.agents.registerExternalSessionObservation(AGENT_ID, observation);
    }
}

describe('real-loader External Session hook aggregate conformance', () => {
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
