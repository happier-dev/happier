import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
    HostEventEnvelope,
    HostEventId,
    HostEventTarget } from '@happier-dev/plugin-sdk/events';
import type {
    McpClient as PluginMcpClient } from '@happier-dev/plugin-sdk/mcp';
import type {
    PluginServices,
    PluginServiceId } from '@happier-dev/plugin-sdk';
import type {
    DaemonDatabaseStorageScope,
    StorageScopeService,
} from '@happier-dev/plugin-sdk/storage';

import {
    decodeRunnerDaemonPluginServiceWireValueV1,
    encodeRunnerDaemonPluginServiceWireValueV1,
    RunnerDaemonManagedProviderBootstrapV1Schema,
    type RunnerDaemonPluginServiceOperationV1,
    type RunnerDaemonPluginServiceWireInput,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import {
    prepareRunnerDaemonPluginServices,
} from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import {
    createPluginInvocationActionsService,
} from '@/plugins/runtime/invocation/services/actions';
import {
    createPluginActionCallerMaterializationFixture,
} from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import {
    createStablePluginExecService,
} from '@/plugins/runtime/invocation/services/exec';
import {
    createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import {
    createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
    createRunnerDaemonPluginServicesHost,
    type RunnerDaemonCurrentGlobalExternalSessionsOwner,
    type RunnerDaemonCurrentGlobalMcpOwner,
} from './runnerDaemonPluginServicesHost';

const binding = createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'fixture.plugin',
    pluginVersion: '1.0.0',
    agentId: 'fixture.agent',
    localAgentId: 'agent',
    immutableGenerationId: 'generation-1',
    locator: {
        module: './agent.js',
        export: 'createRuntime',
        runtimeApiVersion: 1,
    },
    normalizedModulePath: '/plugins/fixture/agent.js',
    loadMode: 'immutable-js',
});

const sessionId = 'session-1';
const runner = {
    pid: 123,
    processStartTimeMs: 1,
    processCommandHash: '4'.repeat(64),
    snapshotIdentity: 'snapshot-1',
};
const direct = Object.freeze({
    sessionId,
    runner,
    retainedAgent: binding,
});
const fixturePluginMaterialization = createPluginActionCallerMaterializationFixture(
    'fixture.plugin',
);

const witness = Object.freeze({
    inputId: 'input-1',
    turnId: 'turn-1',
    userMessageSeq: 1,
    userMessageSeqs: [1],
});

function unavailableDaemonDatabaseScope(scope: StorageScopeService): DaemonDatabaseStorageScope {
    return Object.freeze({
        ...scope,
        async database(): Promise<never> {
            throw new Error('daemon database was not expected by this runner service fixture');
        },
    });
}

function managedProviderBootstrap() {
    return RunnerDaemonManagedProviderBootstrapV1Schema.parse({
        v: 1,
        scope: {
            v: 1,
            sessionId: 'session-1',
            runtimeBindingBasis: {
                v: 1,
                agentTargetKey: 'fixture.agent',
                connectionId: 'provider-connection-1',
                contributionKey: 'provider.plugin/gateway',
                runtimeCredentialTransport: null,
                prepared: { v: 1, materialization: 'spawnEnv' },
                adapterVersion: 1,
                agentSupport: {
                    acceptsProtocols: ['anthropic'],
                    required: { streaming: true },
                    credentialSupport: {
                        supportsNoAuth: true,
                        apiKeyTransports: [],
                    },
                    authIsolation: {
                        suppressConnectedServiceIds: [],
                        ownedEnvKeys: [],
                    },
                    materialization: 'spawnEnv',
                    applyPolicy: 'restart_session',
                    supportsFreeformModelIds: true,
                },
                deployment: {
                    kind: 'managedLocal',
                    implementationIdentity: {
                        pluginId: 'provider.plugin',
                        localId: 'gateway',
                    },
                    managedRuntime: {
                        kind: 'managed',
                        dependencies: [],
                        endpointTemplateIds: ['messages'],
                        connectedAccounts: [],
                        requestAuthUses: [],
                    },
                    purposeBindings: { v: 1, bindings: [] },
                },
                endpoint: {
                    endpointTemplateId: 'messages',
                    protocol: 'anthropic',
                    publicHeaders: {},
                },
                credentialAuthorization: {
                    connectionSecurityFingerprint: 'connection-security',
                    grantFingerprint: 'grant',
                },
            },
            pluginId: 'provider.plugin',
            providerLocalId: 'gateway',
            activationGeneration: '17',
            immutableGenerationId: 'provider-generation-17',
            manifestAuthority: 'external',
            operationClaimId: 'session-provider-claim-1',
        },
        requestAuth: null,
        providerPluginHardRevocationRevisionAtAdmission: 3,
    });
}

function requestBase(options?: Readonly<{ lifecycle?: boolean }>) {
    return {
        requestId: crypto.randomUUID(),
        invocationId: 'invocation-1',
        ...(options?.lifecycle ? {} : { witness }),
    };
}

function isWireRecord(
    value: RunnerDaemonPluginServiceWireInput,
): value is Readonly<
    Record<string, RunnerDaemonPluginServiceWireInput>
> {
    return value !== null
        && typeof value === 'object'
        && !(value instanceof Uint8Array)
        && !Array.isArray(value);
}

