import { describe, expect, it, vi } from 'vitest';

import type { PluginInvocationContext, PluginServices } from '@happier-dev/plugin-sdk';
import type {
    ManagedServiceHandle,
    ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';
import type {
    AgentProviderBindingAdapter,
    AgentRuntimeFactory,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    AgentExternalSessionHookResolveInstallationRequest,
    AgentExternalSessionHooksContribution,
    AgentExternalSessionObservationContribution,
    AgentExternalSessionObservationReconcileResultV1,
    AgentExternalSessionsContribution,
    AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionTakeoverContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import { PluginContributesV2Schema } from '@happier-dev/protocol';

import type { ActivationTarget } from '../activation/targets';
import type { ContributionRuntimeRegistration } from '../../api/registrationRightsHost';
import {
    createContributionRegistrationHost,
    recordValidatedAgentSessionRunnerFactory,
} from '../../api/registrationRightsHost';
import {
    createDeclarativeAcpAgentRuntimeRegistry,
    createTargetAgentRuntimeRegistry,
} from './targetAgents';
import {
    createExternalSessionObservationReconciler,
} from '../../../../api/session/external/leases/createExternalSessionObservationReconciler';
import { createUnavailablePluginServices } from '../../invocation/services/unavailable';
import type { CreateAgentInvocationServices } from '../../invocation/services/types';

const providerBinding: AgentProviderBindingAdapter = {
    v: 1,
    adapterVersion: 1,
    prepare: () => ({ v: 1, materialization: 'spawnEnv' }),
    materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
};
const TEST_RETIREMENT_SIGNAL = new AbortController().signal;

const externalSessionsContribution: AgentExternalSessionsContribution = Object.freeze({
    resolveSource: vi.fn(async (request) => ({ ok: true as const, value: { source: request.source } })),
    listCandidates: vi.fn(async () => ({ ok: true as const, value: { candidates: [], nextCursor: null } })),
    resolveLinkIdentity: vi.fn(async (request) => ({ ok: true as const, value: {
        remoteSessionId: request.remoteSessionId,
        source: request.source,
        linkData: request.linkData ?? {},
    } })),
    resolveLinkedIdentity: vi.fn(async (request) => ({ ok: true as const, value: {
        remoteSessionId: request.remoteSessionId,
        source: request.source,
        linkData: request.linkData,
    } })),
    pageTranscript: vi.fn(async () => ({ ok: true as const, value: { items: [], nextCursor: null } })),
    readAfterTranscript: vi.fn(async () => ({ ok: true as const, value: { outcome: 'already_current' as const } })),
});

function createExternalSessionHooksContribution(params?: Readonly<{
    resolveInstallation?: AgentExternalSessionHooksContribution['resolveInstallation'];
    mapHookEvent?: AgentExternalSessionHooksContribution['mapHookEvent'];
}>): AgentExternalSessionHooksContribution {
    return Object.freeze({
        installationVariants: Object.freeze([Object.freeze({
            variantId: 'fixture-variant',
            targets: Object.freeze([Object.freeze({
                targetId: 'settings',
                format: 'hook_event_json_arrays_v1' as const,
                collectionId: 'hooks',
            })]),
            events: Object.freeze([Object.freeze({
                eventId: 'session-start',
                targetId: 'settings',
                nativeEventName: 'SessionStart',
                command: Object.freeze({
                    kind: 'happier_observation_v1' as const,
                    shellDialect: 'posix' as const,
                }),
            })]),
        })]),
        resolveInstallation: params?.resolveInstallation ?? (async () => ({
                ok: true as const,
                value: {
                    kind: 'supported' as const,
                    variantId: 'fixture-variant',
                    targets: [{
                        targetId: 'settings',
                        absolutePath: '/var/lib/arbitrary-agent/settings.json',
                    }],
                    readiness: { kind: 'ready' as const },
                },
            })),
        mapHookEvent: params?.mapHookEvent ?? (async () => ({
            ok: true as const,
            value: { kind: 'ignored' as const },
        })),
    });
}

function resolveInstallationRequest(
    signal: AbortSignal,
): AgentExternalSessionHookResolveInstallationRequest {
    return {
        signal,
        deadlineAtMs: Date.now() + 15_000,
        maxSerializedBytes: 65_536,
        installation: {
            installationIdentity: 'installation-1',
            executableIdentity: 'sha256:fixture',
            installedVersion: '1.0.0',
            platform: 'darwin',
            architecture: 'arm64',
        },
    };
}

function createObservationContribution(params?: Readonly<{
    acquire?: AgentExternalSessionObservationContribution['observeResource'];
    reconcile?: AgentExternalSessionObservationContribution['reconcileResource'];
}>): AgentExternalSessionObservationContribution {
    return Object.freeze({
        describeResource: () => ({
            resourceKey: 'resource-1',
            linkKey: 'link-1',
            changeObservation: 'observe_resource' as const,
        }),
        observeResource: params?.acquire ?? (async () => ({ dispose() {} })),
        reconcileResource: params?.reconcile ?? (async ({ purpose, links }) =>
            purpose === 'resource_descriptors'
                ? {
                    purpose,
                    outcomes: links.map(({ linkKey }) => ({
                        kind: 'described' as const,
                        descriptor: {
                            resourceKey: 'resource-1',
                            linkKey,
                            changeObservation: 'observe_resource' as const,
                        },
                    })),
                }
                : {
                    purpose,
                    outcomes: links.map(({ linkKey }) => ({
                        linkKey,
                        facts: [{
                            kind: 'retrieval_failed' as const,
                            evidenceClass: 'reconciliation' as const,
                            observedAtMs: 1,
                            axis: 'liveness' as const,
                        }],
                    })),
                }),
    });
}

async function readPromiseStateAfterMicrotasks(
    value: unknown,
): Promise<'fulfilled' | 'rejected' | 'pending'> {
    let state: 'fulfilled' | 'rejected' | 'pending' = 'pending';
    void Promise.resolve(value).then(
        () => {
            state = 'fulfilled';
        },
        () => {
            state = 'rejected';
        },
    );
    for (let index = 0; index < 25; index += 1) {
        await Promise.resolve();
    }
    return state;
}

function target(pluginId = 'happier.agent.fixture'): ActivationTarget {
    // Boundary fixture: targetAgents only consumes manifest.version from an admitted target.
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId,
        manifestPath: `/plugins/${pluginId}/plugin.json`,
        daemonEntryPath: `/plugins/${pluginId}/daemon.js`,
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: { version: '0.0.0' },
    } as unknown as ActivationTarget;
}

function registration(params: Readonly<{
    pluginId?: string;
    localId?: string;
    generation?: string;
    factory: AgentRuntimeFactory;
    providerBinding?: AgentProviderBindingAdapter;
}>): Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}> {
    return {
        pluginId: params.pluginId ?? 'happier.agent.fixture',
        generation: params.generation ?? 'generation-7',
        registration: {
            family: 'agents',
            localId: params.localId ?? 'assistant',
            value: { factory: params.factory, providerBinding: params.providerBinding ?? providerBinding },
        },
    };
}

function externalSessionsRegistration(params?: Readonly<{
    pluginId?: string;
    localId?: string;
    generation?: string;
}>): Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}> {
    return {
        pluginId: params?.pluginId ?? 'happier.agent.fixture',
        generation: params?.generation ?? 'generation-7',
        registration: {
            family: 'agents',
            localId: params?.localId ?? 'assistant',
            value: { externalSessions: externalSessionsContribution },
        } as ContributionRuntimeRegistration,
    };
}

function observationRegistration(params?: Readonly<{
    pluginId?: string;
    localId?: string;
    generation?: string;
    observation?: AgentExternalSessionObservationContribution;
    externalSessionHooks?: AgentExternalSessionHooksContribution;
    externalSessionTakeover?: AgentExternalSessionTakeoverContribution;
}>): Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}> {
    return {
        pluginId: params?.pluginId ?? 'happier.agent.fixture',
        generation: params?.generation ?? 'generation-7',
        registration: {
            family: 'agents',
            localId: params?.localId ?? 'assistant',
            value: {
                externalSessions: externalSessionsContribution,
                ...(params?.externalSessionHooks
                    ? { externalSessionHooks: params.externalSessionHooks }
                    : {}),
                ...(params?.externalSessionTakeover
                    ? { externalSessionTakeover: params.externalSessionTakeover }
                    : {}),
                externalSessionObservation: params?.observation ?? createObservationContribution(),
            },
        } as ContributionRuntimeRegistration,
    };
}

function externalSessionHooksRegistration(params?: Readonly<{
    contribution?: AgentExternalSessionHooksContribution;
}>): Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}> {
    return {
        pluginId: 'happier.agent.fixture',
        generation: 'generation-7',
        registration: {
            family: 'agents',
            localId: 'assistant',
            value: {
                externalSessions: externalSessionsContribution,
                externalSessionHooks:
                    params?.contribution ?? createExternalSessionHooksContribution(),
            },
        } as ContributionRuntimeRegistration,
    };
}

/**
 * Minimal managed-services double. Only the process-owning boundary is faked;
 * the acquisition decision, spec admission and reuse under test are the real
 * host implementations.
 */
function createManagedServicesDouble(params?: Readonly<{
    respond?: (request: Readonly<{ pathAndQuery: string }>) => Readonly<{
        ok: boolean;
        status: number;
        statusText: string;
        headers: Readonly<Record<string, string>>;
        body: ReadableStream<Uint8Array> | null;
    }>;
}>) {
    const supervisedSpecs: ManagedServiceSpec[] = [];
    const request = vi.fn(async (input: Readonly<{ pathAndQuery: string }>) => (
        params?.respond?.(input) ?? Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body: null,
        })
    ));
    const snapshot = Object.freeze({
        id: 'service',
        state: 'healthy' as const,
        mode: 'spawn' as const,
        baseUrl: null,
        startedAtMs: null,
        lastHealthyAtMs: null,
        diagnostics: Object.freeze([]),
        diagnosticsTruncated: false,
    });
    const handle: ManagedServiceHandle = Object.freeze({
        snapshot: () => snapshot,
        observe: () => Object.freeze({ dispose() {} }),
        waitUntilHealthy: vi.fn(async () => snapshot),
        request,
        stop: vi.fn(async () => Object.freeze({ status: 'stopped' })),
        dispose: vi.fn(async () => undefined),
    });
    const supervise = vi.fn(async (
        spec: ManagedServiceSpec,
        _options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ManagedServiceHandle> => {
        supervisedSpecs.push(spec);
        return handle;
    });
    const unavailableServices = createUnavailablePluginServices();
    const createAgentInvocationServices = vi.fn(
        async (
            _params: Parameters<CreateAgentInvocationServices>[0],
        ): Promise<PluginServices> => (
            // The managed endpoint acquisition is the only service under test,
            // while the bounded callback still receives the canonical
            // fail-closed ExecService required by its public invocation shape.
            {
                ...unavailableServices,
                managedServices: {
                    ...unavailableServices.managedServices,
                    supervise,
                },
            }
        ),
    );
    return {
        supervise,
        supervisedSpecs,
        request,
        createAgentInvocationServices,
    };
}

