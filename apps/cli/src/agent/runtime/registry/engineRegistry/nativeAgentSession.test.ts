import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    AgentRuntime,
    AgentSessionCatalogControl,
    AgentSessionContinuationControl,
    AgentSessionConversationRollbackControl,
    AgentSessionRuntimeFactory,
    AgentSessionRuntimeContext,
    AgentSessionRuntime,
    AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';
import {
    ProviderConnectionIdSchema,
    redactBugReportSensitiveText,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';
import type {
    TerminalControlPort,
    TerminalHostAdapter,
    TerminalHostHandle,
    TerminalInputInjectionResult,
} from '@happier-dev/agents';
import type { HostTerminalLaunchRequest } from '@/agent/runtime/session/terminal/contract';
import type { Credentials } from '@/persistence';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import {
    createEmptyBackendExecutionSurfaces,
    type BackendExecutionSurfaces,
} from '@/agent/runtime/registry/engineRegistryTypes';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { logger } from '@/ui/logger';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

import {
    createNativeAgentSessionOperations,
    createNativeAgentRuntimeSessionPlan,
    type NativeAgentSessionHostServiceOwners,
} from './nativeAgentSession';
import { createNativeAgentSessionServices } from './nativeAgentSessionInteractions';
import type { UsageObservation } from '@/usage/usageObservation';
import { buildUsageEventIngestRequest } from '@/usage/buildUsageEventIngestRequest';
import { createPluginTerminalHostService } from '@/plugins/runtime/context/terminalHost';
import { resolveCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import {
    HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
    serializeProviderBindingLaunchHandoffForEnv,
} from '@/plugins/runtime/providerBindings/handoff';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import type { HostPluginServices } from '@/agent/runtime/state/currentSessionUiTypes';
import type { ExternalSessionHostOperationPort } from '@/session/external/hostOperationOwner';

const daemonBridgeMocks = vi.hoisted(() => ({
    abandonPreparedSession: vi.fn(async () => undefined),
}));

vi.mock('@/agent/runtime/session/process/agentRuntimeDaemonBridgeClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/agent/runtime/session/process/agentRuntimeDaemonBridgeClient')>(),
    abandonDaemonAgentRuntimePreparedSession: daemonBridgeMocks.abandonPreparedSession,
}));

const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
};

type CommittedUserMessageSeqObserverFixture = {
    current: ((input: Readonly<{ localId: string; seq: number }>) => void) | null;
};

function notifyCommittedUserMessageSeq(
    observer: CommittedUserMessageSeqObserverFixture,
    input: Readonly<{ localId: string; seq: number }>,
): void {
    const listener = observer.current;
    if (listener !== null) listener(input);
}

function providerBindingMetadata(connectionId: string, modelId: string) {
    return {
        v: 1 as const,
        connectionId: ProviderConnectionIdSchema.parse(connectionId),
        contributionKey: 'provider.test',
        connectionRevision: 1,
        model: { id: modelId, name: modelId },
        protocol: 'openai-responses' as const,
        materialization: 'engineConfig' as const,
        adapterBindingKey: 'provider-test',
        compatibilityFingerprint: 'compatibility:v1:test',
        bindingSecurityFingerprint: 'binding-security:v1:test',
        displaySnapshot: {
            providerName: 'Test Provider',
            connectionName: 'Test connection',
            connectionRole: 'default' as const,
            connectionDisplayNameMode: 'automatic' as const,
        },
    };
}

function createNativeSessionClientTestPort(
    sessionId: string,
    overrides: Readonly<Record<string, unknown>> = {},
) {
    let agentState: Record<string, unknown> = {};
    let metadata: Record<string, unknown> = {
        path: '/tmp/test', host: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib', happyToolsDir: '/tmp/.happier/tools',
    };
    const handlers = new Map<string, (input: unknown) => unknown>();
    const metadataListeners = new Set<() => void>();
    return {
        sessionId,
        rpcHandlerManager: {
            registerHandler: (method: string, handler: (input: unknown) => unknown) => handlers.set(method, handler),
            invokeLocal: async (method: string, input: unknown) => await handlers.get(method)?.(input),
        },
        updateAgentState: async (updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
            agentState = updater(agentState);
        },
        updateMetadata: async (updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
            metadata = updater(metadata);
            for (const listener of metadataListeners) listener();
        },
        getMetadataSnapshot: () => metadata,
        getAgentStateSnapshot: () => agentState,
        readSessionTurnsProjection: async () => null,
        on: (event: string, listener: () => void) => {
            if (event === 'metadata-updated') metadataListeners.add(listener);
        },
        off: (event: string, listener: () => void) => {
            if (event === 'metadata-updated') metadataListeners.delete(listener);
        },
        ...overrides,
    };
}

function readHostServices(context: AgentSessionRuntimeContext): HostPluginServices {
    // The public Agent context deliberately omits host-only session services.
    return context.services as HostPluginServices;
}

function createExternalContributionFixtures(
    agentId: string,
    sessionOpenKinds: readonly ('create' | 'resume' | 'fork')[] = ['create', 'resume'],
) {
    return {
        backend: {
            id: agentId,
            agentId,
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: agentId, agentId },
            pluginId: 'acme.agent-plugin',
        },
        agent: {
            id: agentId,
            provenance: 'external',
            source: { kind: 'path' },
            definition: { kindVersion: 1, id: agentId, ownedBackendIds: [agentId] },
            richDefinition: {
                provenance: 'external',
                definition: {
                    id: agentId,
                    title: { key: 'agents.acme.title', fallback: 'Acme Agent' },
                    description: { key: 'agents.acme.description', fallback: 'Acme Agent' },
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: [...sessionOpenKinds],
                            delivery: new Array<'newTurn' | 'steer' | 'followUp'>('newTurn'),
                            cancel: true,
                        },
                    },
                },
            },
            pluginId: 'acme.agent-plugin',
        },
    } satisfies Readonly<{
        backend: ResolvedAgentRuntimeContribution;
        agent: ResolvedAgentContribution;
    }>;
}

function createLease(agentId: string): AgentRuntimeRegistrationLease {
    return {
        pluginId: 'acme.agent-plugin',
        pluginVersion: '1.0.0',
        agentId,
        generation: 'generation-1',
        immutableGenerationId: null,
        hasPrimaryRuntime: true,
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: async () => { throw new Error('not used by the session adapter'); },
    };
}

function createSessionHostServiceOwners(): NativeAgentSessionHostServiceOwners {
    return Object.freeze({
        features: Object.freeze({ isEnabled: () => false }),
        sessionHooks: Object.freeze({
            startServer: async () => Object.freeze({
                port: 4312,
                stop: () => undefined,
                dispose: async () => undefined,
            }),
            resolveForwarderAssets: async () => Object.freeze({
                nodeExecutable: '/runtime/node',
                sessionForwarderScript: '/runtime/session-forwarder.cjs',
                permissionForwarderScript: '/runtime/permission-forwarder.cjs',
            }),
            createPluginDir: async () => '/tmp/plugin-dir',
            disposePluginDir: async () => undefined,
            publishProviderTranscript: async () => undefined,
        }),
        transcripts: Object.freeze({
            fileFollow: Object.freeze({
                follow: async () => Object.freeze({
                    id: 'follow-1',
                    drainNow: async () => undefined,
                    close: async () => undefined,
                }),
            }),
        }),
        accountUsage: Object.freeze({
            resolveSourceContext: async () => null,
            recordSnapshot: async () => ({ status: 'unavailable' as const, reason: 'daemon_unavailable' as const }),
            adoptProvisionalRecord: async () => ({ status: 'unavailable' as const, reason: 'daemon_unavailable' as const }),
        }),
        auth: Object.freeze({
            services: Object.freeze({
                refreshRuntimeAuth: async () => ({ status: 'unavailable' as const, reason: 'test' }),
            }),
        }),
        mcp: Object.freeze({ resolveForSession: async () => Object.freeze([]) }),
        dispose: async () => undefined,
    });
}

function createWorkflowRunSystemRecordPayload() {
    return {
        v: 1,
        projectionVersion: 1,
        runId: 'workflow-native-1',
        backendId: 'claude',
        agentId: 'claude',
        title: 'Native workflow',
        status: 'active',
        workflowToolUseId: 'workflow-native-1',
        recordRevision: '1',
        updatedAt: 123,
        totalAgents: 0,
        completedAgents: 0,
        phases: [],
        agents: [],
    } as const;
}

function createWorkflowActivityHeadline() {
    return {
        v: 1,
        backendId: 'claude',
        agentId: 'claude',
        updatedAt: 124,
        primaryRunId: 'workflow-native-1',
        activeRuns: [{
            runId: 'workflow-native-1',
            title: 'Native workflow',
            status: 'active',
            workflowToolUseId: 'workflow-native-1',
            updatedAt: 123,
            recordRevision: '1',
            recordUpdatedAt: 123,
            totalAgents: 0,
            completedAgents: 0,
        }],
    } as const;
}