describe('runner daemon PluginServices host', () => {
    it('projects retired runner authority as typed unavailable capability facts while effectful operations still reject', async () => {
        const services = createUnavailablePluginServices();
        const capabilities = vi.fn(
            services.sessions.external.capabilities,
        );
        let authorityCurrent = true;
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => authorityCurrent,
                    executeCurrentGlobalAction: async () => null,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions: Object.freeze({
                        ...services.sessions.external,
                        capabilities,
                    }),
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });

        authorityCurrent = false;
        const result = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_sessions.external.capabilities_v1',
                ...requestBase(),
            },
        });

        expect(decodeRunnerDaemonPluginServiceWireValueV1(
            result.value,
        )).toEqual({
            list: {
                status: 'unavailable',
                code: 'plugin_generation_retired',
            },
            attach: {
                status: 'unavailable',
                code: 'plugin_generation_retired',
            },
            takeover: {
                status: 'unavailable',
                code: 'plugin_generation_retired',
            },
            transcript: {
                status: 'unavailable',
                code: 'plugin_generation_retired',
            },
            follow: {
                status: 'unavailable',
                code: 'plugin_generation_retired',
            },
        });
        expect(capabilities).not.toHaveBeenCalled();
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_sessions.external.list_v1',
                ...requestBase(),
            },
        })).rejects.toMatchObject({
            code: 'plugin_services_turn_authority_unavailable',
        });
    });

    it('retires an invocation before reusing its id under changed direct runner correspondence', async () => {
        const services = createUnavailablePluginServices();
        const disposals: Array<ReturnType<typeof vi.fn>> = [];
        const createInvocation = vi.fn(async () => {
            const dispose = vi.fn();
            disposals.push(dispose);
            return {
                services,
                resourceDescriptors: {},
                subscriptionCapabilities: {
                    settingsWatch: false,
                    eventSubscriptions: [],
                    resourceWatches: [],
                    notificationPreferencesWatch: false,
                },
                dispose,
                authorizeOperation: () => true,
                executeCurrentGlobalAction: async () => null,
                currentGlobalMcp: services.mcp,
                currentGlobalExternalSessions:
                    services.sessions.external,
            };
        });
        const host = createRunnerDaemonPluginServicesHost({
            createInvocation,
        });
        const prepare = {
            kind: 'plugin_services.prepare_v1' as const,
            ...requestBase({ lifecycle: true }),
        };

        await host.dispatch({ ...direct, operation: prepare });
        const replacementRunner = {
            ...runner,
            processStartTimeMs: runner.processStartTimeMs + 1,
        };
        await host.dispatch({
            sessionId,
            runner: replacementRunner,
            retainedAgent: binding,
            operation: prepare,
        });

        expect(disposals[0]).toHaveBeenCalledOnce();
        expect(createInvocation).toHaveBeenNthCalledWith(1, {
            ...direct,
            invocationId: prepare.invocationId,
            witness: undefined,
            signal: expect.any(AbortSignal),
        });
        expect(createInvocation).toHaveBeenNthCalledWith(2, {
            sessionId,
            runner: replacementRunner,
            retainedAgent: binding,
            invocationId: prepare.invocationId,
            witness: undefined,
            signal: expect.any(AbortSignal),
        });
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.close_v1',
                ...requestBase({ lifecycle: true }),
            },
        })).rejects.toMatchObject({
            code: 'plugin_services_invocation_unavailable',
        });
    });

    it('disposes a created invocation that settles after host retirement without installing it', async () => {
        const services = createUnavailablePluginServices();
        let releaseCreation!: () => void;
        const creationGate = new Promise<void>((resolve) => {
            releaseCreation = resolve;
        });
        const creation = { signal: null as AbortSignal | null };
        const dispose = vi.fn(async () => undefined);
        const createInvocation = vi.fn(async (params: Readonly<{
            signal: AbortSignal;
        }>) => {
            creation.signal = params.signal;
            await creationGate;
            return {
                services,
                resourceDescriptors: {},
                subscriptionCapabilities: {
                    settingsWatch: false,
                    eventSubscriptions: [],
                    resourceWatches: [],
                    notificationPreferencesWatch: false,
                },
                dispose,
                authorizeOperation: () => true,
                executeCurrentGlobalAction: async () => null,
                currentGlobalMcp: services.mcp,
                currentGlobalExternalSessions: services.sessions.external,
            };
        });
        const host = createRunnerDaemonPluginServicesHost({
            createInvocation,
        });
        const preparation = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        await vi.waitFor(() => expect(createInvocation).toHaveBeenCalledOnce());

        const hostDisposal = host.dispose();
        releaseCreation();

        await expect(preparation).rejects.toMatchObject({
            code: 'plugin_services_host_disposed',
        });
        await expect(hostDisposal).resolves.toBeUndefined();
        expect(creation.signal?.aborted).toBe(true);
        expect(dispose).toHaveBeenCalledOnce();
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        })).rejects.toMatchObject({
            code: 'plugin_services_host_disposed',
        });
    });

    it('settles External Sessions follow delivery and close through the subscription carrier', async () => {
        const unavailable = createUnavailablePluginServices();
        let publishFollowEvent!:
            Parameters<
                RunnerDaemonCurrentGlobalExternalSessionsOwner[
                    'followTranscript'
                ]
            >[2];
        let finishFollowDisposal!: () => void;
        const followDisposal = new Promise<void>((resolve) => {
            finishFollowDisposal = resolve;
        });
        const disposeFollow = vi.fn(async () => {
            await followDisposal;
        });
        let registrationDeliverySettled = false;
        const followTranscript = vi.fn(async (
            ref: Parameters<
                RunnerDaemonCurrentGlobalExternalSessionsOwner[
                    'followTranscript'
                ]
            >[0],
            _options: Parameters<
                RunnerDaemonCurrentGlobalExternalSessionsOwner[
                    'followTranscript'
                ]
            >[1],
            listener: Parameters<
                RunnerDaemonCurrentGlobalExternalSessionsOwner[
                    'followTranscript'
                ]
            >[2],
        ) => {
            if (ref.remoteSessionId === 'remote-failure') {
                throw new Error('follow acquisition failed');
            }
            publishFollowEvent = listener;
            await listener({
                kind: 'data',
                items: [],
                fromCursor: null,
                nextCursor: 'cursor-0',
            });
            registrationDeliverySettled = true;
            return Object.freeze({
                status: 'following' as const,
                startingCursor: 'cursor-0',
                subscription: Object.freeze({
                    dispose: disposeFollow,
                }),
            });
        });
        const currentGlobalExternalSessions:
            RunnerDaemonCurrentGlobalExternalSessionsOwner =
            Object.freeze({
                ...unavailable.sessions.external,
                capabilities: vi.fn(async () => Object.freeze({
                    list: Object.freeze({ status: 'available' as const }),
                    attach: Object.freeze({ status: 'available' as const }),
                    takeover: Object.freeze({
                        status: 'unavailable' as const,
                        code: 'plugin_external_takeover_unavailable',
                    }),
                    transcript: Object.freeze({ status: 'available' as const }),
                    follow: Object.freeze({ status: 'available' as const }),
                })),
                followTranscript,
            });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services: unavailable,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction: async () => null,
                    currentGlobalMcp: unavailable.mcp,
                    currentGlobalExternalSessions,
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        const capabilitiesSignal = new AbortController().signal;
        const capabilities = await host.dispatch({
            ...direct,
            signal: capabilitiesSignal,
            operation: {
                kind: 'plugin_sessions.external.capabilities_v1',
                ...requestBase(),
            },
        });
        expect(decodeRunnerDaemonPluginServiceWireValueV1(
            capabilities.value,
        )).toMatchObject({
            list: { status: 'available' },
            attach: { status: 'available' },
            transcript: { status: 'available' },
            follow: { status: 'available' },
            takeover: {
                status: 'unavailable',
                code: 'plugin_external_takeover_unavailable',
            },
        });
        expect(currentGlobalExternalSessions.capabilities)
            .toHaveBeenCalledWith({ signal: capabilitiesSignal });
        const opening = await host.dispatch({
            ...direct,
            operation: {
                kind:
                    'plugin_sessions.external.follow_transcript.open_v1',
                ...requestBase(),
                subscriptionId: 'external-follow',
                ref: encodeRunnerDaemonPluginServiceWireValueV1({
                    agentId: 'fixture.agent',
                    sourceId: 'source-1',
                    remoteSessionId: 'remote-1',
                }),
                options:
                    encodeRunnerDaemonPluginServiceWireValueV1({}),
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(opening.value),
        ).toEqual({ status: 'opening' });

        const delivered = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'external-follow',
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(delivered.value),
        ).toMatchObject({
            kind:
                'plugin_sessions.external.follow_transcript.event_v1',
        });
        await Promise.resolve();
        expect(registrationDeliverySettled).toBe(false);

        const opened = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'external-follow',
                acknowledgement: 'settled',
            } as RunnerDaemonPluginServiceOperationV1,
        });
        const openedResult = await opened;
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(
                openedResult.value,
            ),
        ).toMatchObject({
            kind:
                'plugin_sessions.external.follow_transcript.opened_v1',
            result: {
                status: 'following',
                startingCursor: 'cursor-0',
            },
        });
        expect(registrationDeliverySettled).toBe(true);

        const openedAcknowledgement = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'external-follow',
                acknowledgement: 'settled',
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(
                openedAcknowledgement.value,
            ),
        ).toBeNull();
        const nextDelivery = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'external-follow',
            },
        });
        const rejectedAuthorDelivery = Promise.resolve(
            publishFollowEvent({
                kind: 'data',
                items: [],
                fromCursor: 'cursor-1',
                nextCursor: 'cursor-2',
            }),
        );
        const rejectedAuthorDeliveryExpectation = expect(
            rejectedAuthorDelivery,
        ).rejects.toMatchObject({
            code: 'plugin_external_follow_listener_failed',
        });
        await expect(nextDelivery).resolves.toMatchObject({
            kind: 'plugin_services.result_v1',
        });
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'external-follow',
                acknowledgement: 'rejected',
            },
        })).resolves.toMatchObject({
            kind: 'plugin_services.result_v1',
        });
        await rejectedAuthorDeliveryExpectation;

        let closeSettled = false;
        const close = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.close_v1',
                ...requestBase({ lifecycle: true }),
                subscriptionId: 'external-follow',
            },
        }).then(() => {
            closeSettled = true;
        });
        await Promise.resolve();
        expect(closeSettled).toBe(false);
        expect(disposeFollow).toHaveBeenCalledOnce();

        finishFollowDisposal();
        await expect(close).resolves.toBeUndefined();

        await host.dispatch({
            ...direct,
            operation: {
                kind:
                    'plugin_sessions.external.follow_transcript.open_v1',
                ...requestBase(),
                subscriptionId: 'external-follow-failed',
                ref: encodeRunnerDaemonPluginServiceWireValueV1({
                    agentId: 'fixture.agent',
                    sourceId: 'source-1',
                    remoteSessionId: 'remote-failure',
                }),
                options:
                    encodeRunnerDaemonPluginServiceWireValueV1({}),
            },
        });
        const failed = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'external-follow-failed',
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(failed.value),
        ).toMatchObject({
            kind:
                'plugin_sessions.external.follow_transcript.opened_v1',
            result: {
                status: 'failed',
                code: 'plugin_external_follow_failed',
                message: 'follow acquisition failed',
            },
        });
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'external-follow-failed',
                acknowledgement: 'settled',
            },
        })).resolves.toMatchObject({
            kind: 'plugin_services.result_v1',
        });
    });

    it('keeps follow disposer custody across acquisition-close races and rejected cleanup retries', async () => {
        const unavailable = createUnavailablePluginServices();
        let settleLateFollow!: () => void;
        const lateFollow = new Promise<void>((resolve) => {
            settleLateFollow = resolve;
        });
        const disposeLate = vi.fn(async () => undefined);
        const disposeRetry = vi.fn()
            .mockRejectedValueOnce(new Error('physical follow disposal rejected'))
            .mockResolvedValueOnce(undefined);
        const followTranscript: RunnerDaemonCurrentGlobalExternalSessionsOwner[
            'followTranscript'
        ] = vi.fn(async (ref) => {
            if (ref.remoteSessionId === 'late') await lateFollow;
            return Object.freeze({
                status: 'following' as const,
                startingCursor: null,
                subscription: Object.freeze({
                    dispose: ref.remoteSessionId === 'late'
                        ? disposeLate
                        : disposeRetry,
                }),
            });
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services: unavailable,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction: async () => null,
                    currentGlobalMcp: unavailable.mcp,
                    currentGlobalExternalSessions: Object.freeze({
                        ...unavailable.sessions.external,
                        followTranscript,
                    }),
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        const open = async (subscriptionId: string, remoteSessionId: string) => {
            await host.dispatch({
                ...direct,
                operation: {
                    kind:
                        'plugin_sessions.external.follow_transcript.open_v1',
                    ...requestBase(),
                    subscriptionId,
                    ref: encodeRunnerDaemonPluginServiceWireValueV1({
                        agentId: 'fixture.agent',
                        sourceId: 'source-1',
                        remoteSessionId,
                    }),
                    options:
                        encodeRunnerDaemonPluginServiceWireValueV1({}),
                },
            });
        };
        const close = async (subscriptionId: string) => await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.subscription.close_v1',
                ...requestBase({ lifecycle: true }),
                subscriptionId,
            },
        });

        await open('late-follow', 'late');
        let lateCloseSettled = false;
        const lateClose = close('late-follow').finally(() => {
            lateCloseSettled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(lateCloseSettled).toBe(false);
        settleLateFollow();
        await expect(lateClose).resolves.toMatchObject({
            kind: 'plugin_services.result_v1',
        });
        expect(disposeLate).toHaveBeenCalledOnce();

        await open('retry-follow', 'retry');
        await vi.waitFor(() => expect(followTranscript).toHaveBeenCalledTimes(2));
        await expect(close('retry-follow')).rejects.toThrow(
            'physical follow disposal rejected',
        );
        await expect(close('retry-follow')).resolves.toMatchObject({
            kind: 'plugin_services.result_v1',
        });
        expect(disposeRetry).toHaveBeenCalledTimes(2);
    });

    it('routes MCP lookup through the current-global owner and keeps the selected client for later requests', async () => {
        const services = createUnavailablePluginServices();
        const list = vi.fn(async () => ({ items: [] }));
        const discover = vi.fn(async () => ({ items: [] }));
        const listTools = vi.fn(async () => ({
            items: [{
                name: 'selected-generation-tool',
                inputSchema: { type: 'object' as const },
            }],
        }));
        let finishClientDisposal!: () => void;
        const clientDisposal = new Promise<void>((resolve) => {
            finishClientDisposal = resolve;
        });
        const disposeClient = vi.fn(async () => {
            await clientDisposal;
        });
        const connect = vi.fn(async () => Object.freeze({
            listTools,
            async callTool() { return null; },
            async listResources() { return { items: [] }; },
            async listResourceTemplates() { return { items: [] }; },
            async readResource() { return { contents: [] }; },
            async subscribeResource() { return { dispose() {} }; },
            async listPrompts() { return { items: [] }; },
            async getPrompt() { return { messages: [] }; },
            dispose: disposeClient,
        }));
        const currentGlobalMcp: RunnerDaemonCurrentGlobalMcpOwner =
            Object.freeze({ list, discover, connect });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction: async () => null,
                    currentGlobalMcp,
                    currentGlobalExternalSessions:
                        services.sessions.external,
                };
            },
        });

        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_mcp.list_v1',
                ...requestBase(),
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_mcp.discover_v1',
                ...requestBase(),
                provider: {
                    pluginId: 'current.plugin',
                    localId: 'discovery',
                },
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_mcp.connect_v1',
                ...requestBase(),
                clientId: 'selected-client',
                ref: {
                    pluginId: 'current.plugin',
                    localId: 'server',
                },
                elicitation: { mode: 'reject' },
            },
        });
        const tools = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_mcp.client.list_tools_v1',
                ...requestBase(),
                clientId: 'selected-client',
            },
        });
        expect(decodeRunnerDaemonPluginServiceWireValueV1(tools.value))
            .toMatchObject({
                items: [{ name: 'selected-generation-tool' }],
            });
        let closeSettled = false;
        const close = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_mcp.client.close_v1',
                ...requestBase(),
                clientId: 'selected-client',
            },
        }).then(() => {
            closeSettled = true;
        });
        await vi.waitFor(() => expect(disposeClient)
            .toHaveBeenCalledTimes(1));
        expect(closeSettled).toBe(false);
        finishClientDisposal();
        await close;

        expect(list).toHaveBeenCalledTimes(1);
        expect(discover).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(listTools).toHaveBeenCalledTimes(1);
        expect(disposeClient).toHaveBeenCalledTimes(1);
    });

    it('awaits every MCP client before surfacing invocation disposal failure', async () => {
        const services = createUnavailablePluginServices();
        const firstFailure = new Error('first MCP cleanup failed');
        const disposeFirstClient = vi.fn(async () => {
            throw firstFailure;
        });
        let finishSecondClientDisposal!: () => void;
        const secondClientDisposal = new Promise<void>((resolve) => {
            finishSecondClientDisposal = resolve;
        });
        const disposeSecondClient = vi.fn(async () => {
            await secondClientDisposal;
        });
        const clients = [disposeFirstClient, disposeSecondClient].map(
            (dispose) => Object.freeze({
                async listTools() { return { items: [] }; },
                async callTool() { return null; },
                async listResources() { return { items: [] }; },
                async listResourceTemplates() { return { items: [] }; },
                async readResource() { return { contents: [] }; },
                async subscribeResource() {
                    return { dispose() {} };
                },
                async listPrompts() { return { items: [] }; },
                async getPrompt() { return { messages: [] }; },
                dispose,
            } satisfies PluginMcpClient),
        );
        const connect = vi.fn(async () => {
            const client = clients.shift();
            if (!client) throw new Error('No MCP client available');
            return client;
        });
        const disposeInvocationOwner = vi.fn();
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose: disposeInvocationOwner,
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction: async () => null,
                    currentGlobalMcp: Object.freeze({
                        list: async () => ({ items: [] }),
                        discover: async () => ({ items: [] }),
                        connect,
                    }),
                    currentGlobalExternalSessions:
                        services.sessions.external,
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        for (const clientId of ['first-client', 'second-client']) {
            await host.dispatch({
                ...direct,
                operation: {
                    kind: 'plugin_mcp.connect_v1',
                    ...requestBase(),
                    clientId,
                    ref: {
                        pluginId: 'current.plugin',
                        localId: 'server',
                    },
                    elicitation: { mode: 'reject' },
                },
            });
        }

        let closeSettled = false;
        const close = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.close_v1',
                ...requestBase({ lifecycle: true }),
            },
        }).finally(() => {
            closeSettled = true;
        });
        await vi.waitFor(() => {
            expect(disposeFirstClient).toHaveBeenCalledOnce();
            expect(disposeSecondClient).toHaveBeenCalledOnce();
        });
        expect(closeSettled).toBe(false);

        finishSecondClientDisposal();
        await expect(close).rejects.toBe(firstFailure);
        expect(disposeInvocationOwner).toHaveBeenCalledOnce();
    });

    it('retains an exact system-tool resolution across multiple launches in one invocation', async () => {
        const unavailable = createUnavailablePluginServices();
        const executable = Object.freeze({
            kind: 'systemTool' as const,
            id: 'codex-cli',
        });
        const resolveSystemTool = vi.fn(async () => ({
            grantId: 'codex-cli-grant',
            toolId: 'codex-cli',
            displayName: 'Codex CLI',
            source: 'system' as const,
            executablePath: '/daemon/codex',
            launch: {
                kind: 'binary' as const,
                executablePath: '/daemon/codex',
                args: [],
                env: {},
            },
        }));
        const exec = createStablePluginExecService({
            allowedExecutables: [executable],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable: async () => {
                throw new Error('an exact system-tool resolution must remain available');
            },
            resolvePath: async () => {
                throw new Error('cwd was not expected');
            },
            systemTools: { resolve: resolveSystemTool },
        });
        const services: PluginServices = Object.freeze({
            ...unavailable,
            availability(serviceId: PluginServiceId) {
                return serviceId === 'exec'
                    ? { status: 'available' as const }
                    : unavailable.availability(serviceId);
            },
            exec,
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction: async () => null,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions: services.sessions.external,
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        const resolution = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_exec.system_tools.resolve_v1',
                ...requestBase(),
                request: {
                    toolId: 'codex-cli',
                    purpose: 'Launch the Codex native app-server',
                },
            },
        });
        const decodedResolution = decodeRunnerDaemonPluginServiceWireValueV1(
            resolution.value,
        );
        expect(decodedResolution).toMatchObject({
            resolutionId: expect.any(String),
            result: { executable },
        });
        if (
            !isWireRecord(decodedResolution)
            || typeof decodedResolution.resolutionId !== 'string'
        ) {
            throw new Error('system-tool resolution id missing');
        }
        const systemToolResolutionId = decodedResolution.resolutionId;
        const authorize = async () => await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_exec.launch.authorize_v1',
                ...requestBase(),
                systemToolResolutionId,
                request: {
                    executable,
                    args: ['app-server'],
                },
            },
        });

        await expect(authorize()).resolves.toMatchObject({
            kind: 'plugin_services.result_v1',
        });
        await expect(authorize()).resolves.toMatchObject({
            kind: 'plugin_services.result_v1',
        });
        expect(resolveSystemTool).toHaveBeenCalledOnce();
    });

    it('preserves empty and non-empty binary inputs through canonical fetch and no-spawn exec authorization', async () => {
        const unavailable = createUnavailablePluginServices();
        const values = new Map<string, JsonValue>();
        const fetchBodies: Array<Uint8Array | undefined> = [];
        const scope: StorageScopeService = {
            consistency: () => ({
                kind: 'authoritativeSerializable',
            }),
            async get<T extends JsonValue = JsonValue>(key: string) {
                return (values.get(key) ?? null) as T | null;
            },
            async set(key, value) {
                values.set(key, value);
            },
            async delete(key) {
                values.delete(key);
            },
            async list() {
                return {
                    items: [...values.keys()].map((key) => ({ key })),
                };
            },
            async transaction(operation) {
                return await operation(scope);
            },
        };
        const release = vi.fn();
        const resolveExecutable = vi.fn(async () => ({
            command: '/daemon/resolved/executable',
            args: ['--daemon-prefix'],
            env: { DAEMON_RESOLVED: '1' },
            release,
        }));
        const exec = createStablePluginExecService({
            allowedExecutables: [{
                kind: 'managedDependency',
                id: 'fixture.adapter',
            }],
            allowedEnvKeys: ['SAFE_ENV'],
            environment: { SAFE_ENV: 'host' },
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            resolveExecutable,
            async resolvePath() {
                throw new Error('cwd was not expected');
            },
        });
        const watchDisposals = {
            settings: vi.fn(),
            events: vi.fn(),
            resources: vi.fn(),
            notifications: vi.fn(),
        };
        const eventDeliveryOutcomes: Array<Promise<
            | Readonly<{ status: 'fulfilled' }>
            | Readonly<{ status: 'rejected'; error: unknown }>
        >> = [];
        const observeEventDelivery = (
            delivery: void | Promise<void>,
        ): void => {
            eventDeliveryOutcomes.push(Promise.resolve(delivery).then(
                () => ({ status: 'fulfilled' as const }),
                (error: unknown) => ({
                    status: 'rejected' as const,
                    error,
                }),
            ));
        };
        const providerDescribe = vi.fn(async () => ({
            status: 'success' as const,
            connections: [],
            available: [],
            availableTruncated: false,
            discoveryCandidates: [],
            discoveryCandidatesTruncated: false,
            localInstallations: [],
            diagnostics: [],
            diagnosticsTruncated: false,
        }));
        const actionExecute = vi.fn(async () => ({
            ok: true as const,
            result: [],
        }));
        const currentActions = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'fixture.plugin', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    fixturePluginMaterialization.resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'cli',
                session: { id: 'session-1' },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: actionExecute },
            invokeContributedAction: vi.fn(),
        });
        const retainedGenerationActions =
            createPluginInvocationActionsService({
                seed: {
                    plugin: {
                        id: 'fixture.plugin',
                        version: '1.0.0',
                    },
                    resolveCurrentPluginMaterializationRef:
                        fixturePluginMaterialization.resolveCurrentPluginMaterializationRef,
                    generation: 'generation-1',
                    surface: 'cli',
                    session: { id: 'session-1' },
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => false,
                },
                actionExecutor: {
                    execute: vi.fn(async () => ({
                        ok: true as const,
                        result: [],
                    })),
                },
                invokeContributedAction: vi.fn(),
            });
        const services: PluginServices = Object.freeze<PluginServices>({
            ...unavailable,
            availability(serviceId: PluginServiceId) {
                return [
                    'storage',
                    'fetch',
                    'exec',
                    'actions',
                    'providers',
                    'settings',
                    'events',
                    'resources',
                    'notifications',
                    'connectedAccounts',
                ].includes(serviceId)
                    ? { status: 'available' as const }
                    : unavailable.availability(serviceId);
            },
            storage: {
                ephemeral: scope,
                daemonSession: scope,
                daemon: unavailableDaemonDatabaseScope(scope),
            },
            providers: Object.freeze({
                ...unavailable.providers,
                connections: Object.freeze({
                    ...unavailable.providers.connections,
                    describe: providerDescribe,
                }),
            }),
            settings: {
                forScope(
                    scope: Parameters<PluginServices['settings']['forScope']>[0],
                ) {
                    return {
                async snapshot() {
                    return { scope, revision: 'settings-1', values: {} };
                },
                async get() {
                    return null;
                },
                async set() {
                    return { scope, revision: 'settings-2' };
                },
                async reset() {
                    return { scope, revision: 'settings-2' };
                },
                describe() {
                    return [];
                },
                watch(
                    listener: Parameters<
                        ReturnType<PluginServices['settings']['forScope']>['watch']
                    >[0],
                ) {
                    listener({
                        scope,
                        revision: 'settings-1',
                        changedIds: ['theme'],
                        values: { theme: 'dark' },
                    });
                    listener({
                        scope,
                        revision: 'settings-2',
                        changedIds: ['theme'],
                        values: { theme: 'light' },
                    });
                    return {
                        dispose: watchDisposals.settings,
                    };
                },
                    };
                },
            } satisfies PluginServices['settings'],
            events: {
                plugin: {
                    async emit() {
                        return {
                            status: 'admitted' as const,
                            sequence: 1,
                            subscriberCount: 1,
                        };
                    },
                    subscribe<T extends JsonValue>(
                        event: Readonly<{
                            pluginId: string;
                            localId: string;
                        }>,
                        listener: (
                            event: Readonly<{
                                ref: Readonly<{
                                    pluginId: string;
                                    localId: string;
                                }>;
                                payload: T;
                                sequence: number;
                            }>,
                        ) => void | Promise<void>,
                    ) {
                        observeEventDelivery(listener({
                            ref: event,
                            // The wire fixture supplies JSON independently of the caller-selected payload type.
                            payload: { ready: true } as unknown as T,
                            sequence: 2,
                        }));
                        observeEventDelivery(listener({
                            ref: event,
                            payload: { ready: false } as unknown as T,
                            sequence: 3,
                        }));
                        return {
                            dispose: watchDisposals.events,
                        };
                    },
                },
                host: unavailable.events.host,
            },
            resources: {
                describe(
                    id: Parameters<
                        PluginServices['resources']['describe']
                    >[0],
                ) {
                    return {
                        id,
                        kind: 'prompt' as const,
                        contentType: 'text/plain',
                        digest: 'resource-1',
                        size: 2,
                    };
                },
                async read() {
                    return {
                        kind: 'prompt' as const,
                        contentType: 'text/plain',
                        digest: 'resource-1',
                        bytes: new Uint8Array([111, 107]),
                    };
                },
                watch(
                    _id: Parameters<
                        PluginServices['resources']['watch']
                    >[0],
                    listener: Parameters<
                        PluginServices['resources']['watch']
                    >[1],
                ) {
                    listener({ digest: 'resource-2' });
                    listener({ digest: 'resource-3' });
                    return {
                        dispose: watchDisposals.resources,
                    };
                },
            },
            notifications: {
                async send() {
                    return { deliveries: [], replayed: false };
                },
                async listChannels() {
                    return { items: [] };
                },
                async listCategories() {
                    return { items: [] };
                },
                async preferences(
                    categoryId: Parameters<
                        PluginServices['notifications']['preferences']
                    >[0],
                ) {
                    return {
                        categoryId,
                        enabled: true,
                        channelIds: ['desktop'],
                        revision: 'notifications-1',
                    };
                },
                watchPreferences(
                    categoryId: Parameters<
                        PluginServices['notifications'][
                            'watchPreferences'
                        ]
                    >[0],
                    listener: Parameters<
                        PluginServices['notifications'][
                            'watchPreferences'
                        ]
                    >[1],
                ) {
                    listener({
                        categoryId,
                        enabled: true,
                        channelIds: ['desktop'],
                        revision: 'notifications-1',
                    });
                    listener({
                        categoryId,
                        enabled: false,
                        channelIds: [],
                        revision: 'notifications-2',
                    });
                    return {
                        dispose:
                            watchDisposals.notifications,
                    };
                },
            },
            http: {
                ...unavailable.http,
                async request(
                    request: Parameters<
                        PluginServices['http']['request']
                    >[0],
                ) {
                    fetchBodies.push(request.body);
                    return {
                        status: 200,
                        finalUrl: request.url,
                        headers: {},
                        body: new Uint8Array(),
                    };
                },
            },
            exec,
            actions: retainedGenerationActions,
            connectedAccounts: {
                async getBinding() {
                    return null;
                },
                async requestSelection() {
                    throw new Error('selection was not expected');
                },
                async materialize() {
                    throw new Error('materialize was not expected');
                },
                listAccounts: async () => {
                    throw new Error('Connected Account listing is outside this fixture');
                },
                materializeListedAccount: async () => {
                    throw new Error('Exact-listed Connected Account materialization is outside this fixture');
                },
                watch(
                    _purpose: string,
                    listener: Parameters<
                        PluginServices[
                            'connectedAccounts'
                        ]['watch']
                    >[1],
                ) {
                    queueMicrotask(() => listener({ kind: 'resync' }));
                    return { dispose: vi.fn() };
                },
            },
        });
        const disposeInvocation = vi.fn();
        const authorizeOperation = vi.fn(
            (candidate: typeof witness | undefined) =>
                candidate?.inputId === witness.inputId
                && candidate.turnId === witness.turnId
                && candidate.userMessageSeq === witness.userMessageSeq
                && JSON.stringify(candidate.userMessageSeqs)
                    === JSON.stringify(witness.userMessageSeqs),
        );
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation(params) {
                expect(params).toEqual({
                    ...direct,
                    invocationId: 'invocation-1',
                    witness,
                    signal: expect.any(AbortSignal),
                });
                return {
                    services,
                    resourceDescriptors: {
                        prompt:
                            services.resources.describe(
                                'prompt',
                            ),
                    },
                    subscriptionCapabilities: {
                        settingsWatch: true,
                        eventSubscriptions: [{
                            pluginId: 'fixture.plugin',
                            localId: 'changed',
                        }],
                        resourceWatches: ['prompt'],
                        notificationPreferencesWatch: true,
                    },
                    dispose: disposeInvocation,
                    authorizeOperation,
                    executeCurrentGlobalAction:
                        currentActions.execute,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions:
                        services.sessions.external,
                };
            },
        });

        const prepared = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(
                prepared.value,
            ),
        ).toMatchObject({
            availability: {
                storage: { status: 'available' },
                exec: { status: 'available' },
                connectedAccounts: { status: 'available' },
                providers: { status: 'available' },
            },
        });

        const providerCaller = new AbortController();
        const providerResult = await host.dispatch({
            ...direct,
            signal: providerCaller.signal,
            operation: {
                kind: 'plugin_providers.invoke_v1',
                ...requestBase(),
                operation: 'connections.describe',
                request: { t: 'object', value: {} },
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(
                providerResult.value,
            ),
        ).toMatchObject({ status: 'success' });
        expect(providerDescribe).toHaveBeenCalledWith({}, {
            signal: providerCaller.signal,
        });

        const actionCaller = new AbortController();
        const actionResult = await host.dispatch({
            ...direct,
            signal: actionCaller.signal,
            operation: {
                kind: 'plugin_actions.execute_v1',
                ...requestBase(),
                actionId: 'session.list',
                input: {
                    t: 'object',
                    value: {},
                },
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(
                actionResult.value,
            ),
        ).toEqual([]);
        expect(actionExecute).toHaveBeenCalledWith(
            'session.list',
            {},
            expect.objectContaining({
                surface: 'plugin',
                actionCaller: {
                    kind: 'plugin',
                    pluginId: 'fixture.plugin',
                    materialization: fixturePluginMaterialization.materialization,
                },
                signal: expect.any(AbortSignal),
            }),
        );

        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.set_v1',
                ...requestBase(),
                scope: 'daemonSession',
                key: 'state',
                value: {
                    t: 'object',
                    value: {
                        ready: {
                            t: 'boolean',
                            value: true,
                        },
                    },
                },
            },
        });
        expect(values.get('state')).toEqual({ ready: true });

        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.transaction.open_v1',
                ...requestBase(),
                transactionId: 'transaction-1',
                scope: 'daemonSession',
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.transaction.set_v1',
                ...requestBase(),
                transactionId: 'transaction-1',
                key: 'transaction-state',
                value: {
                    t: 'string',
                    value: 'committed',
                },
            },
        });
        const transactionValue = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.transaction.get_v1',
                ...requestBase(),
                transactionId: 'transaction-1',
                key: 'transaction-state',
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(
                transactionValue.value,
            ),
        ).toBe('committed');
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.transaction.commit_v1',
                ...requestBase(),
                transactionId: 'transaction-1',
            },
        });

        for (const input of [
            {
                base64: '',
                bytes: new Uint8Array(),
            },
            {
                base64: 'AAH/',
                bytes: new Uint8Array([0, 1, 255]),
            },
        ]) {
            await host.dispatch({
                ...direct,
                operation: {
                    kind: 'plugin_fetch.request_v1',
                    ...requestBase(),
                    request: {
                        url: 'https://example.test/binary',
                        redirect: 'error',
                        body: input.base64,
                    },
                },
            });
            const authorized = await host.dispatch({
                ...direct,
                operation: {
                    kind: 'plugin_exec.launch.authorize_v1',
                    ...requestBase(),
                    request: {
                        executable: {
                            kind: 'managedDependency',
                            id: 'fixture.adapter',
                        },
                        args: ['--runner-request'],
                        env: { SAFE_ENV: 'request' },
                        stdin: input.base64,
                    },
                },
            });
            expect(
                decodeRunnerDaemonPluginServiceWireValueV1(
                    authorized.value,
                ),
            ).toMatchObject({
                authorizationId: expect.any(String),
                launch: {
                    command: '/daemon/resolved/executable',
                    args: [
                        '--daemon-prefix',
                        '--runner-request',
                    ],
                    env: {
                        SAFE_ENV: 'request',
                        DAEMON_RESOLVED: '1',
                    },
                    stdin: input.base64,
                },
            });

            const authorization =
                decodeRunnerDaemonPluginServiceWireValueV1(
                    authorized.value,
                );
            if (
                !authorization
                || !isWireRecord(authorization)
                || typeof authorization.authorizationId !== 'string'
            ) {
                throw new Error('authorization id missing');
            }
            await host.dispatch({
                ...direct,
                operation: {
                    kind: 'plugin_exec.launch.release_v1',
                    ...requestBase({ lifecycle: true }),
                    authorizationId:
                        authorization.authorizationId,
                },
            });
        }
        expect(fetchBodies).toEqual([
            new Uint8Array(),
            new Uint8Array([0, 1, 255]),
        ]);
        expect(resolveExecutable).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledTimes(2);

        await host.dispatch({
            ...direct,
            operation: {
                kind:
                    'plugin_connected_accounts.watch.open_v1',
                ...requestBase(),
                subscriptionId: 'watch-1',
                purpose: 'upstream',
            },
        });
        const event = await host.dispatch({
            ...direct,
            operation: {
                kind:
                    'plugin_connected_accounts.watch.next_v1',
                ...requestBase(),
                subscriptionId: 'watch-1',
            },
        });
        expect(
            decodeRunnerDaemonPluginServiceWireValueV1(event.value),
        ).toEqual({
            kind:
                'plugin_connected_accounts.watch.event_v1',
            invocationId: 'invocation-1',
            subscriptionId: 'watch-1',
            event: { kind: 'resync' },
        });

        const watchCases = [
            {
                open: {
                    kind:
                        'plugin_settings.watch.open_v1' as const,
                    subscriptionId: 'settings-watch',
                    scope: 'daemon' as const,
                },
                expectedKind:
                    'plugin_settings.watch.event_v1',
                expectedValues: ['settings-1', 'settings-2'],
            },
            {
                open: {
                    kind:
                        'plugin_events.subscribe.open_v1' as const,
                    subscriptionId: 'events-watch',
                    event: {
                        pluginId: 'fixture.plugin',
                        localId: 'changed',
                    },
                },
                expectedKind:
                    'plugin_events.subscribe.event_v1',
                expectedValues: [2, 3],
                // Event subscriptions hold the broker's delivery open until the runner reports
                // that its listener ran, so each later request carries an acknowledgement.
                acknowledgeDelivery: true,
            },
            {
                open: {
                    kind:
                        'plugin_resources.watch.open_v1' as const,
                    subscriptionId: 'resources-watch',
                    id: 'prompt',
                },
                expectedKind:
                    'plugin_resources.watch.event_v1',
                expectedValues: ['resource-3'],
            },
            {
                open: {
                    kind:
                        'plugin_notifications.watch_preferences.open_v1' as const,
                    subscriptionId: 'notifications-watch',
                    categoryId: 'build',
                },
                expectedKind:
                    'plugin_notifications.watch_preferences.event_v1',
                expectedValues: ['notifications-2'],
            },
        ];
        for (const watchCase of watchCases) {
            await host.dispatch({
                ...direct,
                operation: {
                    ...watchCase.open,
                    ...requestBase(),
                },
            });
            const observedValues: unknown[] = [];
            for (
                let index = 0;
                index < watchCase.expectedValues.length;
                index += 1
            ) {
                const watched = await host.dispatch({
                    ...direct,
                    signal: AbortSignal.timeout(1_000),
                    operation: {
                        kind:
                            'plugin_services.subscription.next_v1',
                        ...requestBase(),
                        subscriptionId:
                            watchCase.open.subscriptionId,
                        ...(
                            'acknowledgeDelivery' in watchCase
                            && watchCase.acknowledgeDelivery
                            && index > 0
                                ? { acknowledgement: 'settled' as const }
                                : {}
                        ),
                    },
                });
                const decoded =
                    decodeRunnerDaemonPluginServiceWireValueV1(
                        watched.value,
                    );
                expect(decoded).toMatchObject({
                    kind: watchCase.expectedKind,
                    invocationId: 'invocation-1',
                    subscriptionId:
                        watchCase.open.subscriptionId,
                });
                if (!isWireRecord(decoded)) {
                    throw new Error('watch event missing');
                }
                const payload = decoded.change
                    ?? decoded.event
                    ?? decoded.preferences;
                if (!payload || !isWireRecord(payload)) {
                    throw new Error('watch payload missing');
                }
                observedValues.push(
                    payload.revision
                    ?? payload.sequence
                    ?? payload.digest,
                );
            }
            expect(observedValues)
                .toEqual(watchCase.expectedValues);
            if (watchCase.open.subscriptionId === 'events-watch') {
                expect(eventDeliveryOutcomes).toHaveLength(2);
                const firstEventDelivery = eventDeliveryOutcomes[0];
                if (!firstEventDelivery) {
                    throw new Error('first event delivery outcome missing');
                }
                await expect(firstEventDelivery).resolves.toEqual({
                    status: 'fulfilled',
                });
            }
        }

        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.close_v1',
                ...requestBase({ lifecycle: true }),
            },
        });
        const secondEventDelivery = eventDeliveryOutcomes[1];
        if (!secondEventDelivery) {
            throw new Error('second event delivery outcome missing');
        }
        await expect(secondEventDelivery).resolves.toMatchObject({
            status: 'rejected',
            error: { code: 'plugin_service_subscription_closed' },
        });
        expect(disposeInvocation).toHaveBeenCalledOnce();
        expect(authorizeOperation).toHaveBeenCalled();
    });

    it('admits idle stable operations while rejecting forged witnesses and witness-less privileged Actions', async () => {
        const get = vi.fn(async () => null);
        const executeAction = vi.fn(async () => Object.freeze({ ok: true }));
        const executeCurrentGlobalAction = vi.fn(async (
            _actionId: unknown,
            _input: unknown,
            _options: unknown,
            receivedWitness: unknown,
        ) => {
            expect(receivedWitness).toEqual(witness);
            return Object.freeze({ ok: true });
        });
        const unavailable = createUnavailablePluginServices();
        const scope = {
            consistency: () => ({
                kind: 'authoritativeSerializable' as const,
            }),
            get,
            async set() {},
            async delete() {},
            async list() {
                return { items: [] };
            },
            async transaction<T>(
                operation: (
                    transaction: StorageScopeService,
                ) => Promise<T>,
            ) {
                return await operation(this);
            },
        } satisfies StorageScopeService;
        const services: PluginServices = Object.freeze({
            ...unavailable,
            availability(serviceId: PluginServiceId) {
                return serviceId === 'storage'
                    ? { status: 'available' as const }
                    : unavailable.availability(serviceId);
            },
            storage: {
                ephemeral: scope,
                daemonSession: scope,
                daemon: unavailableDaemonDatabaseScope(scope),
            },
            actions: Object.freeze({
                ...unavailable.actions,
                execute: executeAction,
            }),
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation(
                        candidate: typeof witness | undefined,
                        options?: Readonly<{
                            requireActiveTurn?: boolean;
                        }>,
                    ) {
                        if (!candidate) {
                            return options?.requireActiveTurn !== true;
                        }
                        return candidate?.inputId === witness.inputId
                            && candidate.turnId === witness.turnId
                            && candidate.userMessageSeq
                                === witness.userMessageSeq
                            && JSON.stringify(
                                candidate.userMessageSeqs,
                            ) === JSON.stringify(
                                witness.userMessageSeqs,
                            );
                    },
                    executeCurrentGlobalAction:
                        executeCurrentGlobalAction,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions:
                        services.sessions.external,
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });

        await expect(host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.get_v1',
                ...requestBase({ lifecycle: true }),
                scope: 'daemonSession',
                key: 'state',
            },
        })).resolves.toBeDefined();
        expect(get).toHaveBeenCalledOnce();

        for (const candidate of [
            { ...witness, turnId: 'stale-turn' },
            { ...witness, inputId: 'forged-input' },
        ]) {
            await expect(host.dispatch({
                ...direct,
                operation: {
                    kind: 'plugin_storage.get_v1',
                    ...requestBase({ lifecycle: true }),
                    ...(candidate ? { witness: candidate } : {}),
                    scope: 'daemonSession',
                    key: 'state',
                },
            })).rejects.toMatchObject({
                code: 'plugin_services_turn_authority_unavailable',
            });
        }

        for (const candidate of [
            undefined,
            { ...witness, turnId: 'stale-turn' },
        ]) {
            await expect(host.dispatch({
                ...direct,
                operation: {
                    kind: 'plugin_actions.execute_v1',
                    ...requestBase({ lifecycle: true }),
                    ...(candidate ? { witness: candidate } : {}),
                    actionId: 'session.list',
                    input: {
                        t: 'object',
                        value: {},
                    },
                },
            })).rejects.toMatchObject({
                code: 'plugin_services_turn_authority_unavailable',
            });
        }
        expect(executeCurrentGlobalAction).not.toHaveBeenCalled();

        await expect(host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_actions.execute_v1',
                ...requestBase(),
                actionId: 'session.list',
                input: {
                    t: 'object',
                    value: {},
                },
            },
        })).resolves.toBeDefined();
        expect(executeCurrentGlobalAction).toHaveBeenCalledOnce();
        expect(executeAction).not.toHaveBeenCalled();
    });

    it('routes retained runner log entries into the canonical daemon logger', async () => {
        const unavailable = createUnavailablePluginServices();
        const info = vi.fn();
        const diagnostic = vi.fn();
        const services: PluginServices = Object.freeze({
            ...unavailable,
            logger: Object.freeze({
                ...unavailable.logger,
                info,
                diagnostic,
            }),
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction:
                        services.actions.execute,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions:
                        services.sessions.external,
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });

        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_logger.write_v1',
                ...requestBase(),
                entry: {
                    kind: 'log',
                    level: 'info',
                    message: 'retained runner log',
                    fields:
                        encodeRunnerDaemonPluginServiceWireValueV1({
                            owner: 'generation-g',
                        }),
                },
            },
        });

        expect(info).toHaveBeenCalledWith(
            'retained runner log',
            { owner: 'generation-g' },
        );
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_logger.write_v1',
                ...requestBase(),
                entry: {
                    kind: 'diagnostic',
                    data: {
                        code: 'retained_runner_diagnostic',
                        severity: 'warning',
                        details:
                            encodeRunnerDaemonPluginServiceWireValueV1({
                                owner: 'generation-g',
                            }),
                    },
                },
            },
        });
        expect(diagnostic).toHaveBeenCalledWith({
            code: 'retained_runner_diagnostic',
            severity: 'warning',
            details: { owner: 'generation-g' },
        });
        await host.dispose();
    });

    it('closes transaction command admission before awaiting the admitted command tail', async () => {
        const unavailable = createUnavailablePluginServices();
        let resolveFirstSet!: () => void;
        const firstSetReleased = new Promise<void>((resolve) => {
            resolveFirstSet = resolve;
        });
        let resolveFirstSetStarted!: () => void;
        const firstSetStarted = new Promise<void>((resolve) => {
            resolveFirstSetStarted = resolve;
        });
        let transactionActive = false;
        const writes: Array<Readonly<{
            key: string;
            transactionActive: boolean;
        }>> = [];
        const scope: StorageScopeService = {
            consistency: () => ({
                kind: 'authoritativeSerializable',
            }),
            async get() {
                return null;
            },
            async set(key) {
                if (key === 'first') {
                    resolveFirstSetStarted();
                    await firstSetReleased;
                }
                writes.push({ key, transactionActive });
            },
            async delete() {},
            async list() {
                return { items: [] };
            },
            async transaction(operation) {
                transactionActive = true;
                try {
                    return await operation(scope);
                } finally {
                    transactionActive = false;
                }
            },
        };
        const services: PluginServices = Object.freeze({
            ...unavailable,
            availability(serviceId: PluginServiceId) {
                return serviceId === 'storage'
                    ? { status: 'available' as const }
                    : unavailable.availability(serviceId);
            },
            storage: {
                ephemeral: scope,
                daemonSession: scope,
                daemon: unavailableDaemonDatabaseScope(scope),
            },
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    authorizeManagedProviderMaterialization:
                        () => true,
                    executeCurrentGlobalAction:
                        services.actions.execute,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions:
                        services.sessions.external,
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.transaction.open_v1',
                ...requestBase(),
                transactionId: 'transaction-race',
                scope: 'daemonSession',
            },
        });
        const first = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.transaction.set_v1',
                ...requestBase(),
                transactionId: 'transaction-race',
                key: 'first',
                value: { t: 'null' },
            },
        });
        await firstSetStarted;
        const commit = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.transaction.commit_v1',
                ...requestBase(),
                transactionId: 'transaction-race',
            },
        });
        const late = host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_storage.transaction.set_v1',
                ...requestBase(),
                transactionId: 'transaction-race',
                key: 'late',
                value: { t: 'null' },
            },
        });
        resolveFirstSet();
        await first;
        await commit;
        await expect(late).rejects.toMatchObject({
            code: 'plugin_storage_transaction_unavailable',
        });
        expect(writes).toEqual([{
            key: 'first',
            transactionActive: true,
        }]);
    });

    it('routes the bounded purpose-scoped listing and exact-listed materialization to the bound service', async () => {
        const unavailable = createUnavailablePluginServices();
        const listAccounts = vi.fn(async () => Object.freeze({
            status: 'truncated' as const,
            accounts: Object.freeze([Object.freeze({
                account: Object.freeze({
                    service: Object.freeze({
                        pluginId: 'acme.accounts',
                        localId: 'openai',
                    }),
                    accountId: 'account-1',
                }),
                displayName: 'EU account',
                state: 'connected' as const,
                connectedAccountOrigins: Object.freeze(['https://eu.example.test']),
                connectedAccountBases: Object.freeze(['https://eu.example.test']),
            })]),
        }));
        const materializeListedAccount = vi.fn(async () => Object.freeze({
            kind: 'environment' as const,
            env: Object.freeze({ TOKEN: 'listed-token' }),
        }));
        const services: PluginServices = Object.freeze({
            ...unavailable,
            availability(serviceId: PluginServiceId) {
                return serviceId === 'connectedAccounts'
                    ? { status: 'available' as const }
                    : unavailable.availability(serviceId);
            },
            connectedAccounts: Object.freeze({
                async getBinding() {
                    return null;
                },
                async requestSelection() {
                    throw new Error('selection was not expected');
                },
                async materialize() {
                    throw new Error('selected-binding materialization was not expected');
                },
                listAccounts,
                materializeListedAccount,
                watch() {
                    return Object.freeze({ dispose() {} });
                },
            }) as PluginServices['connectedAccounts'],
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction: services.actions.execute,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions: services.sessions.external,
                };
            },
        });

        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });

        const listed = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_connected_accounts.list_accounts_v1',
                ...requestBase(),
                purpose: 'upstream',
                limit: 5,
            },
        });
        expect(decodeRunnerDaemonPluginServiceWireValueV1(listed.value)).toEqual({
            status: 'truncated',
            accounts: [{
                account: {
                    service: { pluginId: 'acme.accounts', localId: 'openai' },
                    accountId: 'account-1',
                },
                displayName: 'EU account',
                state: 'connected',
                connectedAccountOrigins: ['https://eu.example.test'],
                connectedAccountBases: ['https://eu.example.test'],
            }],
        });
        expect(listAccounts).toHaveBeenCalledWith(
            { purpose: 'upstream', limit: 5 },
            expect.anything(),
        );

        const materialized = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_connected_accounts.materialize_listed_account_v1',
                ...requestBase(),
                purpose: 'upstream',
                account: {
                    service: { pluginId: 'acme.accounts', localId: 'openai' },
                    accountId: 'account-1',
                },
                request: { kind: 'environment', keys: ['TOKEN'] },
            },
        });
        expect(decodeRunnerDaemonPluginServiceWireValueV1(materialized.value)).toEqual({
            kind: 'environment',
            env: { TOKEN: 'listed-token' },
        });
        expect(materializeListedAccount).toHaveBeenCalledWith(
            {
                purpose: 'upstream',
                account: {
                    service: { pluginId: 'acme.accounts', localId: 'openai' },
                    accountId: 'account-1',
                },
                materialization: { kind: 'environment', keys: ['TOKEN'] },
            },
            expect.anything(),
        );
    });

    it('refuses a stale observed binding through the actual runner proxy', async () => {
        const unavailable = createUnavailablePluginServices();
        const accountA = {
            service: {
                pluginId: 'acme.accounts',
                localId: 'openai',
            },
            accountId: 'account-a',
        };
        const accountB = {
            service: accountA.service,
            accountId: 'account-b',
        };
        let currentAccount: Readonly<{
            service: Readonly<{ pluginId: string; localId: string }>;
            accountId: string;
        }> = accountA;
        const materialize = vi.fn(async (
            _purpose: string,
            _request: unknown,
            options?: Readonly<{
                expectedAccount?: typeof accountA;
                signal?: AbortSignal;
            }>,
        ) => {
            if (
                options?.expectedAccount
                && options.expectedAccount.accountId !== currentAccount.accountId
            ) {
                throw new PluginError({
                    code: 'plugin_host_access_resource_not_selected',
                    message: 'The observed Connected Account is no longer current',
                });
            }
            return Object.freeze({
                kind: 'environment' as const,
                env: Object.freeze({ TOKEN: 'current-token' }),
            });
        });
        const services: PluginServices = Object.freeze({
            ...unavailable,
            availability(serviceId: PluginServiceId) {
                return serviceId === 'connectedAccounts'
                    ? { status: 'available' as const }
                    : unavailable.availability(serviceId);
            },
            connectedAccounts: Object.freeze({
                async getBinding(purpose: string) {
                    return Object.freeze({
                        purpose,
                        service: currentAccount.service,
                        account: currentAccount,
                        target: Object.freeze({
                            kind: 'account' as const,
                            displayName: currentAccount.accountId,
                        }),
                    });
                },
                async requestSelection() {
                    throw new Error('selection was not expected');
                },
                materialize,
                async listAccounts() {
                    throw new Error('listing was not expected');
                },
                async materializeListedAccount() {
                    throw new Error('exact-listed materialization was not expected');
                },
                watch() {
                    return Object.freeze({ dispose() {} });
                },
            }) as PluginServices['connectedAccounts'],
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction: services.actions.execute,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions: services.sessions.external,
                };
            },
        });
        let releaseMaterializationDispatch!: () => void;
        const materializationDispatchReleased = new Promise<void>((resolve) => {
            releaseMaterializationDispatch = resolve;
        });
        let markMaterializationDispatched!: () => void;
        const materializationDispatched = new Promise<void>((resolve) => {
            markMaterializationDispatched = resolve;
        });
        const runnerServices = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-observed-account',
            signal: new AbortController().signal,
            dispatch: async (operation, options) => {
                if (operation.kind === 'plugin_connected_accounts.materialize_v1') {
                    markMaterializationDispatched();
                    await materializationDispatchReleased;
                }
                const result = await host.dispatch({
                    ...direct,
                    operation,
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
                return decodeRunnerDaemonPluginServiceWireValueV1(result.value);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
                composerContent: unavailable.composerContent,
            },
        });

        const observed = await runnerServices.connectedAccounts.getBinding(
            'provider.inference',
        );
        expect(observed?.account).toEqual(accountA);
        if (!observed) throw new Error('Expected an observed Connected Account binding');
        currentAccount = accountB;
        const cancellation = new AbortController();
        const expectedAccount = {
            service: { ...observed.account.service },
            accountId: observed.account.accountId,
        };

        const materialization = runnerServices.connectedAccounts.materialize(
            'provider.inference',
            { kind: 'environment', keys: ['TOKEN'] },
            {
                expectedAccount,
                signal: cancellation.signal,
            },
        );
        await materializationDispatched;
        expectedAccount.accountId = accountB.accountId;
        releaseMaterializationDispatch();

        await expect(materialization).rejects.toMatchObject({
            code: 'plugin_host_access_resource_not_selected',
        });
        expect(materialize).toHaveBeenLastCalledWith(
            'provider.inference',
            { kind: 'environment', keys: ['TOKEN'] },
            expect.objectContaining({
                expectedAccount: {
                    service: {
                        pluginId: 'acme.accounts',
                        localId: 'openai',
                    },
                    accountId: 'account-a',
                },
                signal: cancellation.signal,
            }),
        );
    });

    it('prepares and routes one exact current managed Provider projection without broadening Agent services', async () => {
        const unavailable = createUnavailablePluginServices();
        const agentGetBinding = vi.fn(async () => null);
        const providerGetBinding = vi.fn(async () => null);
        const connectedAccounts = (
            getBinding: typeof agentGetBinding,
        ): PluginServices['connectedAccounts'] => Object.freeze({
            getBinding,
            async requestSelection() {
                throw new Error('selection was not expected');
            },
            async materialize() {
                throw new Error('materialization was not expected');
            },
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch() {
                return Object.freeze({ dispose() {} });
            },
        });
        const services: PluginServices = Object.freeze({
            ...unavailable,
            availability(serviceId: PluginServiceId) {
                return serviceId === 'connectedAccounts'
                    ? { status: 'available' as const }
                    : unavailable.availability(serviceId);
            },
            connectedAccounts:
                connectedAccounts(agentGetBinding),
        });
        let providerCurrent = true;
        const bootstrap = managedProviderBootstrap();
        const expectedLaunch = Object.freeze({
            serverId: 'provider-runtime',
            executable: Object.freeze({
                kind: 'packaged-runtime-binary' as const,
                directorySegments: Object.freeze(['tools', 'unpacked']),
                executableBaseName: 'provider-runtime',
            }),
            environmentKeys: Object.freeze(['HOST', 'PORT']),
        });
        const startManagedProvider = vi.fn(async () => undefined);
        let materializationAuthorized = false;
        const authorizeManagedProviderMaterialization =
            vi.fn(() => materializationAuthorized);
        const materializeAgentBinding = vi.fn(async () => ({
            v: 1,
            kind: 'spawnEnv',
            env: [{
                name: 'PROVIDER_API_KEY',
                value: 'provider-placeholder-aaaaaaaaaaaaaaaa',
                source: 'provider',
            }],
        }));
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    managedProvider: {
                        bootstrap,
                        connectedAccounts:
                            connectedAccounts(providerGetBinding),
                        isCurrent: () => providerCurrent,
                        readSupervisionLaunchAuthority: (serverId: string) =>
                            serverId === expectedLaunch.serverId
                                ? expectedLaunch
                                : null,
                        start: startManagedProvider,
                        materializeAgentBinding,
                    },
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    authorizeManagedProviderMaterialization:
                        authorizeManagedProviderMaterialization,
                    executeCurrentGlobalAction:
                        services.actions.execute,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions:
                        services.sessions.external,
                };
            },
        });

        const prepared = await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        expect(decodeRunnerDaemonPluginServiceWireValueV1(
            prepared.value,
        )).toMatchObject({ managedProvider: bootstrap });

        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.managed_provider.start_v1',
                ...requestBase(),
                retained: {
                    v: 1,
                    scope: bootstrap.scope,
                    providerPluginHardRevocationRevisionAtAdmission:
                        bootstrap
                            .providerPluginHardRevocationRevisionAtAdmission,
                },
            },
        });
        expect(startManagedProvider).toHaveBeenCalledOnce();
        expect(authorizeManagedProviderMaterialization)
            .not.toHaveBeenCalled();

        materializationAuthorized = true;
        const materialized = await host.dispatch({
            ...direct,
            operation: {
                kind:
                    'plugin_services.managed_provider.materialize_agent_binding_v1',
                ...requestBase(),
                retained: {
                    v: 1,
                    scope: bootstrap.scope,
                    providerPluginHardRevocationRevisionAtAdmission:
                        bootstrap
                            .providerPluginHardRevocationRevisionAtAdmission,
                },
                endpointUrl: 'http://127.0.0.1:4312/v1',
                credentialPlaceholder:
                    'provider-placeholder-aaaaaaaaaaaaaaaa',
            },
        });
        expect(decodeRunnerDaemonPluginServiceWireValueV1(
            materialized.value,
        )).toMatchObject({
            kind: 'spawnEnv',
        });
        expect(materializeAgentBinding).toHaveBeenCalledWith({
            endpointUrl: 'http://127.0.0.1:4312/v1',
            credentialPlaceholder:
                'provider-placeholder-aaaaaaaaaaaaaaaa',
        });
        expect(authorizeManagedProviderMaterialization)
            .toHaveBeenCalledOnce();
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind:
                    'plugin_services.managed_provider.materialize_agent_binding_v1',
                ...requestBase(),
                retained: {
                    v: 1,
                    scope: bootstrap.scope,
                    providerPluginHardRevocationRevisionAtAdmission:
                        bootstrap
                            .providerPluginHardRevocationRevisionAtAdmission,
                },
                endpointUrl: 'http://127.0.0.1:4312/v1',
                credentialPlaceholder:
                    'provider-placeholder-aaaaaaaaaaaaaaaa',
            },
        })).rejects.toMatchObject({
            code:
                'plugin_services_managed_provider_materialization_already_attempted',
        });
        expect(materializeAgentBinding).toHaveBeenCalledOnce();
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind:
                    'plugin_services.managed_provider.materialize_agent_binding_v1',
                ...requestBase(),
                retained: {
                    v: 1,
                    scope: bootstrap.scope,
                    providerPluginHardRevocationRevisionAtAdmission:
                        bootstrap
                            .providerPluginHardRevocationRevisionAtAdmission,
                },
                endpointUrl: 'http://127.0.0.1:4312/other',
                credentialPlaceholder:
                    'provider-placeholder-aaaaaaaaaaaaaaaa',
            },
        })).rejects.toMatchObject({
            code:
                'plugin_services_managed_provider_materialization_already_attempted',
        });
        expect(startManagedProvider).toHaveBeenCalledOnce();

        const raceInvocationId = 'invocation-provider-race';
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
                invocationId: raceInvocationId,
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.managed_provider.start_v1',
                ...requestBase(),
                invocationId: raceInvocationId,
                retained: {
                    v: 1,
                    scope: bootstrap.scope,
                    providerPluginHardRevocationRevisionAtAdmission:
                        bootstrap
                            .providerPluginHardRevocationRevisionAtAdmission,
                },
            },
        });
        materializeAgentBinding.mockImplementationOnce(async () => {
            providerCurrent = false;
            return {
                v: 1,
                kind: 'spawnEnv',
                env: [],
            };
        });
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind:
                    'plugin_services.managed_provider.materialize_agent_binding_v1',
                ...requestBase(),
                invocationId: raceInvocationId,
                retained: {
                    v: 1,
                    scope: bootstrap.scope,
                    providerPluginHardRevocationRevisionAtAdmission:
                        bootstrap
                            .providerPluginHardRevocationRevisionAtAdmission,
                },
                endpointUrl: 'http://127.0.0.1:4312/v1',
                credentialPlaceholder:
                    'provider-placeholder-bbbbbbbbbbbbbbbb',
            },
        })).rejects.toMatchObject({
            code:
                'plugin_services_managed_provider_authority_unavailable',
        });
        expect(materializeAgentBinding).toHaveBeenCalledTimes(2);
        providerCurrent = true;
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.close_v1',
                ...requestBase({ lifecycle: true }),
                invocationId: raceInvocationId,
            },
        });

        await expect(
            host.readManagedProviderSupervisionAuthority({
                ...direct,
                contributionId: 'provider.plugin/providers/gateway',
                operationClaimId:
                    bootstrap.scope.operationClaimId,
                serverId: expectedLaunch.serverId,
            }),
        ).resolves.toEqual({
            bootstrap,
            expectedLaunch,
        });
        await expect(
            host.readManagedProviderSupervisionAuthority({
                ...direct,
                contributionId: 'provider.plugin/providers/gateway',
                operationClaimId:
                    bootstrap.scope.operationClaimId,
                serverId: 'unknown-provider-runtime',
            }),
        ).resolves.toEqual({
            bootstrap,
            expectedLaunch: null,
        });
        await expect(
            host.readManagedProviderSupervisionAuthority({
                ...direct,
                contributionId: 'provider.plugin/providers/gateway',
                operationClaimId: 'another-provider-claim',
                serverId: expectedLaunch.serverId,
            }),
        ).resolves.toBeNull();

        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_connected_accounts.get_binding_v1',
                ...requestBase(),
                purpose: 'upstream',
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_connected_accounts.get_binding_v1',
                ...requestBase(),
                serviceScope: 'managedProvider',
                purpose: 'upstream',
            },
        });
        expect(agentGetBinding).toHaveBeenCalledOnce();
        expect(providerGetBinding).toHaveBeenCalledOnce();

        providerCurrent = false;
        await expect(
            host.readManagedProviderSupervisionAuthority({
                ...direct,
                contributionId: 'provider.plugin/providers/gateway',
                operationClaimId:
                    bootstrap.scope.operationClaimId,
                serverId: expectedLaunch.serverId,
            }),
        ).resolves.toBeNull();
        await expect(host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_connected_accounts.get_binding_v1',
                ...requestBase(),
                serviceScope: 'managedProvider',
                purpose: 'upstream',
            },
        })).rejects.toMatchObject({
            code: 'plugin_services_managed_provider_authority_unavailable',
        });
        expect(providerGetBinding).toHaveBeenCalledOnce();

        providerCurrent = true;
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.close_v1',
                ...requestBase({ lifecycle: true }),
            },
        });
        await expect(
            host.readManagedProviderSupervisionAuthority({
                ...direct,
                contributionId: 'provider.plugin/providers/gateway',
                operationClaimId:
                    bootstrap.scope.operationClaimId,
                serverId: expectedLaunch.serverId,
            }),
        ).resolves.toBeNull();
    });

    // The Event broker, not this transport, owns Host Event delivery accounting. Its `publish`
    // must therefore stay pending until the runner reports its listener ran, and the transport
    // must not carry a second count-only drop policy of its own.
    it('keeps Host Event delivery in broker custody until the runner acknowledges it', async () => {
        const unavailable = createUnavailablePluginServices();
        const diagnostic = vi.fn();
        let publishHostEvent!: (event: unknown) => Promise<void>;
        const deliveryOutcomes: Array<Promise<
            | Readonly<{ status: 'fulfilled' }>
            | Readonly<{ status: 'rejected'; error: unknown }>
        >> = [];
        const observeDelivery = (
            delivery: Promise<void>,
            onFulfilled?: () => void,
        ) => {
            const outcome = delivery.then(
                () => {
                    onFulfilled?.();
                    return { status: 'fulfilled' as const };
                },
                (error: unknown) => ({
                    status: 'rejected' as const,
                    error,
                }),
            );
            deliveryOutcomes.push(outcome);
            return outcome;
        };
        const services: PluginServices = Object.freeze({
            ...unavailable,
            logger: Object.freeze({
                ...unavailable.logger,
                diagnostic,
            }),
            events: Object.freeze({
                ...unavailable.events,
                host: Object.freeze({
                    subscribe<Id extends HostEventId>(
                        _target: HostEventTarget<Id>,
                        listener: (
                            event: HostEventEnvelope<Id>,
                        ) => void | Promise<void>,
                    ) {
                        publishHostEvent = async (event) => {
                            await listener(event as never);
                        };
                        return Object.freeze({ dispose() {} });
                    },
                }),
            }),
        });
        const host = createRunnerDaemonPluginServicesHost({
            async createInvocation() {
                return {
                    services,
                    resourceDescriptors: {},
                    subscriptionCapabilities: {
                        settingsWatch: false,
                        eventSubscriptions: [],
                        resourceWatches: [],
                        notificationPreferencesWatch: false,
                    },
                    dispose() {},
                    authorizeOperation: () => true,
                    executeCurrentGlobalAction:
                        services.actions.execute,
                    currentGlobalMcp: services.mcp,
                    currentGlobalExternalSessions:
                        services.sessions.external,
                };
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.prepare_v1',
                ...requestBase(),
            },
        });
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_events.host.subscribe.open_v1',
                ...requestBase(),
                subscriptionId: 'host-events',
                target: {
                    eventId: '@happier/runtime/turn-complete',
                    scope: {
                        kind: 'session',
                        sessionId: 'session-1',
                    },
                },
            },
        });

        const hostEvent = (sequence: number) => ({
            eventId: '@happier/runtime/turn-complete',
            scope: { kind: 'session', sessionId: 'session-1' },
            payload: {
                sequence,
                sessionId: 'session-1',
                emittedAtMs: sequence,
                kind: 'turn-complete',
                turnId: `turn-${sequence}`,
            },
        });
        let firstSettled = false;
        const firstDelivery = observeDelivery(
            publishHostEvent(hostEvent(1)),
            () => { firstSettled = true; },
        );
        await Promise.resolve();
        expect(firstSettled).toBe(false);

        await host.dispatch({
            ...direct,
            signal: AbortSignal.timeout(1_000),
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'host-events',
            },
        });
        await Promise.resolve();
        expect(firstSettled).toBe(false);

        const secondDelivery = observeDelivery(publishHostEvent(hostEvent(2)));
        await host.dispatch({
            ...direct,
            signal: AbortSignal.timeout(1_000),
            operation: {
                kind: 'plugin_services.subscription.next_v1',
                ...requestBase(),
                subscriptionId: 'host-events',
                acknowledgement: 'settled',
            },
        });
        await expect(firstDelivery).resolves.toEqual({ status: 'fulfilled' });

        // The second delivery remains in broker custody when the invocation closes. Its
        // fixture handler is attached immediately above, so the rejection is observed instead
        // of becoming an unhandled Promise rejection.
        await host.dispatch({
            ...direct,
            operation: {
                kind: 'plugin_services.close_v1',
                ...requestBase({ lifecycle: true }),
            },
        });
        expect(deliveryOutcomes).toHaveLength(2);
        await expect(secondDelivery).resolves.toMatchObject({
            status: 'rejected',
            error: { code: 'plugin_service_subscription_closed' },
        });
        expect(diagnostic).not.toHaveBeenCalled();
    });
});