const HOST_MINTED_SPAWN_SPEC: ManagedServiceSpec = Object.freeze({
    id: 'fixture-server',
    mode: Object.freeze({
        kind: 'spawn' as const,
        launch: Object.freeze({ executable: {} as never }),
        endpoint: Object.freeze({
            kind: 'assignAndInject' as const,
            port: Object.freeze({ kind: 'allocated' as const }),
        }),
    }),
    clientAccess: Object.freeze({
        kind: 'hostBasic' as const,
        username: 'fixture',
        injectPasswordEnvironmentKey: 'FIXTURE_SERVER_PASSWORD',
    }),
});

const USER_OWNED_ATTACH_SPEC: ManagedServiceSpec = Object.freeze({
    id: 'fixture-server/attach',
    mode: Object.freeze({
        kind: 'attach' as const,
        baseUrl: 'http://127.0.0.1:4096',
    }),
});

function declaringExternalSessionsRegistration(
    resolveManagedEndpointService:
        NonNullable<AgentExternalSessionsContribution['resolveManagedEndpointService']>,
): Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}> {
    return {
        pluginId: 'happier.agent.fixture',
        generation: 'generation-7',
        registration: {
            family: 'agents',
            localId: 'assistant',
            value: {
                externalSessions: Object.freeze({
                    ...externalSessionsContribution,
                    resolveManagedEndpointService,
                }),
            },
        } as ContributionRuntimeRegistration,
    };
}

describe('contribution-owned External Sessions managed endpoint', () => {
    it('serves a browse listing from a daemon-owned service with no Session runner endpoint', async () => {
        const managed = createManagedServicesDouble({
            respond: () => Object.freeze({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: Object.freeze({ 'x-observed': 'owned' }),
                body: null,
            }),
        });
        const runnerEndpointRead = vi.fn(async () => {
            throw new Error('Session-runner endpoint host must not be consulted');
        });
        const listCandidates = vi.fn(async (
            request: Parameters<AgentExternalSessionsContribution['listCandidates']>[0],
        ) => {
            const response = await request.managedEndpointRead({ pathAndQuery: '/session?limit=50' });
            return {
                ok: true as const,
                value: {
                    candidates: [{
                        remoteSessionId: `session-${response.headers['x-observed']}`,
                        updatedAtMs: 1,
                    }],
                    nextCursor: null,
                },
            };
        });
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [{
                pluginId: 'happier.agent.fixture',
                generation: 'generation-7',
                registration: {
                    family: 'agents',
                    localId: 'assistant',
                    value: {
                        externalSessions: Object.freeze({
                            ...externalSessionsContribution,
                            listCandidates,
                            resolveManagedEndpointService: () => HOST_MINTED_SPAWN_SPEC,
                        }),
                    },
                } as ContributionRuntimeRegistration,
            }],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            managedEndpointRead: runnerEndpointRead,
            createAgentInvocationServices: managed.createAgentInvocationServices,
            onDuplicate: vi.fn(),
        });
        const externalSessions = registry.get('assistant')?.externalSessions;
        if (!externalSessions) throw new Error('Expected External Sessions lease');

        const first = await externalSessions.listCandidates({
            source: { kind: 'opencodeServer', managedEndpoint: true },
            maxItems: 50,
            maxSerializedBytes: 1_048_576,
            deadlineAtMs: Date.now() + 15_000,
            signal: new AbortController().signal,
        });
        const second = await externalSessions.listCandidates({
            source: { kind: 'opencodeServer', managedEndpoint: true },
            maxItems: 50,
            maxSerializedBytes: 1_048_576,
            deadlineAtMs: Date.now() + 15_000,
            signal: new AbortController().signal,
        });

        expect(first).toMatchObject({
            ok: true,
            value: { candidates: [{ remoteSessionId: 'session-owned' }] },
        });
        expect(second).toMatchObject({ ok: true });
        expect(runnerEndpointRead).not.toHaveBeenCalled();
        expect(managed.request).toHaveBeenCalledTimes(2);
        // One acquisition identity serves both pages; each admitted callback
        // additionally receives its own signal-bound generic invocation service.
        expect(managed.createAgentInvocationServices).toHaveBeenCalledTimes(3);
        expect(managed.supervisedSpecs).toEqual([
            HOST_MINTED_SPAWN_SPEC,
            HOST_MINTED_SPAWN_SPEC,
        ]);
        const correlationIds = new Set(
            managed.createAgentInvocationServices.mock.calls
                .map((call) => call[0].correlationId),
        );
        expect(correlationIds.size).toBe(3);
    });

    it('keeps the Session-runner endpoint host when a contribution declares no service', async () => {
        const managed = createManagedServicesDouble();
        const runnerRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({ 'x-observed': 'runner' }),
            body: null,
        }));
        const runnerEndpointRead = vi.fn(async () => runnerRead);
        const listCandidates = vi.fn(async (
            request: Parameters<AgentExternalSessionsContribution['listCandidates']>[0],
        ) => {
            const response = await request.managedEndpointRead({ pathAndQuery: '/session' });
            return {
                ok: true as const,
                value: {
                    candidates: [{
                        remoteSessionId: `session-${response.headers['x-observed']}`,
                        updatedAtMs: 1,
                    }],
                    nextCursor: null,
                },
            };
        });
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [{
                pluginId: 'happier.agent.fixture',
                generation: 'generation-7',
                registration: {
                    family: 'agents',
                    localId: 'assistant',
                    value: {
                        externalSessions: Object.freeze({
                            ...externalSessionsContribution,
                            listCandidates,
                        }),
                    },
                } as ContributionRuntimeRegistration,
            }],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            managedEndpointRead: runnerEndpointRead,
            createAgentInvocationServices: managed.createAgentInvocationServices,
            onDuplicate: vi.fn(),
        });
        const externalSessions = registry.get('assistant')?.externalSessions;
        if (!externalSessions) throw new Error('Expected External Sessions lease');

        await expect(externalSessions.listCandidates({
            source: { kind: 'opencodeServer', managedEndpoint: true },
            maxItems: 50,
            maxSerializedBytes: 1_048_576,
            deadlineAtMs: Date.now() + 15_000,
            signal: new AbortController().signal,
        })).resolves.toMatchObject({
            ok: true,
            value: { candidates: [{ remoteSessionId: 'session-runner' }] },
        });
        expect(runnerEndpointRead).toHaveBeenCalledOnce();
        expect(managed.supervise).not.toHaveBeenCalled();
    });

    it('never supervises the contribution-owned service for passive observation', async () => {
        // Acquiring the contribution-owned endpoint is active: it spawns and
        // retains the agent's server for the whole generation. Passive
        // observation carries no user demand for that, so it stays on the
        // Session-runner endpoint host and fails closed when there is none.
        const managed = createManagedServicesDouble();
        const observedReads: unknown[] = [];
        const observation = createObservationContribution({
            acquire: async (request) => {
                observedReads.push(
                    await request.managedEndpointRead({ pathAndQuery: '/global/event' })
                        .then(() => 'read')
                        .catch((error: unknown) => error),
                );
                return { dispose() {} };
            },
        });
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [{
                ...observationRegistration({ observation }),
                registration: {
                    family: 'agents',
                    localId: 'assistant',
                    value: {
                        externalSessions: Object.freeze({
                            ...externalSessionsContribution,
                            resolveManagedEndpointService: () => HOST_MINTED_SPAWN_SPEC,
                        }),
                        externalSessionObservation: observation,
                    },
                } as ContributionRuntimeRegistration,
            }],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            createAgentInvocationServices: managed.createAgentInvocationServices,
            onDuplicate: vi.fn(),
        });
        const lease = registry.get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');
        const managedEndpointSource = Object.freeze({
            kind: 'opencode',
            baseUrl: 'http://127.0.0.1:4096',
        });

        const acquired = await lease.observeResource({
            resourceKey: 'resource-1',
            managedEndpointSource,
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        });
        await acquired.dispose();
        await lease.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [{
                linkKey: 'link-1',
                linkedSource: {
                    source: managedEndpointSource,
                    remoteSessionId: 'session-1',
                    linkData: {},
                },
            }],
            signal: new AbortController().signal,
        });

        expect(managed.supervise).not.toHaveBeenCalled();
        expect(managed.supervisedSpecs).toEqual([]);
        expect(observedReads).toEqual([expect.any(Error)]);

        // The same contribution keeps its owned endpoint for explicit demand.
        const externalSessions = registry.get('assistant')?.externalSessions;
        if (!externalSessions) throw new Error('Expected External Sessions lease');
        await externalSessions.listCandidates({
            source: { kind: 'opencodeServer', managedEndpoint: true },
            maxItems: 50,
            maxSerializedBytes: 1_048_576,
            deadlineAtMs: Date.now() + 15_000,
            signal: new AbortController().signal,
        });
        expect(managed.supervisedSpecs).toEqual([HOST_MINTED_SPAWN_SPEC]);
    });

    it('follows a user-owned attached server passively without owning a process', async () => {
        // Passive following of a server the user already runs starts nothing,
        // so refusing it removed a real capability. Only an owned spawn stays
        // out of the passive path.
        const managed = createManagedServicesDouble({
            respond: () => Object.freeze({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: Object.freeze({ 'x-observed': 'attached' }),
                body: null,
            }),
        });
        const observedStatuses: unknown[] = [];
        const observation = createObservationContribution({
            acquire: async (request) => {
                observedStatuses.push(
                    await request.managedEndpointRead({ pathAndQuery: '/global/event' })
                        .then((response) => response.status)
                        .catch((error: unknown) => error),
                );
                return { dispose() {} };
            },
        });
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [{
                ...observationRegistration({ observation }),
                registration: {
                    family: 'agents',
                    localId: 'assistant',
                    value: {
                        externalSessions: Object.freeze({
                            ...externalSessionsContribution,
                            resolveManagedEndpointService: () => USER_OWNED_ATTACH_SPEC,
                        }),
                        externalSessionObservation: observation,
                    },
                } as ContributionRuntimeRegistration,
            }],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            createAgentInvocationServices: managed.createAgentInvocationServices,
            onDuplicate: vi.fn(),
        });
        const lease = registry.get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        const acquired = await lease.observeResource({
            resourceKey: 'resource-1',
            managedEndpointSource: Object.freeze({
                kind: 'opencode',
                baseUrl: 'http://127.0.0.1:4096',
            }),
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        });
        await acquired.dispose();

        expect(observedStatuses).toEqual([200]);
        expect(managed.supervisedSpecs).toEqual([USER_OWNED_ATTACH_SPEC]);
    });

    it('declares no owned service for a source that names the user\'s own server', async () => {
        const managed = createManagedServicesDouble();
        const resolveManagedEndpointService = vi.fn(() => null);
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [
                declaringExternalSessionsRegistration(resolveManagedEndpointService),
            ],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            createAgentInvocationServices: managed.createAgentInvocationServices,
            onDuplicate: vi.fn(),
        });
        const externalSessions = registry.get('assistant')?.externalSessions;
        if (!externalSessions) throw new Error('Expected External Sessions lease');

        await externalSessions.resolveSource({
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
            maxSerializedBytes: 262_144,
            deadlineAtMs: Date.now() + 15_000,
            signal: new AbortController().signal,
        });

        expect(resolveManagedEndpointService).toHaveBeenCalled();
        expect(managed.supervise).not.toHaveBeenCalled();
    });
});