describe('native Agent session host adapter', () => {
    it('claims and redacts host-private late Profile environment immediately before native open', async () => {
        const agentId = 'acme-native-late-profile';
        const contributions = createExternalContributionFixtures(agentId);
        const events: string[] = [];
        const dispose = vi.fn(async () => undefined);
        const open = vi.fn(async (request) => {
            events.push('open');
            expect(request.launchEnvironment?.values).toMatchObject({
                PROFILE_SECRET: 'profile-plaintext',
            });
            expect(redactBugReportSensitiveText(
                'value=profile-plaintext',
            )).toBe('value=[REDACTED]');
            return {
                send: vi.fn(async () => ({ status: 'admitted' as const })),
                watch: () => ({ dispose: () => undefined }),
                dispose,
            };
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-late-profile',
                resolveLateEnvironment: async () => {
                    events.push('claim');
                    return {
                        environmentVariables: {
                            PROFILE_SECRET: 'profile-plaintext',
                        },
                        unsetEnvironmentVariables: [],
                        sensitiveEnvironmentVariableNames: [
                            'PROFILE_SECRET',
                        ],
                    };
                },
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-late-profile',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort(
                'session-native-late-profile',
            ),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(events).toEqual(['claim', 'open']);
        expect(redactBugReportSensitiveText(
            'value=profile-plaintext',
        )).toBe('value=[REDACTED]');
        await created.operations.resetOrDisposeRuntime();
        expect(dispose).toHaveBeenCalledOnce();
        expect(redactBugReportSensitiveText(
            'value=profile-plaintext',
        )).toBe('value=profile-plaintext');
    });

    it.each([
        { cleanupFails: false, expectedContext: 'native open failed' },
        { cleanupFails: true, expectedContext: 'host cleanup failed' },
    ])(
        'sanitizes a secret-bearing late open boundary error when cleanupFails=$cleanupFails',
        async ({ cleanupFails, expectedContext }) => {
            const agentId = cleanupFails
                ? 'acme-native-late-cleanup-error'
                : 'acme-native-late-open-error';
            const secret = cleanupFails
                ? 'profile-cleanup-secret'
                : 'profile-open-secret';
            const contributions =
                createExternalContributionFixtures(agentId);
            const disposeHostServices = vi.fn(async () => {
                if (cleanupFails) {
                    const error = new Error(
                        `host cleanup failed: ${secret}`,
                    );
                    error.stack =
                        `Error: host cleanup failed: ${secret}\n`
                        + `    at cleanup (${secret}:1:1)`;
                    throw error;
                }
            });
            const open = vi.fn(async () => {
                const error = new Error(
                    `native open failed: ${secret}`,
                );
                error.stack =
                    `Error: native open failed: ${secret}\n`
                    + `    at open (${secret}:1:1)`;
                throw error;
            });
            const plan = await createNativeAgentRuntimeSessionPlan({
                runtime: { sessions: { open } },
                lease: createLease(agentId),
                backend: contributions.backend,
                agent: contributions.agent,
                createSessionHostServiceOwners: () => Object.freeze({
                    ...createSessionHostServiceOwners(),
                    dispose: disposeHostServices,
                }),
                sessionInput: buildPluginSessionBindingInput({
                    credentials,
                    directory: `/tmp/${agentId}`,
                    resolveLateEnvironment: async () => ({
                        environmentVariables: {
                            PROFILE_SECRET: secret,
                        },
                        unsetEnvironmentVariables: [],
                        sensitiveEnvironmentVariableNames: [
                            'PROFILE_SECRET',
                        ],
                    }),
                }),
            });
            if (!plan.config.createSessionRuntime) {
                throw new Error('expected a session runtime factory');
            }
            let propagated: unknown = null;
            try {
                await plan.config.createSessionRuntime({
                    directory: `/tmp/${agentId}`,
                    metadata: {},
                    machineId: 'machine-1',
                    session: createNativeSessionClientTestPort(
                        `session-${agentId}`,
                    ),
                    transcriptSession: {},
                    messageBuffer: {},
                    mcpServers: {},
                    permissionHandler: {},
                    getPermissionMode: () => 'default',
                    setThinking: () => undefined,
                    memoryRecallGuidanceEnabled: false,
                } as never);
            } catch (error) {
                propagated = error;
            }

            expect(propagated).toBeInstanceOf(Error);
            const propagatedError = propagated as Error;
            expect(propagatedError.message).toContain(expectedContext);
            expect(
                `${propagatedError.name}\n`
                + `${propagatedError.message}\n`
                + `${propagatedError.stack ?? ''}`,
            ).not.toContain(secret);
            expect(propagatedError.message).toContain('[REDACTED]');
            expect(Reflect.get(propagatedError, 'cause')).toBeUndefined();
            expect(disposeHostServices).toHaveBeenCalledOnce();
            expect(redactBugReportSensitiveText(
                `value=${secret}`,
            )).toBe(`value=${secret}`);
        },
    );

    it('disposes an opened late Provider session when binding metadata persistence fails', async () => {
        const agentId = 'codex';
        const externalContributions =
            createExternalContributionFixtures(agentId);
        const contributions = {
            backend: {
                ...externalContributions.backend,
                provenance: 'first_party' as const,
                source: { kind: 'bundled' as const },
                pluginId: 'happier.agent.codex',
            },
            agent: {
                ...externalContributions.agent,
                provenance: 'first_party' as const,
                source: { kind: 'bundled' as const },
                pluginId: 'happier.agent.codex',
            },
        };
        const dispose = vi.fn(async () => undefined);
        const open = vi.fn(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose,
        }));
        const metadata = providerBindingMetadata(
            'pc_late',
            'late-model',
        );
        const materialization = Object.freeze({
            v: 1 as const,
            kind: 'engineConfig' as const,
            engineConfig: Object.freeze({}),
        });
        const persistedMetadata = {
            path: '/tmp/acme-native-late-provider',
            host: 'test',
            homeDir: '/tmp',
            happyHomeDir: '/tmp/.happier',
            happyLibDir: '/tmp/.happier/lib',
            happyToolsDir: '/tmp/.happier/tools',
            providerBindingV1: providerBindingMetadata(
                'pc_previous',
                'previous-model',
            ),
        };
        const session = createNativeSessionClientTestPort(
            'session-native-late-provider',
            {
                getMetadataSnapshot: () => persistedMetadata,
                updateMetadata: vi.fn(async () => {
                    throw new Error('metadata persistence failed');
                }),
            },
        );
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open } },
            lease: {
                ...createLease(agentId),
                pluginId: 'happier.agent.codex',
            },
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-late-provider',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'codex',
                },
                modelSelection: {
                    v: 1,
                    updatedAt: 1,
                    ref: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: 'pc_late',
                        modelId: 'late-model',
                    },
                },
                resolveLateEnvironment: async () => ({
                    environmentVariables: {
                        HAPPIER_CODEX_PROVIDER_API_KEY:
                            'provider-plaintext',
                        [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
                            serializeProviderBindingLaunchHandoffForEnv(
                                materialization,
                                metadata,
                            ),
                    },
                    unsetEnvironmentVariables: [
                        'OPENAI_API_KEY',
                        'CODEX_API_KEY',
                    ],
                    sensitiveEnvironmentVariableNames: [],
                }),
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }

        await expect(plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-late-provider',
            metadata: {
                providerBindingV1: providerBindingMetadata(
                    'pc_previous',
                    'previous-model',
                ),
            },
            machineId: 'machine-1',
            session,
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never)).rejects.toThrow('metadata persistence failed');

        expect(open).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(session.getMetadataSnapshot()).toMatchObject({
            providerBindingV1: providerBindingMetadata(
                'pc_previous',
                'previous-model',
            ),
        });
    });

    it('projects terminal follow through the bound daemon port when the carried child has no local External Session surface', async () => {
        const agentId = 'acme-native-terminal-agent';
        const base = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...base.agent,
            richDefinition: {
                ...base.agent.richDefinition,
                definition: {
                    ...base.agent.richDefinition.definition,
                    surfaces: {
                        externalSession: {
                            sources: [{
                                sourceKind: 'terminal',
                                schema: {
                                    fields: [
                                        {
                                            name: 'kind',
                                            kind: 'literal',
                                            value: 'terminal',
                                        },
                                        {
                                            name: 'projectId',
                                            kind: 'string',
                                        },
                                    ],
                                },
                                key: {
                                    segments: [
                                        {
                                            kind: 'literal',
                                            value: 'terminal',
                                        },
                                        {
                                            kind: 'field',
                                            field: 'projectId',
                                        },
                                    ],
                                },
                                instances: [{
                                    kind: 'default',
                                    constants: { projectId: 'project-1' },
                                }],
                            }],
                        },
                    },
                },
            },
        };
        const disposeFollow = vi.fn(async () => undefined);
        const executeProviderSessionFollow = vi.fn<
            ExternalSessionHostOperationPort['executeProviderSessionFollow']
        >(async (request) => {
            await request.listener({
                kind: 'data',
                items: [{
                    id: 'terminal-item-1',
                    timestampMs: 11,
                    kind: 'agent',
                    data: { type: 'text', text: 'terminal output' },
                }],
                fromCursor: 'cursor-0',
                nextCursor: 'cursor-1',
            });
            return {
                status: 'following' as const,
                startingCursor: 'cursor-0',
                subscription: { dispose: disposeFollow },
            };
        });
        const retireExternalSessionHostOperations = vi.fn(async () => undefined);
        const bindExternalSessionHostOperations = vi.fn(() => ({
            executeTakeover: vi.fn(),
            executeFollow: vi.fn(),
            executeProviderSessionFollow,
            retire: retireExternalSessionHostOperations,
        }));
        const open = vi.fn(async () => {
            const providerIdentityEvent: AgentSessionRuntimeEvent = {
                sequence: 1,
                sessionId: 'session-native-terminal',
                emittedAtMs: 1,
                kind: 'provider-session-id',
                providerSessionId: 'provider-terminal-1',
            };
            return {
                send: vi.fn(async () => ({ status: 'admitted' as const })),
                watch(listener: (event: AgentSessionRuntimeEvent) => void) {
                    listener(providerIdentityEvent);
                    return { dispose: () => undefined };
                },
                dispose: vi.fn(),
            };
        });
        const terminalLaunch = vi.fn(async (_request: HostTerminalLaunchRequest) => ({
                type: 'control_returned' as const,
                reason: 'pending_input' as const,
        }));
        const executionSurfaces: BackendExecutionSurfaces = {
            ...createEmptyBackendExecutionSurfaces(),
            terminalRuntime: { launch: terminalLaunch },
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: {
                sessions: { open },
                surfaces: {
                    terminal: {
                        resolveLaunch: () => ({ argv: ['--terminal'] }),
                    },
                },
            },
            lease: createLease(agentId),
            backend: base.backend,
            agent,
            executionSurfaces,
            externalSessionHostOperations: {
                bindSession: bindExternalSessionHostOperations,
            },
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-terminal',
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const messageQueue = new MessageQueue2<
            { permissionMode: string },
            { text: string }
        >((mode) => mode.permissionMode);
        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: true,
        }));
        let currentSessionMetadata: Record<string, unknown> = {
            terminalRuntime: { promptInteractive: true },
        };
        const sessionPort = createNativeSessionClientTestPort(
            'session-native-terminal',
            {
                enqueueAgentMessageCommitted,
                getMetadataSnapshot: () => currentSessionMetadata,
            },
        );
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-terminal',
            metadata: currentSessionMetadata,
            machineId: 'machine-1',
            session: sessionPort,
            transcriptSession: {},
            messageQueue,
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);
        expect(bindExternalSessionHostOperations).toHaveBeenCalledOnce();

        expect(
            (created.operations as unknown as Readonly<Record<string, unknown>>)
                .resolveTerminalRemoteSessionModeLoop,
        ).toBeUndefined();
        const modeLoop = created.terminalRemoteModeLoop ?? null;
        expect(modeLoop).not.toBeNull();
        expect(modeLoop?.startingMode).toBe('remote');
        const unsubscribeRuntimeEvents =
            created.operations.subscribeRuntimeEvents(() => undefined);
        let remoteSettled = false;
        const remoteResult = modeLoop?.runRemote().then((result) => {
            remoteSettled = true;
            return result;
        });
        await Promise.resolve();
        await expect(sessionPort.rpcHandlerManager.invokeLocal(
            'switch',
            { to: 'remote' },
        )).resolves.toBe(true);
        await expect(sessionPort.rpcHandlerManager.invokeLocal(
            'switch',
            { to: 'unsupported' },
        )).resolves.toBe(false);
        expect(remoteSettled).toBe(false);
        await expect(sessionPort.rpcHandlerManager.invokeLocal(
            'switch',
            { to: 'local' },
        )).resolves.toBe(true);
        await expect(remoteResult).resolves.toBe('switch');
        currentSessionMetadata = {
            terminalRuntime: {
                promptInteractive: true,
                sandbox: true,
            },
            providerSessionId: 'provider-terminal-stale',
        };
        await expect(sessionPort.rpcHandlerManager.invokeLocal(
            'switch',
            { to: 'local' },
        )).resolves.toBe(false);
        await expect(modeLoop?.runTerminal({ entry: 'initial' })).resolves.toEqual({ type: 'switch' });
        expect(terminalLaunch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-native-terminal',
            directory: '/tmp/acme-native-terminal',
            metadata: {
                terminalRuntime: {
                    promptInteractive: true,
                    sandbox: true,
                },
                providerSessionId: 'provider-terminal-1',
            },
            signal: expect.any(AbortSignal),
            host: expect.objectContaining({
                transcriptFollow: expect.objectContaining({
                    bindProviderSession: expect.any(Function),
                    releaseActiveBindings: expect.any(Function),
                }),
            }),
        }));
        expect(bindExternalSessionHostOperations).toHaveBeenCalledOnce();
        expect(bindExternalSessionHostOperations).toHaveBeenCalledWith('session-native-terminal');
        expect(executeProviderSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
            agentId,
            providerSessionId: 'provider-terminal-1',
            options: { signal: expect.any(AbortSignal) },
            listener: expect.any(Function),
        }));
        expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
            agentId,
            { type: 'message', message: 'terminal output' },
            expect.objectContaining({
                localId: 'terminal-item-1',
                provenance: {
                    kind: 'non_dependent',
                    source: 'external',
                },
            }),
        );
        expect(disposeFollow).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
        const launchCountBeforeAuthorityRefusal =
            terminalLaunch.mock.calls.length;
        const transcriptCountBeforeAuthorityRefusal =
            enqueueAgentMessageCommitted.mock.calls.length;
        executeProviderSessionFollow.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'plugin_external_follow_authority_unavailable',
        });
        await expect(
            modeLoop?.runTerminal({ entry: 'initial' }),
        ).rejects.toThrow('plugin_external_follow_authority_unavailable');
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeAuthorityRefusal,
        );
        expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(
            transcriptCountBeforeAuthorityRefusal,
        );
        const terminalSignal = terminalLaunch.mock.calls[0]?.[0].signal;
        expect(terminalSignal?.aborted).toBe(false);
        const retiredRemoteResult = modeLoop?.runRemote();
        await Promise.resolve();
        unsubscribeRuntimeEvents();
        await created.operations.resetOrDisposeRuntime();
        await expect(retiredRemoteResult).resolves.toBe('exit');
        await expect(sessionPort.rpcHandlerManager.invokeLocal(
            'switch',
            { to: 'local' },
        )).resolves.toBe(false);
        expect(terminalSignal?.aborted).toBe(true);
        expect(retireExternalSessionHostOperations).toHaveBeenCalledOnce();
    });

    it('projects session-bound system records through the live session client and fences retired generations', async () => {
        let current = true;
        let systemRecords: AgentSessionRuntimeContext['session']['services']['systemRecords'] | undefined;
        const payload = createWorkflowRunSystemRecordPayload();
        const upsertSessionSystemRecord = vi.fn(async () => undefined);
        const fetchSessionSystemRecord = vi.fn(async () => ({
            id: 'record-native-1',
            sessionId: 'session-native-system-records',
            namespace: 'activity' as const,
            kind: 'workflow_run.v1' as const,
            localId: 'activity:workflow_run:v1:workflow-native-1',
            content: { t: 'plain' as const, v: payload },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:01.000Z',
        }));
        const runtime: AgentRuntime = {
            sessions: {
                open: vi.fn(async (_request, context) => {
                    systemRecords = context.session.services.systemRecords;
                    return {
                        send: vi.fn(async () => ({ status: 'admitted' as const })),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: vi.fn(),
                    };
                }),
            },
        };
        const agentId = 'acme-native-system-records-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition.capabilities,
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            open: ['create', 'fork'],
                        },
                    },
                },
            },
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: { ...createLease(agentId), isCurrent: () => current },
            backend: contributions.backend,
            agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-system-records',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-system-records', metadata: {}, machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-native-system-records', {
                upsertSessionSystemRecord,
                fetchSessionSystemRecord,
                getStoredContentEncryptionContext: () => ({ mode: 'plain' as const }),
            }),
            transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
            getPermissionMode: () => 'default', setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(systemRecords).toBeDefined();
        if (!systemRecords) return;
        const request = {
            namespace: 'activity' as const,
            kind: 'workflow_run.v1' as const,
            localId: 'activity:workflow_run:v1:workflow-native-1',
            payload,
        };
        await expect(systemRecords.write(request)).resolves.toBeUndefined();
        expect(upsertSessionSystemRecord).toHaveBeenCalledWith({
            namespace: request.namespace,
            kind: request.kind,
            localId: request.localId,
            content: { t: 'plain', v: payload },
        });
        await expect(systemRecords.read({
            namespace: request.namespace,
            localId: request.localId,
        })).resolves.toEqual(request);

        current = false;
        await expect(systemRecords.write(request)).rejects.toThrow(/retired or unavailable/u);
        await expect(systemRecords.read({
            namespace: request.namespace,
            localId: request.localId,
        })).rejects.toThrow(/retired or unavailable/u);
        expect(upsertSessionSystemRecord).toHaveBeenCalledTimes(1);
        expect(fetchSessionSystemRecord).toHaveBeenCalledTimes(1);
        await created.operations.resetOrDisposeRuntime();
    });

    it('publishes only a validated compact workflow headline through the bound session and fences retired generations', async () => {
        type WorkflowActivityService = Readonly<{
            publishHeadline(headline: unknown): Promise<void>;
        }>;

        let current = true;
        let workflowActivity: WorkflowActivityService | undefined;
        const runtime: AgentRuntime = {
            sessions: {
                open: vi.fn(async (_request, context) => {
                    workflowActivity = (context.session.services as unknown as Readonly<{
                        workflowActivity: WorkflowActivityService;
                    }>).workflowActivity;
                    return {
                        send: vi.fn(async () => ({ status: 'admitted' as const })),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: vi.fn(),
                    };
                }),
            },
        };
        const agentId = 'acme-native-workflow-activity-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const session = createNativeSessionClientTestPort('session-native-workflow-activity');
        const updateMetadata = vi.spyOn(session, 'updateMetadata');
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: { ...createLease(agentId), isCurrent: () => current },
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-workflow-activity',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-workflow-activity', metadata: {}, machineId: 'machine-1',
            session,
            transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
            getPermissionMode: () => 'default', setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(workflowActivity).toBeDefined();
        if (!workflowActivity) return;
        const headline = createWorkflowActivityHeadline();
        await expect(workflowActivity.publishHeadline({
            ...headline,
            unapprovedDetail: { agents: ['must-not-persist'] },
            activeRuns: headline.activeRuns.map((run) => ({
                ...run,
                phases: [{ title: 'must-not-persist' }],
            })),
        })).resolves.toBeUndefined();
        expect(session.getMetadataSnapshot()).toMatchObject({
            path: '/tmp/test',
        });
        expect(session.getMetadataSnapshot().sessionWorkflowActivityHeadlineV1).toEqual(headline);
        expect(JSON.stringify(session.getMetadataSnapshot())).not.toContain('must-not-persist');
        expect(Object.keys(workflowActivity)).toEqual(['publishHeadline']);

        await expect(workflowActivity.publishHeadline({
            ...headline,
            v: 2,
        })).rejects.toThrow();
        expect(updateMetadata).toHaveBeenCalledTimes(1);
        expect(session.getMetadataSnapshot().sessionWorkflowActivityHeadlineV1).toEqual(headline);

        current = true;
        updateMetadata.mockImplementationOnce(async (updater) => {
            current = false;
            const beforeRetirement = session.getMetadataSnapshot();
            expect(updater(beforeRetirement)).toBe(beforeRetirement);
        });
        await expect(workflowActivity.publishHeadline(headline)).rejects.toThrow(/retired or unavailable/u);
        expect(updateMetadata).toHaveBeenCalledTimes(2);
        expect(session.getMetadataSnapshot().sessionWorkflowActivityHeadlineV1).toEqual(headline);

        current = false;
        await expect(workflowActivity.publishHeadline(headline)).rejects.toThrow(/retired or unavailable/u);
        expect(updateMetadata).toHaveBeenCalledTimes(2);
        await created.operations.resetOrDisposeRuntime();
    });

    it('projects the canonical terminal host only into an eligible session scope and fences its lifecycle', async () => {
        const handles: TerminalHostHandle[] = [];
        const disposeHost = vi.fn(async (_input: Readonly<{ intent: unknown }>) => undefined);
        const controlPort: TerminalControlPort = {
            hostKind: 'tmux',
            sendLiteralText: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            sendRawSequence: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            sendSpecialKey: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            captureScreen: vi.fn(async () => ({
                status: 'captured' as const,
                capture: { text: '', capturedAtMs: 1, hostKind: 'tmux' as const },
            })),
        };
        const adapter: TerminalHostAdapter = {
            kind: 'tmux',
            createOrAttachHost: vi.fn(async ({ sessionName }) => {
                const handle: TerminalHostHandle = {
                    attachmentId: 'native-terminal-attachment' as NonNullable<TerminalHostHandle['attachmentId']>,
                    kind: 'tmux',
                    sessionName,
                    paneId: String(handles.length),
                    attachMetadata: {
                        attachStrategy: 'terminal_host',
                        topology: 'exclusive',
                        locality: 'same_machine',
                        maxClients: null,
                        requiresLocalAttachmentInfo: true,
                        liveProbe: 'required',
                    },
                };
                handles.push(handle);
                return handle;
            }),
            injectUserPrompt: vi.fn(async (handle): Promise<TerminalInputInjectionResult> => ({
                status: 'injected',
                injectedAt: 2,
                bytesWritten: 5,
                hostKind: handle.kind,
                hostSessionName: handle.sessionName,
                paneId: handle.paneId,
            })),
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 3 })),
            captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: 4 })),
            createControlPort: vi.fn(() => controlPort),
            dispose: vi.fn(async () => undefined),
        };
        const terminalHost = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost' || capability === 'terminal.host.control',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({ command: '/usr/local/bin/acme-agent', args: [] }),
            disposeHost,
        });
        let current = true;
        let projectedTerminalHost: (typeof terminalHost) | undefined;
        const runtime: AgentRuntime = {
            sessions: {
                open: vi.fn(async (_request, context) => {
                    projectedTerminalHost = (context.session.services as typeof context.session.services & Readonly<{
                        terminalHost?: typeof terminalHost;
                    }>).terminalHost;
                    if (!projectedTerminalHost) throw new Error('expected eligible native terminal host');
                    await expect(projectedTerminalHost.resolve({ preference: 'auto' })).resolves.toMatchObject({
                        status: 'resolved',
                        hostKind: 'tmux',
                    });
                    const explicitHandle = await projectedTerminalHost.createOrAttachHost({
                        preference: 'tmux',
                        sessionName: 'native-explicit',
                        workingDirectory: '/tmp/acme-native-terminal',
                        launch: { kind: 'agent-cli', agentId: 'acme-native-terminal-agent' },
                        isolatedEnv: true,
                    });
                    await expect(projectedTerminalHost.injectUserPrompt(explicitHandle, {
                        text: 'hello',
                        multiline: false,
                        origin: { kind: 'ui_pending', nonce: 'native-terminal-1' },
                        scheduling: {},
                    })).resolves.toMatchObject({ status: 'injected' });
                    await expect(projectedTerminalHost.captureInputState(explicitHandle)).resolves.toMatchObject({
                        stable: true,
                    });
                    await expect(projectedTerminalHost.controlPort(explicitHandle)).resolves.toBe(controlPort);
                    await expect(projectedTerminalHost.evaluateLiveness(explicitHandle)).resolves.toMatchObject({
                        paneAlive: true,
                    });
                    await expect(projectedTerminalHost.interruptTurn(explicitHandle)).resolves.toBeUndefined();
                    await projectedTerminalHost.dispose(explicitHandle, {
                        kind: 'destroy_owned_host',
                        reason: 'session_closed',
                    });
                    await projectedTerminalHost.dispose(explicitHandle, {
                        kind: 'destroy_owned_host',
                        reason: 'session_closed',
                    });
                    await projectedTerminalHost.createOrAttachHost({
                        preference: 'tmux',
                        sessionName: 'native-lifecycle-owned',
                        workingDirectory: '/tmp/acme-native-terminal',
                        launch: { kind: 'agent-cli', agentId: 'acme-native-terminal-agent' },
                        isolatedEnv: true,
                    });
                    return {
                        send: vi.fn(async () => ({ status: 'admitted' as const })),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: vi.fn(),
                    };
                }),
            },
        };
        const agentId = 'acme-native-terminal-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const session = createNativeSessionClientTestPort('native-terminal-session');
        const reportSessionMetadataToDaemon = vi.fn(async () => undefined);
        const planWithTerminalMetadataPublication = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: { ...createLease(agentId), isCurrent: () => current },
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-terminal',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => Object.freeze({
                ...createSessionHostServiceOwners(),
                terminalHost,
            }),
            reportSessionMetadataToDaemon,
        });
        if (!planWithTerminalMetadataPublication.config.createSessionRuntime) {
            throw new Error('expected a terminal metadata publication runtime factory');
        }
        const created = await planWithTerminalMetadataPublication.config.createSessionRuntime({
            directory: '/tmp/acme-native-terminal', metadata: {}, machineId: 'machine-1',
            session,
            transcriptSession: { rpcHandlerManager: { registerHandler: vi.fn() } }, messageBuffer: {},
            mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default',
            setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
        } as never);

        expect(session.getMetadataSnapshot().terminal).toEqual({
            mode: 'tmux',
            tmux: {
                target: 'native-lifecycle-owned:1',
            },
        });
        expect(reportSessionMetadataToDaemon).toHaveBeenLastCalledWith({
            sessionId: 'native-terminal-session',
            metadata: session.getMetadataSnapshot(),
        });
        expect(disposeHost).toHaveBeenCalledTimes(1);
        current = false;
        await expect(projectedTerminalHost?.resolve({ preference: 'auto' })).rejects.toMatchObject({
            code: 'PLUGIN_TERMINAL_HOST_SCOPE_RETIRED',
        });
        await created.operations.resetOrDisposeRuntime();
        await created.operations.resetOrDisposeRuntime();
        expect(disposeHost).toHaveBeenCalledTimes(2);
        expect(disposeHost.mock.calls.map(([input]) => input.intent)).toEqual([
            { kind: 'destroy_owned_host', reason: 'session_closed' },
            { kind: 'preserve_host', reason: 'runtime_recovery' },
        ]);
    });

    it('keeps feature decisions fail-closed and omits imperative terminal authority when it is not granted', async () => {
        let captured: AgentSessionRuntimeContext | null = null;
        const isEnabled = vi.fn((featureId: string): boolean => {
            if (featureId === 'agents.claude.unifiedTerminal') return true;
            if (featureId === 'malformed.feature.decision') return 'enabled' as never;
            return false;
        });
        const agentId = 'acme-declarative-terminal-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: {
                sessions: {
                    open: vi.fn(async (_request, context) => {
                        captured = context;
                        return {
                            send: vi.fn(async () => ({ status: 'admitted' as const })),
                            watch: () => ({ dispose: () => undefined }),
                            dispose: vi.fn(),
                        };
                    }),
                },
            },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-declarative-terminal',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => Object.freeze({
                ...createSessionHostServiceOwners(),
                features: Object.freeze({ isEnabled }),
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-declarative-terminal', metadata: {}, machineId: 'machine-1',
            session: createNativeSessionClientTestPort('native-no-terminal-authority'),
            transcriptSession: { rpcHandlerManager: { registerHandler: vi.fn() } }, messageBuffer: {},
            mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default',
            setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
        } as never);
        if (!captured) throw new Error('expected native context');
        const hostServices = (captured as AgentSessionRuntimeContext).session.services as AgentSessionRuntimeContext['session']['services'] & Readonly<{
            features: Readonly<{ isEnabled(featureId: string): boolean }>;
            terminalHost?: unknown;
        }>;
        expect(hostServices).not.toHaveProperty('terminalHost');
        expect(hostServices.features.isEnabled('agents.claude.unifiedTerminal')).toBe(true);
        expect(hostServices.features.isEnabled('not.a.feature')).toBe(false);
        expect(hostServices.features.isEnabled('malformed.feature.decision')).toBe(false);
        expect(isEnabled).toHaveBeenCalledTimes(3);
        await created.operations.resetOrDisposeRuntime();
    });

    it('projects declared native direct facets and persists the pre-dispatch rollback range without an Agent-id branch', async () => {
        const emitter: { current: ((event: AgentSessionRuntimeEvent) => void) | null } = { current: null };
        let capturedRollbackRequest: Parameters<AgentSessionConversationRollbackControl['rollback']>[0] | null = null;
        let lastObservedMessageSeq = 11;
        const rollback = vi.fn<AgentSessionConversationRollbackControl['rollback']>(async (request) => {
            capturedRollbackRequest = request;
            lastObservedMessageSeq = 99;
            return {
                status: 'outcomeUnknown' as const,
                diagnostic: { code: 'rollback_reply_lost', severity: 'error' as const },
            };
        });
        const reconcile = vi.fn<AgentSessionConversationRollbackControl['reconcile']>(async () => ({ status: 'applied' as const }));
        const getGoal = vi.fn(async () => ({ status: 'applied' as const, revision: 'goal-revision-1' }));
        const setGoal = vi.fn(async () => ({ status: 'applied' as const, revision: 'goal-revision-2' }));
        const clearGoal = vi.fn(async () => ({ status: 'unchanged' as const, revision: 'goal-revision-3' }));
        const listCatalog = vi.fn<AgentSessionCatalogControl['list']>(async (request) => request.kind === 'vendorPlugins'
            ? {
                status: 'ok' as const,
                kind: 'vendorPlugins' as const,
                items: [{
                    id: 'plugin://gmail',
                    name: 'gmail',
                    displayName: 'Gmail',
                    installed: true,
                    enabled: true,
                    mentionable: true,
                }],
            }
            : {
                status: 'ok' as const,
                kind: 'skills' as const,
                items: [{
                    id: 'skill-review',
                    name: 'review',
                    displayName: 'Review',
                    path: '/skills/review',
                    enabled: true,
                }],
            });
        const executeUsage = vi.fn(async (request: Readonly<{ kind: 'checkNow' | 'consumeResetCredit' }>) => ({
            status: request.kind === 'checkNow' ? 'ready' as const : 'noRecoveryNeeded' as const,
        }));
        const runtime: AgentRuntime = {
            sessions: {
                goals: { get: getGoal, set: setGoal, clear: clearGoal },
                catalog: { list: listCatalog },
                usageLimitRecovery: { execute: executeUsage },
                open: vi.fn(async () => ({
                    conversationRollback: { rollback, reconcile },
                    send: vi.fn(async () => ({ status: 'admitted' as const })),
                    watch: (handler: (event: AgentSessionRuntimeEvent) => void) => {
                        emitter.current = handler;
                        return { dispose: () => undefined };
                    },
                    dispose: vi.fn(),
                })),
            },
        };
        const agentId = 'acme-direct-controls-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition.capabilities,
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            conversationRollback: true,
                            goals: {
                                active: { get: true, clear: true, set: { fields: ['objective', 'status', 'tokenBudget'] } },
                                source: 'goals',
                            },
                            catalog: { active: ['vendorPlugins', 'skills'] },
                            usageLimitRecovery: { active: ['checkNow', 'consumeResetCredit'] },
                            workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
                        },
                    },
                },
            },
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-direct-controls-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                resume: 'provider-session-1',
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const hostSession = createNativeSessionClientTestPort('session-direct-controls', {
            readSessionTurnsProjection: async () => ({
                v: 1,
                sessionId: 'session-direct-controls',
                updatedAt: 10,
                turns: [{
                    turnId: 'persisted-turn-1',
                    status: 'completed',
                    startedAt: 1,
                    updatedAt: 2,
                    transcriptAnchors: { startUserMessageSeq: 7 },
                    rollback: {
                        state: 'eligible',
                        providerCheckpoint: { promptIndex: 42 },
                        updatedAt: 3,
                    },
                }],
            }),
            getLastObservedMessageSeq: () => lastObservedMessageSeq,
        });
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-direct-controls-agent', metadata: {}, machineId: 'machine-1',
            session: hostSession, transcriptSession: {}, messageBuffer: {},
            mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default',
            setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
        } as never);
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId,
            session: {
                sessionId: 'session-direct-controls',
                enqueueSessionTurnMutation: (mutation) => { mutations.push(mutation); },
            },
        });
        const controls = created.nativeRuntime as typeof created.nativeRuntime & Readonly<{
            rollbackConversation(request: Readonly<{ v: 1; target: Readonly<{ type: 'latest_turn' }> }>): Promise<unknown>;
            refreshGoal(): Promise<unknown>;
            setGoal(objective?: string, options?: Readonly<{ status?: string; tokenBudget?: number | null }>): Promise<unknown>;
            clearGoal(): Promise<unknown>;
            listVendorPlugins(): Promise<unknown>;
            listSkills(): Promise<unknown>;
            checkUsageLimitRecoveryNow(request: Readonly<{ sessionId: string; resumePromptMode?: 'standard' | 'off' | 'custom' }>): Promise<unknown>;
            consumeUsageLimitResetCredit(request: Readonly<{ sessionId: string; issueFingerprint?: string }>): Promise<unknown>;
        }>;
        created.operations.subscribeRuntimeEvents((event) => {
            if (!('kind' in event)) return;
            lifecycle.observeRuntimeEvent(event);
        });

        await controls.refreshGoal();
        await controls.setGoal('Ship direct facets', { status: 'active', tokenBudget: 1000 });
        await controls.clearGoal();
        await expect(controls.listVendorPlugins()).resolves.toEqual({
            vendorPlugins: [{
                vendorPluginRef: 'plugin://gmail', name: 'gmail', displayName: 'Gmail',
                installed: true, enabled: true, mentionable: true,
            }],
        });
        await expect(controls.listSkills()).resolves.toEqual({
            skills: [{
                v: 1, id: 'skill-review', origin: 'vendor', backendId: agentId, agentId,
                name: 'review', displayName: 'Review', path: '/skills/review', enabled: true,
            }],
        });
        await expect(controls.checkUsageLimitRecoveryNow({
            sessionId: 'untrusted-session',
            resumePromptMode: 'custom',
        })).resolves.toEqual({ status: 'ready' });
        await expect(controls.consumeUsageLimitResetCredit({
            sessionId: 'untrusted-session',
            issueFingerprint: 'quota-1',
        })).resolves.toEqual({ status: 'noRecoveryNeeded' });

        emitter.current?.({
            kind: 'provider-session-id', sessionId: 'session-direct-controls', providerSessionId: 'provider-session-1',
            emittedAtMs: 1, sequence: 1,
        });
        await expect(controls.rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toEqual({
            ok: true,
            target: { type: 'latest_turn' },
            threadId: 'provider-session-1',
        });
        expect(hostSession.getMetadataSnapshot()).toMatchObject({
            sessionRollbackRangesV1: {
                v: 1,
                updatedAt: expect.any(Number),
                ranges: [{
                    target: { type: 'latest_turn' },
                    startSeqInclusive: 7,
                    endSeqInclusive: 11,
                    rolledBackAt: expect.any(Number),
                }],
            },
        });
        expect(rollback).toHaveBeenCalledWith(expect.objectContaining({
            affectedTurns: [{
                turnId: 'persisted-turn-1',
                providerCheckpoint: { promptIndex: 42 },
            }],
        }), expect.any(Object));
        expect(mutations.at(-1)).toMatchObject({
            action: 'mark_rolled_back',
            turnId: 'persisted-turn-1',
            restoredToTurnId: 'persisted-turn-1',
        });
        await expect(controls.rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toMatchObject({
            ok: false,
            errorCode: 'native_conversation_rollback_target_unavailable',
        });
        rollback.mockClear();
        reconcile.mockClear();
        emitter.current?.({
            kind: 'turn-start', sessionId: 'session-direct-controls', turnId: 'turn-1', startedBy: 'provider',
            emittedAtMs: 2, sequence: 2,
        });
        emitter.current?.({
            kind: 'turn-rollback-boundary', sessionId: 'session-direct-controls', turnId: 'turn-1',
            agentTurnId: 'provider-turn-1', agentRollbackOrdinal: 4, providerCheckpoint: { promptIndex: 9 },
            emittedAtMs: 3, sequence: 3,
        });
        emitter.current?.({
            kind: 'turn-complete', sessionId: 'session-direct-controls', turnId: 'turn-1',
            emittedAtMs: 4, sequence: 4,
        });
        await expect(controls.rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toEqual({
            ok: true,
            target: { type: 'latest_turn' },
            threadId: 'provider-session-1',
        });
        expect(rollback).toHaveBeenCalledWith(expect.objectContaining({
            operationId: expect.any(String),
            target: { kind: 'beforeTurn', turnId: 'turn-1' },
            affectedTurns: [{
                turnId: 'turn-1',
                providerCheckpoint: { promptIndex: 9 },
            }],
            providerSessionId: 'provider-session-1',
            runtimeIncarnationId: expect.any(String),
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(reconcile).toHaveBeenCalledWith(
            capturedRollbackRequest,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(mutations.at(-1)).toMatchObject({
            action: 'mark_rolled_back',
            turnId: 'turn-1',
            restoredToTurnId: 'turn-1',
            agentTurnId: 'provider-turn-1',
            agentRollbackOrdinal: 4,
        });
        expect(getGoal).toHaveBeenCalledWith(expect.objectContaining({
            session: expect.objectContaining({ id: 'session-direct-controls', activity: 'active' }),
            goalSource: expect.any(Object),
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(setGoal).toHaveBeenCalledWith({ objective: 'Ship direct facets', status: 'active', tokenBudget: 1000 }, expect.any(Object), expect.any(Object));
        expect(listCatalog.mock.calls.map(([request]) => request)).toEqual([{ kind: 'vendorPlugins' }, { kind: 'skills' }]);
        expect(executeUsage.mock.calls.map(([request]) => request)).toEqual([
            { kind: 'checkNow', resumePromptMode: 'custom' },
            { kind: 'consumeResetCredit', issueFingerprint: 'quota-1' },
        ]);

        await created.operations.resetOrDisposeRuntime();
        await expect(controls.refreshGoal()).resolves.toEqual({
            ok: false,
            errorCode: 'native_goal_control_unavailable',
            error: 'native_goal_control_unavailable',
        });
        expect(getGoal).toHaveBeenCalledTimes(1);
    });

    it('sanitizes and cleans a late-environment resume when continuation verification rejects', async () => {
        const agentId = 'acme-continuation-late-rejection-agent';
        const secret = 'continuation-late-secret-value';
        const contributions = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition.capabilities,
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            open: ['create', 'resume'],
                            continuationVerification: {
                                intents: ['resume'],
                                requirement: 'required',
                            },
                        },
                    },
                },
            },
        };
        const verify = vi.fn<
            AgentSessionContinuationControl['verify']
        >(async () => {
            throw new Error(
                `continuation verification rejected: ${secret}`,
            );
        });
        const open = vi.fn<AgentSessionRuntimeFactory['open']>();
        const disposeHostServices = vi.fn(async () => undefined);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { continuation: { verify }, open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-continuation-late-rejection-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                resume: 'provider-session-late-rejection',
                resolveLateEnvironment: async () => ({
                    environmentVariables: {
                        R490_CONTINUATION_SECRET: secret,
                    },
                    unsetEnvironmentVariables: [],
                    sensitiveEnvironmentVariableNames: [
                        'R490_CONTINUATION_SECRET',
                    ],
                }),
            }),
            createSessionHostServiceOwners: () => Object.freeze({
                ...createSessionHostServiceOwners(),
                dispose: disposeHostServices,
            }),
        });
        const runtimeParams = {
            directory: '/tmp/acme-continuation-late-rejection-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort(
                'session-continuation-late-rejection',
            ),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never;
        let propagated: unknown = null;

        try {
            await plan.config.createSessionRuntime?.(runtimeParams);
        } catch (error) {
            propagated = error;
        }

        expect(propagated).toBeInstanceOf(Error);
        expect(`${(propagated as Error).message}\n${
            (propagated as Error).stack ?? ''
        }`).not.toContain(secret);
        expect((propagated as Error).message).toContain('[REDACTED]');
        expect(open).not.toHaveBeenCalled();
        expect(
            daemonBridgeMocks.abandonPreparedSession,
        ).toHaveBeenCalledWith(
            expect.any(Object),
            'session-continuation-late-rejection',
        );
        expect(disposeHostServices).toHaveBeenCalledOnce();
        expect(redactBugReportSensitiveText(
            `value=${secret}`,
        )).toBe(`value=${secret}`);
    });

    it('settles late launch environment before resume continuation verification and native open', async () => {
        const events: string[] = [];
        const verify = vi.fn<AgentSessionContinuationControl['verify']>(
            async () => {
                events.push('verify');
                return {
                    status: 'reachable' as const,
                    providerSessionId: 'provider-session-late-resume',
                };
            },
        );
        const dispose = vi.fn(async () => undefined);
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(
            async () => {
                events.push('open');
                return {
                    send: vi.fn(async () => ({
                        status: 'admitted' as const,
                    })),
                    watch: () => ({ dispose: () => undefined }),
                    dispose,
                };
            },
        );
        const agentId = 'acme-continuation-late-environment-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition.capabilities,
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            open: ['create', 'resume'],
                            continuationVerification: {
                                intents: ['resume'],
                                requirement: 'required',
                            },
                        },
                    },
                },
            },
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { continuation: { verify }, open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-continuation-late-environment-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                resume: 'provider-session-late-resume',
                resolveLateEnvironment: async () => {
                    events.push('claim');
                    return {
                        environmentVariables: {
                            R490_LATE_ENVIRONMENT: 'settled-before-prepare',
                        },
                        unsetEnvironmentVariables: [],
                        sensitiveEnvironmentVariableNames: [],
                    };
                },
            }),
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
        });
        const runtimeParams = {
            directory: '/tmp/acme-continuation-late-environment-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort(
                'session-continuation-late-environment',
            ),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never;

        const created =
            await plan.config.createSessionRuntime?.(runtimeParams);

        expect(events).toEqual(['claim', 'verify', 'open']);
        expect(verify).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
        expect(verify.mock.calls[0]?.[0]).toEqual(open.mock.calls[0]?.[0]);
        expect(open.mock.calls[0]?.[0]).toMatchObject({
            kind: 'resume',
            sessionId: 'session-continuation-late-environment',
            cwd: '/tmp/acme-continuation-late-environment-agent',
            providerSessionId: 'provider-session-late-resume',
            launchEnvironment: {
                values: {
                    R490_LATE_ENVIRONMENT: 'settled-before-prepare',
                },
            },
        });
        await created?.operations.resetOrDisposeRuntime();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('fails required continuation before open and treats advisory unavailability as non-blocking', async () => {
        const verify = vi.fn<AgentSessionContinuationControl['verify']>(async () => ({
            status: 'unavailable' as const,
            diagnostic: { code: 'continuation_probe_unavailable', severity: 'error' as const },
        }));
        const open = vi.fn(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const agentId = 'acme-continuation-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const buildAgent = (requirement: 'required' | 'advisory'): ResolvedAgentContribution => ({
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition.capabilities,
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            open: ['create', 'resume'],
                            continuationVerification: { intents: ['resume'], requirement },
                        },
                    },
                },
            },
        });
        const buildPlan = async (requirement: 'required' | 'advisory') => await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { continuation: { verify }, open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: buildAgent(requirement),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-continuation-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                resume: 'provider-session-1',
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        });
        const runtimeParams = {
            directory: '/tmp/acme-continuation-agent', metadata: {}, machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-continuation'), transcriptSession: {}, messageBuffer: {},
            mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default',
            setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
        } as never;

        const requiredPlan = await buildPlan('required');
        await expect(requiredPlan.config.createSessionRuntime?.(runtimeParams)).rejects.toMatchObject({
            name: 'AgentSessionContinuationUnreachableError',
            message: 'Agent session continuation is unreachable.',
        });
        expect(open).not.toHaveBeenCalled();

        const advisoryPlan = await buildPlan('advisory');
        const created = await advisoryPlan.config.createSessionRuntime?.(runtimeParams);
        expect(open).toHaveBeenCalledTimes(1);
        expect(verify).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'resume',
            sessionId: 'session-continuation',
            cwd: '/tmp/acme-continuation-agent',
            providerSessionId: 'provider-session-1',
        }), expect.objectContaining({
            session: expect.objectContaining({
                id: 'session-continuation',
                activity: 'inactive',
                providerSessionId: 'provider-session-1',
            }),
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        await created?.operations.resetOrDisposeRuntime();
    });

    it.each([
        ['prepared-session abandonment', true, false],
        ['runtime-scope cleanup', false, true],
    ])('preserves required continuation refusal when %s fails', async (
        _label,
        abandonFails,
        scopeCleanupFails,
    ) => {
        const verify = vi.fn<AgentSessionContinuationControl['verify']>(async () => ({
            status: 'unreachable' as const,
            diagnostic: { code: 'continuation_unreachable', severity: 'error' as const },
        }));
        const open = vi.fn(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const disposeHostServices = vi.fn(async () => {
            if (scopeCleanupFails) throw new Error('injected runtime-scope cleanup failure');
        });
        daemonBridgeMocks.abandonPreparedSession.mockImplementationOnce(async () => {
            if (abandonFails) throw new Error('injected prepared-session abandonment failure');
        });
        const agentId = 'acme-continuation-cleanup-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition.capabilities,
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            open: ['create', 'resume'],
                            continuationVerification: {
                                intents: ['resume'],
                                requirement: 'required',
                            },
                        },
                    },
                },
            },
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { continuation: { verify }, open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-continuation-cleanup-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                resume: 'provider-session-1',
            }),
            createSessionHostServiceOwners: () => Object.freeze({
                ...createSessionHostServiceOwners(),
                dispose: disposeHostServices,
            }),
        });
        const runtimeParams = {
            directory: '/tmp/acme-continuation-cleanup-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-continuation-cleanup'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never;

        await expect(plan.config.createSessionRuntime?.(runtimeParams)).rejects.toMatchObject({
            name: 'AgentSessionContinuationUnreachableError',
            message: 'Agent session continuation is unreachable.',
        });
        expect(open).not.toHaveBeenCalled();
        expect(daemonBridgeMocks.abandonPreparedSession).toHaveBeenCalledWith(
            expect.any(Object),
            'session-continuation-cleanup',
        );
        expect(disposeHostServices).toHaveBeenCalledOnce();
    });

    it('disposes a native session that resolves after generation retirement instead of publishing it', async () => {
        const generationController = new AbortController();
        let resolveOpen!: (session: AgentSessionRuntime) => void;
        const pendingOpen = new Promise<AgentSessionRuntime>((resolve) => {
            resolveOpen = resolve;
        });
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(async () => undefined),
        };
        const open = vi.fn(async () => await pendingOpen);
        const agentId = 'acme-late-open-generation';
        const contributions = createExternalContributionFixtures(agentId);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: `/tmp/${agentId}`,
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            generationSignal: generationController.signal,
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        const creating = Promise.resolve(plan.config.createSessionRuntime({
            directory: `/tmp/${agentId}`,
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-generation'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never));
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));

        const retirement = new Error('generation cancelled pending native open');
        generationController.abort(retirement);
        const settlement = await Promise.race([
            creating.then(
                () => 'opened' as const,
                () => 'rejected' as const,
            ),
            new Promise<'timeout'>((resolve) => {
                const timer = setTimeout(() => resolve('timeout'), 100);
                timer.unref?.();
            }),
        ]);
        expect(settlement).toBe('rejected');
        resolveOpen(session);

        await expect(creating).rejects.toThrow(retirement.message);
        await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledTimes(1));
        expect(session.dispose).toHaveBeenCalledWith('runtime_recovery');
        expect(resolveCurrentSessionUiBinding('session-generation')).toBeNull();
    });

    it('automatically disposes the live native session on generation retirement and fences later provider calls', async () => {
        const generationController = new AbortController();
        const send = vi.fn(async () => ({ status: 'admitted' as const }));
        const session: AgentSessionRuntime = {
            send,
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(async () => undefined),
        };
        const agentId = 'acme-live-generation-retirement';
        const contributions = createExternalContributionFixtures(agentId);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open: vi.fn(async () => session) } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: `/tmp/${agentId}`,
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            generationSignal: generationController.signal,
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: `/tmp/${agentId}`,
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-live-retirement'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        const currentSessionUi = resolveCurrentSessionUiBinding('session-live-retirement');
        expect(currentSessionUi).not.toBeNull();
        expect(currentSessionUi?.interactions.request).toEqual(expect.any(Function));
        expect(currentSessionUi?.presentation?.notify).toEqual(expect.any(Function));

        generationController.abort(new Error('plugin generation retired'));
        await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledTimes(1));
        expect(resolveCurrentSessionUiBinding('session-live-retirement')).toBeNull();
        await created.operations.sendTurnPrompt('must not dispatch', {
            localId: 'input-after-retirement',
            userMessageSeq: 1,
        }).catch(() => undefined);
        expect(send).not.toHaveBeenCalled();
        await created.operations.resetOrDisposeRuntime();
        expect(session.dispose).toHaveBeenCalledTimes(1);
    });

    it('keeps undeclared and unavailable native direct facets absent from the host control surface', async () => {
        const agentId = 'acme-no-direct-controls-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: {
                sessions: {
                    open: vi.fn(async () => ({
                        send: vi.fn(async () => ({ status: 'admitted' as const })),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: vi.fn(),
                    })),
                },
            },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-no-direct-controls-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-no-direct-controls-agent', metadata: {}, machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-no-direct-controls'), transcriptSession: {}, messageBuffer: {},
            mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default',
            setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
        } as never);

        expect(created.nativeRuntime).not.toHaveProperty('rollbackConversation');
        expect(created.nativeRuntime).not.toHaveProperty('refreshGoal');
        expect(created.nativeRuntime).not.toHaveProperty('setGoal');
        expect(created.nativeRuntime).not.toHaveProperty('clearGoal');
        expect(created.nativeRuntime).not.toHaveProperty('listVendorPlugins');
        expect(created.nativeRuntime).not.toHaveProperty('listSkills');
        expect(created.nativeRuntime).not.toHaveProperty('checkUsageLimitRecoveryNow');
        expect(created.nativeRuntime).not.toHaveProperty('consumeUsageLimitResetCredit');
        await created.operations.resetOrDisposeRuntime();
    });

    it('delegates the host compact command once to the native session with stripped instructions', async () => {
        const compact = vi.fn<NonNullable<AgentSessionRuntime['compact']>>(async () => ({ status: 'admitted' }));
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            compact,
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-compact');
        expect(runtime.compactContext).toEqual(expect.any(Function));
        await runtime.compactContext!('/compact retain X');
        expect(compact).toHaveBeenCalledTimes(1);
        expect(compact).toHaveBeenCalledWith({
            compactionId: expect.stringMatching(/^host-compact-/u),
            trigger: 'manual',
            instructions: 'retain X',
        });
    });

    it('passes the exact host-private Provider binding through a live configuration update', async () => {
        const updateConfiguration = vi.fn<NonNullable<AgentSessionRuntime['updateConfiguration']>>(async () => ({
            status: 'applied' as const,
            changed: ['model', 'providerBinding'],
        }));
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            updateConfiguration,
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-provider-transition',
            undefined,
            undefined,
            undefined,
            {
                mode: { value: null, updatedAtMs: 0 },
                model: { value: 'old-model', updatedAtMs: 1 },
                permissionIntent: { value: null, updatedAtMs: 0 },
                options: {},
            },
        );
        const providerBinding = {
            connectionId: ProviderConnectionIdSchema.parse('pc_work'),
            model: { id: 'next-model', name: 'Next model' },
            materialization: { v: 1 as const, kind: 'spawnEnv' as const },
        };

        await expect(runtime.updateSessionRuntimeConfig({
            modelId: 'next-model',
            providerBinding,
        })).resolves.toMatchObject({ status: 'applied' });

        expect(updateConfiguration).toHaveBeenCalledWith({
            mode: { value: null, updatedAtMs: 0 },
            model: { value: 'next-model', updatedAtMs: expect.any(Number) },
            permissionIntent: { value: null, updatedAtMs: 0 },
            options: {},
            providerBinding,
        });
    });

    it('projects the bounded VB4 launch and timestamped configuration snapshot into session open', async () => {
        const updateConfiguration = vi.fn<NonNullable<AgentSessionRuntime['updateConfiguration']>>(async () => ({
            status: 'applied' as const,
            changed: ['mode'],
        }));
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            updateConfiguration,
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const runtime: AgentRuntime = { sessions: { open } };
        const happierMcpServer: {
            command: string;
            args: string[];
            env: Record<string, string>;
        } = {
            command: 'happier-mcp',
            args: ['serve'],
            env: {},
        };
        const mcpServers = { happier: happierMcpServer };
        const agentId = 'acme-vb4-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-vb4-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                environmentVariables: {
                    AUGMENT_SESSION_AUTH: 'host-authorized-auth',
                    KEEP_ME: 'yes',
                },
                unsetEnvironmentVariables: ['DROP_ME'],
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 103,
                sessionModeId: 'default',
                sessionModeUpdatedAt: 101,
                modelSelection: {
                    v: 1,
                    updatedAt: 102,
                    ref: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: null,
                        modelId: 'model-vb4',
                    },
                },
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 104,
                    overrides: {
                        allowIndexing: { value: true, updatedAt: 104 },
                    },
                },
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-vb4-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-vb4'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers,
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(open).toHaveBeenCalledWith({
            kind: 'create',
            sessionId: 'session-vb4',
            cwd: '/tmp/acme-vb4-agent',
            launchEnvironment: {
                values: {
                    AUGMENT_SESSION_AUTH: 'host-authorized-auth',
                    KEEP_ME: 'yes',
                },
                unset: ['DROP_ME'],
            },
            configuration: {
                mode: { value: 'default', updatedAtMs: 101 },
                model: { value: 'model-vb4', updatedAtMs: 102 },
                permissionIntent: { value: 'safe-yolo', updatedAtMs: 103 },
                options: {
                    allowIndexing: { value: true, updatedAtMs: 104 },
                },
            },
            mcpServers: {
                happier: {
                    command: 'happier-mcp',
                    args: ['serve'],
                    env: {},
                },
            },
        }, expect.any(Object));
        const openRequest = open.mock.calls[0]?.[0];
        if (!openRequest) throw new Error('expected native session open request');
        const openedMcpServers = (openRequest as typeof openRequest & Readonly<{
            mcpServers: Readonly<Record<string, Readonly<{
                command: string;
                args?: readonly string[];
                env?: Readonly<Record<string, string>>;
            }>>>;
        }>).mcpServers;
        expect(Object.isFrozen(openedMcpServers)).toBe(true);
        expect(Object.isFrozen(openedMcpServers.happier)).toBe(true);
        expect(Object.isFrozen(openedMcpServers.happier?.args)).toBe(true);
        expect(Object.isFrozen(openedMcpServers.happier?.env)).toBe(true);
        mcpServers.happier.args.push('mutated-after-open');
        mcpServers.happier.env.MUTATED_AFTER_OPEN = 'yes';
        expect(openedMcpServers.happier).toEqual({
            command: 'happier-mcp',
            args: ['serve'],
            env: {},
        });

        const updatedAfterMs = Date.now();
        await expect(created.operations.updateSessionRuntimeConfig({ modeId: 'plan' })).resolves.toEqual({
            status: 'applied',
            timing: 'current_window',
        });
        expect(updateConfiguration).toHaveBeenCalledWith({
            mode: { value: 'plan', updatedAtMs: expect.any(Number) },
            model: { value: 'model-vb4', updatedAtMs: 102 },
            permissionIntent: { value: 'safe-yolo', updatedAtMs: 103 },
            options: {
                allowIndexing: { value: true, updatedAtMs: 104 },
            },
        });
        expect(updateConfiguration.mock.calls[0]?.[0].mode.updatedAtMs).toBeGreaterThanOrEqual(updatedAfterMs);

        await created.operations.resetOrDisposeRuntime();
    });

    it('uses the host-adopted startup permission seed when the session binding has no explicit mode', async () => {
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const runtime: AgentRuntime = { sessions: { open } };
        const agentId = 'acme-host-startup-seed';
        const contributions = createExternalContributionFixtures(agentId);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-host-startup-seed',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        await plan.config.createSessionRuntime({
            directory: '/tmp/acme-host-startup-seed',
            metadata: {
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 203,
            },
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-host-startup-seed'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'yolo',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        const openInput = open.mock.calls[0]?.[0];
        if (!openInput) throw new Error('expected native session open input');
        const configuration = openInput.configuration;
        if (!configuration) throw new Error('expected native session open configuration');
        expect(configuration.permissionIntent).toEqual({
            value: 'yolo',
            updatedAtMs: 203,
        });
    });

    it('projects the exact Provider connection and launch materialization into native session open', async () => {
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const runtime: AgentRuntime = { sessions: { open } };
        const agentId = 'acme-provider-bound-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const materialization = Object.freeze({
            v: 1 as const,
            kind: 'engineConfig' as const,
            engineConfig: Object.freeze({
                v: 1,
                modelProvider: 'happier_0123456789abcdef0123456789abcdef',
                config: Object.freeze({}),
            }),
        });
        const createInvocationServices = vi.fn(() => createUnavailablePluginServices());
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            createInvocationServices,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-provider-bound-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                environmentVariables: {
                    [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]: 'host-only-carrier',
                    HAPPIER_CODEX_PROVIDER_API_KEY: 'scoped-provider-credential',
                },
                modelSelection: {
                    v: 1,
                    updatedAt: 102,
                    ref: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: 'pc_work',
                        modelId: 'provider-model-exact',
                    },
                },
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-provider-bound-agent',
            metadata: {
                providerBindingV1: providerBindingMetadata(
                    'pc_work',
                    'provider-model-exact',
                ),
            },
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-provider-bound'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            providerBindingMaterialization: materialization,
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(open).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'create',
            sessionId: 'session-provider-bound',
            configuration: expect.objectContaining({
                model: { value: 'provider-model-exact', updatedAtMs: 102 },
            }),
            launchEnvironment: {
                values: { HAPPIER_CODEX_PROVIDER_API_KEY: 'scoped-provider-credential' },
                unset: [],
            },
            providerBinding: {
                connectionId: 'pc_work',
                model: { id: 'provider-model-exact', name: 'provider-model-exact' },
                materialization,
            },
        }), expect.any(Object));
        expect(createInvocationServices).toHaveBeenCalledWith(expect.objectContaining({
            environment: { HAPPIER_CODEX_PROVIDER_API_KEY: 'scoped-provider-credential' },
            providerBindingActive: true,
        }));

        await created.operations.resetOrDisposeRuntime();
    });

    it.each([
        {
            label: 'Provider-selected model without materialization',
            providerConnectionId: 'pc_work',
            materialization: undefined,
            expectedError: 'Provider-bound native Agent session requires Provider binding materialization',
        },
        {
            label: 'native model with unexpected materialization',
            providerConnectionId: null,
            materialization: Object.freeze({
                v: 1 as const,
                kind: 'engineConfig' as const,
                engineConfig: Object.freeze({ v: 1, modelProvider: 'unused', config: Object.freeze({}) }),
            }),
            expectedError: 'Native model selection cannot include Provider binding materialization',
        },
    ] as const)('refuses $label before native Agent sessions.open', async ({
        providerConnectionId,
        materialization,
        expectedError,
    }) => {
        const open = vi.fn<AgentSessionRuntimeFactory['open']>();
        const agentId = 'acme-provider-pairing-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-provider-pairing-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                modelSelection: {
                    v: 1,
                    updatedAt: 102,
                    ref: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId,
                        modelId: 'pairing-model',
                    },
                },
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        await expect(plan.config.createSessionRuntime({
            directory: '/tmp/acme-provider-pairing-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-provider-pairing'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            providerBindingMaterialization: materialization,
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never)).rejects.toThrow(expectedError);

        expect(open).not.toHaveBeenCalled();
    });

    it('uses canonical persisted Provider intent for both model and binding on attached native sessions', async () => {
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const runtime: AgentRuntime = { sessions: { open } };
        const agentId = 'acme-attached-provider-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const materialization = Object.freeze({
            v: 1 as const,
            kind: 'engineConfig' as const,
            engineConfig: Object.freeze({ v: 1, modelProvider: 'ollama', config: Object.freeze({}) }),
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-attached-provider-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                resume: 'provider-session-attached',
                modelSelection: {
                    v: 1,
                    updatedAt: 10,
                    ref: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: 'pc_attached',
                        modelId: 'attached-provider-model',
                    },
                },
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-attached-provider-agent',
            metadata: {
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 57,
                    selection: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: 'pc_attached',
                        modelId: 'attached-provider-model',
                    },
                },
                providerBindingV1: providerBindingMetadata(
                    'pc_attached',
                    'attached-provider-model',
                ),
            },
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-attached-provider'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            providerBindingMaterialization: materialization,
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(open).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'resume',
            providerSessionId: 'provider-session-attached',
            configuration: expect.objectContaining({
                model: { value: 'attached-provider-model', updatedAtMs: 57 },
            }),
            providerBinding: {
                connectionId: 'pc_attached',
                model: { id: 'attached-provider-model', name: 'attached-provider-model' },
                materialization,
            },
        }), expect.any(Object));

        await created.operations.resetOrDisposeRuntime();
    });

    it('refuses attached Provider intent that does not match the launch materialization selection before side effects', async () => {
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const createInvocationServices = vi.fn(() => createUnavailablePluginServices());
        const agentId = 'acme-attached-provider-mismatch-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const materialization = Object.freeze({
            v: 1 as const,
            kind: 'engineConfig' as const,
            engineConfig: Object.freeze({ v: 1, modelProvider: 'launch-b', config: Object.freeze({}) }),
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            createInvocationServices,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-attached-provider-mismatch-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                resume: 'provider-session-attached',
                modelSelection: {
                    v: 1,
                    updatedAt: 10,
                    ref: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: 'pc_launch_b',
                        modelId: 'launch-model-b',
                    },
                },
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        await expect(plan.config.createSessionRuntime({
            directory: '/tmp/acme-attached-provider-mismatch-agent',
            metadata: {
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 57,
                    selection: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: 'pc_attached_a',
                        modelId: 'attached-model-a',
                    },
                },
                providerBindingV1: providerBindingMetadata(
                    'pc_attached_a',
                    'attached-model-a',
                ),
            },
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-attached-provider-mismatch'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            providerBindingMaterialization: materialization,
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never)).rejects.toThrow('Attached Provider model selection does not match launch binding');

        expect(createInvocationServices).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(resolveCurrentSessionUiBinding('session-attached-provider-mismatch')).toBeNull();
    });

    it('projects session-owned hook, transcript-follow, account-usage, auth, and MCP services with host identity and cancellation', async () => {
        const generationAbortController = new AbortController();
        const callerAbortController = new AbortController();
        const followCallerAbortController = new AbortController();
        let followedSignal: AbortSignal | undefined;
        let authSignal: AbortSignal | undefined;
        const sessionHooks = {
            startServer: vi.fn(async () => ({
                port: 4312,
                stop: () => undefined,
                dispose: async () => undefined,
            })),
            resolveForwarderAssets: vi.fn(async () => ({
                nodeExecutable: '/runtime/node',
                sessionForwarderScript: '/runtime/session-forwarder.cjs',
                permissionForwarderScript: '/runtime/permission-forwarder.cjs',
            })),
            createPluginDir: vi.fn(async () => '/tmp/plugin-dir'),
            disposePluginDir: vi.fn(async () => undefined),
            publishProviderTranscript: vi.fn(async () => undefined),
        };
        const fileFollow = {
            follow: vi.fn(async (input: Readonly<{ signal?: AbortSignal }>) => {
                followedSignal = input.signal;
                return {
                    id: 'follow-1',
                    drainNow: async () => undefined,
                    close: async () => undefined,
                };
            }),
        };
        const accountUsage = {
            resolveSourceContext: vi.fn(async () => null),
            recordSnapshot: vi.fn(async () => ({ status: 'recorded' as const, recordId: 'record-1' })),
            adoptProvisionalRecord: vi.fn(async () => ({
                status: 'adopted' as const,
                fromRecordId: 'record-1',
                toRecordId: 'record-2',
            })),
        };
        const auth = {
            services: {
                refreshRuntimeAuth: vi.fn(async (_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
                    authSignal = options?.signal;
                    return { status: 'refreshed' as const };
                }),
            },
        };
        const resolveForSession = vi.fn(async () => [{
            id: 'remote-tools',
            name: 'Remote tools',
            title: 'Unneeded provider title',
            transport: { kind: 'http' as const, url: 'https://mcp.example.test/tools' },
            scope: { sessionId: 'session-services', directory: '/tmp/acme-session-services-agent' },
        }]);
        type ProjectedSessionServices = Readonly<{
            sessionHooks: Readonly<{
                startServer(request: Readonly<Record<string, unknown>>): Promise<unknown>;
                resolveForwarderAssets(): Promise<unknown>;
                createPluginDir(request: Readonly<Record<string, unknown>>): Promise<string>;
                disposePluginDir(pluginDir: string): Promise<void>;
                publishProviderTranscript(request: Readonly<Record<string, unknown>>): Promise<void>;
            }>;
            transcripts: Readonly<{
                fileFollow: Readonly<{
                    follow(input: Readonly<Record<string, unknown>>): Promise<unknown>;
                }>;
            }>;
            accountUsage: Readonly<{
                resolveSourceContext(input: Readonly<Record<string, unknown>>, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
                recordSnapshot(input: Readonly<Record<string, unknown>>, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
                adoptProvisionalRecord(input: Readonly<Record<string, unknown>>, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
            }>;
            auth: Readonly<{
                refreshRuntimeAuth(input: Readonly<Record<string, unknown>>, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
            }>;
            mcp: Readonly<{
                resolveServers(options?: Readonly<{ signal?: AbortSignal }>): Promise<readonly unknown[]>;
            }>;
        }>;
        let contextSignal: AbortSignal | undefined;
        let projectedMcp: ProjectedSessionServices['mcp'] | undefined;
        let resolvedMcp: readonly unknown[] | undefined;
        const runtime: AgentRuntime = {
            sessions: {
                open: vi.fn(async (_request, context) => {
                    const services = (context.session as typeof context.session & Readonly<{
                        services: ProjectedSessionServices;
                    }>).services;
                    contextSignal = context.signal;
                    projectedMcp = services.mcp;
                    await services.sessionHooks.startServer({ sessionHookSecret: 'secret' });
                    await services.sessionHooks.resolveForwarderAssets();
                    await services.sessionHooks.createPluginDir({ files: [] });
                    await services.sessionHooks.disposePluginDir('/tmp/plugin-dir');
                    await services.sessionHooks.publishProviderTranscript({
                        kind: 'assistant_stop',
                        providerSessionId: 'provider-session-1',
                    });
                    await services.transcripts.fileFollow.follow({
                        path: '/tmp/transcript.jsonl',
                        startAt: 'end',
                        signal: followCallerAbortController.signal,
                        onLine: () => undefined,
                    });
                    await services.accountUsage.resolveSourceContext({ serviceId: 'anthropic' });
                    await services.accountUsage.recordSnapshot({ snapshot: { providerId: 'anthropic' } });
                    await services.accountUsage.adoptProvisionalRecord({
                        adoption: {
                            providerId: 'untrusted-provider',
                            fromRecordId: 'record-1',
                            toRecordId: 'record-2',
                        },
                    });
                    await services.auth.refreshRuntimeAuth({
                        serviceId: 'anthropic',
                    }, { signal: callerAbortController.signal });
                    resolvedMcp = await services.mcp.resolveServers();
                    return {
                        send: vi.fn(async () => ({ status: 'admitted' as const })),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: vi.fn(async () => {
                            expect(contextSignal?.aborted).toBe(true);
                        }),
                    };
                }),
            },
        };
        const agentId = 'acme-session-services-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-session-services-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => ({
                ...createSessionHostServiceOwners(),
                sessionHooks,
                transcripts: { fileFollow },
                accountUsage,
                auth,
                mcp: { resolveForSession },
            }),
            generationSignal: generationAbortController.signal,
        } as never);
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-session-services-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-services'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(sessionHooks.startServer).toHaveBeenCalledWith(expect.objectContaining({
            providerId: agentId,
            sessionId: 'session-services',
            lifecycle: { kind: 'session', sessionId: 'session-services' },
        }));
        expect(sessionHooks.createPluginDir).toHaveBeenCalledWith(expect.objectContaining({
            providerId: agentId,
            lifecycle: { kind: 'session', sessionId: 'session-services' },
        }));
        expect(sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
            providerId: agentId,
            sessionId: 'session-services',
            kind: 'assistant_stop',
        }));
        expect(accountUsage.recordSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-services',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(accountUsage.adoptProvisionalRecord).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-services',
            adoption: expect.objectContaining({ providerId: agentId }),
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(auth.services.refreshRuntimeAuth).toHaveBeenCalledWith(expect.objectContaining({
            agentId,
            serviceId: 'anthropic',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(resolveForSession).toHaveBeenCalledWith({
            sessionId: 'session-services',
            directory: '/tmp/acme-session-services-agent',
        });
        expect(resolvedMcp).toEqual([{
            id: 'remote-tools',
            name: 'Remote tools',
            transport: { kind: 'http', url: 'https://mcp.example.test/tools' },
        }]);
        expect(followedSignal).toBeDefined();
        expect(followedSignal).not.toBe(contextSignal);
        expect(followedSignal?.aborted).toBe(false);
        expect(authSignal).toBeDefined();
        expect(authSignal).not.toBe(callerAbortController.signal);
        callerAbortController.abort(new Error('caller stopped'));
        expect(authSignal?.aborted).toBe(true);

        const mcpCallerAbortController = new AbortController();
        mcpCallerAbortController.abort(new Error('MCP caller stopped'));
        await expect(projectedMcp?.resolveServers({ signal: mcpCallerAbortController.signal }))
            .rejects.toThrow('MCP caller stopped');
        expect(resolveForSession).toHaveBeenCalledTimes(1);

        await created.operations.resetOrDisposeRuntime();
        await expect(projectedMcp?.resolveServers()).rejects.toThrow();
        expect(resolveForSession).toHaveBeenCalledTimes(1);
        expect(contextSignal?.aborted).toBe(true);
        expect(followedSignal?.aborted).toBe(true);
    });

    it('denies bound MCP resolution after the native Agent generation retires', async () => {
        const generationAbortController = new AbortController();
        const resolveForSession = vi.fn(async () => Object.freeze([]));
        let projectedMcp: AgentSessionRuntimeContext['session']['services']['mcp'] | undefined;
        const runtime: AgentRuntime = {
            sessions: {
                open: vi.fn(async (_request, context) => {
                    projectedMcp = context.session.services.mcp;
                    return {
                        send: vi.fn(async () => ({ status: 'admitted' as const })),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: vi.fn(),
                    };
                }),
            },
        };
        const agentId = 'acme-mcp-generation-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const baseOwners = createSessionHostServiceOwners();
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-mcp-generation-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => Object.freeze({
                ...baseOwners,
                mcp: Object.freeze({ resolveForSession }),
            }),
            generationSignal: generationAbortController.signal,
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-mcp-generation-agent', metadata: {}, machineId: 'machine-1',
            session: createNativeSessionClientTestPort('mcp-generation-session'), transcriptSession: {}, messageBuffer: {},
            mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default',
            setThinking: () => undefined, memoryRecallGuidanceEnabled: false,
        } as never);

        generationAbortController.abort(new Error('plugin generation retired'));
        await expect(projectedMcp?.resolveServers()).rejects.toThrow('plugin generation retired');
        expect(resolveForSession).not.toHaveBeenCalled();
        await created.operations.resetOrDisposeRuntime();
    });

    it('publishes generated media once through the stable current-session service and fences stale generations', async () => {
        await withTempDir('happier-native-media-', async (sourceRoot) => {
            const capturedContext: { current: AgentSessionRuntimeContext | null } = { current: null };
            const sendAgentSessionMediaCommitted = vi.fn(async () => undefined);
            const session: AgentSessionRuntime = {
                send: vi.fn(async () => ({ status: 'admitted' as const })),
                watch: () => ({ dispose: () => undefined }),
                dispose: vi.fn(),
            };
            const runtime: AgentRuntime = {
                sessions: {
                    open: vi.fn(async (_request, context) => {
                        capturedContext.current = context;
                        return session;
                    }),
                },
            };
            let current = true;
            const agentId = 'acme-media-agent';
            const contributions = createExternalContributionFixtures(agentId);
            const plan = await createNativeAgentRuntimeSessionPlan({
                runtime,
                lease: { ...createLease(agentId), isCurrent: () => current },
                backend: contributions.backend,
                agent: contributions.agent,
                createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
                sessionInput: buildPluginSessionBindingInput({
                    credentials,
                    directory: sourceRoot,
                    backendTarget: { kind: 'backend', backendId: agentId },
                }),
            });
            if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

            const created = await plan.config.createSessionRuntime({
                directory: sourceRoot,
                metadata: {},
                machineId: 'machine-1',
                session: createNativeSessionClientTestPort('session-media'),
                transcriptSession: { sendAgentSessionMediaCommitted },
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: {},
                getPermissionMode: () => 'default',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            } as never);

            if (!capturedContext.current) throw new Error('expected an Agent session context');
            await writeFile(join(sourceRoot, 'generated.png'), 'generated');
            const source = await capturedContext.current.services.sessions.current.media.registerSourceRoot({
                rootPath: sourceRoot,
            });
            await expect(source.publishGenerated({
                localId: 'native-generated-1',
                path: join(sourceRoot, 'generated.png'),
            })).resolves.toEqual({ status: 'published' });
            expect(sendAgentSessionMediaCommitted).toHaveBeenCalledTimes(1);

            current = false;
            await expect(source.publishGenerated({
                localId: 'native-generated-stale',
                path: join(sourceRoot, 'stale.png'),
            })).rejects.toThrow('media_session_scope_forbidden');

            current = true;
            await created.operations.resetOrDisposeRuntime();
            await expect(source.publishGenerated({
                localId: 'native-generated-disposed',
                path: join(sourceRoot, 'disposed.png'),
            })).rejects.toThrow('media_source_root_revoked');
            expect(sendAgentSessionMediaCommitted).toHaveBeenCalledTimes(1);
        });
    });

    it('publishes only declared native work-state sources through the host merge owner', async () => {
        const capturedContext: { current: AgentSessionRuntimeContext | null } = { current: null };
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        };
        const runtime: AgentRuntime = {
            sessions: {
                open: vi.fn(async (_request, context) => {
                    capturedContext.current = context;
                    return session;
                }),
            },
        };
        const agentId = 'OhMyPi';
        const contributions = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...contributions.agent,
            identity: {
                pluginId: 'acme.agent-plugin',
                localId: 'ohmypi',
            },
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            workStateSources: [
                                { id: 'todos', itemKinds: ['todo'] },
                                { id: 'goals', itemKinds: ['goal'] },
                            ],
                        },
                    },
                },
            },
        } as ResolvedAgentContribution;
        let metadata: Record<string, unknown> = {};
        const updateMetadata = vi.fn(async (
            updater: (current: Record<string, unknown>) => Record<string, unknown>,
        ) => {
            metadata = updater(metadata);
        });
        let current = true;
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: { ...createLease(agentId), isCurrent: () => current },
            backend: contributions.backend,
            agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-work-state-agent',
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        await plan.config.createSessionRuntime({
            directory: '/tmp/acme-work-state-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-work-state', { updateMetadata }),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);
        if (!capturedContext.current) throw new Error('expected an Agent session context');
        expect(capturedContext.current.contribution).toEqual({
            id: 'ohmypi',
            qualifiedId: 'acme.agent-plugin/agents/ohmypi',
        });

        const todos = capturedContext.current.workState.publisher('todos');
        const goals = capturedContext.current.workState.publisher('goals');
        await expect(todos.publish({
            sourceSequence: 1,
            observedAtMs: 10,
            items: [{
                localId: 'todo-1',
                kind: 'todo',
                origin: 'vendor',
                status: 'active',
                title: 'Ship the host seam',
                providerRef: 'provider-todo-1',
                updatedAtMs: 10,
            }],
            primaryLocalId: 'todo-1',
        })).resolves.toMatchObject({ status: 'applied', sourceSequence: 1 });
        await expect(goals.publish({
            sourceSequence: 1,
            observedAtMs: 11,
            items: [{
                localId: 'goal-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'active',
                title: 'Converge native Agents',
                updatedAtMs: 11,
            }],
            primaryLocalId: 'goal-1',
        })).resolves.toMatchObject({ status: 'applied', sourceSequence: 1 });

        const workState = metadata.sessionWorkStateV1 as Readonly<{
            items: readonly Readonly<{ id: string; kind: string; title: string; agentId?: string; vendorRef?: string }>[];
            primaryItemId: string | null;
        }>;
        expect(workState.items).toHaveLength(2);
        expect(workState.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'todo',
                title: 'Ship the host seam',
                agentId,
                vendorRef: 'provider-todo-1',
            }),
            expect.objectContaining({ kind: 'goal', title: 'Converge native Agents', agentId }),
        ]));
        expect(workState.items.every((item) => item.id !== 'todo-1' && item.id !== 'goal-1')).toBe(true);
        expect(workState.items.find((item) => item.id === workState.primaryItemId)?.kind).toBe('todo');

        await expect(todos.publish({
            sourceSequence: 1,
            observedAtMs: 10,
            items: [{
                localId: 'todo-1',
                kind: 'todo',
                origin: 'vendor',
                status: 'active',
                title: 'Ship the host seam',
                providerRef: 'provider-todo-1',
                updatedAtMs: 10,
            }],
            primaryLocalId: 'todo-1',
        })).resolves.toMatchObject({ status: 'unchanged', sourceSequence: 1 });
        await expect(todos.publish({
            sourceSequence: 1,
            observedAtMs: 12,
            items: [],
        })).resolves.toMatchObject({ status: 'conflict' });
        await expect(todos.publish({
            sourceSequence: 0,
            observedAtMs: 9,
            items: [],
        })).resolves.toMatchObject({ status: 'ignoredStale', currentSourceSequence: 1 });
        await expect(capturedContext.current.workState.publisher('unknown').publish({
            sourceSequence: 1,
            observedAtMs: 12,
            items: [],
        })).resolves.toMatchObject({
            status: 'unavailable',
            diagnostic: { code: 'agent_work_state_source_unavailable' },
        });
        await expect(todos.publish({
            sourceSequence: 2,
            observedAtMs: 13,
            items: [{
                localId: 'wrong-kind',
                kind: 'goal',
                origin: 'vendor',
                status: 'active',
                title: 'Must reject',
                updatedAtMs: 13,
            }],
        })).resolves.toMatchObject({ status: 'conflict' });

        current = false;
        await expect(goals.publish({
            sourceSequence: 2,
            observedAtMs: 14,
            items: [],
        })).resolves.toMatchObject({
            status: 'unavailable',
            diagnostic: { code: 'agent_work_state_generation_retired' },
        });
    });

    it('composes a managed-dependency public ACP session through the mature subprocess boundary', async () => {
        await withTempDir('happier-public-agent-acp-', async (directory) => {
            const scriptPath = writeAcpTestAgentScript({
                dir: directory,
                fileName: 'public-agent-acp.mjs',
                source: `
                    const decoder = new TextDecoder();
                    let buffer = '';
                    const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
                    process.stdin.on('data', (chunk) => {
                        buffer += decoder.decode(chunk, { stream: true });
                        const lines = buffer.split('\\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (!line.trim()) continue;
                            const request = JSON.parse(line);
                            if (request.method === 'initialize') {
                                send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, authMethods: [] } });
                            } else if (request.method === 'session/new') {
                                send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'provider-public-acp-1' } });
                            } else if (request.id !== undefined) {
                                send({ jsonrpc: '2.0', id: request.id, result: {} });
                            }
                        }
                    });
                `,
            });
            const releaseExecutable = vi.fn();
            let composedSession: AgentSessionRuntime | null = null;
            const generationController = new AbortController();
            const invocationServices = createUnavailablePluginServices();
            const exec = createStablePluginExecService({
                allowedExecutables: [{
                    kind: 'managedDependency',
                    id: 'fixture-acp',
                }],
                signal: generationController.signal,
                isGenerationCurrent: () => !generationController.signal.aborted,
                async resolveExecutable(executable) {
                    expect(executable).toEqual({
                        kind: 'managedDependency',
                        id: 'fixture-acp',
                    });
                    return {
                        command: process.execPath,
                        args: [scriptPath],
                        release: releaseExecutable,
                    };
                },
                async resolvePath() {
                    throw new Error('path resolution was not expected');
                },
            });
            const runtime: AgentRuntime = {
                sessions: {
                    open: async (request, context) => {
                        composedSession = await context.protocols.acp.open(request, {
                            transport: {
                                kind: 'stdio',
                                executable: { kind: 'managedDependency', id: 'fixture-acp' },
                            },
                        });
                        return composedSession;
                    },
                },
            };
            const agentId = 'acme-public-acp-agent';
            const contributions = createExternalContributionFixtures(agentId);
            const plan = await createNativeAgentRuntimeSessionPlan({
                runtime,
                lease: createLease(agentId),
                backend: contributions.backend,
                agent: contributions.agent,
                createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
                sessionInput: buildPluginSessionBindingInput({
                    credentials,
                    directory,
                    backendTarget: { kind: 'backend', backendId: agentId },
                }),
                createInvocationServices: () => Object.freeze({
                    ...invocationServices,
                    exec,
                }),
                generationSignal: generationController.signal,
            });

            if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
            const created = await plan.config.createSessionRuntime({
                directory,
                metadata: {},
                machineId: 'machine-1',
                session: createNativeSessionClientTestPort('host-session-1'),
                transcriptSession: {},
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: {},
                getPermissionMode: () => 'default',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            } as never);

            expect(releaseExecutable).not.toHaveBeenCalled();
            expect(composedSession).not.toBeNull();
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            try {
                generationController.abort(new Error('plugin generation retired'));
                const outcome = await Promise.race([
                    composedSession!.send({
                        inputIds: ['input-after-generation-retired'],
                        input: { text: 'must not dispatch' },
                        delivery: { kind: 'newTurn', turnId: 'turn-after-generation-retired' },
                    }),
                    new Promise<{ status: 'timed-out' }>((resolve) => {
                        timeoutId = setTimeout(() => resolve({ status: 'timed-out' }), 500);
                    }),
                ]);
                expect(outcome).toMatchObject({ status: 'unavailable' });
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                await created.operations.resetOrDisposeRuntime();
            }
            expect(releaseExecutable).toHaveBeenCalledOnce();
        });
    });

    it('rejects resume before invoking a create-only native Agent session contribution', async () => {
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const agentId = 'acme-create-only-agent';
        const contributions = createExternalContributionFixtures(agentId, ['create']);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-create-only-agent',
                resume: 'provider-session-resume',
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');

        await expect(plan.config.createSessionRuntime({
            directory: '/tmp/acme-create-only-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-create-only'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never)).rejects.toThrow(
            `Native Agent '${agentId}' does not declare sessions.open resume support`,
        );
        expect(open).not.toHaveBeenCalled();
    });

    it('binds the public current-session UI to the live host permission owner', async () => {
        const capturedContext: { current: AgentSessionRuntimeContext | null } = { current: null };
        const nativeEventListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                nativeEventListeners.add(listener);
                return { dispose: () => { nativeEventListeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const open = vi.fn(async (_request, context: AgentSessionRuntimeContext) => {
            capturedContext.current = context;
            return session;
        });
        const runtime: AgentRuntime = { sessions: { open } };
        const agentId = 'acme-current-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const handleToolCall = vi.fn(async () => ({ decision: 'denied' as const }));
        const cancelByPlugin = vi.fn(async () => undefined);
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-current-agent',
                resume: ' provider-session-resume ',
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-current-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-1'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: { handleToolCall, cancelByPlugin },
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(cancelByPlugin).toHaveBeenCalledWith(
            'acme.agent-plugin',
            'agent_runtime_replaced',
        );
        expect(open).toHaveBeenCalledWith({
            kind: 'resume',
            sessionId: 'session-1',
            cwd: '/tmp/acme-current-agent',
            providerSessionId: 'provider-session-resume',
            launchEnvironment: {
                values: {},
                unset: [],
            },
            configuration: {
                mode: { value: null, updatedAtMs: 0 },
                model: { value: null, updatedAtMs: 0 },
                permissionIntent: { value: 'default', updatedAtMs: 0 },
                options: {},
            },
        }, expect.any(Object));
        if (!capturedContext.current) throw new Error('expected an Agent session context');
        const hostServices = readHostServices(capturedContext.current);
        expect(capturedContext.current.services.availability('sessions')).toEqual({ status: 'available' });
        expect(capturedContext.current.services.sessions.current.availability()).toEqual({ status: 'available' });
        expect(capturedContext.current.services.sessions.subagents.capabilities().observe).toEqual({
            status: 'unavailable',
            code: 'plugin_subagent_durable_custody_unavailable',
        });
        await expect(capturedContext.current.services.sessions.subagents.observe({
            observationId: 'worker-1',
            status: 'running',
        })).rejects.toMatchObject({ code: 'plugin_subagent_durable_custody_unavailable' });
        expect(hostServices.sessions.external.capabilities().list).toEqual({
            status: 'unavailable',
            code: 'plugin_external_list_unavailable',
        });
        await expect(capturedContext.current.ui.confirm(
            'Continue with the operation?',
            { title: 'Continue?' },
        )).resolves.toBe(false);
        expect(handleToolCall).toHaveBeenCalledWith(
            expect.any(String),
            'AgentConfirmation',
            {
                title: 'Continue?',
                message: 'Continue with the operation?',
            },
            expect.objectContaining({
                owner: { kind: 'plugin', pluginId: 'acme.agent-plugin', runtimeId: agentId },
                signal: expect.any(AbortSignal),
            }),
        );
        if (!created.nativeRuntime) throw new Error('expected the native session runtime');
        const subscribeCanonical = created.nativeRuntime.subscribeCanonicalAgentSessionEvents;
        if (!subscribeCanonical) throw new Error('expected canonical native session events');
        subscribeCanonical(() => undefined);
        for (const listener of nativeEventListeners) {
            listener({
                sequence: 1,
                sessionId: 'session-1',
                emittedAtMs: 1,
                kind: 'turn-start',
                turnId: 'turn-1',
                startedBy: 'provider',
            });
            listener({
                sequence: 2,
                sessionId: 'session-1',
                emittedAtMs: 2,
                kind: 'turn-failed',
                turnId: 'turn-1',
                diagnostic: { code: 'provider_failure', severity: 'error' },
            });
        }
        await vi.waitFor(() => expect(cancelByPlugin).toHaveBeenCalledWith(
            'acme.agent-plugin',
            'agent_turn-failed',
        ));
    });

    it('passes the canonical child fork source to native sessions.open without converting it to resume', async () => {
        const open = vi.fn(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        }));
        const agentId = 'acme-native-fork-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const forkAgent: ResolvedAgentContribution = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition.capabilities,
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            open: ['create', 'fork'],
                        },
                    },
                },
            },
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: forkAgent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-fork-agent',
                nativeForkSource: {
                    sessionId: 'host-parent',
                    providerSessionId: 'provider-parent',
                    cwd: '/tmp/source-workspace',
                    target: {
                        turnId: 'host-turn-42',
                        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
                    },
                },
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-fork-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('host-child'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(open).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'fork',
            sessionId: 'host-child',
            cwd: '/tmp/acme-native-fork-agent',
            source: {
                sessionId: 'host-parent',
                providerSessionId: 'provider-parent',
                cwd: '/tmp/source-workspace',
                target: {
                    turnId: 'host-turn-42',
                    providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
                },
            },
        }), expect.any(Object));
        expect(open).not.toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'resume' }),
            expect.anything(),
        );
        await created.operations.resetOrDisposeRuntime();
    });

    it('composes qualified host takeover with list, transcript, and canonical host follow', async () => {
        const capturedContext: { current: AgentSessionRuntimeContext | null } = { current: null };
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        };
        const runtime: AgentRuntime = {
            sessions: {
                open: vi.fn(async (_request, context) => {
                    capturedContext.current = context;
                    return session;
                }),
            },
        };
        const agentId = 'acme-native-follow-agent';
        const disposeFollow = vi.fn(async () => undefined);
        const executeFollow = vi.fn(async () => ({
            status: 'following' as const,
            startingCursor: 'tail-1',
            subscription: Object.freeze({ dispose: disposeFollow }),
        }));
        const executeTakeover = vi.fn(async () => ({
            sessionId: 'linked-session-1',
            status: 'takenOver' as const,
        }));
        const base = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...base.agent,
            definition: { ...base.agent.definition, ownedBackendIds: [agentId] },
            provenance: 'external' as const,
            richDefinition: {
                provenance: 'external' as const,
                definition: {
                    ...base.agent.richDefinition.definition,
                    surfaces: {
                        externalSession: {
                            sources: [{
                                sourceKind: 'syntheticFollowSource',
                                schema: {
                                    fields: [
                                        {
                                            name: 'kind',
                                            kind: 'literal',
                                            value: 'syntheticFollowSource',
                                        },
                                    ],
                                },
                                key: {
                                    segments: [{
                                        kind: 'literal',
                                        value: 'syntheticFollowSource',
                                    }],
                                },
                                instances: [{ kind: 'default', constants: {} }],
                            }],
                        },
                    },
                },
            },
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: { ...base.backend, provenance: 'external' },
            agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            executionSurfaces: {
                externalSession: {
                    validateSource: async ({ source }) => ({ ok: true, source }),
                    listCandidates: async () => ({
                        candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }],
                        nextCursor: null,
                    }),
                    pageTranscript: async () => ({
                        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
                    }),
                    readAfterTranscript: async () => ({ outcome: 'already_current' }),
                },
            },
            externalSessionHostOperations: Object.freeze({
                bindSession: vi.fn(() => Object.freeze({
                    executeFollow,
                    executeProviderSessionFollow: executeFollow,
                    executeTakeover,
                    retire: async () => undefined,
                })),
            }),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-follow-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-follow-agent',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-1'),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        if (!capturedContext.current) throw new Error('expected an Agent session context');
        const hostServices = readHostServices(capturedContext.current);
        expect(hostServices.sessions.external.capabilities()).toMatchObject({
            list: { status: 'available' },
            transcript: { status: 'available' },
            attach: { status: 'available' },
            takeover: { status: 'available' },
            follow: { status: 'available' },
        });
        const listed = await hostServices.sessions.external.list();
        expect(listed).toMatchObject({
            items: [expect.objectContaining({
                ref: expect.objectContaining({ remoteSessionId: 'remote-1' }),
                capabilities: ['attach', 'takeover', 'transcript', 'follow'],
            })],
        });
        const listedRef = listed.items[0]?.ref;
        if (!listedRef) throw new Error('expected configured external-session candidate');
        await expect(hostServices.sessions.external.takeover(listedRef)).resolves.toEqual({
            sessionId: 'linked-session-1',
            status: 'takenOver',
        });
        expect(executeTakeover).toHaveBeenCalledWith(expect.objectContaining({
            ref: listedRef,
            source: { kind: 'syntheticFollowSource' },
        }));
        const follow = await hostServices.sessions.external.followTranscript({
            ref: listedRef,
            source: { kind: 'syntheticFollowSource' },
        }, {}, vi.fn());
        expect(follow).toMatchObject({ status: 'following', startingCursor: 'tail-1' });
        if (follow.status === 'following') await follow.subscription.dispose();
        expect(executeFollow).toHaveBeenCalledWith(expect.objectContaining({
            ref: listedRef,
            source: { kind: 'syntheticFollowSource' },
        }));
        expect(disposeFollow).toHaveBeenCalledOnce();
    });

    it('exposes typed unavailability when no current-session interaction owner exists', async () => {
        const services = createNativeAgentSessionServices({
            permissionHandler: null,
            pluginId: 'acme.plugin',
            contributionId: 'acme-agent',
            runtimeId: 'acme-agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
        });

        expect(services.availability('sessions')).toEqual(expect.objectContaining({ status: 'unavailable' }));

        await expect(services.sessions.current.interactions.request({
            kind: 'confirmation',
            requestId: 'confirmation-unavailable',
            title: 'Continue?',
            message: 'Continue?',
        })).resolves.toEqual(expect.objectContaining({
            kind: 'confirmation',
            status: 'unavailable',
            diagnostic: expect.objectContaining({ code: 'agent_session_interaction_unavailable' }),
        }));
    });

    it.each(['claude', 'unknown-other-agent'])(
        'fails closed when an external current Agent lease identity is %s',
        async (leaseAgentId) => {
            const declaredAgentId = leaseAgentId === 'claude' ? 'claude' : 'acme-current-agent';
            const contributions = createExternalContributionFixtures(declaredAgentId);
            const runtime: AgentRuntime = {
                sessions: {
                    open: async () => { throw new Error('must not open'); },
                },
            };

            await expect(createNativeAgentRuntimeSessionPlan({
                runtime,
                lease: createLease(leaseAgentId),
                backend: contributions.backend,
                agent: contributions.agent,
                createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
                sessionInput: buildPluginSessionBindingInput({ credentials }),
            })).rejects.toThrow(
                leaseAgentId === 'claude' ? /collides with a built-in Agent/i : /does not match/i,
            );
        },
    );

    it('delivers host input through the public AgentSessionRuntime contract and projects identity/events', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const disposeRuntimeScope = vi.fn(async () => undefined);
        const runtime = createNativeAgentSessionOperations(session, 'session-1', disposeRuntimeScope);
        const events: unknown[] = [];
        const unsubscribe = runtime.subscribeRuntimeEvents((event) => events.push(event));

        await expect(runtime.sendTurnPrompt(
            'hello',
            { localId: 'input-1', turnId: 'turn-1' },
        )).resolves.toBeUndefined();
        expect(send).toHaveBeenCalledWith({
            inputIds: ['input-1'],
            input: { text: 'hello' },
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
        });

        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-1',
                emittedAtMs: 1,
                kind: 'provider-session-id',
                providerSessionId: 'provider-session-1',
            });
        }
        expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'provider-session-1' });
        expect(events).toEqual([expect.objectContaining({
            kind: 'session-id-publish',
            publishedSessionId: 'provider-session-1',
        })]);
        unsubscribe();
        await runtime.resetOrDisposeRuntime('session_closed');
        expect(disposeRuntimeScope).toHaveBeenCalledOnce();
    });

    it('projects only the safe native failure classification into the durable runtime issue', () => {
        const providerMessageSentinel = 'VOICE_PRIVATE_MESSAGE_SENTINEL: user transcript';
        const providerAdditionalDetailsSentinel = 'VOICE_PRIVATE_DETAILS_SENTINEL: startup instructions';
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-privacy');
        const events: unknown[] = [];
        runtime.subscribeRuntimeEvents((event) => events.push(event));

        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-privacy',
                emittedAtMs: 6,
                kind: 'turn-start',
                turnId: 'turn-private',
                startedBy: 'provider',
            });
        }
        events.length = 0;

        for (const listener of listeners) {
            listener({
                sequence: 2,
                sessionId: 'session-privacy',
                emittedAtMs: 7,
                kind: 'turn-failed',
                turnId: 'turn-private',
                diagnostic: {
                    code: 'codex_app_server_turn_failed',
                    severity: 'error',
                    message: 'Codex app-server turn failed.',
                    details: {
                        errorClass: 'CodexAppServerTurnFailure',
                        runtimeIssueSource: 'agent_session_error',
                        providerMessage: providerMessageSentinel,
                        providerAdditionalDetails: providerAdditionalDetailsSentinel,
                    },
                },
            });
        }

        expect(events).toEqual([{
            sessionId: 'session-privacy',
            emittedAtMs: 7,
            ordering: 2,
            kind: 'turn-failed',
            turnId: 'turn-private',
            issue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'codex_app_server_turn_failed',
                source: 'agent_session_error',
                occurredAt: 7,
                sanitizedPreview: 'Codex app-server turn failed.',
            },
        }]);
        expect(JSON.stringify(events)).not.toContain(providerMessageSentinel);
        expect(JSON.stringify(events)).not.toContain(providerAdditionalDetailsSentinel);
    });

    it('shares concurrent disposal completion while invoking native and host cleanup exactly once', async () => {
        let finishDispose!: () => void;
        const nativeDisposeFinished = new Promise<void>((resolve) => {
            finishDispose = resolve;
        });
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(async () => await nativeDisposeFinished),
        };
        const disposeRuntimeScope = vi.fn(async () => undefined);
        const runtime = createNativeAgentSessionOperations(session, 'session-dispose-once', disposeRuntimeScope);
        let secondCompleted = false;

        const first = runtime.resetOrDisposeRuntime('session_closed');
        const second = runtime.resetOrDisposeRuntime('runtime_recovery').then(() => {
            secondCompleted = true;
        });
        await Promise.resolve();

        expect(session.dispose).toHaveBeenCalledTimes(1);
        expect(secondCompleted).toBe(false);
        finishDispose();
        await Promise.all([first, second]);
        expect(session.dispose).toHaveBeenCalledTimes(1);
        expect(disposeRuntimeScope).toHaveBeenCalledTimes(1);
    });

    it('binds native model and active-input truth through scoped host services without V1 runtime fields', async () => {
        const agentId = 'acme-native-publications';
        const contributions = createExternalContributionFixtures(agentId);
        const agent = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        sessions: {
                            ...contributions.agent.richDefinition.definition.capabilities.sessions,
                            delivery: ['newTurn', 'steer'],
                        },
                    },
                },
            },
        } as ResolvedAgentContribution;
        const queued = vi.fn();
        const applyPermissionIntentDuringTurn = vi.fn(async () => ({ status: 'applied' as const }));
        const clearTerminalComposer = vi.fn(async () => ({
            ok: true as const,
            status: 'cleared' as const,
            sessionId: 'session-native-publications',
        }));
        const interruptPendingInputAndRun = vi.fn(async () => ({
            ok: true as const,
            status: 'accepted' as const,
        }));
        let activeInputService!: AgentSessionRuntimeContext['session']['services']['activeInput'];
        let activeInputBinding!: ReturnType<typeof activeInputService.bind>;
        const activeInputStatus = Object.freeze({
            steerAvailable: false,
            steerUnavailableReason: 'user_terminal_draft' as const,
            stateUpdatedAtMs: 1234,
            terminalComposerDraftPresent: true,
            terminalComposerClearSupported: true,
            inFlightConfigurationApplySupported: true,
            pendingInputInterruptAndRunLocalId: null,
            pendingInputInterruptAndRunStateAt: null,
        });
        const bindActiveInput = () => activeInputService.bind({
            isTurnInFlight: () => true,
            canSteer: () => true,
            onPromptQueued: queued,
            applyPermissionIntentDuringTurn,
            clearTerminalComposer,
            interruptPendingInputAndRun,
        });
        let modelSnapshot: ReturnType<
            Parameters<AgentSessionRuntimeContext['session']['services']['models']['bind']>[0]['read']
        > = Object.freeze({
            currentModelId: 'provider-current',
            models: Object.freeze([Object.freeze({
                id: 'provider-current',
                name: 'Provider current',
                modelOptions: Object.freeze([Object.freeze({
                    id: 'effort',
                    name: 'Effort',
                    type: 'select',
                    currentValue: 'high',
                })]),
            })]),
        });
        const modelListeners = new Set<(snapshot: typeof modelSnapshot) => void>();
        const runtime: AgentRuntime = {
            sessions: {
                async open(_request, context) {
                    context.session.services.models.bind({
                        read: () => modelSnapshot,
                        subscribe(listener) {
                            modelListeners.add(listener);
                            listener(modelSnapshot);
                            return { dispose: () => { modelListeners.delete(listener); } };
                        },
                    });
                    activeInputService = context.session.services.activeInput;
                    activeInputBinding = bindActiveInput();
                    activeInputService.publishStatus(activeInputStatus);
                    return {
                        send: vi.fn(async () => ({ status: 'admitted' as const })),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: vi.fn(),
                    };
                },
            },
        };
        const session = createNativeSessionClientTestPort('session-native-publications');
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-native-publications',
            }),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-publications', metadata: {}, machineId: 'machine-1',
            session, transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
            getPermissionMode: () => 'default', setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);
        const nativeRuntime = created.nativeRuntime as typeof created.nativeRuntime & Readonly<{
            supportsInFlightSteer(): boolean;
            isTurnInFlight(): boolean;
            canSteerPrompt(): boolean;
            notifyPromptQueuedDuringTurn(): void;
            applyConfigDeltaInFlight(delta: Readonly<{ permissionMode: string }>): Promise<unknown>;
            clearTerminalComposer(request: Readonly<{ sessionId: string; expectedStateAtMs?: number }>): Promise<unknown>;
            interruptPendingInputAndRun(request: Readonly<{
                sessionId: string;
                localId: string;
                expectedStateAtMs?: number;
            }>): Promise<unknown>;
            resetOrDisposeRuntime(): Promise<void>;
            models?: Readonly<{
                read(): Readonly<{ currentModelId?: string | null }>;
            }>;
        }>;

        expect(nativeRuntime.supportsInFlightSteer()).toBe(true);
        expect(nativeRuntime.isTurnInFlight()).toBe(true);
        expect(nativeRuntime.canSteerPrompt()).toBe(true);
        nativeRuntime.notifyPromptQueuedDuringTurn();
        expect(queued).toHaveBeenCalledOnce();
        await expect(nativeRuntime.applyConfigDeltaInFlight({ permissionMode: 'safe-yolo' }))
            .resolves.toEqual({ status: 'applied' });
        expect(applyPermissionIntentDuringTurn).toHaveBeenCalledWith('safe-yolo');
        await expect(nativeRuntime.clearTerminalComposer({
            sessionId: 'session-native-publications',
            expectedStateAtMs: 1234,
        })).resolves.toMatchObject({ ok: true, status: 'cleared' });
        expect(clearTerminalComposer).toHaveBeenCalledWith({ expectedStateAtMs: 1234 });
        await expect(nativeRuntime.interruptPendingInputAndRun({
            sessionId: 'session-native-publications',
            localId: 'local-1',
            expectedStateAtMs: 1234,
        })).resolves.toMatchObject({ ok: true, status: 'accepted' });
        expect(interruptPendingInputAndRun).toHaveBeenCalledWith({
            localId: 'local-1',
            expectedStateAtMs: 1234,
        });
        expect(nativeRuntime.models?.read().currentModelId)
            .toBe('provider-current');
        expect(session.getMetadataSnapshot()).not.toHaveProperty('sessionModelsV1');
        expect(session.getAgentStateSnapshot()).toMatchObject({
            capabilities: {
                inFlightSteerAvailable: false,
                inFlightSteerUnavailableReason: 'user_terminal_draft',
                inFlightSteerStateAt: 1234,
                terminalComposerDraftPresent: true,
                terminalComposerClearSupported: true,
                inFlightConfigApplySupported: true,
                pendingInputInterruptAndRunLocalId: null,
                pendingInputInterruptAndRunStateAt: null,
            },
        });

        modelSnapshot = Object.freeze({ currentModelId: 'provider-next', models: Object.freeze([
            Object.freeze({ id: 'provider-next', name: 'Provider next', modelOptions: Object.freeze([]) }),
        ]) });
        for (const listener of modelListeners) listener(modelSnapshot);
        await Promise.resolve();
        expect(nativeRuntime.models?.read().currentModelId)
            .toBe('provider-next');
        expect(session.getMetadataSnapshot()).not.toHaveProperty('sessionModelsV1');

        activeInputBinding.dispose();
        expect(nativeRuntime.supportsInFlightSteer()).toBe(false);
        activeInputBinding = bindActiveInput();
        expect(nativeRuntime.supportsInFlightSteer()).toBe(true);
        await nativeRuntime.resetOrDisposeRuntime();
        expect(nativeRuntime.supportsInFlightSteer()).toBe(false);
        expect(() => activeInputService.publishStatus(activeInputStatus)).toThrow(/retired or unavailable/u);
    });

    it('attaches the native watcher only after the host subscriber can receive cold replay', () => {
        const buffered: AgentSessionRuntimeEvent[] = [{
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'provider-session-id',
            providerSessionId: 'provider-session-buffered',
        }];
        const watch = vi.fn<AgentSessionRuntime['watch']>((listener) => {
            for (const event of buffered.splice(0)) listener(event);
            return { dispose: vi.fn() };
        });
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch,
            dispose: vi.fn(),
        };

        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const events: unknown[] = [];
        runtime.subscribeRuntimeEvents((event) => events.push(event));

        expect(watch).toHaveBeenCalledOnce();
        expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'provider-session-buffered' });
        expect(events).toEqual([expect.objectContaining({
            kind: 'session-id-publish',
            publishedSessionId: 'provider-session-buffered',
        })]);
    });

    it('joins the exact host user-message anchor with the native provider checkpoint', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'codex',
            session: {
                sessionId: 'session-checkpoint',
                enqueueSessionTurnMutation: (mutation) => { mutations.push(mutation); },
            },
        });
        const runtime = createNativeAgentSessionOperations(session, 'session-checkpoint');
        runtime.subscribeRuntimeEvents((event) => {
            if (!('kind' in event)) return;
            lifecycle.observeRuntimeEvent(event);
        });

        await runtime.sendTurnPrompt('create rollback-me.txt', {
            localId: 'queue-checkpoint',
            turnId: 'host-turn-1',
            userMessageSeq: 7,
            userMessageSeqs: [7],
        });
        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-checkpoint',
                emittedAtMs: 1,
                kind: 'input-accepted',
                inputIds: ['queue-checkpoint'],
                delivery: { kind: 'newTurn', turnId: 'host-turn-1' },
            });
            listener({
                sequence: 2,
                sessionId: 'session-checkpoint',
                emittedAtMs: 2,
                kind: 'turn-start',
                turnId: 'host-turn-1',
                agentTurnId: 'provider-turn-1',
                startedBy: 'host',
            });
            listener({
                sequence: 3,
                sessionId: 'session-checkpoint',
                emittedAtMs: 3,
                kind: 'turn-complete',
                turnId: 'host-turn-1',
                agentTurnId: 'provider-turn-1',
            });
            listener({
                sequence: 4,
                sessionId: 'session-checkpoint',
                emittedAtMs: 4,
                kind: 'turn-rollback-boundary',
                turnId: 'host-turn-1',
                agentTurnId: 'provider-turn-1',
                providerCheckpoint: 'provider-turn-1',
            });
        }

        await runtime.sendTurnPrompt('create successor.txt', {
            localId: 'queue-checkpoint-successor',
            turnId: 'host-turn-2',
            userMessageSeq: 9,
            userMessageSeqs: [9],
        });
        for (const listener of listeners) {
            listener({
                sequence: 5,
                sessionId: 'session-checkpoint',
                emittedAtMs: 5,
                kind: 'input-accepted',
                inputIds: ['queue-checkpoint-successor'],
                delivery: { kind: 'newTurn', turnId: 'host-turn-2' },
            });
            listener({
                sequence: 6,
                sessionId: 'session-checkpoint',
                emittedAtMs: 6,
                kind: 'turn-start',
                turnId: 'host-turn-2',
                agentTurnId: 'provider-turn-2',
                startedBy: 'host',
            });
            listener({
                sequence: 7,
                sessionId: 'session-checkpoint',
                emittedAtMs: 7,
                kind: 'turn-rollback-boundary',
                turnId: 'host-turn-2',
                agentTurnId: 'provider-turn-2',
                providerCheckpoint: 'provider-turn-2',
            });
            listener({
                sequence: 8,
                sessionId: 'session-checkpoint',
                emittedAtMs: 8,
                kind: 'turn-complete',
                turnId: 'host-turn-2',
                agentTurnId: 'provider-turn-2',
            });
        }
        await Promise.resolve();

        expect(mutations.filter((mutation) => mutation.action === 'mark_rollback_eligible')).toEqual([
            expect.objectContaining({
                action: 'mark_rollback_eligible',
                turnId: 'host-turn-1',
                agentTurnId: 'provider-turn-1',
                transcriptAnchors: {
                    startUserMessageSeq: 7,
                    providerCheckpoint: 'provider-turn-1',
                },
            }),
            expect.objectContaining({
                action: 'mark_rollback_eligible',
                turnId: 'host-turn-2',
                agentTurnId: 'provider-turn-2',
                transcriptAnchors: {
                    startUserMessageSeq: 9,
                    providerCheckpoint: 'provider-turn-2',
                },
            }),
        ]);
    });

    it('does not persist native rollback eligibility without an exact host user-message anchor', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'codex',
            session: {
                sessionId: 'session-checkpoint-missing-anchor',
                enqueueSessionTurnMutation: (mutation) => { mutations.push(mutation); },
            },
        });
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-checkpoint-missing-anchor',
        );
        runtime.subscribeRuntimeEvents((event) => {
            if (!('kind' in event)) return;
            lifecycle.observeRuntimeEvent(event);
        });

        await runtime.sendTurnPrompt('missing host sequence', {
            localId: 'queue-checkpoint-missing-anchor',
            turnId: 'host-turn-missing-anchor',
        });
        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-checkpoint-missing-anchor',
                emittedAtMs: 1,
                kind: 'input-accepted',
                inputIds: ['queue-checkpoint-missing-anchor'],
                delivery: { kind: 'newTurn', turnId: 'host-turn-missing-anchor' },
            });
            listener({
                sequence: 2,
                sessionId: 'session-checkpoint-missing-anchor',
                emittedAtMs: 2,
                kind: 'turn-start',
                turnId: 'host-turn-missing-anchor',
                agentTurnId: 'provider-turn-missing-anchor',
                startedBy: 'host',
            });
            listener({
                sequence: 3,
                sessionId: 'session-checkpoint-missing-anchor',
                emittedAtMs: 3,
                kind: 'turn-rollback-boundary',
                turnId: 'host-turn-missing-anchor',
                agentTurnId: 'provider-turn-missing-anchor',
                providerCheckpoint: 'provider-turn-missing-anchor',
            });
        }

        expect(mutations).not.toContainEqual(expect.objectContaining({
            action: 'mark_rollback_eligible',
            turnId: 'host-turn-missing-anchor',
        }));
    });

    it('publishes a cached native checkpoint once when exact accepted settlement arrives after turn completion', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const committedObserver: CommittedUserMessageSeqObserverFixture = { current: null };
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'codex',
            session: {
                sessionId: 'session-checkpoint-late-anchor',
                enqueueSessionTurnMutation: (mutation) => { mutations.push(mutation); },
            },
        });
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-checkpoint-late-anchor',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            {
                onTurnTerminal: () => undefined,
                subscribeCommittedUserMessageSeq(listener) {
                    committedObserver.current = listener;
                    return () => {
                        committedObserver.current = null;
                    };
                },
            },
        );
        runtime.subscribeRuntimeEvents((event) => {
            if ('kind' in event) lifecycle.observeRuntimeEvent(event);
        });

        await runtime.sendTurnPrompt('late accepted anchor', {
            localId: ' queue-late-anchor ',
            turnId: 'host-turn-late-anchor',
        });
        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-checkpoint-late-anchor',
                emittedAtMs: 1,
                kind: 'input-accepted',
                inputIds: [' queue-late-anchor '],
                delivery: { kind: 'newTurn', turnId: 'host-turn-late-anchor' },
            });
            listener({
                sequence: 2,
                sessionId: 'session-checkpoint-late-anchor',
                emittedAtMs: 2,
                kind: 'turn-start',
                turnId: 'host-turn-late-anchor',
                agentTurnId: 'provider-turn-late-anchor',
                startedBy: 'host',
            });
            listener({
                sequence: 3,
                sessionId: 'session-checkpoint-late-anchor',
                emittedAtMs: 3,
                kind: 'turn-rollback-boundary',
                turnId: 'host-turn-late-anchor',
                agentTurnId: 'provider-turn-late-anchor',
                providerCheckpoint: 'provider-turn-late-anchor',
            });
            listener({
                sequence: 4,
                sessionId: 'session-checkpoint-late-anchor',
                emittedAtMs: 4,
                kind: 'turn-complete',
                turnId: 'host-turn-late-anchor',
                agentTurnId: 'provider-turn-late-anchor',
            });
        }
        expect(mutations.filter((mutation) => mutation.action === 'mark_rollback_eligible')).toEqual([]);

        notifyCommittedUserMessageSeq(committedObserver, { localId: 'wrong-local-id', seq: 8 });
        expect(mutations.filter((mutation) => mutation.action === 'mark_rollback_eligible')).toEqual([]);
        notifyCommittedUserMessageSeq(committedObserver, { localId: ' queue-late-anchor ', seq: 9 });
        notifyCommittedUserMessageSeq(committedObserver, { localId: ' queue-late-anchor ', seq: 9 });

        expect(mutations.filter((mutation) => mutation.action === 'mark_rollback_eligible')).toEqual([
            expect.objectContaining({
                turnId: 'host-turn-late-anchor',
                agentTurnId: 'provider-turn-late-anchor',
                transcriptAnchors: {
                    startUserMessageSeq: 9,
                    providerCheckpoint: 'provider-turn-late-anchor',
                },
            }),
        ]);

        const retiredObserver = committedObserver.current;
        await runtime.resetOrDisposeRuntime();
        expect(committedObserver.current).toBeNull();
        notifyCommittedUserMessageSeq({ current: retiredObserver }, {
            localId: ' queue-late-anchor ',
            seq: 10,
        });
        expect(mutations.filter((mutation) => mutation.action === 'mark_rollback_eligible')).toHaveLength(1);
    });

    it('joins an exact sequence already committed before native input acceptance', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const committedObserver: CommittedUserMessageSeqObserverFixture = { current: null };
        const committedSeqByLocalId = new Map<string, number>();
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'codex',
            session: {
                sessionId: 'session-checkpoint-anchor-before-start',
                enqueueSessionTurnMutation: (mutation) => { mutations.push(mutation); },
            },
        });
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-checkpoint-anchor-before-start',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            {
                onTurnTerminal: () => undefined,
                subscribeCommittedUserMessageSeq(listener) {
                    committedObserver.current = listener;
                    return () => {
                        committedObserver.current = null;
                    };
                },
                getCommittedUserMessageSeq(localId) {
                    return committedSeqByLocalId.get(localId) ?? null;
                },
            },
        );
        runtime.subscribeRuntimeEvents((event) => {
            if ('kind' in event) lifecycle.observeRuntimeEvent(event);
        });

        await runtime.sendTurnPrompt('accepted anchor before start', {
            localId: 'queue-anchor-before-start',
            turnId: 'host-turn-anchor-before-start',
        });
        committedSeqByLocalId.set('queue-anchor-before-start', 7);
        notifyCommittedUserMessageSeq(committedObserver, {
            localId: 'queue-anchor-before-start',
            seq: 7,
        });
        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-checkpoint-anchor-before-start',
                emittedAtMs: 1,
                kind: 'input-accepted',
                inputIds: ['queue-anchor-before-start'],
                delivery: { kind: 'newTurn', turnId: 'host-turn-anchor-before-start' },
            });
        }
        for (const listener of listeners) {
            listener({
                sequence: 2,
                sessionId: 'session-checkpoint-anchor-before-start',
                emittedAtMs: 2,
                kind: 'turn-start',
                turnId: 'host-turn-anchor-before-start',
                agentTurnId: 'provider-turn-anchor-before-start',
                startedBy: 'host',
            });
            listener({
                sequence: 3,
                sessionId: 'session-checkpoint-anchor-before-start',
                emittedAtMs: 3,
                kind: 'turn-rollback-boundary',
                turnId: 'host-turn-anchor-before-start',
                agentTurnId: 'provider-turn-anchor-before-start',
                providerCheckpoint: 'provider-turn-anchor-before-start',
            });
            listener({
                sequence: 4,
                sessionId: 'session-checkpoint-anchor-before-start',
                emittedAtMs: 4,
                kind: 'turn-complete',
                turnId: 'host-turn-anchor-before-start',
                agentTurnId: 'provider-turn-anchor-before-start',
            });
        }
        await Promise.resolve();

        expect(mutations.filter((mutation) => mutation.action === 'mark_rollback_eligible')).toEqual([
            expect.objectContaining({
                turnId: 'host-turn-anchor-before-start',
                transcriptAnchors: {
                    startUserMessageSeq: 7,
                    providerCheckpoint: 'provider-turn-anchor-before-start',
                },
            }),
        ]);
    });

    it.each(['turn-failed', 'turn-cancelled'] as const)(
        'does not publish rollback eligibility when a late accepted sequence follows %s',
        async (terminalKind) => {
            const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
            const session: AgentSessionRuntime = {
                send: vi.fn(async () => ({ status: 'admitted' as const })),
                watch(listener) {
                    listeners.add(listener);
                    return { dispose: () => { listeners.delete(listener); } };
                },
                dispose: vi.fn(),
            };
            const committedObserver: CommittedUserMessageSeqObserverFixture = { current: null };
            const mutations: SessionTurnMutationV1[] = [];
            const lifecycle = createSessionTurnLifecycle({
                agentId: 'codex',
                session: {
                    sessionId: `session-checkpoint-${terminalKind}`,
                    enqueueSessionTurnMutation: (mutation) => { mutations.push(mutation); },
                },
            });
            const runtime = createNativeAgentSessionOperations(
                session,
                `session-checkpoint-${terminalKind}`,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [],
                {
                    onTurnTerminal: () => undefined,
                    subscribeCommittedUserMessageSeq(listener) {
                        committedObserver.current = listener;
                        return () => {
                            committedObserver.current = null;
                        };
                    },
                },
            );
            runtime.subscribeRuntimeEvents((event) => {
                if ('kind' in event) lifecycle.observeRuntimeEvent(event);
            });
            const publish = (event: AgentSessionRuntimeEvent): void => {
                for (const listener of listeners) listener(event);
            };
            const sessionId = `session-checkpoint-${terminalKind}`;
            const localId = `queue-checkpoint-${terminalKind}`;
            const turnId = `host-turn-${terminalKind}`;

            await runtime.sendTurnPrompt('terminal before accepted sequence', {
                localId,
                turnId,
            });
            publish({
                sequence: 1,
                sessionId,
                emittedAtMs: 1,
                kind: 'input-accepted',
                inputIds: [localId],
                delivery: { kind: 'newTurn', turnId },
            });
            publish({
                sequence: 2,
                sessionId,
                emittedAtMs: 2,
                kind: 'turn-start',
                turnId,
                startedBy: 'host',
            });
            publish(terminalKind === 'turn-failed'
                ? {
                    sequence: 3,
                    sessionId,
                    emittedAtMs: 3,
                    kind: terminalKind,
                    turnId,
                    diagnostic: { code: 'provider_failure', severity: 'error' },
                }
                : {
                    sequence: 3,
                    sessionId,
                    emittedAtMs: 3,
                    kind: terminalKind,
                    turnId,
                    cause: 'user',
                });

            notifyCommittedUserMessageSeq(committedObserver, { localId, seq: 11 });
            expect(mutations.filter(
                (mutation) => mutation.action === 'mark_rollback_eligible',
            )).toEqual([]);
            await runtime.resetOrDisposeRuntime();
        },
    );

    it('fences a native runtime-ended fact without durably ending the Happier session', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const cancel = vi.fn<NonNullable<AgentSessionRuntime['cancel']>>(async (request) => ({
            status: 'requested',
            turnId: request.turnId,
        }));
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            cancel,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            agentId: 'novel-native-agent',
            session: {
                sessionId: 'session-1',
                enqueueSessionTurnMutation: (mutation) => { mutations.push(mutation); },
            },
        });
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const eventKinds: string[] = [];
        runtime.subscribeRuntimeEvents((event) => {
            if (!('kind' in event)) return;
            eventKinds.push(event.kind);
            lifecycle.observeRuntimeEvent(event);
        });

        await runtime.sendTurnPrompt(
            'finish before process exit',
            { localId: 'queue-local-runtime-ended', turnId: 'turn-runtime-ended' },
        );
        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-1',
                emittedAtMs: 1,
                kind: 'input-accepted',
                inputIds: ['queue-local-runtime-ended'],
                delivery: { kind: 'newTurn', turnId: 'turn-runtime-ended' },
            });
            listener({
                sequence: 2,
                sessionId: 'session-1',
                emittedAtMs: 2,
                kind: 'turn-start',
                turnId: 'turn-runtime-ended',
                startedBy: 'host',
            });
            listener({
                sequence: 3,
                sessionId: 'session-1',
                emittedAtMs: 3,
                kind: 'turn-complete',
                turnId: 'turn-runtime-ended',
            });
            listener({
                sequence: 4,
                sessionId: 'session-1',
                emittedAtMs: 4,
                kind: 'runtime-ended',
                cause: 'providerEnded',
                retryable: false,
            });
        }

        expect(eventKinds).toEqual(['turn-start', 'turn-complete']);
        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
        expect(mutations).not.toContainEqual(expect.objectContaining({ action: 'end_session' }));
        await expect(runtime.cancelTurn()).resolves.toBeUndefined();
        expect(cancel).not.toHaveBeenCalled();
    });

    it('publishes only canonical session-correlated turn evidence and reports rejected lifecycle violations', () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const legacyEvents: Array<{ kind: string; turnId?: string }> = [];
        const canonicalEvents: Array<{ kind: string; turnId?: string }> = [];
        runtime.subscribeRuntimeEvents((event) => {
            if ('kind' in event) legacyEvents.push(event);
        });
        runtime.subscribeCanonicalAgentSessionEvents?.((event) => canonicalEvents.push(event));
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

        const publish = (event: AgentSessionRuntimeEvent): void => {
            for (const listener of listeners) listener(event);
        };

        try {
            publish({
                sequence: 1,
                sessionId: 'other-session',
                emittedAtMs: 1,
                kind: 'turn-start',
                turnId: 'foreign-turn',
                startedBy: 'provider',
            });
            publish({
                sequence: 1,
                sessionId: 'session-1',
                emittedAtMs: 1,
                kind: 'turn-progress',
                turnId: 'turn-1',
            });
            publish({
                sequence: 2,
                sessionId: 'session-1',
                emittedAtMs: 2,
                kind: 'provider-session-id',
                providerSessionId: 'provider-session-1',
            });
            publish({
                sequence: 3,
                sessionId: 'session-1',
                emittedAtMs: 3,
                kind: 'provider-session-id',
                providerSessionId: 'conflicting-provider-session',
            });
            publish({
                sequence: 4,
                sessionId: 'session-1',
                emittedAtMs: 4,
                kind: 'turn-start',
                turnId: 'turn-1',
                agentTurnId: 'agent-turn-1',
                startedBy: 'provider',
            });
            publish({
                sequence: 5,
                sessionId: 'session-1',
                emittedAtMs: 5,
                kind: 'message-delta',
                turnId: 'turn-1',
                agentTurnId: 'agent-turn-1',
                channel: 'assistant',
                text: 'accepted output',
            });
            publish({
                sequence: 6,
                sessionId: 'session-1',
                emittedAtMs: 6,
                kind: 'turn-agent-id-observed',
                turnId: 'turn-1',
                agentTurnId: 'conflicting-agent-turn',
            });
            publish({
                sequence: 7,
                sessionId: 'session-1',
                emittedAtMs: 7,
                kind: 'turn-start',
                turnId: 'turn-2',
                startedBy: 'provider',
                causedByTurnId: 'turn-1',
            });
            publish({
                sequence: 8,
                sessionId: 'session-1',
                emittedAtMs: 8,
                kind: 'turn-complete',
                turnId: 'turn-1',
                agentTurnId: 'agent-turn-1',
            });
            publish({
                sequence: 9,
                sessionId: 'session-1',
                emittedAtMs: 9,
                kind: 'turn-failed',
                turnId: 'turn-1',
                diagnostic: { code: 'duplicate_terminal', severity: 'error' },
            });
            publish({
                sequence: 10,
                sessionId: 'session-1',
                emittedAtMs: 10,
                kind: 'message-delta',
                turnId: 'turn-1',
                channel: 'assistant',
                text: 'late output',
            });
            publish({
                sequence: 11,
                sessionId: 'session-1',
                emittedAtMs: 11,
                kind: 'turn-start',
                turnId: 'turn-2',
                startedBy: 'provider',
                causedByTurnId: 'turn-1',
            });
            publish({
                sequence: 12,
                sessionId: 'session-1',
                emittedAtMs: 12,
                kind: 'runtime-ended',
                cause: 'connectionLost',
                retryable: true,
            });
            publish({
                sequence: 13,
                sessionId: 'session-1',
                emittedAtMs: 13,
                kind: 'turn-complete',
                turnId: 'turn-2',
            });
            publish({
                sequence: 14,
                sessionId: 'session-1',
                emittedAtMs: 14,
                kind: 'runtime-ended',
                cause: 'connectionLost',
                retryable: true,
            });
            publish({
                sequence: 15,
                sessionId: 'session-1',
                emittedAtMs: 15,
                kind: 'provider-session-id',
                providerSessionId: 'post-end-provider-session',
            });

            expect(canonicalEvents.map((event) => [event.kind, event.turnId])).toEqual([
                ['provider-session-id', undefined],
                ['turn-start', 'turn-1'],
                ['message-delta', 'turn-1'],
                ['turn-complete', 'turn-1'],
                ['turn-start', 'turn-2'],
                ['turn-complete', 'turn-2'],
                ['runtime-ended', undefined],
            ]);
            expect(legacyEvents.map((event) => [event.kind, event.turnId])).toEqual([
                ['session-id-publish', undefined],
                ['turn-start', 'turn-1'],
                ['message-delta', 'turn-1'],
                ['turn-complete', 'turn-1'],
                ['turn-start', 'turn-2'],
                ['turn-complete', 'turn-2'],
            ]);
            expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'provider-session-1' });
            expect(warn).toHaveBeenCalledTimes(9);
        } finally {
            warn.mockRestore();
        }
    });

    it('cancels host-owned current-session interactions on every accepted native turn terminal', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const onTurnTerminal = vi.fn(async (
            _event: Extract<
                AgentSessionRuntimeEvent,
                { kind: 'turn-complete' | 'turn-failed' | 'turn-cancelled' }
            >,
        ) => undefined);
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-1',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            { onTurnTerminal },
        );
        runtime.subscribeRuntimeEvents(() => undefined);
        const publish = (event: AgentSessionRuntimeEvent): void => {
            for (const listener of listeners) listener(event);
        };
        let sequence = 0;
        for (const terminal of ['turn-complete', 'turn-failed', 'turn-cancelled'] as const) {
            const turnId = `turn-${terminal}`;
            publish({
                sequence: ++sequence,
                sessionId: 'session-1',
                emittedAtMs: sequence,
                kind: 'turn-start',
                turnId,
                startedBy: 'provider',
            });
            publish(terminal === 'turn-complete'
                ? {
                    sequence: ++sequence,
                    sessionId: 'session-1',
                    emittedAtMs: sequence,
                    kind: terminal,
                    turnId,
                }
                : terminal === 'turn-failed'
                    ? {
                        sequence: ++sequence,
                        sessionId: 'session-1',
                        emittedAtMs: sequence,
                        kind: terminal,
                        turnId,
                        diagnostic: { code: 'provider_failure', severity: 'error' },
                    }
                    : {
                        sequence: ++sequence,
                        sessionId: 'session-1',
                        emittedAtMs: sequence,
                        kind: terminal,
                        turnId,
                        cause: 'user',
                    });
        }

        await vi.waitFor(() => expect(onTurnTerminal).toHaveBeenCalledTimes(3));
        expect(onTurnTerminal.mock.calls.map(([event]) => [event.kind, event.turnId])).toEqual([
            ['turn-complete', 'turn-turn-complete'],
            ['turn-failed', 'turn-turn-failed'],
            ['turn-cancelled', 'turn-turn-cancelled'],
        ]);
    });

    it('keeps Queue V2 localId correlation one-to-one and forwards only exact native custody evidence', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        const runtimeEvents: unknown[] = [];
        const canonicalEvents: AgentSessionRuntimeEvent[] = [];
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));
        runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
        runtime.subscribeCanonicalAgentSessionEvents?.((event) => canonicalEvents.push(event));

        await expect(runtime.sendTurnPrompt(
            'hello',
            {
                localId: 'queue-local-1',
                localIds: ['queue-local-1'],
                turnId: 'turn-1',
                userMessageSeq: 41,
                userMessageSeqs: [41],
            },
        )).resolves.toBeUndefined();
        expect(send).toHaveBeenCalledWith({
            inputIds: ['queue-local-1'],
            input: { text: 'hello' },
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
        });

        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'cross-session',
                emittedAtMs: 1,
                kind: 'input-rejected',
                inputIds: ['queue-local-1'],
                diagnostic: { code: 'cross_session_rejection', severity: 'error' },
                retryable: false,
            });
            listener({
                sequence: 2,
                sessionId: 'session-1',
                emittedAtMs: 2,
                kind: 'input-accepted',
                inputIds: ['foreign-local-id'],
                delivery: { kind: 'newTurn', turnId: 'turn-1' },
            });
            listener({
                sequence: 3,
                sessionId: 'session-1',
                emittedAtMs: 3,
                kind: 'input-accepted',
                inputIds: ['queue-local-1'],
                delivery: { kind: 'newTurn', turnId: 'turn-1' },
            });
            listener({
                sequence: 4,
                sessionId: 'session-1',
                emittedAtMs: 4,
                kind: 'input-accepted',
                inputIds: ['queue-local-1'],
                delivery: { kind: 'newTurn', turnId: 'turn-1' },
            });
            listener({
                sequence: 5,
                sessionId: 'session-1',
                emittedAtMs: 5,
                kind: 'input-custody-unknown',
                inputIds: ['queue-local-1'],
                issue: { code: 'stale_after_acceptance', severity: 'error' },
            });
            listener({
                sequence: 6,
                sessionId: 'session-1',
                emittedAtMs: 6,
                kind: 'input-custody-unknown',
                inputIds: ['foreign-local-id'],
                issue: { code: 'foreign', severity: 'error' },
            });
        }

        expect(deliveryOutcomes).toEqual([{
            type: 'input-accepted',
            localId: 'queue-local-1',
            userMessageSeq: 41,
            userMessageSeqs: [41],
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
        }]);
        expect(runtimeEvents).toEqual([]);
        expect(canonicalEvents).not.toContainEqual(expect.objectContaining({
            kind: 'input-accepted',
            delivery: { kind: 'newTurn', turnId: 'conflicting-turn' },
        }));
        expect(warn).toHaveBeenCalledWith(
            '[NativeAgentSession] rejected conflicting Queue correlation evidence',
            expect.objectContaining({ code: 'agent_runtime_input_correlation_conflict' }),
        );

        await expect(runtime.sendTurnPrompt(
            'must not aggregate Queue rows',
            {
                localId: 'queue-local-2',
                localIds: ['queue-local-2', 'queue-local-3'],
                turnId: 'turn-2',
            },
        )).rejects.toThrow('exactly one Queue localId');
        expect(send).toHaveBeenCalledOnce();
        warn.mockRestore();
    });

    it('preserves a nonblank opaque Queue localId through native send and typed acceptance', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));
        const opaqueLocalId = ' queue-local-opaque ';

        await expect(runtime.sendTurnPrompt(
            'opaque prompt',
            { localId: opaqueLocalId, userMessageSeq: 42 },
        )).resolves.toBeUndefined();
        expect(send).toHaveBeenCalledWith({
            inputIds: [opaqueLocalId],
            input: { text: 'opaque prompt' },
            delivery: {
                kind: 'newTurn',
                turnId: expect.stringMatching(/^native-turn-[0-9a-f-]+-1$/),
            },
        });
        const turnId = send.mock.calls[0]?.[0].delivery.turnId;
        expect(turnId).toEqual(expect.any(String));
        if (typeof turnId !== 'string') throw new Error('expected native fallback turn id');

        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-1',
                emittedAtMs: 1,
                kind: 'input-accepted',
                inputIds: [opaqueLocalId],
                delivery: { kind: 'newTurn', turnId },
            });
        }
        expect(deliveryOutcomes).toEqual([{
            type: 'input-accepted',
            localId: opaqueLocalId,
            userMessageSeq: 42,
            delivery: { kind: 'newTurn', turnId },
        }]);

        await expect(runtime.sendTurnPrompt(
            'blank prompt id',
            { localId: '   ', turnId: 'turn-blank' },
        )).rejects.toThrow('exactly one Queue localId');
        expect(send).toHaveBeenCalledOnce();
    });

    it('keeps fallback turn identities unique across runtime incarnations of one session', async () => {
        const send = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
        const session: AgentSessionRuntime = {
            send,
            watch: () => ({ dispose: () => {} }),
            dispose: vi.fn(),
        };
        const firstRuntime = createNativeAgentSessionOperations(session, 'session-1');
        const replacementRuntime = createNativeAgentSessionOperations(session, 'session-1');

        await firstRuntime.sendTurnPrompt('first prompt', { localId: 'queue-local-1' });
        await replacementRuntime.sendTurnPrompt('replacement prompt', { localId: 'queue-local-2' });

        const firstDelivery = send.mock.calls[0]?.[0].delivery;
        const replacementDelivery = send.mock.calls[1]?.[0].delivery;
        expect(firstDelivery).toEqual(expect.objectContaining({ kind: 'newTurn' }));
        expect(replacementDelivery).toEqual(expect.objectContaining({ kind: 'newTurn' }));
        expect(replacementDelivery?.turnId).not.toBe(firstDelivery?.turnId);
    });

    it('settles synchronous native custody loss exactly once when send then throws', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-custody-unknown',
                    inputIds: request.inputIds,
                    issue: { code: 'native_process_lost', severity: 'error' },
                });
            }
            throw new Error('native process lost after write');
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await expect(runtime.sendTurnPrompt(
            'write then lose process',
            { localId: 'queue-local-loss', turnId: 'turn-loss' },
        )).rejects.toThrow('native process lost after write');

        expect(deliveryOutcomes).toEqual([{
            type: 'input-custody-unknown',
            localId: 'queue-local-loss',
            userMessageSeq: null,
            issue: { code: 'native_process_lost', severity: 'error' },
        }]);
    });

    it('keeps synchronous new-turn custody uncertainty authoritative when send returns unavailable', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-custody-unknown',
                    inputIds: request.inputIds,
                    issue: { code: 'native_outcome_unknown', severity: 'warning' },
                });
            }
            return {
                status: 'unavailable',
                diagnostic: { code: 'native_unavailable', severity: 'warning' },
                retryable: true,
            };
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await expect(runtime.sendTurnPrompt(
            'custody becomes unknown',
            { localId: 'queue-local-new-turn-unknown', turnId: 'turn-new-turn-unknown' },
        )).rejects.toThrow("rejected prompt with status 'unavailable'");

        expect(deliveryOutcomes).toEqual([{
            type: 'input-custody-unknown',
            localId: 'queue-local-new-turn-unknown',
            userMessageSeq: null,
            issue: { code: 'native_outcome_unknown', severity: 'warning' },
        }]);
    });

    it('keeps synchronous steer custody uncertainty authoritative when send returns unavailable', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let sequence = 0;
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            if (request.delivery.kind === 'newTurn') {
                for (const listener of listeners) {
                    listener({
                        sequence: ++sequence,
                        sessionId: 'session-1',
                        emittedAtMs: sequence,
                        kind: 'input-accepted',
                        inputIds: request.inputIds,
                        delivery: request.delivery,
                    });
                    listener({
                        sequence: ++sequence,
                        sessionId: 'session-1',
                        emittedAtMs: sequence,
                        kind: 'turn-start',
                        turnId: request.delivery.turnId,
                        startedBy: 'host',
                    });
                }
                return { status: 'admitted' };
            }
            for (const listener of listeners) {
                listener({
                    sequence: ++sequence,
                    sessionId: 'session-1',
                    emittedAtMs: sequence,
                    kind: 'input-custody-unknown',
                    inputIds: request.inputIds,
                    issue: { code: 'native_steer_outcome_unknown', severity: 'warning' },
                });
            }
            return {
                status: 'unavailable',
                diagnostic: { code: 'native_steer_unavailable', severity: 'warning' },
                retryable: true,
            };
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await runtime.sendTurnPrompt(
            'start turn before steer',
            { localId: 'queue-local-start', turnId: 'turn-steer-unknown' },
        );
        await expect(runtime.steerInFlightTurn(
            'steer with unknown custody',
            { localId: 'queue-local-steer-unknown' },
        )).rejects.toThrow("rejected steer with status 'unavailable'");

        expect(deliveryOutcomes).toEqual([{
            type: 'input-accepted',
            localId: 'queue-local-start',
            userMessageSeq: null,
            delivery: { kind: 'newTurn', turnId: 'turn-steer-unknown' },
        }, {
            type: 'input-custody-unknown',
            localId: 'queue-local-steer-unknown',
            userMessageSeq: null,
            issue: { code: 'native_steer_outcome_unknown', severity: 'warning' },
        }]);
    });

    it('preserves native delivery-failed evidence and duplicate risk for the exact Queue localId', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-accepted',
                    inputIds: request.inputIds,
                    delivery: request.delivery,
                });
                listener({
                    sequence: 2,
                    sessionId: 'session-1',
                    emittedAtMs: 2,
                    kind: 'input-delivery-failed',
                    inputIds: request.inputIds,
                    delivery: request.delivery.kind === 'newTurn'
                        ? request.delivery
                        : { kind: 'newTurn', turnId: request.delivery.turnId },
                    issue: { code: 'native_delivery_failed_after_effect', severity: 'error' },
                    duplicateRisk: 'likely',
                });
            }
            return { status: 'admitted' };
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await expect(runtime.sendTurnPrompt(
            'delivery outcome failed',
            { localId: 'queue-local-delivery-failed', turnId: 'turn-delivery-failed' },
        )).resolves.toBeUndefined();

        expect(deliveryOutcomes).toEqual([{
            type: 'input-accepted',
            localId: 'queue-local-delivery-failed',
            userMessageSeq: null,
            delivery: { kind: 'newTurn', turnId: 'turn-delivery-failed' },
        }, {
            type: 'input-delivery-failed',
            localId: 'queue-local-delivery-failed',
            userMessageSeq: null,
            delivery: { kind: 'newTurn', turnId: 'turn-delivery-failed' },
            issue: { code: 'native_delivery_failed_after_effect', severity: 'error' },
            duplicateRisk: 'likely',
        }]);
    });

    it('does not downgrade accepted native input to custody-unknown during disposal', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-accepted',
                    inputIds: request.inputIds,
                    delivery: request.delivery,
                });
            }
            return { status: 'admitted' };
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await runtime.sendTurnPrompt(
            'accepted before reset',
            { localId: 'queue-local-accepted-reset', turnId: 'turn-accepted-reset' },
        );
        await runtime.resetOrDisposeRuntime();

        expect(deliveryOutcomes).toEqual([{
            type: 'input-accepted',
            localId: 'queue-local-accepted-reset',
            userMessageSeq: null,
            delivery: { kind: 'newTurn', turnId: 'turn-accepted-reset' },
        }]);
    });

    it('preserves exact correlation from nonterminal uncertainty to later canonical rejection', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-custody-unknown',
                    inputIds: request.inputIds,
                    issue: { code: 'native_outcome_temporarily_unknown', severity: 'warning' },
                });
            }
            return {
                status: 'rejected',
                diagnostic: { code: 'native_definitive_rejection', severity: 'error' },
                retryable: false,
            };
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await expect(runtime.sendTurnPrompt(
            'uncertain then rejected',
            { localId: 'queue-local-uncertain-rejected', turnId: 'turn-uncertain-rejected' },
        )).rejects.toThrow("rejected prompt with status 'rejected'");

        expect(deliveryOutcomes).toEqual([{
            type: 'input-custody-unknown',
            localId: 'queue-local-uncertain-rejected',
            userMessageSeq: null,
            issue: { code: 'native_outcome_temporarily_unknown', severity: 'warning' },
        }]);

        for (const listener of listeners) {
            listener({
                sequence: 2,
                sessionId: 'session-1',
                emittedAtMs: 2,
                kind: 'input-rejected',
                inputIds: ['queue-local-uncertain-rejected'],
                diagnostic: { code: 'native_definitive_rejection', severity: 'error' },
                retryable: false,
            });
        }

        expect(deliveryOutcomes).toEqual([{
            type: 'input-custody-unknown',
            localId: 'queue-local-uncertain-rejected',
            userMessageSeq: null,
            issue: { code: 'native_outcome_temporarily_unknown', severity: 'warning' },
        }, {
            type: 'input-rejected',
            localId: 'queue-local-uncertain-rejected',
            userMessageSeq: null,
            diagnostic: { code: 'native_definitive_rejection', severity: 'error' },
            retryable: false,
        }]);
    });

    it('settles synchronous native rejection exactly once when send also returns rejected', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-rejected',
                    inputIds: request.inputIds,
                    diagnostic: { code: 'native_rejected', severity: 'error' },
                    retryable: false,
                });
            }
            return {
                status: 'rejected',
                diagnostic: { code: 'native_rejected', severity: 'error' },
                retryable: false,
            };
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await expect(runtime.sendTurnPrompt(
            'reject before write',
            { localId: 'queue-local-rejected', turnId: 'turn-rejected' },
        )).rejects.toThrow("rejected prompt with status 'rejected'");

        expect(deliveryOutcomes).toEqual([{
            type: 'input-rejected',
            localId: 'queue-local-rejected',
            userMessageSeq: null,
            diagnostic: { code: 'native_rejected', severity: 'error' },
            retryable: false,
        }]);

        for (const listener of listeners) {
            listener({
                sequence: 2,
                sessionId: 'session-1',
                emittedAtMs: 2,
                kind: 'input-rejected',
                inputIds: ['queue-local-rejected'],
                diagnostic: { code: 'native_rejected', severity: 'error' },
                retryable: false,
            });
        }
        expect(deliveryOutcomes).toHaveLength(2);
        expect(deliveryOutcomes[1]).toEqual(deliveryOutcomes[0]);
    });

    it('preserves retryable native pre-effect rejection for Queue-owned disposition', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-rejected',
                    inputIds: request.inputIds,
                    diagnostic: { code: 'native_temporarily_unavailable', severity: 'warning' },
                    retryable: true,
                });
            }
            return {
                status: 'unavailable',
                diagnostic: { code: 'native_temporarily_unavailable', severity: 'warning' },
                retryable: true,
            };
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await expect(runtime.sendTurnPrompt(
            'retry later',
            { localId: 'queue-local-retryable', turnId: 'turn-retryable' },
        )).rejects.toThrow("rejected prompt with status 'unavailable'");
        expect(deliveryOutcomes).toEqual([{
            type: 'input-rejected',
            localId: 'queue-local-retryable',
            userMessageSeq: null,
            diagnostic: { code: 'native_temporarily_unavailable', severity: 'warning' },
            retryable: true,
        }]);
    });

    it('cancels with the exact active native turn id instead of a private sentinel', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-accepted',
                    inputIds: request.inputIds,
                    delivery: request.delivery,
                });
                listener({
                    sequence: 2,
                    sessionId: 'session-1',
                    emittedAtMs: 2,
                    kind: 'turn-start',
                    turnId: request.delivery.turnId,
                    startedBy: 'host',
                });
            }
            return { status: 'admitted' };
        });
        const cancel = vi.fn<NonNullable<AgentSessionRuntime['cancel']>>(async (request) => ({
            status: 'requested',
            turnId: request.turnId,
        }));
        const watch = vi.fn<AgentSessionRuntime['watch']>((listener) => {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        });
        const session: AgentSessionRuntime = {
            send,
            cancel,
            watch,
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        await runtime.sendTurnPrompt(
            'wait for cancel',
            { localId: 'queue-local-cancel', turnId: 'turn-cancel' },
        );

        await expect(runtime.cancelTurn()).resolves.toBeUndefined();
        expect(cancel).toHaveBeenCalledWith({ turnId: 'turn-cancel', reason: 'user' });
    });

    it('cancels the exact pending new-turn id before provider acknowledgement', async () => {
        let resolveSend: ((result: { status: 'admitted' }) => void) | null = null;
        const send = vi.fn<AgentSessionRuntime['send']>(() => new Promise((resolve) => {
            resolveSend = resolve;
        }));
        const cancel = vi.fn<NonNullable<AgentSessionRuntime['cancel']>>(async (request) => {
            resolveSend?.({ status: 'admitted' });
            return { status: 'requested', turnId: request.turnId };
        });
        const session: AgentSessionRuntime = {
            send,
            cancel,
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');
        const sending = runtime.sendTurnPrompt(
            'cancel before acknowledgement',
            { localId: 'queue-local-pre-ack', turnId: 'turn-pre-ack' },
        );

        await expect(runtime.cancelTurn()).resolves.toBeUndefined();
        await expect(sending).resolves.toBeUndefined();
        expect(cancel).toHaveBeenCalledWith({ turnId: 'turn-pre-ack', reason: 'user' });
    });

    it('does not resurrect a synchronously terminal native turn after send resolves', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-accepted',
                    inputIds: request.inputIds,
                    delivery: request.delivery,
                });
                listener({
                    sequence: 2,
                    sessionId: 'session-1',
                    emittedAtMs: 2,
                    kind: 'turn-start',
                    turnId: request.delivery.turnId,
                    startedBy: 'host',
                });
                listener({
                    sequence: 3,
                    sessionId: 'session-1',
                    emittedAtMs: 3,
                    kind: 'turn-complete',
                    turnId: request.delivery.turnId,
                });
            }
            return { status: 'admitted' };
        });
        const cancel = vi.fn<NonNullable<AgentSessionRuntime['cancel']>>(async (request) => ({
            status: 'requested',
            turnId: request.turnId,
        }));
        const watch = vi.fn<AgentSessionRuntime['watch']>((listener) => {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        });
        const session: AgentSessionRuntime = {
            send,
            cancel,
            watch,
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');

        await runtime.sendTurnPrompt(
            'complete synchronously',
            { localId: 'queue-local-complete', turnId: 'turn-complete' },
        );

        await expect(runtime.waitForTurnCompletion({ timeoutMs: 10 })).resolves.toBeUndefined();
        await expect(runtime.cancelTurn()).resolves.toBeUndefined();
        expect(cancel).not.toHaveBeenCalled();
    });

    it('does not resurrect a turn when an admitted send resolves after disposal', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let resolveSend: ((result: { status: 'admitted' }) => void) | null = null;
        let retainedListener: ((event: AgentSessionRuntimeEvent) => void) | null = null;
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            if (resolveSend) return { status: 'admitted' };
            for (const listener of listeners) {
                listener({
                    sequence: 1,
                    sessionId: 'session-1',
                    emittedAtMs: 1,
                    kind: 'input-accepted',
                    inputIds: request.inputIds,
                    delivery: request.delivery,
                });
                listener({
                    sequence: 2,
                    sessionId: 'session-1',
                    emittedAtMs: 2,
                    kind: 'turn-start',
                    turnId: request.delivery.turnId,
                    startedBy: 'host',
                });
            }
            return await new Promise<{ status: 'admitted' }>((resolve) => {
                resolveSend = resolve;
            });
        });
        const cancel = vi.fn<NonNullable<AgentSessionRuntime['cancel']>>(async (request) => ({
            status: 'requested',
            turnId: request.turnId,
        }));
        const watch = vi.fn<AgentSessionRuntime['watch']>((listener) => {
            retainedListener = listener;
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        });
        const session: AgentSessionRuntime = { send, cancel, watch, dispose: vi.fn() };
        const runtime = createNativeAgentSessionOperations(session, 'session-1');

        const sendPromise = runtime.sendTurnPrompt(
            'resolve after dispose',
            { localId: 'queue-local-dispose-race', turnId: 'turn-dispose-race' },
        );
        await vi.waitFor(() => expect(resolveSend).not.toBeNull());
        await runtime.resetOrDisposeRuntime('session_closed');
        (resolveSend as ((value: { status: 'admitted' }) => void) | null)?.({ status: 'admitted' });
        await expect(sendPromise).resolves.toBeUndefined();

        await expect(runtime.cancelTurn()).resolves.toBeUndefined();
        expect(cancel).not.toHaveBeenCalled();
        await expect(runtime.sendTurnPrompt(
            'must not dispatch after dispose',
            { localId: 'queue-local-after-dispose', turnId: 'turn-after-dispose' },
        )).rejects.toThrow('ended, disposing, or disposed');
        expect(send).toHaveBeenCalledOnce();
        runtime.subscribeRuntimeEvents(() => undefined);
        expect(watch).toHaveBeenCalledOnce();
        (retainedListener as ((event: AgentSessionRuntimeEvent) => void) | null)?.({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'provider-session-id',
            providerSessionId: 'stale-provider-after-dispose',
        });
        expect(runtime.readSessionIdentity()).toEqual({ sessionId: null });
    });
});

describe('native Agent session usage bridge — full canonical UsageObservation to ingest (R5-A / A-1)', () => {
    type PublishInput = {
        observedAt: number;
        observation: UsageObservation;
        turnId: string | null;
        externalKey: string;
    };

    function createUsagePublishHarness() {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const published: PublishInput[] = [];
        const runtime = createNativeAgentSessionOperations(session, 'session-usage', undefined, undefined, {
            provider: 'agent-runtime-native',
            publish: (input) => { published.push(input as PublishInput); },
        });
        // A subscriber is required to activate the underlying session subscription.
        runtime.subscribeRuntimeEvents(() => undefined);
        const emit = (event: AgentSessionRuntimeEvent) => {
            for (const listener of [...listeners]) listener(event);
        };
        return { emit, published, runtime };
    }

    it('publishes a rich usage-observed event as a full canonical observation reaching ingest with every field', () => {
        const { emit, published } = createUsagePublishHarness();
        emit({
            sequence: 1,
            sessionId: 'session-usage',
            emittedAtMs: 900,
            kind: 'turn-start',
            turnId: 'turn-42',
            startedBy: 'provider',
        });
        emit({
            sequence: 5,
            sessionId: 'session-usage',
            emittedAtMs: 1_000,
            kind: 'usage-observed',
            observationId: 'obs-cumulative-1',
            turnId: 'turn-42',
            source: 'agent-runtime-native',
            scope: 'session_cumulative',
            modelId: 'claude-opus-4',
            tokens: { input: 100, output: 40, reasoning: 8, cacheRead: 5, cacheWrite: 3, total: 156 },
            cost: {
                reportedUsd: 0.12,
                estimatedUsd: 0.06,
                currency: 'USD',
                costSource: 'provider_reported',
                billingContext: 'api_usage',
            },
            context: {
                v: 1,
                modelId: 'claude-opus-4',
                usedTokens: 156,
                windowTokens: 200_000,
                totalProcessedTokens: 156,
                baselineTokens: 0,
                isAutoCompactEnabled: false,
                categories: null,
                observedAtMs: 1_000,
                source: 'provider_live',
            },
        });

        // Observation identity + turn + model + cost + context all survive the bridge.
        expect(published).toHaveLength(1);
        const call = published[0];
        expect(call.externalKey).toBe('obs-cumulative-1');
        expect(call.turnId).toBe('turn-42');
        expect(call.observedAt).toBe(1_000);
        expect(call.observation).toMatchObject({
            source: 'agent-runtime-native',
            scope: 'session_cumulative',
            modelId: 'claude-opus-4',
            tokens: { input: 100, output: 40, reasoning: 8, cacheRead: 5, cacheWrite: 3, total: 156 },
            cost: { reportedUsd: 0.12, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
            contextUsedTokens: 156,
            contextWindowTokens: 200_000,
        });
        expect(call.observation.contextSnapshot).toMatchObject({ v: 1, usedTokens: 156, windowTokens: 200_000, source: 'provider_live' });

        // The very next hop (server ingest request builder) preserves every analytics field.
        const ingest = buildUsageEventIngestRequest({
            sessionId: 'session-usage',
            observedAt: call.observedAt,
            observation: call.observation,
            turnId: call.turnId,
            externalKey: call.externalKey,
        });
        expect(ingest).toMatchObject({
            sessionId: 'session-usage',
            agentId: 'agent-runtime-native',
            source: 'agent-runtime-native',
            scope: 'session_cumulative',
            isCumulative: true,
            externalKey: 'obs-cumulative-1',
            turnId: 'turn-42',
            modelId: 'claude-opus-4',
            tokens: { input: 100, output: 40, reasoning: 8, cacheRead: 5, cacheWrite: 3, total: 156 },
            cost: { reportedUsd: 0.12, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
            context: { usedTokens: 156, windowTokens: 200_000 },
        });
    });

    it('preserves scope precedence, cumulative flag, and per-model separation across delta/cumulative/final observations', () => {
        const { emit, published } = createUsagePublishHarness();
        const shared = { sessionId: 'session-usage', source: 'agent-runtime-native' } as const;
        emit({ sessionId: 'session-usage', sequence: 1, emittedAtMs: 5, kind: 'turn-start', turnId: 't1', startedBy: 'provider' });
        emit({ ...shared, sequence: 2, emittedAtMs: 10, kind: 'usage-observed', observationId: 'd1', turnId: 't1', scope: 'turn_delta', modelId: 'model-a', tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 } });
        emit({ ...shared, sequence: 3, emittedAtMs: 20, kind: 'usage-observed', observationId: 'c1', turnId: 't1', scope: 'session_cumulative', modelId: 'model-a', tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 } });
        emit({ sessionId: 'session-usage', sequence: 4, emittedAtMs: 24, kind: 'turn-complete', turnId: 't1' });
        emit({ sessionId: 'session-usage', sequence: 5, emittedAtMs: 25, kind: 'turn-start', turnId: 't2', startedBy: 'provider' });
        emit({ ...shared, sequence: 6, emittedAtMs: 30, kind: 'usage-observed', observationId: 'f1', turnId: 't2', scope: 'session_final', modelId: 'model-b', tokens: { input: 40, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 60 } });

        expect(published.map((call) => [call.observation.scope, call.externalKey, call.turnId, call.observation.modelId])).toEqual([
            ['turn_delta', 'd1', 't1', 'model-a'],
            ['session_cumulative', 'c1', 't1', 'model-a'],
            ['session_final', 'f1', 't2', 'model-b'],
        ]);
        // Ingest cumulative flag follows scope precedence (delta is not cumulative; cumulative/final are).
        expect(published.map((call) => buildUsageEventIngestRequest({
            sessionId: 'session-usage',
            observedAt: call.observedAt,
            observation: call.observation,
            turnId: call.turnId,
            externalKey: call.externalKey,
        })?.isCumulative)).toEqual([false, true, true]);
    });
});