describe('target Agent runtime registry', () => {
    it('binds managed endpoint reads once before observation and reconciliation entry', async () => {
        const observeExactRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({ 'x-next-cursor': 'cursor-2' }),
            body: null,
        }));
        const reconcileExactRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 201,
            statusText: 'Created',
            headers: Object.freeze({}),
            body: null,
        }));
        const replacementRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 299,
            statusText: 'Replacement',
            headers: Object.freeze({}),
            body: null,
        }));
        let selectedRead: AgentExternalSessionsManagedEndpointRead = observeExactRead;
        const managedEndpointRead = vi.fn(async () => selectedRead);
        const observeRead = vi.fn();
        const reconcileRead = vi.fn();
        const retainedReads: AgentExternalSessionsManagedEndpointRead[] = [];
        const observation = createObservationContribution({
            acquire: async (request) => {
                expect(managedEndpointRead).toHaveBeenCalledOnce();
                retainedReads.push(request.managedEndpointRead);
                selectedRead = replacementRead;
                observeRead(await request.managedEndpointRead({
                    pathAndQuery: '/global/event',
                    headers: { accept: 'text/event-stream' },
                }));
                return { dispose() {} };
            },
            reconcile: async (request) => {
                expect(managedEndpointRead).toHaveBeenCalledTimes(2);
                retainedReads.push(request.managedEndpointRead);
                selectedRead = replacementRead;
                reconcileRead(await request.managedEndpointRead({
                    pathAndQuery: '/session',
                }));
                return {
                    purpose: 'observation_evidence' as const,
                    outcomes: request.links.map(({ linkKey }) => ({
                        linkKey,
                        facts: [{
                            kind: 'retrieval_failed' as const,
                            evidenceClass: 'reconciliation' as const,
                            observedAtMs: 1,
                            axis: 'liveness' as const,
                        }],
                    })),
                };
            },
        });
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            managedEndpointRead,
            onDuplicate: vi.fn(),
        });
        const lease = registry.get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');
        const managedEndpointSource = Object.freeze({
            kind: 'opencode',
            baseUrl: 'http://127.0.0.1:4096',
        });

        const acquired = await lease.observeResource({
            resourceKey: 'resource-1',
            managedEndpointSource,
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        });
        await acquired.dispose();
        const retainedObserveRead = retainedReads[0];
        if (!retainedObserveRead) throw new Error('Expected retained observe read');
        await expect(retainedObserveRead({ pathAndQuery: '/global/event' }))
            .rejects.toBe('disposed');
        expect(observeExactRead).toHaveBeenCalledOnce();
        expect(replacementRead).not.toHaveBeenCalled();
        selectedRead = reconcileExactRead;
        await lease.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [{
                linkKey: 'link-1',
                linkedSource: {
                    source: managedEndpointSource,
                    remoteSessionId: 'session-1',
                    linkData: {},
                },
            }],
            signal: new AbortController().signal,
        });
        const retainedReconcileRead = retainedReads[1];
        if (!retainedReconcileRead) throw new Error('Expected retained reconcile read');
        await expect(retainedReconcileRead({ pathAndQuery: '/session' }))
            .rejects.toBe('disposed');

        expect(observeRead).toHaveBeenCalledWith(expect.objectContaining({
            status: 200,
        }));
        expect(reconcileRead).toHaveBeenCalledWith(expect.objectContaining({
            status: 201,
        }));
        expect(managedEndpointRead).toHaveBeenNthCalledWith(1, expect.objectContaining({
            identity: {
                pluginId: 'happier.agent.fixture',
                agentId: 'assistant',
                generation: 'generation-7',
                contributionQualifiedId:
                    'happier.agent.fixture/agents/assistant',
                immutableGenerationId: null,
            },
            source: managedEndpointSource,
        }));
        expect(managedEndpointRead).toHaveBeenNthCalledWith(2, expect.objectContaining({
            source: managedEndpointSource,
        }));
        expect(observeExactRead).toHaveBeenCalledWith({
            pathAndQuery: '/global/event',
            headers: { accept: 'text/event-stream' },
        });
        expect(reconcileExactRead).toHaveBeenCalledWith({
            pathAndQuery: '/session',
        });
        expect(observeExactRead).toHaveBeenCalledOnce();
        expect(reconcileExactRead).toHaveBeenCalledOnce();
        expect(replacementRead).not.toHaveBeenCalled();
        expect(managedEndpointRead).toHaveBeenCalledTimes(2);
    });

    it('cancels an over-budget managed response during finite reconciliation', async () => {
        const responseCancelled = vi.fn();
        let pulls = 0;
        let releaseThirdPull: (() => void) | undefined;
        const exactRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body: new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulls += 1;
                    if (pulls === 1) {
                        controller.enqueue(new Uint8Array(262_144));
                        return;
                    }
                    if (pulls === 2) {
                        controller.enqueue(new Uint8Array(1));
                        return;
                    }
                    return new Promise<void>((resolve) => {
                        releaseThirdPull = resolve;
                    });
                },
                cancel(reason) {
                    responseCancelled(reason);
                    releaseThirdPull?.();
                },
            }),
        }));
        const reconcile = vi.fn(async (request: Parameters<
            NonNullable<AgentExternalSessionObservationContribution['reconcileResource']>
        >[0]) => {
            const response = await request.managedEndpointRead({ pathAndQuery: '/session' });
            const reader = response.body?.getReader();
            if (!reader) throw new Error('Expected managed endpoint response body');
            await reader.read();
            await reader.read();
            return {
                purpose: 'observation_evidence' as const,
                outcomes: request.links.map(({ linkKey }) => ({
                    linkKey,
                    facts: [{
                        kind: 'retrieval_failed' as const,
                        evidenceClass: 'reconciliation' as const,
                        observedAtMs: 1,
                        axis: 'liveness' as const,
                    }],
                })),
            };
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({
                observation: createObservationContribution({ reconcile }),
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            managedEndpointRead: vi.fn(async () => exactRead),
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        await expect(lease.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [{
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'opencode', baseUrl: 'http://127.0.0.1:4096' },
                    remoteSessionId: 'session-1',
                    linkData: {},
                },
            }],
            signal: new AbortController().signal,
        })).rejects.toThrow(/managed endpoint response exceeds its 262144-byte operation budget/u);

        expect(exactRead).toHaveBeenCalledWith({ pathAndQuery: '/session' });
        expect(responseCancelled).toHaveBeenCalledOnce();
        expect(reconcile).toHaveBeenCalledOnce();
    });

    it('accepts a managed response exactly at the finite reconciliation budget', async () => {
        const responseCancelled = vi.fn();
        const exactRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(262_144));
                    controller.close();
                },
                cancel: responseCancelled,
            }),
        }));
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({
                observation: createObservationContribution({
                    reconcile: async (request) => {
                        const response = await request.managedEndpointRead({
                            pathAndQuery: '/session',
                        });
                        const reader = response.body?.getReader();
                        if (!reader) throw new Error('Expected managed endpoint response body');
                        while (!(await reader.read()).done) {
                            // Consume the exact-boundary response through the plugin-facing seam.
                        }
                        return {
                            purpose: 'observation_evidence' as const,
                            outcomes: request.links.map(({ linkKey }) => ({
                                linkKey,
                                facts: [{
                                    kind: 'retrieval_failed' as const,
                                    evidenceClass: 'reconciliation' as const,
                                    observedAtMs: 1,
                                    axis: 'liveness' as const,
                                }],
                            })),
                        };
                    },
                }),
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            managedEndpointRead: vi.fn(async () => exactRead),
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        await expect(lease.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [{
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'opencode', baseUrl: 'http://127.0.0.1:4096' },
                    remoteSessionId: 'session-1',
                    linkData: {},
                },
            }],
            signal: new AbortController().signal,
        })).resolves.toMatchObject({
            purpose: 'observation_evidence',
            outcomes: [{ linkKey: 'link-1' }],
        });

        expect(responseCancelled).not.toHaveBeenCalled();
    });

    it('leaves the managed event stream unbounded for long-lived observation', async () => {
        const responseCancelled = vi.fn();
        let observedBytes = 0;
        const exactRead = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(262_145));
                    controller.close();
                },
                cancel: responseCancelled,
            }),
        }));
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({
                observation: createObservationContribution({
                    acquire: async (request) => {
                        const response = await request.managedEndpointRead({
                            pathAndQuery: '/global/event',
                        });
                        const reader = response.body?.getReader();
                        if (!reader) throw new Error('Expected managed endpoint response body');
                        for (;;) {
                            const result = await reader.read();
                            if (result.done) break;
                            observedBytes += result.value.byteLength;
                        }
                        return { dispose() {} };
                    },
                }),
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            managedEndpointRead: vi.fn(async () => exactRead),
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        const acquired = await lease.observeResource({
            resourceKey: 'resource-1',
            managedEndpointSource: { kind: 'opencode', baseUrl: 'http://127.0.0.1:4096' },
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        });
        await acquired.dispose();

        expect(exactRead).toHaveBeenCalledWith({ pathAndQuery: '/global/event' });
        expect(observedBytes).toBe(262_145);
        expect(responseCancelled).not.toHaveBeenCalled();
    });

    it('settles retired observation while a managed endpoint bind ignores abort', async () => {
        vi.useFakeTimers();
        try {
            let settleBind!: (read: AgentExternalSessionsManagedEndpointRead) => void;
            let bindSignal: AbortSignal | undefined;
            let current = true;
            const retirement = new AbortController();
            const acquire = vi.fn(async () => ({ dispose() {} }));
            const managedEndpointRead = vi.fn(({ signal }: { signal: AbortSignal }) => {
                bindSignal = signal;
                return new Promise<AgentExternalSessionsManagedEndpointRead>((resolve) => {
                    settleBind = resolve;
                });
            });
            const lease = createTargetAgentRuntimeRegistry({
                agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
                activationTargets: [target()],
                targetRegistrations: [observationRegistration({
                    observation: createObservationContribution({ acquire }),
                })],
                isGenerationActive: () => current,
                retirementSignal: retirement.signal,
                managedEndpointRead,
                onDuplicate: vi.fn(),
            }).get('assistant')?.externalSessionObservation;
            if (!lease) throw new Error('Expected observation lease');

            const acquisition = Promise.resolve(lease.observeResource({
                resourceKey: 'resource-1',
                managedEndpointSource: { kind: 'fixture' },
                signal: new AbortController().signal,
                emit() {},
                requestReconcile() {},
                requestTranscriptRefresh() {},
            }));
            void acquisition.catch(() => undefined);
            await Promise.resolve();
            expect(managedEndpointRead).toHaveBeenCalledOnce();
            current = false;
            retirement.abort();

            expect(bindSignal?.aborted).toBe(true);
            expect(await readPromiseStateAfterMicrotasks(acquisition)).toBe('rejected');
            await expect(acquisition).rejects.toThrow(/retired generation/u);
            expect(acquire).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);

            settleBind(async () => {
                throw new Error('Late managed endpoint read must remain unreachable');
            });
            await Promise.resolve();
            expect(acquire).not.toHaveBeenCalled();
            await expect(acquisition).rejects.toThrow(/retired generation/u);
        } finally {
            vi.useRealTimers();
        }
    });

    it('times out reconciliation while a managed endpoint bind ignores abort', async () => {
        vi.useFakeTimers();
        try {
            let settleBind!: (read: AgentExternalSessionsManagedEndpointRead) => void;
            let bindSignal: AbortSignal | undefined;
            const reconcile = vi.fn(createObservationContribution().reconcileResource);
            const managedEndpointRead = vi.fn(({ signal }: { signal: AbortSignal }) => {
                bindSignal = signal;
                return new Promise<AgentExternalSessionsManagedEndpointRead>((resolve) => {
                    settleBind = resolve;
                });
            });
            const lease = createTargetAgentRuntimeRegistry({
                agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
                activationTargets: [target()],
                targetRegistrations: [observationRegistration({
                    observation: createObservationContribution({ reconcile }),
                })],
                isGenerationActive: () => true,
                retirementSignal: new AbortController().signal,
                managedEndpointRead,
                onDuplicate: vi.fn(),
            }).get('assistant')?.externalSessionObservation;
            if (!lease) throw new Error('Expected observation lease');

            const reconciliation = Promise.resolve(lease.reconcileResource({
                purpose: 'observation_evidence',
                resourceKey: 'resource-1',
                links: [{
                    linkKey: 'link-1',
                    linkedSource: {
                        source: { kind: 'fixture' },
                        remoteSessionId: 'native-session',
                        linkData: {},
                    },
                }],
                signal: new AbortController().signal,
            }));
            void reconciliation.catch(() => undefined);
            await Promise.resolve();
            expect(managedEndpointRead).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(15_000);

            expect(bindSignal?.aborted).toBe(true);
            expect(await readPromiseStateAfterMicrotasks(reconciliation)).toBe('rejected');
            await expect(reconciliation).rejects.toThrow(/timed out/u);
            expect(reconcile).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);

            settleBind(async () => {
                throw new Error('Late managed endpoint read must remain unreachable');
            });
            await Promise.resolve();
            expect(reconcile).not.toHaveBeenCalled();
            await expect(reconciliation).rejects.toThrow(/timed out/u);
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails closed when no retirement signal owns a generated runtime lease', () => {
        expect(() => createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [registration({
                factory: async () => ({
                    sessions: {
                        open: async () => ({
                            send: async () => ({ status: 'admitted' }),
                            watch: () => ({ dispose() {} }),
                            dispose() {},
                        }),
                    },
                }),
            })],
            isGenerationActive: () => true,
            onDuplicate: vi.fn(),
        } as never)).toThrow(/retirement signal/i);
    });

    it('leases a static ACP declaration as a native runtime that delegates only to the public composer', async () => {
        const open = vi.fn(async () => ({
            send: async () => ({ status: 'admitted' as const }),
            watch: () => ({ dispose() {} }),
            dispose() {},
        }));
        const transport = {
            kind: 'stdio' as const,
            executable: { kind: 'systemTool' as const, id: 'fixture-acp' },
        };
        const registry = createDeclarativeAcpAgentRuntimeRegistry({
            agents: [{
                id: 'declarative-agent',
                provenance: 'external',
                source: { kind: 'path' },
                definition: { kindVersion: 1, id: 'declarative-agent', ownedBackendIds: [] },
                richDefinition: {
                    provenance: 'external',
                    definition: {
                        id: 'declarative-agent',
                        title: 'Declarative Agent',
                        runtime: { kind: 'acp', transport },
                        primary: 'sessions',
                        capabilities: {
                            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                        },
                    },
                },
                pluginId: 'acme.declarative',
                sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/acme.declarative',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                    resolvedVersion: '2.3.4',
                },
            }],
            registered: new Map(),
            generation: 'generation-9',
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
        });

        const lease = registry.get('declarative-agent');
        expect(lease).toMatchObject({
            pluginId: 'acme.declarative',
            pluginVersion: '2.3.4',
            agentId: 'declarative-agent',
            generation: 'generation-9',
            hasPrimaryRuntime: true,
        });
        if (!lease?.hasPrimaryRuntime) throw new Error('Expected a primary Agent runtime lease');
        const runtime = await lease.createRuntime({ signal: new AbortController().signal });
        const request = { kind: 'create' as const, sessionId: 'host-session', cwd: '/tmp' };
        const context = {
            protocols: { acp: { open } },
        // Boundary fixture: this owner delegates only to the public protocol-composer surface.
        } as unknown as AgentSessionRuntimeContext;
        await runtime?.sessions?.open(request, context);

        expect(open).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledWith(request, { transport });
    });

    it('leases one manifest-joined factory with provider binding and canonical identity', async () => {
        const factory = vi.fn<AgentRuntimeFactory>(async () => ({
            sessions: {
                open: async () => ({
                    send: async () => ({ status: 'admitted' }),
                    watch: () => ({ dispose() {} }),
                    dispose() {},
                }),
            },
        }));
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [registration({ factory })],
            immutableGenerationIdsByPluginId: new Map([['happier.agent.fixture', 'immutable-generation-content-digest']]),
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });

        const lease = registry.get('assistant');
        expect(lease).toMatchObject({
            pluginId: 'happier.agent.fixture',
            pluginVersion: '0.0.0',
            agentId: 'assistant',
            generation: 'generation-7',
            immutableGenerationId: 'immutable-generation-content-digest',
            providerBinding,
            hasPrimaryRuntime: true,
        });
        if (!lease?.hasPrimaryRuntime) throw new Error('Expected a primary Agent runtime lease');
        const signal = new AbortController().signal;
        const runtime = await lease.createRuntime({ signal });
        expect(factory).toHaveBeenCalledWith({
            plugin: { id: 'happier.agent.fixture', version: '0.0.0' },
            agent: { id: 'assistant' },
            signal,
        });
        expect(runtime?.sessions).toBeDefined();
    });

    it('retains a direct runner factory binding without host-only lease fields', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'happier.agent.fixture',
            generation: 'generation-7',
            rights: [{
                family: 'agents',
                localId: 'assistant',
                target: { realm: 'daemon' },
                requiredFields: ['factory', 'sessionRunnerFactory'],
            }],
            isGenerationCurrent: () => true,
        });
        const factory: AgentRuntimeFactory = async () => ({
            sessions: {
                open: async () => ({
                    send: async () => ({ status: 'admitted' }),
                    watch: () => ({ dispose() {} }),
                    dispose() {},
                }),
            },
        });
        host.api.agents.register('assistant', factory, {
            sessionRunnerFactory: {
                module: './agent/runtime.js',
                export: 'createAssistantRuntime',
                runtimeApiVersion: 1,
            },
        });
        const [committed] = host.commit();
        if (committed?.family !== 'agents') {
            throw new Error('Expected an Agent runtime registration');
        }
        const locator = committed.value.sessionRunnerFactory;
        if (!locator) {
            throw new Error('Expected a session runner factory locator');
        }
        recordValidatedAgentSessionRunnerFactory(committed.value, {
            locator,
            normalizedModulePath: 'agent/runtime.js',
            loadMode: 'immutable-js',
        });

        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [{
                pluginId: 'happier.agent.fixture',
                generation: 'generation-7',
                registration: committed,
            }],
            immutableGenerationIdsByPluginId: new Map([
                ['happier.agent.fixture', 'immutable-generation-7'],
            ]),
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant');

        if (!lease?.hasPrimaryRuntime) {
            throw new Error('Expected a primary Agent runtime lease');
        }
        expect(lease.sessionRunnerFactoryBinding).toEqual({
            v: 1,
            pluginId: 'happier.agent.fixture',
            pluginVersion: '0.0.0',
            agentId: 'assistant',
            localAgentId: 'assistant',
            immutableGenerationId: 'immutable-generation-7',
            locator,
            normalizedModulePath: 'agent/runtime.js',
            loadMode: 'immutable-js',
        });
        expect(lease).not.toHaveProperty('workflowRunRecordSessionOpen');
        expect(lease).not.toHaveProperty('issueRunnerExecutionGrant');
        expect(lease).not.toHaveProperty('manifestDigest');
    });

    it('leases an auxiliary-only External Sessions contribution without claiming primary runtime ownership', () => {
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [externalSessionsRegistration()],
            immutableGenerationIdsByPluginId: new Map([
                ['happier.agent.fixture', 'immutable-generation-content-digest'],
            ]),
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });

        expect(registry.get('assistant')).toMatchObject({
            pluginId: 'happier.agent.fixture',
            agentId: 'assistant',
            generation: 'generation-7',
            immutableGenerationId: 'immutable-generation-content-digest',
            hasPrimaryRuntime: false,
        });
        expect(registry.get('assistant')?.externalSessions).toBeDefined();
        expect(registry.get('assistant')?.externalSessions).not.toBe(externalSessionsContribution);
        expect(registry.get('assistant')?.createRuntime).toBeUndefined();
    });

    it('binds the generic invocation ExecService into an External Sessions callback', async () => {
        const services = createUnavailablePluginServices();
        const createAgentInvocationServices = vi.fn(async (
            _params: Parameters<CreateAgentInvocationServices>[0],
        ) => services);
        let receivedRequest: Parameters<AgentExternalSessionsContribution['listCandidates']>[0] | undefined;
        const listCandidates = vi.fn<AgentExternalSessionsContribution['listCandidates']>(
            async (request) => {
                receivedRequest = request;
                return { ok: true, value: { candidates: [], nextCursor: null } };
            },
        );
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [{
                pluginId: 'happier.agent.fixture',
                generation: 'generation-7',
                registration: {
                    family: 'agents',
                    localId: 'assistant',
                    value: {
                        externalSessions: Object.freeze({
                            ...externalSessionsContribution,
                            listCandidates,
                        }),
                    },
                } as ContributionRuntimeRegistration,
            }],
            createAgentInvocationServices,
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });
        const externalSessions = registry.get('assistant')?.externalSessions;
        if (!externalSessions) throw new Error('Expected External Sessions lease');

        await expect(externalSessions.listCandidates({
            source: { kind: 'fixture' },
            maxItems: 50,
            maxSerializedBytes: 1_048_576,
            deadlineAtMs: Date.now() + 15_000,
            signal: new AbortController().signal,
        })).resolves.toEqual({
            ok: true,
            value: { candidates: [], nextCursor: null },
        });

        // The public invocation type gains this service with the owner change;
        // this narrow assertion makes the missing runtime wiring fail RED first.
        expect((receivedRequest as unknown as { exec?: unknown } | undefined)?.exec)
            .toBe(services.exec);
        expect(createAgentInvocationServices).toHaveBeenCalledOnce();
        if (!receivedRequest) throw new Error('Expected External Sessions callback request');
        expect(createAgentInvocationServices.mock.calls[0]?.[0].signal)
            .toBe(receivedRequest.signal);
    });

    it('leases observation beside the same auxiliary-only External Sessions identity and generation', () => {
        const observation = createObservationContribution();
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });

        const lease = registry.get('assistant');
        expect(lease).toMatchObject({
            pluginId: 'happier.agent.fixture',
            agentId: 'assistant',
            generation: 'generation-7',
            hasPrimaryRuntime: false,
        });
        expect(lease?.externalSessions).toBeDefined();
        expect(lease?.externalSessionObservation).toBeDefined();
        expect(lease?.externalSessionObservation).not.toBe(observation);
        expect(lease?.createRuntime).toBeUndefined();
    });

    it('carries one hook contribution on the same generation-owned External Sessions lease', () => {
        const contribution = createExternalSessionHooksContribution();
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{
                id: 'assistant',
                identity: { pluginId: 'happier.agent.fixture', localId: 'assistant' },
                pluginId: 'happier.agent.fixture',
            }],
            activationTargets: [target()],
            targetRegistrations: [externalSessionHooksRegistration({ contribution })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });

        const lease = registry.get('assistant');
        expect(lease?.externalSessions).toBeDefined();
        expect(lease?.externalSessionHooks).toBeDefined();
        expect(lease?.externalSessionHooks).not.toBe(contribution);
        expect(lease?.externalSessionHooks?.installationVariants)
            .toBe(contribution.installationVariants);
    });

    it('passes the canonical composed invocation context only to resolveInstallation', async () => {
        let receivedContext: PluginInvocationContext | undefined;
        let receivedRequestSignal: AbortSignal | undefined;
        const resolveInstallation = vi.fn<AgentExternalSessionHooksContribution['resolveInstallation']>(
            async (request, context) => {
                receivedRequestSignal = request.signal;
                receivedContext = context;
                return {
                    ok: true,
                    value: {
                        kind: 'supported',
                        variantId: 'fixture-variant',
                        targets: [{
                            targetId: 'settings',
                            absolutePath: '/var/lib/arbitrary-agent/settings.json',
                        }],
                        readiness: { kind: 'ready' },
                    },
                };
            },
        );
        const mapHookEvent = vi.fn<AgentExternalSessionHooksContribution['mapHookEvent']>(
            async () => ({
                ok: true,
                value: { kind: 'ignored' },
            }),
        );
        const services = createUnavailablePluginServices();
        const createAgentInvocationServices = vi.fn(async () => services);
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{
                id: 'assistant',
                identity: { pluginId: 'happier.agent.fixture', localId: 'assistant' },
                pluginId: 'happier.agent.fixture',
            }],
            activationTargets: [target()],
            targetRegistrations: [externalSessionHooksRegistration({
                contribution: createExternalSessionHooksContribution({
                    resolveInstallation,
                    mapHookEvent,
                }),
            })],
            createAgentInvocationServices,
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });
        const externalSessionHooks = registry.get('assistant')?.externalSessionHooks;
        if (!externalSessionHooks) throw new Error('Expected hook lease');

        await externalSessionHooks.resolveInstallation(
            resolveInstallationRequest(new AbortController().signal),
        );

        expect(receivedContext).toMatchObject({
            plugin: { id: 'happier.agent.fixture', version: '0.0.0' },
            contribution: {
                id: 'assistant',
                qualifiedId: 'happier.agent.fixture/agents/assistant',
            },
            surface: 'agent',
        });
        expect(receivedContext?.signal).toBe(receivedRequestSignal);
        expect(receivedContext?.services).toBe(services);
        expect(createAgentInvocationServices).toHaveBeenCalledWith(
            expect.objectContaining({
                pluginId: 'happier.agent.fixture',
                pluginVersion: '0.0.0',
                agentId: 'assistant',
                generation: 'generation-7',
                cwd: process.cwd(),
                signal: receivedRequestSignal,
                isGenerationCurrent: expect.any(Function),
            }),
        );

        await externalSessionHooks.mapHookEvent({
            signal: new AbortController().signal,
            deadlineAtMs: Date.now() + 500,
            maxSerializedBytes: 65_536,
            installationIdentity: 'installation-1',
            variantId: 'fixture-variant',
            eventId: 'session-start',
            observedAtMs: Date.now(),
            nativePayload: {},
        });
        expect(mapHookEvent.mock.calls[0]).toHaveLength(1);
        expect(createAgentInvocationServices).toHaveBeenCalledOnce();
    });

    it.each(['cancelled', 'retired'] as const)(
        'fences hook callback settlement after the invocation is %s',
        async (terminal) => {
            let settle!: () => void;
            const callbackSettled = new Promise<void>((resolve) => {
                settle = resolve;
            });
            const resolveInstallation = vi.fn(async () => {
                await callbackSettled;
                return {
                    ok: true as const,
                    value: {
                        kind: 'supported' as const,
                        variantId: 'fixture-variant',
                        targets: [{
                            targetId: 'settings',
                            absolutePath: '/var/lib/arbitrary-agent/settings.json',
                        }],
                        readiness: { kind: 'ready' as const },
                    },
                };
            });
            let current = true;
            const retirement = new AbortController();
            const registry = createTargetAgentRuntimeRegistry({
                agents: [{
                    id: 'assistant',
                    identity: { pluginId: 'happier.agent.fixture', localId: 'assistant' },
                    pluginId: 'happier.agent.fixture',
                }],
                activationTargets: [target()],
                targetRegistrations: [externalSessionHooksRegistration({
                    contribution: createExternalSessionHooksContribution({ resolveInstallation }),
                })],
                isGenerationActive: () => current,
                retirementSignal: retirement.signal,
                onDuplicate: vi.fn(),
            });
            const externalSessionHooks = registry.get('assistant')?.externalSessionHooks;
            if (!externalSessionHooks) throw new Error('Expected hook lease');
            const caller = new AbortController();
            const invocation = externalSessionHooks.resolveInstallation(
                resolveInstallationRequest(caller.signal),
            );
            await vi.waitFor(() => {
                expect(resolveInstallation).toHaveBeenCalledOnce();
            });

            if (terminal === 'cancelled') {
                caller.abort();
            } else {
                current = false;
                retirement.abort();
            }
            await expect(invocation).rejects.toThrow(
                terminal === 'cancelled' ? /cancelled/u : /retired generation/u,
            );
            settle();
            await Promise.resolve();
            await Promise.resolve();
        },
    );

    it('enforces the caller serialized-result ceiling after callback validation', async () => {
        const resolveInstallation = vi.fn(async () => ({
            ok: true as const,
            value: {
                kind: 'supported' as const,
                variantId: 'x'.repeat(512),
                targets: [{
                    targetId: 'settings',
                    absolutePath: '/var/lib/arbitrary-agent/settings.json',
                }],
                readiness: { kind: 'ready' as const },
            },
        }));
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [externalSessionHooksRegistration({
                contribution: createExternalSessionHooksContribution({ resolveInstallation }),
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });
        const externalSessionHooks = registry.get('assistant')?.externalSessionHooks;
        if (!externalSessionHooks) throw new Error('Expected hook lease');
        const request = {
            ...resolveInstallationRequest(new AbortController().signal),
            maxSerializedBytes: 256,
        };

        await expect(externalSessionHooks.resolveInstallation(request))
            .rejects.toThrow(/serialized-byte limit/u);
        expect(resolveInstallation).toHaveBeenCalledOnce();
    });

    it('does not invoke a hook callback after its admitted deadline', async () => {
        const resolveInstallation = vi.fn(async () => ({
            ok: true as const,
            value: {
                kind: 'supported' as const,
                variantId: 'fixture-variant',
                targets: [{
                    targetId: 'settings',
                    absolutePath: '/var/lib/arbitrary-agent/settings.json',
                }],
                readiness: { kind: 'ready' as const },
            },
        }));
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [externalSessionHooksRegistration({
                contribution: createExternalSessionHooksContribution({ resolveInstallation }),
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });
        const externalSessionHooks = registry.get('assistant')?.externalSessionHooks;
        if (!externalSessionHooks) throw new Error('Expected hook lease');
        const request = {
            ...resolveInstallationRequest(new AbortController().signal),
            deadlineAtMs: Date.now() - 1,
        };

        await expect(externalSessionHooks.resolveInstallation(request))
            .rejects.toThrow(/timed out/u);
        expect(resolveInstallation).not.toHaveBeenCalled();
    });

    it('carries primary runtime and External Sessions fields on the same Agent lease', () => {
        const factory: AgentRuntimeFactory = async () => ({
            sessions: {
                open: async () => ({
                    send: async () => ({ status: 'admitted' }),
                    watch: () => ({ dispose() {} }),
                    dispose() {},
                }),
            },
        });
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [{
                pluginId: 'happier.agent.fixture',
                generation: 'generation-7',
                registration: {
                    family: 'agents',
                    localId: 'assistant',
                    value: { factory, externalSessions: externalSessionsContribution },
                } as ContributionRuntimeRegistration,
            }],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });

        expect(registry.get('assistant')?.externalSessions).toBeDefined();
        expect(registry.get('assistant')?.externalSessions).not.toBe(externalSessionsContribution);
        expect(registry.get('assistant')?.hasPrimaryRuntime).toBe(true);
        expect(registry.get('assistant')?.createRuntime).toBeTypeOf('function');
    });

    it('merges a declarative ACP primary runtime into the same-plugin External Sessions lease', async () => {
        const pluginId = 'acme.declarative';
        const agentId = 'declarative-agent';
        let activationCurrent = true;
        let registryCurrent = true;
        const transport = {
            kind: 'stdio' as const,
            executable: { kind: 'systemTool' as const, id: 'fixture-acp' },
        };
        const agent = {
            id: agentId,
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            definition: { kindVersion: 1 as const, id: agentId, ownedBackendIds: [] },
            richDefinition: {
                provenance: 'external' as const,
                definition: {
                    id: agentId,
                    title: 'Declarative Agent',
                    runtime: { kind: 'acp' as const, transport },
                    primary: 'sessions' as const,
                    capabilities: {
                        sessions: { open: ['create' as const], delivery: ['newTurn' as const], cancel: true },
                    },
                },
            },
            pluginId,
            sourceSpec: {
                kind: 'path' as const,
                locator: `/plugins/${pluginId}`,
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
                resolvedVersion: '2.3.4',
            },
        };
        const observation = createObservationContribution();
        const externalSessionHooks = createExternalSessionHooksContribution();
        const externalSessionTakeover: AgentExternalSessionTakeoverContribution =
            Object.freeze({
                resolveLaunch: async () => ({
                    ok: true as const,
                    value: { directory: '/tmp/declarative-agent' },
                }),
            });
        const auxiliaryRetirement = new AbortController();
        const registered = createTargetAgentRuntimeRegistry({
            agents: [{ id: agentId, pluginId }],
            activationTargets: [target(pluginId)],
            targetRegistrations: [observationRegistration({
                pluginId,
                localId: agentId,
                observation,
                externalSessionHooks,
                externalSessionTakeover,
            })],
            isGenerationActive: () => activationCurrent,
            retirementSignal: auxiliaryRetirement.signal,
            onDuplicate: vi.fn(),
        });

        const registry = createDeclarativeAcpAgentRuntimeRegistry({
            agents: [agent],
            registered,
            generation: 'generation-9',
            isGenerationActive: () => registryCurrent,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
        });

        const lease = registry.get(agentId);
        expect(lease).toMatchObject({
            pluginId,
            agentId,
            hasPrimaryRuntime: true,
        });
        expect(lease?.externalSessions).toBe(registered.get(agentId)?.externalSessions);
        expect(lease?.externalSessionObservation)
            .toBe(registered.get(agentId)?.externalSessionObservation);
        expect(lease?.externalSessionHooks)
            .toBe(registered.get(agentId)?.externalSessionHooks);
        expect(lease?.externalSessionTakeover)
            .toBe(registered.get(agentId)?.externalSessionTakeover);
        if (!lease?.hasPrimaryRuntime) throw new Error('Expected a primary Agent runtime lease');
        const runtime = await lease.createRuntime({ signal: new AbortController().signal });
        expect(runtime.sessions).toBeDefined();
        const disposeWatch = vi.fn();
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: async () => ({ dispose() {} }),
            watchFile: () => disposeWatch,
        });
        await reconciler.reconcileLink({
            resource: {
                pluginId,
                agentLocalId: agentId,
                pluginGeneration: lease.generation,
                resourceKey: 'resource-1',
                retirementSignal: lease.retirementSignal,
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'fixture' },
                    remoteSessionId: 'native-session-1',
                    linkData: {},
                },
                changeObservation: 'watch_file_changes',
                watchFileChanges: { files: ['/tmp/declarative-agent-session.jsonl'] },
            },
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            },
            onFacts() {},
        });
        activationCurrent = false;
        auxiliaryRetirement.abort();
        await Promise.resolve();
        expect(disposeWatch).toHaveBeenCalledOnce();
        expect(lease.retirementSignal).toBe(auxiliaryRetirement.signal);
        await reconciler.dispose();
        expect(disposeWatch).toHaveBeenCalledOnce();
        expect(lease.isCurrent()).toBe(false);
        await expect(lease.createRuntime({ signal: new AbortController().signal }))
            .rejects.toThrow(/retired generation/i);
        activationCurrent = true;
        registryCurrent = false;
        expect(lease.isCurrent()).toBe(false);
    });

    it('settles retirement-bound observation before a non-cooperative late acquisition and disposes it once', async () => {
        vi.useFakeTimers();
        let settle!: (disposable: Readonly<{ dispose(): void }>) => void;
        let observedSignal: AbortSignal | undefined;
        let emit: ((event: never) => void) | undefined;
        let requestReconcile: (() => void) | undefined;
        let requestTranscriptRefresh: ((linkKey: string) => void) | undefined;
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        const dispose = vi.fn();
        const observation = createObservationContribution({
            acquire: ({
                signal,
                emit: emitValue,
                requestReconcile: requestReconcileValue,
                requestTranscriptRefresh: requestTranscriptRefreshValue,
            }) => {
                observedSignal = signal;
                emit = emitValue;
                requestReconcile = requestReconcileValue;
                requestTranscriptRefresh = requestTranscriptRefreshValue;
                markEntered();
                return new Promise((resolve) => {
                    settle = resolve;
                });
            },
        });
        const retirement = new AbortController();
        let current = true;
        const publish = vi.fn();
        const reconcile = vi.fn();
        const refresh = vi.fn();
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation })],
            isGenerationActive: () => current,
            retirementSignal: retirement.signal,
            onDuplicate: vi.fn(),
        });
        const lease = registry.get('assistant');
        if (!lease?.externalSessionObservation) throw new Error('Expected observation lease');

        const acquisition = lease.externalSessionObservation.observeResource({
            resourceKey: 'resource-1',
            signal: new AbortController().signal,
            emit: publish,
            requestReconcile: reconcile,
            requestTranscriptRefresh: refresh,
        });
        await entered;
        requestReconcile?.();
        requestTranscriptRefresh?.('link-1');
        expect(reconcile).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledWith('link-1');
        current = false;
        retirement.abort();
        expect(observedSignal?.aborted).toBe(true);
        emit?.({} as never);
        requestReconcile?.();
        requestTranscriptRefresh?.('link-1');
        expect(publish).not.toHaveBeenCalled();
        expect(reconcile).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();

        expect(await readPromiseStateAfterMicrotasks(acquisition)).toBe('rejected');
        expect(vi.getTimerCount()).toBe(0);
        settle({ dispose });
        await expect(acquisition).rejects.toThrow(/retired generation/u);
        await Promise.resolve();
        expect(dispose).toHaveBeenCalledOnce();
        retirement.abort();
        expect(dispose).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it('settles caller-cancelled observation without waiting for the plugin and releases listeners and deadline', async () => {
        vi.useFakeTimers();
        let settle!: (disposable: Readonly<{ dispose(): void }>) => void;
        let observedSignal: AbortSignal | undefined;
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        const dispose = vi.fn();
        const caller = new AbortController();
        const retirement = new AbortController();
        const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
        const retirementRemove = vi.spyOn(retirement.signal, 'removeEventListener');
        const observation = createObservationContribution({
            acquire: ({ signal }) => {
                observedSignal = signal;
                markEntered();
                return new Promise((resolve) => {
                    settle = resolve;
                });
            },
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation })],
            isGenerationActive: () => true,
            retirementSignal: retirement.signal,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        const acquisition = lease.observeResource({
            resourceKey: 'resource-1',
            signal: caller.signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        });
        await entered;
        caller.abort();

        expect(observedSignal?.aborted).toBe(true);
        expect(await readPromiseStateAfterMicrotasks(acquisition)).toBe('rejected');
        expect(callerRemove).toHaveBeenCalled();
        expect(retirementRemove).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        settle({ dispose });
        await expect(acquisition).rejects.toThrow(/cancelled/u);
        await Promise.resolve();
        expect(dispose).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it('bounds reconciliation at 15 seconds, ignores its late result, and releases listeners and deadline', async () => {
        vi.useFakeTimers();
        let settle!: (
            result: Awaited<
                ReturnType<AgentExternalSessionObservationContribution['reconcileResource']>
            >,
        ) => void;
        const caller = new AbortController();
        const retirement = new AbortController();
        const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
        const retirementRemove = vi.spyOn(retirement.signal, 'removeEventListener');
        const observation = createObservationContribution({
            reconcile: () => new Promise((resolve) => {
                settle = resolve;
            }),
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation })],
            isGenerationActive: () => true,
            retirementSignal: retirement.signal,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        const reconciliation = lease.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [{
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'fixture' },
                    remoteSessionId: 'native-session',
                    linkData: {},
                },
            }],
            signal: caller.signal,
        });
        await vi.advanceTimersByTimeAsync(14_999);
        expect(await readPromiseStateAfterMicrotasks(reconciliation)).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);

        expect(await readPromiseStateAfterMicrotasks(reconciliation)).toBe('rejected');
        await expect(reconciliation).rejects.toThrow(/timed out/u);
        expect(callerRemove).toHaveBeenCalled();
        expect(retirementRemove).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        settle({
            purpose: 'observation_evidence',
            outcomes: [{
                linkKey: 'link-1',
                facts: [{
                    kind: 'turn_phase',
                    evidenceClass: 'agent_native',
                    value: 'working',
                    observedAtMs: 1,
                    expiresAtMs: 2,
                }],
            }],
        });
        await Promise.resolve();
        await expect(reconciliation).rejects.toThrow(/timed out/u);
        vi.useRealTimers();
    });

    it('lets reconciler teardown finish before a non-cooperative observation settles and disposes the late observer once', async () => {
        vi.useFakeTimers();
        let settle!: (disposable: Readonly<{ dispose(): void }>) => void;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const dispose = vi.fn();
        const observation = createObservationContribution({
            acquire: () => {
                markStarted();
                return new Promise((resolve) => {
                    settle = resolve;
                });
            },
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: async (input) => await lease.observeResource({
                resourceKey: input.resource.resourceKey,
                signal: input.signal,
                emit: input.emit,
                requestReconcile: input.requestReconcile,
                requestTranscriptRefresh() {},
            }),
        });
        const admission = reconciler.reconcileLink({
            resource: {
                pluginId: 'happier.agent.fixture',
                agentLocalId: 'assistant',
                pluginGeneration: 'generation-7',
                resourceKey: 'resource-1',
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'fixture' },
                    remoteSessionId: 'native-session',
                    linkData: {},
                },
                changeObservation: 'observe_resource',
            },
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            },
            onFacts() {},
        });
        const admissionOutcome = admission.then(
            () => 'fulfilled' as const,
            (error: unknown) => {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toMatch(/cancelled/u);
                return 'rejected' as const;
            },
        );
        await started;

        const teardown = reconciler.dispose();
        expect(await readPromiseStateAfterMicrotasks(teardown)).toBe('fulfilled');
        await expect(admissionOutcome).resolves.toBe('rejected');
        expect(vi.getTimerCount()).toBe(0);

        settle({ dispose });
        await Promise.resolve();
        expect(dispose).toHaveBeenCalledOnce();
        await reconciler.dispose();
        expect(dispose).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it('retires an acquired observer exactly once without affecting a reloaded generation', async () => {
        const firstDispose = vi.fn();
        const secondDispose = vi.fn();
        const firstRetirement = new AbortController();
        const secondRetirement = new AbortController();
        let firstCurrent = true;
        const createRegistry = (
            generation: string,
            retirement: AbortController,
            isGenerationActive: () => boolean,
            dispose: () => void,
        ) => createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({
                generation,
                observation: createObservationContribution({
                    acquire: async () => ({ dispose }),
                }),
            })],
            isGenerationActive,
            retirementSignal: retirement.signal,
            onDuplicate: vi.fn(),
        });
        const first = createRegistry(
            'generation-7',
            firstRetirement,
            () => firstCurrent,
            firstDispose,
        ).get('assistant')?.externalSessionObservation;
        const second = createRegistry(
            'generation-8',
            secondRetirement,
            () => true,
            secondDispose,
        ).get('assistant')?.externalSessionObservation;
        if (!first || !second) throw new Error('Expected observation leases');

        const firstLease = await first.observeResource({
            resourceKey: 'resource-1',
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        });
        const secondLease = await second.observeResource({
            resourceKey: 'resource-1',
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        });
        firstCurrent = false;
        firstRetirement.abort();
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).not.toHaveBeenCalled();
        await firstLease.dispose();
        expect(firstDispose).toHaveBeenCalledOnce();
        await secondLease.dispose();
        secondRetirement.abort();
        expect(secondDispose).toHaveBeenCalledOnce();
    });

    it('sanitizes a rejecting observer disposal and retries the exact same cleanup', async () => {
        const dispose = vi.fn<() => Promise<void>>(async () => {
            throw new Error('plugin-private-observer-disposal-failure');
        });
        const observation = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({
                observation: createObservationContribution({
                    acquire: async () => ({ dispose }),
                }),
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!observation) throw new Error('Expected observation lease');

        const observer = await observation.observeResource({
            resourceKey: 'resource-1',
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        });

        let failure: unknown = null;
        try {
            await observer.dispose();
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
            'Agent External Session observation cleanup failed',
        );
        expect((failure as Error).message).not.toContain(
            'plugin-private-observer-disposal-failure',
        );
        // One physical disposal per attempt: the rejecting call is not repeated
        // inside the attempt that observed it.
        expect(dispose).toHaveBeenCalledOnce();

        // The observation reconciler deliberately retains an observer whose
        // disposal rejected so the next owned retirement retries it. Caching the
        // rejected attempt here would make that exact cleanup permanently
        // unreachable and leak the plugin-side resource for the daemon's lifetime.
        dispose.mockResolvedValueOnce(undefined);
        await expect(observer.dispose()).resolves.toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('retries the exact plugin observer cleanup through generation retirement after it rejects once', async () => {
        // Every wrapper between the observation reconciler and the plugin leaf has to
        // preserve one contract: a cleanup that rejected keeps its custody and can be
        // retried physically. Fixing only one of them reads as fixed and is not, so
        // this drives the real chain — generation abort, the generation-bound facade,
        // the reconciler's resource retirement, and the disposal owner.
        const retirement = new AbortController();
        const dispose = vi.fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('plugin-private-observer-disposal-failure'))
            .mockResolvedValue(undefined);
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({
                observation: createObservationContribution({
                    acquire: async () => ({ dispose }),
                }),
            })],
            isGenerationActive: () => !retirement.signal.aborted,
            retirementSignal: retirement.signal,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: async (input) => await lease.observeResource({
                resourceKey: input.resource.resourceKey,
                signal: input.signal,
                emit: input.emit,
                requestReconcile: input.requestReconcile,
                requestTranscriptRefresh() {},
            }),
        });
        await reconciler.reconcileLink({
            resource: {
                pluginId: 'happier.agent.fixture',
                agentLocalId: 'assistant',
                pluginGeneration: 'generation-7',
                resourceKey: 'resource-1',
                retirementSignal: retirement.signal,
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'fixture' },
                    remoteSessionId: 'native-session',
                    linkData: {},
                },
                changeObservation: 'observe_resource',
            },
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            },
            onFacts() {},
        });

        const unhandled: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            retirement.abort();
            // Let Node run its unhandled-rejection detection for this turn.
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
            expect(dispose).toHaveBeenCalledTimes(1);
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }

        await reconciler.dispose();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('bounds a non-cooperative observer disposal at the existing observation deadline', async () => {
        vi.useFakeTimers();
        try {
            const dispose = vi.fn(() => new Promise<void>(() => {}));
            const observation = createTargetAgentRuntimeRegistry({
                agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
                activationTargets: [target()],
                targetRegistrations: [observationRegistration({
                    observation: createObservationContribution({
                        acquire: async () => ({ dispose }),
                    }),
                })],
                isGenerationActive: () => true,
                retirementSignal: TEST_RETIREMENT_SIGNAL,
                onDuplicate: vi.fn(),
            }).get('assistant')?.externalSessionObservation;
            if (!observation) throw new Error('Expected observation lease');

            const observer = await observation.observeResource({
                resourceKey: 'resource-1',
                signal: new AbortController().signal,
                emit() {},
                requestReconcile() {},
                requestTranscriptRefresh() {},
            });
            const disposal = observer.dispose();

            await vi.advanceTimersByTimeAsync(14_999);
            expect(await readPromiseStateAfterMicrotasks(disposal)).toBe('pending');
            await vi.advanceTimersByTimeAsync(1);

            expect(await readPromiseStateAfterMicrotasks(disposal)).toBe('rejected');
            await expect(disposal).rejects.toThrow(
                'Agent External Session observation cleanup timed out after 15000ms',
            );
            expect(dispose).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('admits a replacement generation after retirement while old physical cleanup is bounded', async () => {
        vi.useFakeTimers();
        try {
            const firstRetirement = new AbortController();
            const secondRetirement = new AbortController();
            let firstCurrent = true;
            const firstDispose = vi.fn(() => new Promise<void>(() => {}));
            const secondDispose = vi.fn(async () => undefined);
            const first = createTargetAgentRuntimeRegistry({
                agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
                activationTargets: [target()],
                targetRegistrations: [observationRegistration({
                    generation: 'generation-7',
                    observation: createObservationContribution({
                        acquire: async () => ({ dispose: firstDispose }),
                    }),
                })],
                isGenerationActive: () => firstCurrent,
                retirementSignal: firstRetirement.signal,
                onDuplicate: vi.fn(),
            }).get('assistant')?.externalSessionObservation;
            const second = createTargetAgentRuntimeRegistry({
                agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
                activationTargets: [target()],
                targetRegistrations: [observationRegistration({
                    generation: 'generation-8',
                    observation: createObservationContribution({
                        acquire: async () => ({ dispose: secondDispose }),
                    }),
                })],
                isGenerationActive: () => true,
                retirementSignal: secondRetirement.signal,
                onDuplicate: vi.fn(),
            }).get('assistant')?.externalSessionObservation;
            if (!first || !second) throw new Error('Expected observation leases');

            const reconciler = createExternalSessionObservationReconciler({
                acquireObserver: async (input) => await (
                    input.resource.pluginGeneration === 'generation-7'
                        ? first
                        : second
                ).observeResource({
                    resourceKey: input.resource.resourceKey,
                    signal: input.signal,
                    emit: input.emit,
                    requestReconcile: input.requestReconcile,
                    requestTranscriptRefresh: input.requestTranscriptRefresh,
                }),
            });
            const link = {
                sessionId: 'session-1',
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'fixture' },
                    remoteSessionId: 'native-session',
                    linkData: {},
                },
                changeObservation: 'observe_resource' as const,
            };
            const demand = {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            };

            await expect(reconciler.reconcileLink({
                resource: {
                    pluginId: 'happier.agent.fixture',
                    agentLocalId: 'assistant',
                    pluginGeneration: 'generation-7',
                    resourceKey: 'resource-1',
                    retirementSignal: firstRetirement.signal,
                },
                link: { ...link, linkGeneration: 'link-generation-1' },
                demand,
                onFacts() {},
            })).resolves.toEqual({ state: 'observing' });

            firstCurrent = false;
            firstRetirement.abort();
            expect(firstDispose).toHaveBeenCalledOnce();

            await expect(reconciler.reconcileLink({
                resource: {
                    pluginId: 'happier.agent.fixture',
                    agentLocalId: 'assistant',
                    pluginGeneration: 'generation-8',
                    resourceKey: 'resource-1',
                    retirementSignal: secondRetirement.signal,
                },
                link: { ...link, linkGeneration: 'link-generation-2' },
                demand,
                onFacts() {},
            })).resolves.toEqual({ state: 'observing' });

            await vi.advanceTimersByTimeAsync(15_000);
            await reconciler.dispose();
            expect(firstDispose).toHaveBeenCalledOnce();
            expect(secondDispose).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('admits only strict bounded observation descriptors, batches, and reconciliation DTOs', async () => {
        const reconcileResource = vi.fn(async () => ({
            outcomes: [],
        }) as unknown as AgentExternalSessionObservationReconcileResultV1);
        const observation: AgentExternalSessionObservationContribution = Object.freeze({
            describeResource: () => ({
                resourceKey: 'resource-1',
                linkKey: 'link-1',
                changeObservation: 'observe_resource',
            }) as unknown as ReturnType<
                AgentExternalSessionObservationContribution['describeResource']
            >,
            observeResource: async ({ emit }) => {
                emit({ items: [] });
                return { dispose() {} };
            },
            reconcileResource,
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        expect(() => lease.describeResource({
            source: { kind: 'fixture' },
            remoteSessionId: 'native-session',
            linkData: {},
        })).toThrow();
        await expect(lease.observeResource({
            resourceKey: 'resource-1',
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        })).rejects.toThrow();
        await expect(lease.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [{
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'fixture' },
                    remoteSessionId: 'native-session',
                    linkData: {},
                },
            }],
            signal: new AbortController().signal,
        })).rejects.toThrow();
        await expect(lease.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [],
            signal: new AbortController().signal,
        })).rejects.toThrow();
        expect(reconcileResource).toHaveBeenCalledOnce();
    });

    it('rejects an over-bound observation reconciliation result', async () => {
        const observation = createObservationContribution();
        const overBound: AgentExternalSessionObservationContribution = Object.freeze({
            ...observation,
            reconcileResource: async () => ({
                purpose: 'observation_evidence' as const,
                outcomes: Array.from({ length: 257 }, (_, index) => ({
                    linkKey: `link-${index}`,
                    facts: [{
                        kind: 'retrieval_failed' as const,
                        evidenceClass: 'reconciliation' as const,
                        observedAtMs: 1,
                        axis: 'liveness' as const,
                    }],
                })),
            }),
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation: overBound })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        await expect(lease.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [{
                linkKey: 'link-1',
                linkedSource: {
                    source: { kind: 'fixture' },
                    remoteSessionId: 'native-session',
                    linkData: {},
                },
            }],
            signal: new AbortController().signal,
        })).rejects.toThrow();
    });

    it('requires one reconciliation outcome per requested link and canonicalizes plugin order', async () => {
        const outcome = (linkKey: string) => ({
            linkKey,
            facts: [{
                kind: 'retrieval_failed' as const,
                evidenceClass: 'reconciliation' as const,
                observedAtMs: 1,
                axis: 'liveness' as const,
            }],
        });
        let pluginOutcomes = [outcome('link-2'), outcome('link-1')];
        const observation = createObservationContribution({
            reconcile: async () => ({
                purpose: 'observation_evidence',
                outcomes: pluginOutcomes,
            }),
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');
        const request = {
            purpose: 'observation_evidence',
            resourceKey: 'resource-1',
            links: [
                {
                    linkKey: 'link-1',
                    linkedSource: {
                        source: { kind: 'fixture' },
                        remoteSessionId: 'native-session-1',
                        linkData: {},
                    },
                },
                {
                    linkKey: 'link-2',
                    linkedSource: {
                        source: { kind: 'fixture' },
                        remoteSessionId: 'native-session-2',
                        linkData: {},
                    },
                },
            ],
            signal: new AbortController().signal,
        } as const;

        await expect(lease.reconcileResource(request)).resolves.toEqual({
            purpose: 'observation_evidence',
            outcomes: [outcome('link-1'), outcome('link-2')],
        });

        pluginOutcomes = [outcome('link-1')];
        await expect(lease.reconcileResource(request)).rejects.toThrow(
            /must correspond exactly/u,
        );

        pluginOutcomes = [outcome('link-1'), outcome('link-extra')];
        await expect(lease.reconcileResource(request)).rejects.toThrow(
            /must correspond exactly/u,
        );

        pluginOutcomes = [
            outcome('link-1'),
            outcome('link-2'),
            outcome('link-extra'),
        ];
        await expect(lease.reconcileResource(request)).rejects.toThrow(
            /must correspond exactly/u,
        );

        pluginOutcomes = [outcome('link-1'), outcome('link-1')];
        await expect(lease.reconcileResource(request)).rejects.toThrow();
    });

    it('validates descriptor reconciliation purpose and exact link set before canonicalizing order', async () => {
        const descriptorOutcome = (linkKey: string) => ({
            kind: 'described' as const,
            descriptor: {
                resourceKey: 'resource-1',
                linkKey,
                changeObservation: 'observe_resource' as const,
            },
        });
        const unavailableOutcome = (linkKey: string) => ({
            kind: 'unavailable' as const,
            linkKey,
        });
        let pluginResult: AgentExternalSessionObservationReconcileResultV1 = {
            purpose: 'resource_descriptors',
            outcomes: [
                unavailableOutcome('link-2'),
                descriptorOutcome('link-1'),
            ],
        };
        const reconcile = vi.fn(async () => pluginResult);
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({
                observation: createObservationContribution({ reconcile }),
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');
        const request = {
            purpose: 'resource_descriptors',
            resourceKey: 'resource-1',
            links: [
                {
                    linkKey: 'link-1',
                    linkedSource: {
                        source: { kind: 'fixture' },
                        remoteSessionId: 'native-session-1',
                        linkData: {},
                    },
                },
                {
                    linkKey: 'link-2',
                    linkedSource: {
                        source: { kind: 'fixture' },
                        remoteSessionId: 'native-session-2',
                        linkData: {},
                    },
                },
            ],
            signal: new AbortController().signal,
        } as const;

        await expect(lease.reconcileResource(request)).resolves.toEqual({
            purpose: 'resource_descriptors',
            outcomes: [
                descriptorOutcome('link-1'),
                unavailableOutcome('link-2'),
            ],
        });
        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'resource_descriptors',
        }));

        pluginResult = {
            purpose: 'observation_evidence',
            outcomes: [{
                linkKey: 'link-1',
                facts: [{
                    kind: 'retrieval_failed',
                    evidenceClass: 'reconciliation',
                    observedAtMs: 1,
                    axis: 'liveness',
                }],
            }],
        };
        await expect(lease.reconcileResource(request)).rejects.toThrow(/purpose/u);

        pluginResult = {
            purpose: 'resource_descriptors',
            outcomes: [descriptorOutcome('link-1')],
        };
        await expect(lease.reconcileResource(request)).rejects.toThrow(
            /must correspond exactly/u,
        );

        pluginResult = {
            purpose: 'resource_descriptors',
            outcomes: [
                descriptorOutcome('link-1'),
                descriptorOutcome('link-extra'),
            ],
        };
        await expect(lease.reconcileResource(request)).rejects.toThrow(
            /must correspond exactly/u,
        );

        pluginResult = {
            purpose: 'resource_descriptors',
            outcomes: [
                descriptorOutcome('link-1'),
                descriptorOutcome('link-1'),
            ],
        };
        await expect(lease.reconcileResource(request)).rejects.toThrow();
    });

    it('rejects a malformed observer acquisition Disposable', async () => {
        const malformed = createObservationContribution({
            acquire: async () => ({ dispose: null }) as unknown as Readonly<{
                dispose(): void;
            }>,
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation: malformed })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        await expect(lease.observeResource({
            resourceKey: 'resource-1',
            signal: new AbortController().signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        })).rejects.toThrow(/invalid Disposable/u);
    });

    it('releases observation listeners and deadline after a synchronous plugin acquisition throw', async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const retirement = new AbortController();
        const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
        const retirementRemove = vi.spyOn(retirement.signal, 'removeEventListener');
        const failure = new Error('synchronous acquisition failure');
        const throwing = createObservationContribution({
            acquire: () => {
                throw failure;
            },
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [observationRegistration({ observation: throwing })],
            isGenerationActive: () => true,
            retirementSignal: retirement.signal,
            onDuplicate: vi.fn(),
        }).get('assistant')?.externalSessionObservation;
        if (!lease) throw new Error('Expected observation lease');

        await expect(lease.observeResource({
            resourceKey: 'resource-1',
            signal: caller.signal,
            emit() {},
            requestReconcile() {},
            requestTranscriptRefresh() {},
        })).rejects.toBe(failure);

        expect(callerRemove).toHaveBeenCalled();
        expect(retirementRemove).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('carries the immutable registration-ingress Provider binding snapshot into the generation lease', async () => {
        const originalPrepare = providerBinding.prepare;
        const originalMaterialize = providerBinding.materialize;
        const mutableProviderBinding = { ...providerBinding };
        const host = createContributionRegistrationHost({
            pluginId: 'happier.agent.fixture',
            generation: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant', target: { realm: 'daemon' } }],
            isGenerationCurrent: () => true,
        });
        const factory: AgentRuntimeFactory = async () => ({
            sessions: {
                open: async () => ({
                    send: async () => ({ status: 'admitted' }),
                    watch: () => ({ dispose() {} }),
                    dispose() {},
                }),
            },
        });
        host.api.agents.register('assistant', factory, {
            providerBinding: mutableProviderBinding,
        });
        const committed = host.commit();
        const [committedRegistration] = committed;
        if (
            committedRegistration?.family !== 'agents'
            || !committedRegistration.value.providerBinding
        ) {
            throw new Error('Expected committed Provider binding snapshot');
        }
        const committedProviderBinding = committedRegistration.value.providerBinding;

        mutableProviderBinding.adapterVersion = 2;
        mutableProviderBinding.prepare = () => ({ v: 1, materialization: 'configFile' });
        mutableProviderBinding.materialize = async () => ({ v: 1, kind: 'configFile', env: [], files: [] });

        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: committed.map((entry) => ({
                pluginId: 'happier.agent.fixture',
                generation: 'generation-7',
                registration: entry,
            })),
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant');

        const binding = lease?.providerBinding;
        if (!binding) throw new Error('Expected Provider binding lease');
        expect(binding).toBe(committedProviderBinding);
        expect(binding).toMatchObject({
            v: 1,
            adapterVersion: 1,
            prepare: expect.any(Function),
            materialize: expect.any(Function),
        });
        expect(binding.prepare).not.toBe(originalPrepare);
        expect(binding.materialize).not.toBe(originalMaterialize);
        expect(binding.prepare({
            v: 1,
            agentTargetKey: 'assistant',
            connectionId: 'connection-1',
        })).toEqual({ v: 1, materialization: 'spawnEnv' });
        await expect(binding.materialize({
            v: 1,
            binding: {
                v: 1,
                agentTargetKey: 'assistant',
                selection: {
                    connectionId: 'connection-1',
                    model: { id: 'model-1', name: 'Model 1' },
                },
                contributionKey: null,
                endpoint: {
                    endpointTemplateId: 'fixture',
                    normalizedUrl: 'https://example.com/v1',
                    protocol: 'openai-responses',
                    publicHeaders: {},
                },
                runtimeCredentialTransport: null,
                compatibilityFingerprint: 'fixture',
            },
            prepared: { v: 1, materialization: 'spawnEnv' },
            credential: { kind: 'none' },
        })).resolves.toEqual({ v: 1, kind: 'spawnEnv', env: [] });
        expect(Object.isFrozen(binding)).toBe(true);
    });

    it('carries the selected normalized startup-instructions capability into the runtime lease', () => {
        const definition = PluginContributesV2Schema.parse({
            agents: [{
                id: 'assistant',
                title: 'Assistant',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                        startupInstructions: { versions: [1] },
                    },
                },
            }],
        }).agents[0]!;
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{
                id: 'assistant',
                pluginId: 'happier.agent.fixture',
                richDefinition: {
                    provenance: 'external',
                    definition,
                },
            }],
            activationTargets: [target()],
            targetRegistrations: [registration({
                factory: async () => ({
                    sessions: {
                        open: async () => ({
                            send: async () => ({ status: 'admitted' }),
                            watch: () => ({ dispose() {} }),
                            dispose() {},
                        }),
                    },
                }),
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });

        expect(registry.get('assistant')?.startupInstructionsVersions)
            .toEqual([1]);
    });

    it('fails closed before and after asynchronous creation when the generation retires', async () => {
        let active = true;
        let resolveFactory: ((runtime: Awaited<ReturnType<AgentRuntimeFactory>>) => void) | undefined;
        const factory: AgentRuntimeFactory = () => new Promise((resolve) => {
            resolveFactory = resolve;
        });
        const lease = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.fixture' }],
            activationTargets: [target()],
            targetRegistrations: [registration({ factory })],
            isGenerationActive: () => active,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        }).get('assistant')!;
        if (!lease.hasPrimaryRuntime) throw new Error('Expected a primary Agent runtime lease');
        const signal = new AbortController().signal;

        active = false;
        await expect(lease.createRuntime({ signal })).rejects.toThrow(/retired generation/i);
        active = true;
        const pending = lease.createRuntime({ signal });
        active = false;
        resolveFactory?.({
            sessions: {
                open: async () => ({
                    send: async () => ({ status: 'admitted' }),
                    watch: () => ({ dispose() {} }),
                    dispose() {},
                }),
            },
        });
        await expect(pending).rejects.toThrow(/retired generation/i);
    });

    it('rejects invalid factory results and resolves duplicate owners deterministically', async () => {
        const invalidFactory: AgentRuntimeFactory = async () => Object.freeze({}) as never;
        const onDuplicate = vi.fn();
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'assistant', pluginId: 'happier.agent.alpha' }],
            activationTargets: [target('happier.agent.zeta'), target('happier.agent.alpha')],
            targetRegistrations: [
                registration({ pluginId: 'happier.agent.zeta', factory: invalidFactory }),
                registration({ pluginId: 'happier.agent.alpha', factory: invalidFactory }),
            ],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate,
        });

        expect(registry.get('assistant')?.pluginId).toBe('happier.agent.alpha');
        expect(onDuplicate).toHaveBeenCalledWith({
            agentId: 'assistant',
            firstPluginId: 'happier.agent.alpha',
            secondPluginId: 'happier.agent.zeta',
        });
        const lease = registry.get('assistant');
        if (!lease?.hasPrimaryRuntime) throw new Error('Expected a primary Agent runtime lease');
        await expect(lease.createRuntime({
            signal: new AbortController().signal,
        })).rejects.toThrow(/invalid Agent runtime/i);
    });

    it('publishes a manifest-local registration under its canonical Agent id', async () => {
        const pluginId = 'happier.agent.ohmypi';
        const factory = vi.fn<AgentRuntimeFactory>(async () => ({
            sessions: {
                open: async () => ({
                    send: async () => ({ status: 'admitted' }),
                    watch: () => ({ dispose() {} }),
                    dispose() {},
                }),
            },
        }));
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{
                id: 'ohMyPi',
                pluginId,
                identity: { pluginId, localId: 'ohmypi' },
            }],
            activationTargets: [target(pluginId)],
            targetRegistrations: [registration({
                pluginId,
                localId: 'ohmypi',
                factory,
            })],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        });

        expect(registry.has('ohmypi')).toBe(false);
        const lease = registry.get('ohMyPi');
        expect(lease).toMatchObject({
            agentId: 'ohMyPi',
            pluginId,
            hasPrimaryRuntime: true,
        });
        if (!lease?.hasPrimaryRuntime) throw new Error('Expected the canonical OhMyPi runtime lease');
        const signal = new AbortController().signal;
        await lease.createRuntime({ signal });
        expect(factory).toHaveBeenCalledWith({
            plugin: { id: pluginId, version: '0.0.0' },
            agent: { id: 'ohmypi' },
            signal,
        });
    });

    it('keeps executable Agent ownership aligned with the selected static contribution owner', () => {
        const selectedProviderBinding: AgentProviderBindingAdapter = Object.freeze({
            ...providerBinding,
            adapterVersion: 2,
        });
        const collidingProviderBinding: AgentProviderBindingAdapter = Object.freeze({
            ...providerBinding,
            adapterVersion: 3,
        });
        const factory: AgentRuntimeFactory = async () => ({
            sessions: {
                open: async () => ({
                    send: async () => ({ status: 'admitted' }),
                    watch: () => ({ dispose() {} }),
                    dispose() {},
                }),
            },
        });
        const selectedPluginId = 'happier.agent.zeta';
        const collidingPluginId = 'acme.agent.alpha';
        const input = {
            agents: [{ id: 'assistant', pluginId: selectedPluginId }],
            activationTargets: [target(selectedPluginId), target(collidingPluginId)],
            targetRegistrations: [
                registration({
                    pluginId: collidingPluginId,
                    factory,
                    providerBinding: collidingProviderBinding,
                }),
                registration({
                    pluginId: selectedPluginId,
                    factory,
                    providerBinding: selectedProviderBinding,
                }),
            ],
            isGenerationActive: () => true,
            retirementSignal: TEST_RETIREMENT_SIGNAL,
            onDuplicate: vi.fn(),
        };

        const lease = createTargetAgentRuntimeRegistry(input).get('assistant');

        expect(lease).toMatchObject({
            pluginId: selectedPluginId,
            providerBinding: selectedProviderBinding,
        });
        expect(input.onDuplicate).toHaveBeenCalledWith({
            agentId: 'assistant',
            firstPluginId: selectedPluginId,
            secondPluginId: collidingPluginId,
        });

        const selectedRuntimeUnavailable = createTargetAgentRuntimeRegistry({
            ...input,
            targetRegistrations: [registration({
                pluginId: collidingPluginId,
                factory,
                providerBinding: collidingProviderBinding,
            })],
        });
        expect(selectedRuntimeUnavailable.has('assistant')).toBe(false);
    });
});
