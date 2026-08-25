import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

import type {
    AgentRuntime,
    AgentRuntimeFactory,
    AgentSessionCatalogControl,
    AgentSessionContinuationControl,
    AgentSessionOpenRequest,
    AgentSessionConversationRollbackControl,
    AgentSessionRuntimeFactory,
    AgentSessionRuntimeContext,
    AgentSessionRuntime,
    AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    ProviderConnectionIdSchema,
    accountSettingsParse,
    redactBugReportSensitiveText,
    type AgentProviderRequirementsV1,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime';
import {
    CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
    CurrentSessionPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions';
import type {
    TerminalControlPort,
    TerminalHostAdapter,
    TerminalHostHandle,
    TerminalInputInjectionResult,
} from '@happier-dev/agents';
import {
    HostTerminalModelSelectionBlockedError,
    type HostTerminalLaunchRequest,
} from '@/agent/runtime/session/terminal/contract';
import type { Credentials } from '@/persistence';
import type { Metadata } from '@/api/types';
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
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { logger } from '@/ui/logger';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
    createNativeAgentSessionHostServices,
    createNativeAgentSessionOperations,
    createNativeAgentRuntimeSessionPlan,
    type NativeAgentNewTurnAdmissionWitness,
    type NativeAgentSessionHostServiceOwners,
} from './nativeAgentSession';
import { createNativeAgentSessionServices } from './nativeAgentSessionInteractions';
import type { UsageObservation } from '@/usage/usageObservation';
import { buildUsageEventIngestRequest } from '@/usage/buildUsageEventIngestRequest';
import type { RuntimeTurnPromptMeta } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createPluginTerminalHostService } from '@/plugins/runtime/context/terminalHost';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { resolveCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import {
    HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
    serializeProviderBindingLaunchHandoffForEnv,
} from '@/plugins/runtime/providerBindings/handoff';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import type { HostPluginServices } from '@/agent/runtime/state/currentSessionUiTypes';
import type {
    PluginProtocolClientHandle,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { ExternalSessionHostOperationPort } from '@/session/external/hostOperationOwner';
import type { HostExternalTranscriptFollowEvent } from '@/session/external/privateContract';
import type { ResolvedSessionMcpServer } from '@/mcp/runtimeTypes';
import {
    createNativeAgentSessionEffectBoundaryError,
} from './nativeAgentSessionBoundaryError';
import { configuration as happierConfiguration } from '@/configuration';
import * as providerBindingRuntimeDiagnosticRedaction from '@/plugins/runtime/providerBindings/runtimeDiagnosticRedaction';

async function loadRealAgentRuntimeFactory(
    relativeRepoPath: string,
    exportName: string,
): Promise<AgentRuntimeFactory> {
    const loader = createJiti(import.meta.url, {
        fsCache: false,
        moduleCache: true,
        interopDefault: false,
    });
    const module = await loader.import(resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../../../',
        relativeRepoPath,
    )) as Readonly<Record<string, unknown>>;
    const factory = module[exportName];
    if (typeof factory !== 'function') {
        throw new Error(
            `Real Agent runtime factory export '${exportName}' is unavailable`,
        );
    }
    return factory as AgentRuntimeFactory;
}

async function loadRealPluginFunction<T>(
    relativeRepoPath: string,
    exportName: string,
): Promise<T> {
    const loader = createJiti(import.meta.url, {
        fsCache: false,
        moduleCache: true,
        interopDefault: false,
    });
    const module = await loader.import(resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../../../',
        relativeRepoPath,
    )) as Readonly<Record<string, unknown>>;
    const value = module[exportName];
    if (typeof value !== 'function') {
        throw new Error(`Real plugin function '${exportName}' is unavailable`);
    }
    return value as T;
}

const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
};

function requireActiveTurnAdmissionWitnessReader(
    reader: (() => NativeAgentNewTurnAdmissionWitness | null) | null,
): () => NativeAgentNewTurnAdmissionWitness | null {
    if (!reader) {
        throw new Error('expected active-turn admission witness reader');
    }
    return reader;
}

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

function externalProviderBindingMetadata(
    connectionId: string,
    modelId: string,
    agentTargetKey: `backend:${string}`,
) {
    return {
        ...providerBindingMetadata(connectionId, modelId),
        contributionKey: 'plugin.openrouter/openrouter',
        adapterBindingKey: 'openrouter',
        runtimeBindingBasis: {
            v: 1 as const,
            deployment: { kind: 'external' as const },
            agentTargetKey,
            connectionId: ProviderConnectionIdSchema.parse(connectionId),
            contributionKey: 'plugin.openrouter/openrouter',
            endpoint: {
                endpointTemplateId: 'responses',
                normalizedUrl: 'https://provider.example/v1',
                protocol: 'openai-responses' as const,
                publicHeaders: {},
            },
            runtimeCredentialTransport: null,
            prepared: {
                v: 1 as const,
                materialization: 'engineConfig' as const,
                adapterBindingKey: 'openrouter',
            },
            adapterVersion: 1,
            credentialAuthorization: {
                connectionSecurityFingerprint: 'connection-security-v1',
                grantFingerprint: 'grant-v1',
                selectedSecretBindingId: null,
                selectedSecretRecordFingerprint: null,
            },
            agentSupport: {
                acceptsProtocols: ['openai-responses' as const],
                required: {},
                credentialSupport: {
                    supportsNoAuth: true,
                    apiKeyTransports: [],
                },
                authIsolation: {
                    suppressConnectedServiceIds: [],
                    ownedEnvKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
                },
                materialization: 'engineConfig' as const,
                applyPolicy: 'live' as const,
                supportsFreeformModelIds: true,
            },
        },
    };
}

function managedProviderBindingMetadata(
    connectionId: string,
    modelId: string,
    agentTargetKey: `backend:${string}`,
) {
    const {
        adapterBindingKey: _adapterBindingKey,
        ...base
    } = providerBindingMetadata(connectionId, modelId);
    const purposeBindings = { v: 1 as const, bindings: [] };
    return {
        ...base,
        contributionKey: 'acme.providers/gateway',
        materialization: 'spawnEnv' as const,
        managedPurposeBindings: purposeBindings,
        runtimeBindingBasis: {
            v: 1 as const,
            deployment: {
                kind: 'managedLocal' as const,
                implementationIdentity: {
                    pluginId: 'acme.providers',
                    localId: 'gateway',
                },
                managedRuntime: {
                    kind: 'managed' as const,
                    dependencies: [],
                    endpointTemplateIds: ['responses'],
                    connectedAccounts: [],
                    requestAuthUses: [],
                },
                purposeBindings,
            },
            agentTargetKey,
            connectionId: ProviderConnectionIdSchema.parse(connectionId),
            contributionKey: 'acme.providers/gateway',
            endpoint: {
                endpointTemplateId: 'responses',
                protocol: 'openai-responses' as const,
                publicHeaders: {},
            },
            runtimeCredentialTransport: null,
            prepared: {
                v: 1 as const,
                materialization: 'spawnEnv' as const,
            },
            adapterVersion: 1,
            credentialAuthorization: {
                connectionSecurityFingerprint: 'connection-security-v1',
                grantFingerprint: 'grant-v1',
            },
            agentSupport: {
                acceptsProtocols: ['openai-responses' as const],
                required: {},
                credentialSupport: {
                    supportsNoAuth: true,
                    apiKeyTransports: [],
                },
                authIsolation: {
                    suppressConnectedServiceIds: [],
                    ownedEnvKeys: [],
                },
                materialization: 'spawnEnv' as const,
                applyPolicy: 'restart_session' as const,
                supportsFreeformModelIds: true,
            },
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
    const updateMetadata = async (
        updater: (state: Record<string, unknown>) => Record<string, unknown>,
    ) => {
        metadata = updater(metadata);
        for (const listener of metadataListeners) listener();
    };
    return {
        sessionId,
        rpcHandlerManager: {
            registerHandler: (method: string, handler: (input: unknown) => unknown) => handlers.set(method, handler),
            invokeLocal: async (method: string, input: unknown) => await handlers.get(method)?.(input),
        },
        updateAgentState: async (updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
            agentState = updater(agentState);
        },
        updateMetadata,
        updateMetadataAsCurrentPublisher: updateMetadata,
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
        localAgentId: agentId,
        generation: 'generation-1',
        immutableGenerationId: null,
        hasPrimaryRuntime: true,
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        async createAgentRuntimeSurfaceInvocationContext() {
            throw new Error('Session adapter fixture should not create an Agent runtime surface invocation context');
        },
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
        mcp: Object.freeze({ resolveForSession: async () => Object.freeze([]) }),
        toolExecution: Object.freeze({
            before: async (
                request: Parameters<
                    NativeAgentSessionHostServiceOwners['toolExecution']['before']
                >[0],
            ) => ({
                status: 'continue' as const,
                input: request.input,
            }),
            observeAfter: async () => undefined,
        }),
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

function createAgentActivityHeadline() {
    return {
        v: 1,
        backendId: 'claude',
        agentId: 'claude',
        updatedAt: 124,
        primaryEntryId: 'workflow_run:workflow-native-1',
        activeEntries: [{
            entryId: 'workflow_run:workflow-native-1',
            kind: 'workflow_run',
            title: 'Native workflow',
            status: 'running',
            updatedAt: 123,
            runId: 'workflow-native-1',
            recordRevision: '1',
        }],
    } as const;
}

describe('native Agent session host adapter', () => {
    it('preflights declared startup instructions before provider open and commits custody only afterward', async () => {
        const agentId = 'acme-startup-instructions';
        const contributions = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition
                            .capabilities,
                        sessions: {
                            ...contributions.agent.richDefinition.definition
                                .capabilities.sessions,
                            startupInstructions: { versions: [1] as const },
                        },
                    },
                },
            },
        };
        const startupInstructions = {
            v: 1 as const,
            id: 'happier.global_voice_agent',
            revision: 7,
            instructions: 'Use the project-specific startup instructions.',
        };
        const events: string[] = [];
        const open = vi.fn(async (request) => {
            events.push('provider-open');
            expect(request).toMatchObject({
                kind: 'create',
                startupInstructions,
            });
            return {
                send: async () => ({ status: 'admitted' as const }),
                watch: () => ({ dispose: () => undefined }),
                dispose: async () => undefined,
            };
        });
        const attestSessionOpen = vi.fn(async (params) => {
            events.push(`attest-${String(Reflect.get(params, 'phase'))}`);
            expect(params.request).toMatchObject({
                kind: 'create',
                startupInstructions,
            });
            if (Reflect.get(params, 'phase') === 'prepare') {
                expect(open).not.toHaveBeenCalled();
            }
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            createRuntime: async () => ({ sessions: { open } }),
            authorizeNewTurn: async () => ({ status: 'admitted' as const }),
            attestSessionOpen,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-startup-instructions',
                agentSessionStartupInstructionsV1: startupInstructions,
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }

        await plan.config.createSessionRuntime({
            directory: '/tmp/acme-startup-instructions',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort(
                'session-startup-instructions',
            ),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(events).toEqual([
            'attest-prepare',
            'provider-open',
            'attest-commit',
        ]);
    });

    it('keeps a rejected session-open prepare attestation pre-dispatch', async () => {
        const agentId = 'acme-session-open-prepare-failure';
        const contributions = createExternalContributionFixtures(agentId);
        const prepareFailure = new Error('session-open prepare rejected');
        const open = vi.fn(async () => ({
            send: async () => ({ status: 'admitted' as const }),
            watch: () => ({ dispose: () => undefined }),
            dispose: async () => undefined,
        }));
        const attestSessionOpen = vi.fn(async (params) => {
            expect(Reflect.get(params, 'phase')).toBe('prepare');
            throw prepareFailure;
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            createRuntime: async () => ({ sessions: { open } }),
            authorizeNewTurn: async () => ({ status: 'admitted' as const }),
            attestSessionOpen,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-session-open-prepare-failure',
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }

        await expect(plan.config.createSessionRuntime({
            directory: '/tmp/acme-session-open-prepare-failure',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort(
                'session-open-prepare-failure',
            ),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never)).rejects.toThrow(prepareFailure);

        expect(open).not.toHaveBeenCalled();
        expect(attestSessionOpen).toHaveBeenCalledOnce();
        expect(attestSessionOpen).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'prepare' }),
        );
    });

    it('constructs the runner-owned Agent runtime only after late request-auth materialization', async () => {
        const agentId = 'acme-runner-owned-runtime';
        const contributions = createExternalContributionFixtures(agentId);
        const agent: ResolvedAgentContribution = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    capabilities: {
                        ...contributions.agent.richDefinition.definition
                            .capabilities,
                        surfaces: ['terminal'],
                    },
                },
            },
        };
        const events: string[] = [];
        const activeTurnAdmissionWitnessReader: {
            current:
                (() => NativeAgentNewTurnAdmissionWitness | null)
                | null;
        } = { current: null };
        const nativeEventListeners =
            new Set<(event: AgentSessionRuntimeEvent) => void>();
        const sessionDispose = vi.fn(async () => undefined);
        let nativeSequence = 0;
        const send = vi.fn<AgentSessionRuntime['send']>(async (request) => {
            events.push('provider-send');
            const inputId = request.inputIds[0];
            if (!inputId) throw new Error('expected one input id');
            for (const listener of nativeEventListeners) {
                listener({
                    sessionId:
                        'session-runner-owned-runtime',
                    sequence: ++nativeSequence,
                    emittedAtMs: 1,
                    kind: 'input-accepted',
                    inputIds: [inputId],
                    delivery: request.delivery,
                });
                listener({
                    sessionId:
                        'session-runner-owned-runtime',
                    sequence: ++nativeSequence,
                    emittedAtMs: 2,
                    kind: 'turn-start',
                    turnId: request.delivery.turnId,
                    startedBy: 'host',
                });
            }
            expect(activeTurnAdmissionWitnessReader.current?.()).toEqual({
                inputId,
                turnId: request.delivery.turnId,
                userMessageSeq:
                    inputId === 'input-runner-owned-runtime' ? 17 : 18,
                userMessageSeqs: [],
                ...(request.causalPermissionAuthority
                    ? {
                        causalPermissionAuthority:
                            request.causalPermissionAuthority,
                    }
                    : {}),
            });
            return { status: 'admitted' as const };
        });
        const authorizeNewTurn = vi.fn(async () => {
            events.push('daemon-admission');
            return { status: 'admitted' as const };
        });
        const attestSessionOpen = vi.fn(async () => {
            events.push('attest-open');
        });
        const resolveTerminalLaunch = vi.fn(() => ({
            argv: ['--runner-local-terminal'],
        }));
        const open = vi.fn(async () => {
            events.push('open');
            return {
                send,
                watch(listener: (event: AgentSessionRuntimeEvent) => void) {
                    nativeEventListeners.add(listener);
                    return {
                        dispose: () => {
                            nativeEventListeners.delete(listener);
                        },
                    };
                },
                dispose: sessionDispose,
            };
        });
        const createRunnerRuntime = vi.fn(async () => {
            events.push('create-runtime');
            return {
                sessions: { open },
                surfaces: {
                    terminal: {
                        resolveLaunch: resolveTerminalLaunch,
                    },
                },
            } satisfies AgentRuntime;
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            createRuntime: createRunnerRuntime,
            authorizeNewTurn,
            attestSessionOpen,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            createInvocationServices: async (input) => {
                events.push('prepare-services');
                activeTurnAdmissionWitnessReader.current =
                    input.readActiveTurnAdmissionWitness;
                return createUnavailablePluginServices();
            },
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-runner-owned-runtime',
                resolveLateEnvironment: async () => {
                    events.push('request-auth');
                    return {
                        environmentVariables: {},
                        unsetEnvironmentVariables: [],
                        sensitiveEnvironmentVariableNames: [],
                    };
                },
            }),
        });
        expect(createRunnerRuntime).not.toHaveBeenCalled();
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }

        const turnMutations: SessionTurnMutationV1[] = [];

        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-runner-owned-runtime',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort('session-runner-owned-runtime', {
                getLastObservedMessageSeq: () => 42,
                enqueueSessionTurnMutation: async (mutation: SessionTurnMutationV1) => {
                    turnMutations.push(mutation);
                },
            }),
            transcriptSession: {},
            messageBuffer: {},
            messageQueue: new MessageQueue2<
                { permissionMode: string },
                { text: string }
            >((mode) => mode.permissionMode),
            mcpServers: {},
            permissionHandler: {
                cancelByPlugin: vi.fn(async () => undefined),
            },
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(events).toEqual([
            'request-auth',
            'prepare-services',
            'create-runtime',
            'attest-open',
            'open',
            'attest-open',
        ]);
        expect(createRunnerRuntime).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
        expect(sessionDispose).not.toHaveBeenCalled();
        expect(created.terminalRemoteModeLoop).not.toBeNull();
        expect(resolveTerminalLaunch).not.toHaveBeenCalled();
        const canonicalTerminalEvents: AgentSessionRuntimeEvent[] = [];
        const unsubscribeCanonical = created.operations.subscribeRuntimeEvents((event) => {
            if ('kind' in event && event.kind === 'turn-complete') canonicalTerminalEvents.push(event);
        });

        await created.operations.sendTurnPrompt('hello runner', {
            turnId: 'turn-runner-owned-runtime',
            localId: 'input-runner-owned-runtime',
            userMessageSeq: 17,
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
            },
        });
        expect(events).toEqual([
            'request-auth',
            'prepare-services',
            'create-runtime',
            'attest-open',
            'open',
            'attest-open',
            'daemon-admission',
            'provider-send',
        ]);
        expect(authorizeNewTurn).toHaveBeenCalledWith(
            {
                inputId: 'input-runner-owned-runtime',
                turnId: 'turn-runner-owned-runtime',
                userMessageSeq: 17,
                userMessageSeqs: [],
                causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1',
                    admittedPermissionCeiling: 'read-only',
                },
            },
            { signal: expect.any(AbortSignal) },
        );
        expect(attestSessionOpen).toHaveBeenCalledWith({
            phase: 'commit',
            request: expect.objectContaining({
                kind: 'create',
                sessionId:
                    'session-runner-owned-runtime',
            }),
            providerSessionId: null,
            signal: expect.any(AbortSignal),
        });
        expect(activeTurnAdmissionWitnessReader.current?.()).toEqual({
            inputId: 'input-runner-owned-runtime',
            turnId: 'turn-runner-owned-runtime',
            userMessageSeq: 17,
            userMessageSeqs: [],
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
            },
        });
        for (const listener of nativeEventListeners) {
            listener({
                sessionId: 'session-runner-owned-runtime',
                sequence: ++nativeSequence,
                emittedAtMs: 3,
                kind: 'turn-complete',
                turnId: 'turn-runner-owned-runtime',
            });
        }
        await vi.waitFor(() => {
            expect(canonicalTerminalEvents).toHaveLength(1);
        });
        expect(turnMutations).toContainEqual(expect.objectContaining({
            action: 'append_transcript_anchors',
            turnId: 'turn-runner-owned-runtime',
            transcriptAnchors: {
                startUserMessageSeq: 17,
                userMessageSeqs: [17],
                startSeqInclusive: 17,
                endSeqInclusive: 42,
            },
        }));
        expect(activeTurnAdmissionWitnessReader.current?.()).toBeNull();

        await created.operations.sendTurnPrompt('next runner turn', {
            turnId: 'turn-runner-owned-runtime-next',
            localId: 'input-runner-owned-runtime-next',
            userMessageSeq: 18,
        });
        expect(activeTurnAdmissionWitnessReader.current?.()).toEqual({
            inputId: 'input-runner-owned-runtime-next',
            turnId: 'turn-runner-owned-runtime-next',
            userMessageSeq: 18,
            userMessageSeqs: [],
        });
        for (const listener of nativeEventListeners) {
            listener({
                sessionId: 'session-runner-owned-runtime',
                sequence: ++nativeSequence,
                emittedAtMs: 4,
                kind: 'turn-complete',
                turnId: 'turn-runner-owned-runtime',
            });
        }
        expect(activeTurnAdmissionWitnessReader.current?.()).toEqual({
            inputId: 'input-runner-owned-runtime-next',
            turnId: 'turn-runner-owned-runtime-next',
            userMessageSeq: 18,
            userMessageSeqs: [],
        });
        for (const listener of nativeEventListeners) {
            listener({
                sessionId: 'session-runner-owned-runtime',
                sequence: ++nativeSequence,
                emittedAtMs: 5,
                kind: 'turn-complete',
                turnId: 'turn-runner-owned-runtime-next',
            });
        }
        expect(activeTurnAdmissionWitnessReader.current?.()).toBeNull();
        expect(sessionDispose).not.toHaveBeenCalled();

        unsubscribeCanonical?.();
        await created.operations.resetOrDisposeRuntime();
        expect(sessionDispose).toHaveBeenCalledOnce();
    });

    it('retries only runner runtime-source retirement after session disposal succeeds', async () => {
        const agentId = 'acme-runner-retirement-owner';
        const contributions = createExternalContributionFixtures(agentId);
        const retirementFailure = new Error(
            'runner runtime-source retirement failed',
        );
        const retireRuntimeSource = vi.fn()
            .mockRejectedValueOnce(retirementFailure)
            .mockResolvedValueOnce(undefined);
        const sessionDispose = vi.fn(async () => undefined);
        const hostServicesDispose = vi.fn(async () => undefined);
        const hostServices = Object.freeze({
            ...createSessionHostServiceOwners(),
            dispose: hostServicesDispose,
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: {
                sessions: {
                    open: async () => ({
                        send: vi.fn(async () => ({
                            status: 'admitted' as const,
                        })),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: sessionDispose,
                    }),
                },
            },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => hostServices,
            retireRuntimeSource,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-runner-retirement-owner',
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-runner-retirement-owner',
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort(
                'session-runner-retirement-owner',
            ),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        await expect(created.operations.resetOrDisposeRuntime())
            .rejects.toBe(retirementFailure);
        await expect(created.operations.resetOrDisposeRuntime())
            .resolves.toBeUndefined();
        await expect(created.operations.resetOrDisposeRuntime())
            .resolves.toBeUndefined();
        expect(sessionDispose).toHaveBeenCalledOnce();
        expect(hostServicesDispose).toHaveBeenCalledOnce();
        expect(retireRuntimeSource).toHaveBeenCalledTimes(2);
    });

    it('carries the account provider state-sharing choice into the native open request', async () => {
        const agentId = 'acme-native-state-sharing';
        const contributions = createExternalContributionFixtures(agentId);
        let openedStateSharing: AgentSessionOpenRequest['stateSharing'];
        const open = vi.fn(async (request: AgentSessionOpenRequest) => {
            openedStateSharing = request.stateSharing;
            return {
                send: vi.fn(async () => ({ status: 'admitted' as const })),
                watch: () => ({ dispose: () => undefined }),
                dispose: vi.fn(async () => undefined),
            };
        });
        const openStateSharingFor = async (
            settings: Readonly<Record<string, unknown>>,
        ): Promise<AgentSessionOpenRequest['stateSharing']> => {
            openedStateSharing = undefined;
            setActiveAccountSettingsSnapshot({
                source: 'cache',
                settings: accountSettingsParse(settings),
                settingsVersion: 1,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
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
                    directory: '/tmp/acme-native-state-sharing',
                }),
            });
            if (!plan.config.createSessionRuntime) {
                throw new Error('expected a session runtime factory');
            }
            await plan.config.createSessionRuntime({
                directory: '/tmp/acme-native-state-sharing',
                metadata: {},
                machineId: 'machine-1',
                session: createNativeSessionClientTestPort(
                    'session-native-state-sharing',
                ),
                transcriptSession: {},
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: {},
                getPermissionMode: () => 'default',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            } as never);
            return openedStateSharing;
        };

        try {
            expect(await openStateSharingFor({})).toEqual({
                configMode: 'linked',
                stateMode: 'shared',
            });
            // An Agent that materializes its own launch-time home never reaches
            // the connected-service materializer, so the user's explicit choice
            // only survives if the host puts it on the open request itself.
            expect(await openStateSharingFor({
                connectedServicesProviderStateSharingSettingsV1: {
                    v: 1,
                    byAgentId: { [agentId]: { stateMode: 'isolated' } },
                },
            })).toEqual({ configMode: 'linked', stateMode: 'isolated' });
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

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

    it('returns a late Provider binding admission to the host without publishing metadata', async () => {
        const agentId = 'codex';
        const agentTargetKey = `backend:${agentId}` as const;
        const externalContributions =
            createExternalContributionFixtures(agentId);
        const metadata = externalProviderBindingMetadata(
            'pc_late',
            'late-model',
            agentTargetKey,
        );
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
                richDefinition: {
                    ...externalContributions.agent.richDefinition,
                    definition: {
                        ...externalContributions.agent.richDefinition.definition,
                        providerRequirements:
                            metadata.runtimeBindingBasis.agentSupport,
                    },
                },
            },
        };
        const dispose = vi.fn(async () => undefined);
        const open = vi.fn(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: () => ({ dispose: () => undefined }),
            dispose,
        }));
        const materialization = Object.freeze({
            v: 1 as const,
            kind: 'engineConfig' as const,
            engineConfig: Object.freeze({}),
        });
        const updateMetadataAsCurrentPublisher = vi.fn(async () => {
            throw Object.assign(
                new Error('publisher superseded'),
                {
                    code: 'session_publisher_authority_lost',
                    retryable: false,
                },
            );
        });
        const session = createNativeSessionClientTestPort(
            'session-native-late-provider',
            {
                updateMetadataAsCurrentPublisher,
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

        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-late-provider',
            metadata: {
                providerBindingV1: metadata,
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
        } as never);

        expect(open).toHaveBeenCalledOnce();
        expect(dispose).not.toHaveBeenCalled();
        expect(updateMetadataAsCurrentPublisher).not.toHaveBeenCalled();
        expect((created as Readonly<{
            admittedProviderBindingHandoff?: unknown;
        }>).admittedProviderBindingHandoff).toEqual({
            v: 1,
            materialization,
            sessionBindingMetadata: metadata,
        });
    });

    it('keeps late config-file materialization in persistent runner custody until Session disposal', async () => {
        const agentId = 'codex';
        const agentTargetKey = `backend:${agentId}` as const;
        const externalContributions =
            createExternalContributionFixtures(agentId);
        const metadata = externalProviderBindingMetadata(
            'pc_retained',
            'retained-model',
            agentTargetKey,
        );
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
                richDefinition: {
                    ...externalContributions.agent.richDefinition,
                    definition: {
                        ...externalContributions.agent.richDefinition.definition,
                        providerRequirements:
                            metadata.runtimeBindingBasis.agentSupport,
                    },
                },
            },
        };
        const materializationBaseDir = join(
            happierConfiguration.happyHomeDir,
            'providers',
            'materialized',
        );
        await mkdir(materializationBaseDir, { recursive: true, mode: 0o700 });
        const materializationRoot = await mkdtemp(
            join(materializationBaseDir, 'provider-binding-'),
        );
        await writeFile(join(materializationRoot, 'provider.json'), '{}');
        const runnerRedactionClose = vi.fn();
        const runnerRedaction = vi.spyOn(
            providerBindingRuntimeDiagnosticRedaction,
            'beginProviderBindingRuntimeDiagnosticRedaction',
        ).mockReturnValue({ close: runnerRedactionClose });
        try {
            const generationController = new AbortController();
            const sessionDispose = vi.fn(async () => undefined);
            const plan = await createNativeAgentRuntimeSessionPlan({
                runtime: {
                    sessions: {
                        open: vi.fn(async () => ({
                            send: vi.fn(async () => ({ status: 'admitted' as const })),
                            watch: () => ({ dispose: () => undefined }),
                            dispose: sessionDispose,
                        })),
                    },
                },
                lease: {
                    ...createLease(agentId),
                    pluginId: 'happier.agent.codex',
                },
                generationSignal: generationController.signal,
                backend: contributions.backend,
                agent: contributions.agent,
                createSessionHostServiceOwners: () =>
                    createSessionHostServiceOwners(),
                sessionInput: buildPluginSessionBindingInput({
                    credentials,
                    directory: '/tmp/acme-native-retained-provider',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'codex',
                    },
                    modelSelection: {
                        v: 1,
                        updatedAt: 1,
                        ref: {
                            agentTargetKey: 'backend:codex',
                            providerConnectionId: 'pc_retained',
                            modelId: 'retained-model',
                        },
                    },
                    resolveLateEnvironment: async () => ({
                        environmentVariables: {
                            [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
                                serializeProviderBindingLaunchHandoffForEnv({
                                    v: 1,
                                    kind: 'configFile',
                                    rootPath: materializationRoot,
                                    relativePaths: ['provider.json'],
                                }, metadata),
                        },
                        unsetEnvironmentVariables: [],
                        sensitiveEnvironmentVariableNames: [],
                    }),
                }),
            });
            if (!plan.config.createSessionRuntime) {
                throw new Error('expected a session runtime factory');
            }

            const created = await plan.config.createSessionRuntime({
                directory: '/tmp/acme-native-retained-provider',
                metadata: { providerBindingV1: metadata },
                machineId: 'machine-1',
                session: createNativeSessionClientTestPort(
                    'session-native-retained-provider',
                ),
                transcriptSession: {},
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: {},
                getPermissionMode: () => 'default',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            } as never);

            expect(await stat(materializationRoot)).toBeDefined();
            generationController.abort(
                new Error('hard-revoked retained generation'),
            );
            await vi.waitFor(() => {
                expect(sessionDispose).toHaveBeenCalledOnce();
                expect(runnerRedactionClose).toHaveBeenCalledOnce();
            });
            await expect(stat(materializationRoot)).rejects.toMatchObject({
                code: 'ENOENT',
            });
            await created.operations.resetOrDisposeRuntime();
            expect(sessionDispose).toHaveBeenCalledOnce();
            expect(runnerRedactionClose).toHaveBeenCalledOnce();
            await expect(stat(materializationRoot)).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            runnerRedaction.mockRestore();
            await rm(materializationRoot, { recursive: true, force: true });
        }
    });

    it('routes declared configured terminal follow through the exact source and bound canonical host operation', async () => {
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
                                terminalFollow: { userRowClassification: 'explicitV1' },
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
        let activeTerminalFollowListener: (
            event: HostExternalTranscriptFollowEvent,
        ) => void | Promise<void> = () => {
            throw new Error('terminal follow listener is unavailable');
        };
        const executeFollow = vi.fn<
            ExternalSessionHostOperationPort['executeFollow']
        >(async (request) => {
            activeTerminalFollowListener = request.listener;
            await request.listener({
                kind: 'data',
                items: [{
                    id: 'terminal-item-1',
                    timestampMs: 11,
                    kind: 'agent',
                    data: {
                        role: 'agent',
                        content: {
                            type: 'message',
                            message: 'terminal output',
                        },
                    },
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
        const executeProviderSessionFollow = vi.fn<
            ExternalSessionHostOperationPort['executeProviderSessionFollow']
        >(async () => ({
            status: 'following' as const,
            startingCursor: 'wrong-provider-session-route',
            subscription: { dispose: async () => undefined },
        }));
        const retireExternalSessionHostOperations = vi.fn(async () => undefined);
        const bindExternalSessionHostOperations = vi.fn(() => ({
            executeFollow,
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
        let terminalPublisherCurrent = true;
        const terminalProcessLaunch = vi.fn(async (_request: HostTerminalLaunchRequest) => ({
                type: 'control_returned' as const,
                reason: 'pending_input' as const,
        }));
        const terminalLaunch = vi.fn(async (request: HostTerminalLaunchRequest) => {
            const permitted = await request.runWithCurrentPublisherPermit(
                async () => await terminalProcessLaunch(request),
            );
            if (permitted.status === 'blocked') {
                throw new HostTerminalModelSelectionBlockedError();
            }
            return permitted.value;
        });
        const exactGValidateSource = vi.fn(async ({ source }) => ({ ok: true as const, source }));
        const exactGListCandidates = vi.fn(async () => ({ candidates: [], nextCursor: null }));
        const exactGResolveLinkIdentity = vi.fn(async ({ source, remoteSessionId }) => ({
            source,
            remoteSessionId,
        }));
        const exactGPageTranscript = vi.fn(async () => ({
            items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }));
        const exactGReadAfterTranscript = vi.fn(async () => ({ outcome: 'already_current' as const }));
        const executionSurfaces: BackendExecutionSurfaces = {
            ...createEmptyBackendExecutionSurfaces(),
            terminalRuntime: { launch: terminalLaunch },
            externalSession: {
                validateSource: exactGValidateSource,
                listCandidates: exactGListCandidates,
                resolveLinkIdentity: exactGResolveLinkIdentity,
                pageTranscript: exactGPageTranscript,
                readAfterTranscript: exactGReadAfterTranscript,
            },
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
                backendTarget: {
                    kind: 'backend',
                    backendId: agentId,
                    sourceKind: 'built_in',
                },
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        });
        if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
        const messageQueue = new MessageQueue2<
            { permissionMode: string },
            { text: string }
        >((mode) => mode.permissionMode);
        const enqueueAgentMessageCommitted = vi.fn<NonNullable<SessionClientPort['enqueueAgentMessageCommitted']>>(async () => ({
            persisted: true,
            delivered: true,
        }));
        let currentSessionMetadata: Record<string, unknown> = {
            terminalRuntime: { promptInteractive: true },
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 7,
                selection: {
                    agentTargetKey: `backend:${agentId}`,
                    providerConnectionId: null,
                    modelId: 'startup-native-model',
                },
            },
        };
        type TerminalModelSelection = Readonly<{
            agentTargetKey: string;
            providerConnectionId: string | null;
            modelId: string;
        }> | null;
        let terminalModelSelection: TerminalModelSelection = {
            agentTargetKey: `backend:${agentId}`,
            providerConnectionId: null,
            modelId: 'startup-native-model',
        };
        let terminalModelSelectionBlocked = false;
        let stableTerminalEffectActive = false;
        let queuedTerminalModelSelection: TerminalModelSelection | undefined;
        const requestTerminalModelTransition = (
            selection: TerminalModelSelection,
        ): void => {
            if (stableTerminalEffectActive) {
                queuedTerminalModelSelection = selection;
                return;
            }
            terminalModelSelection = selection;
        };
        const runWithTerminalModelSelection = async <T>(
            effect: (
                selection: TerminalModelSelection,
                runWithCurrentPublisherPermit: <U>(
                    localEffect: () => Promise<U>,
                ) => Promise<
                    | Readonly<{ status: 'completed'; value: U }>
                    | Readonly<{ status: 'blocked' }>
                >,
            ) => Promise<T>,
        ): Promise<
            | Readonly<{ status: 'completed'; value: T }>
            | Readonly<{ status: 'blocked' }>
        > => {
            if (terminalModelSelectionBlocked || stableTerminalEffectActive) {
                return { status: 'blocked' };
            }
            stableTerminalEffectActive = true;
            const selection = terminalModelSelection;
            try {
                const runWithCurrentPublisherPermit = async <U>(
                    localEffect: () => Promise<U>,
                ): Promise<
                    | Readonly<{ status: 'completed'; value: U }>
                    | Readonly<{ status: 'blocked' }>
                > => {
                    if (!terminalPublisherCurrent) {
                        return { status: 'blocked' };
                    }
                    return {
                        status: 'completed',
                        value: await localEffect(),
                    };
                };
                return {
                    status: 'completed',
                    value: await effect(
                        selection,
                        runWithCurrentPublisherPermit,
                    ),
                };
            } finally {
                stableTerminalEffectActive = false;
                if (queuedTerminalModelSelection !== undefined) {
                    terminalModelSelection = queuedTerminalModelSelection;
                    queuedTerminalModelSelection = undefined;
                }
            }
        };
        let committedBaselineFailure: Error | null = null;
        const sessionPort = createNativeSessionClientTestPort(
            'session-native-terminal',
            {
                enqueueAgentMessageCommitted,
                fetchCommittedTranscriptLocalIdBaseline: async () => {
                    if (committedBaselineFailure) {
                        throw committedBaselineFailure;
                    }
                    return {
                        localIds: new Set<string>(),
                        complete: true,
                    };
                },
                getMetadataSnapshot: () => currentSessionMetadata,
            },
        );
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-native-terminal',
            metadata: currentSessionMetadata,
            machineId: 'machine-1',
            agentTargetKey: `backend:${agentId}`,
            session: sessionPort,
            transcriptSession: {},
            messageQueue,
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
            runnerProcessIdentity: {
                pid: 123,
                processStartTimeMs: 1_000,
            },
            startupModelSelection: {
                agentTargetKey: `backend:${agentId}`,
                providerConnectionId: null,
                modelId: 'startup-native-model',
            },
            runWithTerminalModelSelection,
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
            model: 'raw-model-must-not-win',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 8,
                selection: {
                    agentTargetKey: `backend:${agentId}`,
                    providerConnectionId: 'pc_next',
                    modelId: 'proposed-model-must-not-win',
                },
            },
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
                model: 'raw-model-must-not-win',
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 8,
                    selection: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: 'pc_next',
                        modelId: 'proposed-model-must-not-win',
                    },
                },
            },
            modelSelection: {
                agentTargetKey: `backend:${agentId}`,
                providerConnectionId: null,
                modelId: 'startup-native-model',
            },
            runWithCurrentPublisherPermit: expect.any(Function),
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
        expect(executeFollow).toHaveBeenCalledWith(expect.objectContaining({
            ref: expect.objectContaining({
                agentId,
                remoteSessionId: 'provider-terminal-1',
            }),
            source: {
                kind: 'terminal',
                projectId: 'project-1',
            },
            options: expect.objectContaining({
                admissionDeadlineAtMs: expect.any(Number),
                initialReplay: true,
                signal: expect.any(AbortSignal),
            }),
            listener: expect.any(Function),
        }));
        expect(executeProviderSessionFollow).not.toHaveBeenCalled();
        expect(exactGResolveLinkIdentity).toHaveBeenCalledWith(expect.objectContaining({
            remoteSessionId: 'provider-terminal-1',
            source: {
                kind: 'terminal',
                projectId: 'project-1',
            },
        }));
        expect(exactGValidateSource).toHaveBeenCalledWith({
            source: {
                kind: 'terminal',
                projectId: 'project-1',
            },
        });
        expect(exactGListCandidates).not.toHaveBeenCalled();
        expect(exactGPageTranscript).not.toHaveBeenCalled();
        expect(exactGReadAfterTranscript).not.toHaveBeenCalled();
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
        const launchCountBeforeModelTransitionBlock =
            terminalLaunch.mock.calls.length;
        let releaseRacingFollow = (_result: {
            status: 'following';
            startingCursor: string;
            subscription: { dispose(): void };
        }): void => {
            throw new Error('Racing follow promise was not initialized');
        };
        executeFollow.mockImplementationOnce(async () =>
            await new Promise((resolve) => {
                releaseRacingFollow = resolve;
            }));
        const racingTerminalLaunch =
            modeLoop?.runTerminal({ entry: 'switch' });
        await vi.waitFor(() => {
            expect(executeFollow).toHaveBeenCalledTimes(2);
        });
        expect(stableTerminalEffectActive).toBe(true);
        requestTerminalModelTransition({
            agentTargetKey: `backend:${agentId}`,
            providerConnectionId: 'pc_next',
            modelId: 'provider-model-next',
        });
        expect(terminalModelSelection).toMatchObject({
            modelId: 'startup-native-model',
        });
        releaseRacingFollow({
            status: 'following',
            startingCursor: 'cursor-racing',
            subscription: { dispose() {} },
        });
        await expect(
            racingTerminalLaunch,
        ).resolves.toEqual({ type: 'switch' });
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeModelTransitionBlock + 1,
        );
        expect(terminalLaunch).toHaveBeenLastCalledWith(
            expect.objectContaining({
                modelSelection: {
                    agentTargetKey: `backend:${agentId}`,
                    providerConnectionId: null,
                    modelId: 'startup-native-model',
                },
            }),
        );
        expect(terminalModelSelection).toMatchObject({
            providerConnectionId: 'pc_next',
            modelId: 'provider-model-next',
        });

        const launchCountBeforePublisherSuccessor =
            terminalLaunch.mock.calls.length;
        const processLaunchCountBeforePublisherSuccessor =
            terminalProcessLaunch.mock.calls.length;
        let releaseSuccessorRacingFollow = (_result: {
            status: 'following';
            startingCursor: string;
            subscription: { dispose(): void };
        }): void => {
            throw new Error('Successor racing follow promise was not initialized');
        };
        executeFollow.mockImplementationOnce(async () =>
            await new Promise((resolve) => {
                releaseSuccessorRacingFollow = resolve;
            }));
        const publisherSuccessorRace =
            modeLoop?.runTerminal({ entry: 'switch' });
        await vi.waitFor(() => {
            expect(executeFollow).toHaveBeenCalledTimes(3);
        });
        terminalPublisherCurrent = false;
        releaseSuccessorRacingFollow({
            status: 'following',
            startingCursor: 'cursor-successor-racing',
            subscription: { dispose() {} },
        });
        await expect(publisherSuccessorRace).rejects.toMatchObject({
            name: 'HostTerminalModelSelectionBlockedError',
            code: 'native_agent_terminal_model_selection_blocked',
        } satisfies Partial<HostTerminalModelSelectionBlockedError>);
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforePublisherSuccessor + 1,
        );
        expect(terminalProcessLaunch).toHaveBeenCalledTimes(
            processLaunchCountBeforePublisherSuccessor,
        );
        terminalPublisherCurrent = true;

        let releaseRacingProcessLaunch = (_result: {
            type: 'control_returned';
            reason: 'pending_input';
        }): void => {
            throw new Error('Racing terminal launch promise was not initialized');
        };
        terminalLaunch.mockImplementationOnce(async () =>
            await new Promise((resolve) => {
                releaseRacingProcessLaunch = resolve;
            }));
        const launchCountBeforeProcessResolution =
            terminalLaunch.mock.calls.length;
        const processResolutionRace =
            modeLoop?.runTerminal({ entry: 'switch' });
        await vi.waitFor(() => {
            expect(terminalLaunch).toHaveBeenCalledTimes(
                launchCountBeforeProcessResolution + 1,
            );
        });
        expect(stableTerminalEffectActive).toBe(true);
        requestTerminalModelTransition({
            agentTargetKey: `backend:${agentId}`,
            providerConnectionId: null,
            modelId: 'native-model-after-terminal',
        });
        expect(terminalModelSelection).toMatchObject({
            providerConnectionId: 'pc_next',
            modelId: 'provider-model-next',
        });
        expect(terminalLaunch).toHaveBeenLastCalledWith(
            expect.objectContaining({
                modelSelection: {
                    agentTargetKey: `backend:${agentId}`,
                    providerConnectionId: 'pc_next',
                    modelId: 'provider-model-next',
                },
            }),
        );
        releaseRacingProcessLaunch({
            type: 'control_returned',
            reason: 'pending_input',
        });
        await expect(processResolutionRace).resolves.toEqual({
            type: 'switch',
        });
        expect(terminalModelSelection).toMatchObject({
            providerConnectionId: null,
            modelId: 'native-model-after-terminal',
        });

        let reportCompletedIterationFailure!: (error: Error) => void;
        const completedIterationFailure = new Promise<Error>((resolve) => {
            reportCompletedIterationFailure = resolve;
        });
        executeFollow.mockImplementationOnce(async (request) => {
            activeTerminalFollowListener = request.listener;
            return {
                status: 'following' as const,
                startingCursor: 'cursor-completed-iteration',
                failure: completedIterationFailure,
                subscription: { dispose: disposeFollow },
            };
        });
        await expect(
            modeLoop?.runTerminal({ entry: 'switch' }),
        ).resolves.toEqual({ type: 'switch' });

        let releaseReplacementTerminalLaunch = (): void => {
            throw new Error('replacement terminal launch was not initialized');
        };
        let replacementTerminalSignal!: AbortSignal;
        terminalLaunch.mockImplementationOnce(async (request) => {
            if (!request.signal) {
                throw new Error('replacement terminal signal is unavailable');
            }
            replacementTerminalSignal = request.signal;
            return await new Promise((resolve) => {
                releaseReplacementTerminalLaunch = () => resolve({
                    type: 'control_returned' as const,
                    reason: 'pending_input' as const,
                });
            });
        });
        const replacementTerminalRun =
            modeLoop?.runTerminal({ entry: 'switch' });
        await vi.waitFor(() => {
            expect(replacementTerminalSignal).toBeDefined();
        });

        reportCompletedIterationFailure(Object.assign(
            new Error('late completed-iteration follow failure'),
            { code: 'plugin_external_follow_provider_failed' },
        ));
        await Promise.resolve();
        await Promise.resolve();

        expect(replacementTerminalSignal.aborted).toBe(false);
        releaseReplacementTerminalLaunch();
        await expect(replacementTerminalRun).resolves.toEqual({
            type: 'switch',
        });

        let resolveFailedFollowLaunchSignal!: (
            signal: AbortSignal,
        ) => void;
        const failedFollowLaunchSignalPromise = new Promise<AbortSignal>(
            (resolve) => {
                resolveFailedFollowLaunchSignal = resolve;
            },
        );
        let releaseFailedFollowLaunch = (): void => {
            throw new Error('failed-follow terminal launch was not initialized');
        };
        terminalLaunch.mockImplementationOnce(async (request) => {
            if (!request.signal) {
                throw new Error('terminal launch signal is unavailable');
            }
            const requestSignal = request.signal;
            resolveFailedFollowLaunchSignal(requestSignal);
            return await new Promise((resolve) => {
                releaseFailedFollowLaunch = () => resolve({
                    type: 'control_returned' as const,
                    reason: 'pending_input' as const,
                });
                requestSignal.addEventListener(
                    'abort',
                    releaseFailedFollowLaunch,
                    { once: true },
                );
            });
        });
        const launchCountBeforeFollowFailure = terminalLaunch.mock.calls.length;
        const disposeCountBeforeFollowFailure = disposeFollow.mock.calls.length;
        const failedFollowRun = modeLoop?.runTerminal({ entry: 'switch' });
        await vi.waitFor(() => {
            expect(terminalLaunch).toHaveBeenCalledTimes(
                launchCountBeforeFollowFailure + 1,
            );
        });
        const failedFollowLaunchSignal =
            await failedFollowLaunchSignalPromise;
        await activeTerminalFollowListener({
            kind: 'terminated',
            reason: 'providerFailure',
            cursor: 'cursor-1',
            code: 'plugin_external_follow_provider_failed',
        });
        // ES-PEP-05: for an Agent that declares explicit terminal follow, the
        // ready binding races terminal completion. A durable follow failure wins
        // with a typed failure and stops the child, instead of leaving a live
        // terminal whose rows no transcript owner is recording. (Previously this
        // asserted the inverse: `aborted` false and the run resolving
        // `{ type: 'switch' }`, i.e. follow detaching while the terminal ran on.)
        await expect(failedFollowRun).rejects.toMatchObject({
            name: 'HostTerminalTranscriptFollowAdmissionError',
            followCode: 'plugin_external_follow_provider_failed',
            phase: 'active',
        });
        expect(failedFollowLaunchSignal.aborted).toBe(true);
        await vi.waitFor(() => {
            expect(disposeFollow).toHaveBeenCalledTimes(
                disposeCountBeforeFollowFailure + 1,
            );
        });
        releaseFailedFollowLaunch();

        const closeFailure = createNativeAgentSessionEffectBoundaryError(
            'outcome_unknown_after_dispatch',
        );
        disposeFollow
            .mockRejectedValueOnce(closeFailure)
            .mockRejectedValueOnce(closeFailure);
        const followCountBeforeCloseFailure =
            executeFollow.mock.calls.length;
        const launchCountBeforeCloseFailure = terminalLaunch.mock.calls.length;
        await expect(
            modeLoop?.runTerminal({ entry: 'switch' }),
        ).resolves.toEqual({ type: 'switch' });
        expect(executeFollow).toHaveBeenCalledTimes(
            followCountBeforeCloseFailure + 1,
        );
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeCloseFailure + 1,
        );

        await expect(
            modeLoop?.runTerminal({ entry: 'switch' }),
        ).resolves.toEqual({ type: 'switch' });
        expect(executeFollow).toHaveBeenCalledTimes(
            followCountBeforeCloseFailure + 2,
        );
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeCloseFailure + 2,
        );

        await expect(
            modeLoop?.runTerminal({ entry: 'switch' }),
        ).resolves.toEqual({ type: 'switch' });
        expect(executeFollow).toHaveBeenCalledTimes(
            followCountBeforeCloseFailure + 3,
        );
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeCloseFailure + 3,
        );

        const launchCountBeforeBlockedAdmission =
            terminalLaunch.mock.calls.length;
        const followCountBeforeBlockedAdmission =
            executeFollow.mock.calls.length;
        terminalModelSelectionBlocked = true;
        await expect(
            modeLoop?.runTerminal({ entry: 'switch' }),
        ).rejects.toMatchObject({
            name: 'HostTerminalModelSelectionBlockedError',
            code: 'native_agent_terminal_model_selection_blocked',
        } satisfies Partial<HostTerminalModelSelectionBlockedError>);
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeBlockedAdmission,
        );
        expect(executeFollow).toHaveBeenCalledTimes(
            followCountBeforeBlockedAdmission,
        );
        terminalModelSelectionBlocked = false;
        requestTerminalModelTransition({
            agentTargetKey: `backend:${agentId}`,
            providerConnectionId: null,
            modelId: 'startup-native-model',
        });
        expect(terminalModelSelection).toEqual({
                agentTargetKey: `backend:${agentId}`,
                providerConnectionId: null,
                modelId: 'startup-native-model',
            },
        );
        let admitDelayedFollow!: () => void;
        const delayedFollowAdmission = new Promise<void>((resolve) => {
            admitDelayedFollow = resolve;
        });
        executeFollow.mockImplementationOnce(async () => {
            await delayedFollowAdmission;
            return {
                status: 'following' as const,
                startingCursor: 'cursor-delayed-admission',
                subscription: { dispose: disposeFollow },
            };
        });
        const launchCountBeforeDelayedAdmission = terminalLaunch.mock.calls.length;
        const delayedAdmissionRun = modeLoop?.runTerminal({ entry: 'switch' });
        await Promise.resolve();
        await Promise.resolve();
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeDelayedAdmission,
        );
        admitDelayedFollow();
        await expect(delayedAdmissionRun).resolves.toEqual({ type: 'switch' });
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeDelayedAdmission + 1,
        );

        const launchCountBeforeBaselineFailure = terminalLaunch.mock.calls.length;
        const processLaunchCountBeforeBaselineFailure =
            terminalProcessLaunch.mock.calls.length;
        const followCountBeforeBaselineFailure = executeFollow.mock.calls.length;
        const transcriptCountBeforeBaselineFailure =
            enqueueAgentMessageCommitted.mock.calls.length;
        committedBaselineFailure = new Error('committed baseline unavailable');
        // ES-PEP-03: baseline failure fails closed. It launches no terminal
        // process, fetches no tail cursor, writes no transcript row, preserves
        // the existing Session, and permits an explicit later retry. (Previously
        // this asserted the inverse: the run resolving `{ type: 'switch' }` with
        // `terminalLaunch` and `terminalProcessLaunch` each +1.)
        await expect(
            modeLoop?.runTerminal({ entry: 'initial' }),
        ).rejects.toMatchObject({
            name: 'HostTerminalTranscriptFollowAdmissionError',
            followCode: 'plugin_external_follow_unavailable',
            phase: 'bind',
        });
        expect(executeFollow).toHaveBeenCalledTimes(
            followCountBeforeBaselineFailure,
        );
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeBaselineFailure,
        );
        expect(terminalProcessLaunch).toHaveBeenCalledTimes(
            processLaunchCountBeforeBaselineFailure,
        );
        expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(
            transcriptCountBeforeBaselineFailure,
        );

        // The explicit later retry the amendment requires: a fresh run rebinds
        // and only then launches.
        committedBaselineFailure = null;
        await expect(
            modeLoop?.runTerminal({ entry: 'initial' }),
        ).resolves.toEqual({ type: 'switch' });
        expect(executeFollow).toHaveBeenCalledTimes(
            followCountBeforeBaselineFailure + 1,
        );
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeBaselineFailure + 1,
        );
        expect(terminalProcessLaunch).toHaveBeenCalledTimes(
            processLaunchCountBeforeBaselineFailure + 1,
        );
        expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(
            transcriptCountBeforeBaselineFailure + 1,
        );

        const launchCountBeforeInitialProjectionFailure =
            terminalLaunch.mock.calls.length;
        const processLaunchCountBeforeInitialProjectionFailure =
            terminalProcessLaunch.mock.calls.length;
        const followCountBeforeInitialProjectionFailure =
            executeFollow.mock.calls.length;
        const transcriptCountBeforeInitialProjectionFailure =
            enqueueAgentMessageCommitted.mock.calls.length;
        executeFollow.mockImplementationOnce(async (request) => {
            activeTerminalFollowListener = request.listener;
            await request.listener({
                kind: 'data',
                phase: 'initial_replay',
                items: [{
                    id: 'terminal-item-initial-replay-failure',
                    timestampMs: 12,
                    kind: 'agent',
                    data: {
                        role: 'agent',
                        content: {
                            type: 'message',
                            message: 'initial replay output',
                        },
                    },
                }],
                fromCursor: 'cursor-initial-replay-0',
                nextCursor: 'cursor-initial-replay-1',
            });
            return {
                status: 'following' as const,
                startingCursor: 'cursor-initial-replay-0',
                subscription: { dispose: disposeFollow },
            };
        });
        enqueueAgentMessageCommitted.mockResolvedValueOnce({
            persisted: false,
            delivered: false,
        });
        // ES-PEP-05 orders "complete bounded replay and durable transcript
        // projection" before "launch terminal process", so a refused initial
        // projection closes admission and creates no child. (Previously this
        // asserted the run resolving `{ type: 'switch' }` with `terminalLaunch`
        // and `terminalProcessLaunch` each +1.)
        await expect(
            modeLoop?.runTerminal({ entry: 'initial' }),
        ).rejects.toMatchObject({
            name: 'HostTerminalTranscriptFollowAdmissionError',
            followCode: 'plugin_external_follow_acquisition_failed',
            phase: 'bind',
        });
        expect(executeFollow).toHaveBeenCalledTimes(
            followCountBeforeInitialProjectionFailure + 1,
        );
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeInitialProjectionFailure,
        );
        expect(terminalProcessLaunch).toHaveBeenCalledTimes(
            processLaunchCountBeforeInitialProjectionFailure,
        );
        expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(
            transcriptCountBeforeInitialProjectionFailure + 1,
        );
        expect(
            enqueueAgentMessageCommitted.mock.calls[
                transcriptCountBeforeInitialProjectionFailure
            ]?.[2],
        ).toEqual(expect.objectContaining({
            admission: expect.objectContaining({
                deadlineAtMs: expect.any(Number),
                signal: expect.any(AbortSignal),
            }),
        }));

        const launchCountBeforeAuthorityRefusal =
            terminalLaunch.mock.calls.length;
        const processLaunchCountBeforeAuthorityRefusal =
            terminalProcessLaunch.mock.calls.length;
        const followCountBeforeAuthorityRefusal = executeFollow.mock.calls.length;
        const transcriptCountBeforeAuthorityRefusal =
            enqueueAgentMessageCommitted.mock.calls.length;
        executeFollow.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'plugin_external_follow_authority_unavailable',
        });
        // ES-PEP-05: a typed follow-authority refusal is a pre-launch admission
        // failure, so it creates no child. (Previously this asserted the run
        // resolving `{ type: 'switch' }` with both launch counters +1.)
        await expect(
            modeLoop?.runTerminal({ entry: 'initial' }),
        ).rejects.toMatchObject({
            name: 'HostTerminalTranscriptFollowAdmissionError',
            followCode: 'plugin_external_follow_authority_unavailable',
            phase: 'bind',
        });
        expect(terminalLaunch).toHaveBeenCalledTimes(
            launchCountBeforeAuthorityRefusal,
        );
        expect(terminalProcessLaunch).toHaveBeenCalledTimes(
            processLaunchCountBeforeAuthorityRefusal,
        );
        expect(executeFollow).toHaveBeenCalledTimes(
            followCountBeforeAuthorityRefusal + 1,
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

    it('does not expose system-record authority in the public Agent session context', async () => {
        let publicServices: AgentSessionRuntimeContext['session']['services'] | undefined;
        let openArgumentCount: number | undefined;
        let reflectedWorkflowRecordSymbols: readonly symbol[] = [];
        const runtime: AgentRuntime = {
            sessions: {
                open: vi.fn(async function (_request, context) {
                    openArgumentCount = arguments.length;
                    publicServices = context.session.services;
                    reflectedWorkflowRecordSymbols = Reflect.ownKeys(globalThis)
                        .filter((key): key is symbol => (
                            typeof key === 'symbol'
                            && String(key).includes('workflowRunRecordPort')
                        ));
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
            lease: createLease(agentId),
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
            session: createNativeSessionClientTestPort('session-native-system-records'),
            transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
            getPermissionMode: () => 'default', setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(publicServices).toBeDefined();
        if (!publicServices) throw new Error('expected public Agent session services');
        expect(Reflect.ownKeys(publicServices)).not.toContain('systemRecords');
        expect(Object.getOwnPropertyDescriptor(publicServices, 'systemRecords')).toBeUndefined();
        expect(Reflect.get(publicServices, 'systemRecords')).toBeUndefined();
        expect(openArgumentCount).toBe(2);
        expect(reflectedWorkflowRecordSymbols).toEqual([]);
        await created.operations.resetOrDisposeRuntime();
    });

    it('publishes only validated compact activity headlines through the bound session, in one write, and fences retired generations', async () => {
        type WorkflowActivityService = Readonly<{
            publishHeadlines(bundle: unknown): Promise<void>;
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
        const agentActivity = createAgentActivityHeadline();
        await expect(workflowActivity.publishHeadlines({
            workflow: {
                ...headline,
                unapprovedDetail: { agents: ['must-not-persist'] },
                activeRuns: headline.activeRuns.map((run) => ({
                    ...run,
                    phases: [{ title: 'must-not-persist' }],
                })),
            },
            agentActivity: {
                ...agentActivity,
                unapprovedDetail: { transcript: ['must-not-persist'] },
                activeEntries: agentActivity.activeEntries.map((entry) => ({
                    ...entry,
                    summary: 'must-not-persist',
                })),
            },
        })).resolves.toBeUndefined();
        expect(session.getMetadataSnapshot()).toMatchObject({
            path: '/tmp/test',
        });
        expect(session.getMetadataSnapshot().sessionWorkflowActivityHeadlineV1).toEqual(headline);
        expect(session.getMetadataSnapshot().sessionAgentActivityHeadlineV1).toEqual(agentActivity);
        expect(JSON.stringify(session.getMetadataSnapshot())).not.toContain('must-not-persist');
        expect(Object.keys(workflowActivity)).toEqual(['publishHeadlines']);
        // BOTH keys landed in ONE metadata mutation: two writes would leave a window in which the
        // two keys describe different worlds.
        expect(updateMetadata).toHaveBeenCalledTimes(1);

        // Fail closed on the WHOLE bundle: a malformed half must not publish the other half, or the
        // two keys stop describing the same snapshots.
        await expect(workflowActivity.publishHeadlines({
            workflow: { ...headline, v: 2 },
            agentActivity,
        })).rejects.toThrow();
        await expect(workflowActivity.publishHeadlines({
            workflow: headline,
            agentActivity: { ...agentActivity, v: 2 },
        })).rejects.toThrow();
        expect(updateMetadata).toHaveBeenCalledTimes(1);
        expect(session.getMetadataSnapshot().sessionWorkflowActivityHeadlineV1).toEqual(headline);
        expect(session.getMetadataSnapshot().sessionAgentActivityHeadlineV1).toEqual(agentActivity);

        current = true;
        updateMetadata.mockImplementationOnce(async (updater) => {
            current = false;
            const beforeRetirement = session.getMetadataSnapshot();
            expect(updater(beforeRetirement)).toBe(beforeRetirement);
        });
        await expect(workflowActivity.publishHeadlines({ workflow: headline, agentActivity }))
            .rejects.toMatchObject({
                name: 'PluginError',
                code: 'plugin_generation_stale',
            });
        expect(updateMetadata).toHaveBeenCalledTimes(2);
        expect(session.getMetadataSnapshot().sessionWorkflowActivityHeadlineV1).toEqual(headline);

        current = false;
        await expect(workflowActivity.publishHeadlines({ workflow: headline, agentActivity }))
            .rejects.toThrow(/retired or unavailable/u);
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
            hasCapability: (capability) => capability === 'terminalHost',
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
        const sessionConnectedAccounts = Object.freeze([Object.freeze({
            purpose: 'primary',
            account: Object.freeze({
                service: Object.freeze({
                    pluginId: 'acme.connected-account',
                    localId: 'credential',
                }),
                accountId: 'account-a',
            }),
        })]);
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
                resolveLateEnvironment: async () => Object.assign({
                    environmentVariables: {},
                    unsetEnvironmentVariables: [],
                    sensitiveEnvironmentVariableNames: [],
                }, { sessionConnectedAccounts }),
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
            mcpServers: {},
            permissionHandler: {
                cancelByPlugin: vi.fn(async () => undefined),
            },
            getPermissionMode: () => 'default',
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
            session: expect.objectContaining({
                id: 'session-direct-controls',
                activity: 'active',
                connectedAccounts: sessionConnectedAccounts,
            }),
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
        expect(disposeHostServices).toHaveBeenCalledOnce();
        expect(redactBugReportSensitiveText(
            `value=${secret}`,
        )).toBe(`value=${secret}`);
    });

    it('settles late launch environment before resume continuation verification and native open', async () => {
        const events: string[] = [];
        const sessionConnectedAccounts = Object.freeze([Object.freeze({
            purpose: 'primary',
            account: Object.freeze({
                service: Object.freeze({
                    pluginId: 'acme.connected-account',
                    localId: 'credential',
                }),
                accountId: 'account-a',
            }),
        })]);
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
                    return Object.assign({
                        environmentVariables: {
                            R490_LATE_ENVIRONMENT: 'settled-before-prepare',
                        },
                        unsetEnvironmentVariables: [],
                        sensitiveEnvironmentVariableNames: [],
                    }, { sessionConnectedAccounts });
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
        expect(verify.mock.calls[0]?.[1]).toMatchObject({
            session: {
                activity: 'inactive',
                connectedAccounts: sessionConnectedAccounts,
            },
        });
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
            connectedAccounts: sessionConnectedAccounts,
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

    it('preserves required continuation refusal when runtime-scope cleanup fails', async () => {
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
            throw new Error('injected runtime-scope cleanup failure');
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

    it('stamps immutable native runtime presentation writes with the runtime invocation owner', async () => {
        let context!: AgentSessionRuntimeContext;
        const agentId = 'acme-native-presentation-owner';
        const contributions = createExternalContributionFixtures(agentId);
        const send = vi.fn(async () => ({ status: 'admitted' as const }));
        const runtimeSession: AgentSessionRuntime = {
            send,
            watch: () => ({ dispose: () => undefined }),
            dispose: vi.fn(async () => undefined),
        };
        const session = createNativeSessionClientTestPort(
            'session-native-presentation-owner',
        );
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: {
                sessions: {
                    open: async (_request, runtimeContext) => {
                        context = runtimeContext;
                        return runtimeSession;
                    },
                },
            },
            lease: {
                ...createLease(agentId),
                immutableGenerationId: 'immutable-generation-native-presentation',
            },
            backend: contributions.backend,
            agent: contributions.agent,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: `/tmp/${agentId}`,
                backendTarget: { kind: 'backend', backendId: agentId },
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }

        const created = await plan.config.createSessionRuntime({
            directory: `/tmp/${agentId}`,
            metadata: {},
            machineId: 'machine-1',
            session,
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        const presentation = context.ui;
        if (!presentation) {
            throw new Error('expected native session presentation service');
        }
        await expect(presentation.status.set('runtime', 'Ready')).resolves.toBeUndefined();
        const presentationState = CurrentSessionPresentationStateV1Schema.parse(
            session.getAgentStateSnapshot()[
                CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY
            ],
        );
        expect(presentationState).toMatchObject({
            statuses: [
                {
                    localKey: 'runtime',
                    text: 'Ready',
                    owner: {
                        pluginId: 'acme.agent-plugin',
                        contributionId: agentId,
                        generationId: 'immutable-generation-native-presentation',
                        invocationId: expect.any(String),
                        sessionId: 'session-native-presentation-owner',
                    },
                },
            ],
        });
        const runtimeIncarnationId = presentationState.statuses[0]?.owner
            .invocationId;
        expect(runtimeIncarnationId).toEqual(expect.any(String));

        await created.operations.sendTurnPrompt('continue', {
            localId: 'native-presentation-owner-input',
        });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            delivery: {
                kind: 'newTurn',
                turnId: `native-turn-${runtimeIncarnationId}-1`,
            },
        }));

        await created.operations.resetOrDisposeRuntime();
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

    it('fans canonical Agent events into Host Events once without coupling producer success', () => {
        let observe!: (event: AgentSessionRuntimeEvent) => void;
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: (listener) => {
                observe = listener;
                return { dispose: () => undefined };
            },
            dispose: vi.fn(),
        };
        const publishHostEvent = vi.fn(() => {
            throw new Error('listener-side host publication failure');
        });
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-host-events',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            publishHostEvent,
        );
        runtime.subscribeRuntimeEvents(() => undefined);
        const event = AgentSessionRuntimeEventSchema.parse({
            sequence: 1,
            sessionId: 'session-host-events',
            emittedAtMs: 2,
            kind: 'runtime-activity-snapshot',
            state: 'idle',
            activeCount: 0,
        });

        expect(() => observe(event)).not.toThrow();
        expect(publishHostEvent).toHaveBeenCalledOnce();
        expect(publishHostEvent).toHaveBeenCalledWith(event);

        const centrallyPublishedEvent = AgentSessionRuntimeEventSchema.parse({
            sequence: 2,
            sessionId: 'session-host-events',
            emittedAtMs: 3,
            kind: 'context-compaction',
            compactionId: 'compact-1',
            phase: 'progress',
            trigger: 'manual',
        });
        expect(() => observe(centrallyPublishedEvent)).not.toThrow();
        expect(publishHostEvent).toHaveBeenCalledOnce();

        const divergentCompactionEvent = AgentSessionRuntimeEventSchema.parse({
            sequence: 3,
            sessionId: 'session-host-events',
            emittedAtMs: 4,
            kind: 'context-compaction',
            compactionId: 'compact-2',
            phase: 'outcomeUnknown',
            trigger: 'manual',
            diagnostic: {
                code: 'compaction_outcome_unknown',
                severity: 'warning',
            },
        });
        expect(() => observe(divergentCompactionEvent)).not.toThrow();
        expect(publishHostEvent).toHaveBeenCalledTimes(2);
        expect(publishHostEvent).toHaveBeenLastCalledWith(expect.objectContaining({
            kind: 'context-compaction',
            compactionId: 'compact-2',
            phase: 'outcomeUnknown',
            diagnostic: {
                code: 'compaction_outcome_unknown',
                severity: 'warning',
            },
        }));
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
            upstream: {
                protocol: 'openai-responses' as const,
                normalizedUrl: 'https://provider.example/v1',
                credential: 'apiKey' as const,
            },
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

    it('projects the bounded VB4 launch without host-owned QA instrumentation into session open', async () => {
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
                    HAPPIER_STACK_TOOL_TRACE: '1',
                    HAPPIER_STACK_TOOL_TRACE_DIR: '/tmp/tool-traces',
                    HAPPIER_STACK_TOOL_TRACE_FILE: '/tmp/tool-trace.jsonl',
                },
                unsetEnvironmentVariables: [
                    'DROP_ME',
                    'HAPPIER_STACK_TOOL_TRACE',
                    'HAPPIER_STACK_TOOL_TRACE_DIR',
                    'HAPPIER_STACK_TOOL_TRACE_FILE',
                ],
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
        const createInvocationServices =
            vi.fn(async () => createUnavailablePluginServices());
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

    it('registers custody before invocation services perform public Provider start and Agent create/open', async () => {
        const agentId = 'acme-runner-bootstrap-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const events: string[] = [];
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => {
            events.push('open');
            return {
                send: vi.fn(async () => ({ status: 'admitted' as const })),
                watch: () => ({ dispose: () => undefined }),
                dispose: vi.fn(),
            };
        });
        const createRuntime = vi.fn(async () => {
            events.push('create-runtime');
            return {
                sessions: { open },
            } satisfies AgentRuntime;
        });
        const createInvocationServices =
            vi.fn(async () => {
                events.push('invocation-services');
                return createUnavailablePluginServices();
            });
        const prepareManagedProviderBinding = vi.fn(async () => null);
        const prepareRuntimeSource = vi.fn(async (input: Readonly<{
            sessionId: string;
            signal: AbortSignal;
        }>) => {
            expect(input.sessionId).toBe('session-runner-bootstrap');
            expect(input.signal.aborted).toBe(false);
            expect(events).toEqual(['late-environment']);
            events.push('prepare-runtime-source');
            expect(createRuntime).not.toHaveBeenCalled();
            expect(createInvocationServices).not.toHaveBeenCalled();
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            createRuntime,
            identity: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            prepareRuntimeSource,
            prepareManagedProviderBinding,
            managedServicesCustodyPort: {
                dispatch: vi.fn(async () => ({
                    v: 1 as const,
                    kind: 'disposed' as const,
                })),
            },
            authorizeNewTurn: vi.fn(async () => ({
                status: 'admitted' as const,
            })),
            createInvocationServices,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-runner-bootstrap-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                resolveLateEnvironment: async (
                    { sessionId }: Readonly<{ sessionId: string }>,
                ) => {
                    expect(sessionId).toBe('session-runner-bootstrap');
                    expect(events).toEqual([]);
                    events.push('late-environment');
                    return {
                        environmentVariables: {
                            FOREGROUND_READY: 'yes',
                        },
                        unsetEnvironmentVariables: [],
                        sensitiveEnvironmentVariableNames: [],
                    };
                },
            }),
        });
        expect(prepareRuntimeSource).not.toHaveBeenCalled();
        expect(createRuntime).not.toHaveBeenCalled();
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }

        const session = createNativeSessionClientTestPort(
            'session-runner-bootstrap',
        );
        const registerHandler =
            session.rpcHandlerManager.registerHandler;
        session.rpcHandlerManager.registerHandler = (
            method: string,
            handler: (input: unknown) => unknown,
        ) => {
            if (method === 'managedServices.custody.v1') {
                events.push('custody-register');
            }
            return registerHandler(method, handler);
        };
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-runner-bootstrap-agent',
            metadata: {},
            machineId: 'machine-1',
            session,
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(prepareRuntimeSource).toHaveBeenCalledOnce();
        expect(createInvocationServices).toHaveBeenCalledWith(
            expect.objectContaining({
                environment: {
                    FOREGROUND_READY: 'yes',
                },
            }),
        );
        expect(prepareManagedProviderBinding).not.toHaveBeenCalled();
        expect(createRuntime).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
        expect(events).toEqual([
            'late-environment',
            'prepare-runtime-source',
            'custody-register',
            'invocation-services',
            'create-runtime',
            'open',
        ]);
        await created.operations.resetOrDisposeRuntime();
    });

    it('defers runner-managed Provider materialization across a non-null late environment until custody preparation', async () => {
        const agentId = 'acme-runner-late-provider-agent';
        const contributions = createExternalContributionFixtures(agentId);
        const metadata = managedProviderBindingMetadata(
            'pc_public_late',
            'provider-model-public-late',
            `backend:${agentId}`,
        );
        const events: string[] = [];
        const expectedFailure = new Error(
            'fixture-managed-provider-prepare-stop',
        );
        const createRuntime = vi.fn(async () => ({
            sessions: {
                open: vi.fn(),
            },
        } satisfies AgentRuntime));
        const createInvocationServices = vi.fn(async () =>
            createUnavailablePluginServices()
        );
        const prepareManagedProviderBinding = vi.fn(async () => {
            events.push('public-provider-prepare');
            throw expectedFailure;
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            createRuntime,
            identity: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            managedServicesCustodyPort: {
                dispatch: vi.fn(async () => ({
                    v: 1 as const,
                    kind: 'disposed' as const,
                })),
            },
            authorizeNewTurn: vi.fn(async () => ({
                status: 'admitted' as const,
            })),
            prepareManagedProviderBinding,
            createInvocationServices,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-runner-late-provider-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                modelSelection: {
                    v: 1,
                    updatedAt: 102,
                    ref: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: 'pc_public_late',
                        modelId: 'provider-model-public-late',
                    },
                },
                resolveLateEnvironment: async () => {
                    events.push('late-environment');
                    return {
                        environmentVariables: {
                            FOREGROUND_READY: 'yes',
                        },
                        unsetEnvironmentVariables: [],
                        sensitiveEnvironmentVariableNames: [],
                    };
                },
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }
        const session = createNativeSessionClientTestPort(
            'session-runner-late-provider',
        );
        const registerHandler = session.rpcHandlerManager.registerHandler;
        session.rpcHandlerManager.registerHandler = (method, handler) => {
            if (method === 'managedServices.custody.v1') {
                events.push('custody-register');
            }
            return registerHandler(method, handler);
        };

        await expect(plan.config.createSessionRuntime({
            directory: '/tmp/acme-runner-late-provider-agent',
            metadata: { providerBindingV1: metadata },
            machineId: 'machine-1',
            session,
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never)).rejects.toBe(expectedFailure);
        expect(events).toEqual([
            'late-environment',
            'custody-register',
            'public-provider-prepare',
        ]);
        expect(prepareManagedProviderBinding).toHaveBeenCalledOnce();
        expect(createInvocationServices).not.toHaveBeenCalled();
        expect(createRuntime).not.toHaveBeenCalled();
    });

    it('keeps the public managed Provider marker through one invocation and native sessions.open', async () => {
        const placeholder =
            'happier_runner_placeholder_AAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const credential = 'runner-owned-secret';
        const agentId = 'acme-runner-public-provider-agent';
        const metadata = managedProviderBindingMetadata(
            'pc_public',
            'provider-model-public',
            `backend:${agentId}`,
        );
        const contributions = createExternalContributionFixtures(agentId);
        const agent = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    providerRequirements: {
                        acceptsProtocols: ['openai-responses'],
                        required: {},
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
                    } satisfies AgentProviderRequirementsV1,
                },
            },
        } satisfies ResolvedAgentContribution;
        const events: string[] = [];
        const transformAgentChildLaunchEnvironment = vi.fn(
            (environment: Readonly<Record<string, string>>) =>
                Object.freeze({
                    ...environment,
                    HAPPIER_PROVIDER_KEY:
                        environment.HAPPIER_PROVIDER_KEY === placeholder
                            ? credential
                            : environment.HAPPIER_PROVIDER_KEY,
                }),
        );
        const cleanup = vi.fn();
        const prepareManagedProviderBinding = vi.fn(async () => {
            events.push('public-provider-prepare');
            return Object.freeze({
                handoff: Object.freeze({
                    v: 1 as const,
                    materialization: Object.freeze({
                        v: 1 as const,
                        kind: 'spawnEnv' as const,
                        env: Object.freeze([Object.freeze({
                            name: 'HAPPIER_PROVIDER_KEY',
                            value: placeholder,
                            source: 'provider' as const,
                        })]),
                    }),
                    sessionBindingMetadata: metadata,
                }),
                environmentOverlay: [Object.freeze({
                    name: 'HAPPIER_PROVIDER_KEY',
                    value: placeholder,
                    source: 'provider' as const,
                })],
                additionalRedactionValues: Object.freeze([]),
                transformAgentChildLaunchEnvironment,
                cleanup,
            });
        });
        const createInvocationServices = vi.fn(async (input) => {
            events.push('invocation-services');
            expect(input.environment.HAPPIER_PROVIDER_KEY)
                .toBe(placeholder);
            expect(JSON.stringify(input)).not.toContain(credential);
            return createUnavailablePluginServices();
        });
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(
            async (request) => {
                events.push('open');
                expect(request.launchEnvironment?.values
                    .HAPPIER_PROVIDER_KEY).toBe(placeholder);
                expect(JSON.stringify(request)).not.toContain(credential);
                return {
                    send: vi.fn(async () => ({ status: 'admitted' as const })),
                    watch: () => ({ dispose: () => undefined }),
                    dispose: vi.fn(),
                };
            },
        );
        const createRuntime = vi.fn(async () => {
            events.push('create-runtime');
            return { sessions: { open } } satisfies AgentRuntime;
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            createRuntime,
            identity: createLease(agentId),
            backend: contributions.backend,
            agent,
            managedServicesCustodyPort: {
                dispatch: vi.fn(async () => ({
                    v: 1 as const,
                    kind: 'disposed' as const,
                })),
            },
            authorizeNewTurn: vi.fn(async () => ({
                status: 'admitted' as const,
            })),
            prepareManagedProviderBinding,
            createInvocationServices,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-runner-public-provider-agent',
                backendTarget: { kind: 'backend', backendId: agentId },
                modelSelection: {
                    v: 1,
                    updatedAt: 102,
                    ref: {
                        agentTargetKey: `backend:${agentId}`,
                        providerConnectionId: 'pc_public',
                        modelId: 'provider-model-public',
                    },
                },
                resolveLateEnvironment: async () => ({
                    environmentVariables: {},
                    unsetEnvironmentVariables: [],
                    sensitiveEnvironmentVariableNames: [],
                }),
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }
        const session = createNativeSessionClientTestPort(
            'session-runner-public-provider',
        );
        const registerHandler = session.rpcHandlerManager.registerHandler;
        session.rpcHandlerManager.registerHandler = (method, handler) => {
            if (method === 'managedServices.custody.v1') {
                events.push('custody-register');
            }
            return registerHandler(method, handler);
        };
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-runner-public-provider-agent',
            metadata: { providerBindingV1: metadata },
            machineId: 'machine-1',
            session,
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(events).toEqual([
            'custody-register',
            'public-provider-prepare',
            'invocation-services',
            'create-runtime',
            'open',
        ]);
        expect(prepareManagedProviderBinding).toHaveBeenCalledOnce();
        expect(createInvocationServices).toHaveBeenCalledOnce();
        expect(transformAgentChildLaunchEnvironment).not.toHaveBeenCalled();
        await created.operations.resetOrDisposeRuntime();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('keeps an authoritative external Provider handoff and never starts runner-managed Provider custody', async () => {
        const agentId = 'acme-runner-direct-provider-agent';
        const agentTargetKey = `backend:${agentId}` as const;
        const contributions = createExternalContributionFixtures(agentId);
        const metadata = externalProviderBindingMetadata(
            'pc_direct',
            'provider-model-direct',
            agentTargetKey,
        );
        const agent = {
            ...contributions.agent,
            richDefinition: {
                ...contributions.agent.richDefinition,
                definition: {
                    ...contributions.agent.richDefinition.definition,
                    providerRequirements:
                        metadata.runtimeBindingBasis.agentSupport,
                },
            },
        } satisfies ResolvedAgentContribution;
        const materialization = Object.freeze({
            v: 1 as const,
            kind: 'engineConfig' as const,
            engineConfig: Object.freeze({
                v: 1,
                modelProvider:
                    'happier_0123456789abcdef0123456789abcdef',
                config: Object.freeze({}),
            }),
        });
        const prepareManagedProviderBinding = vi.fn(async () => {
            throw new Error(
                'runner-managed Provider custody must not start',
            );
        });
        const createInvocationServices = vi.fn(async (input) => {
            expect(input.environment.HAPPIER_CODEX_PROVIDER_API_KEY)
                .toBe('direct-provider-credential');
            expect(input.providerBindingActive).toBe(true);
            return createUnavailablePluginServices();
        });
        const open = vi.fn<AgentSessionRuntimeFactory['open']>(
            async (request) => {
                expect(request.launchEnvironment?.values
                    .HAPPIER_CODEX_PROVIDER_API_KEY)
                    .toBe('direct-provider-credential');
                expect(request.providerBinding).toEqual({
                    connectionId: 'pc_direct',
                    model: {
                        id: 'provider-model-direct',
                        name: 'provider-model-direct',
                    },
                    materialization,
                });
                return {
                    send: vi.fn(async () => ({
                        status: 'admitted' as const,
                    })),
                    watch: () => ({ dispose: () => undefined }),
                    dispose: vi.fn(),
                };
            },
        );
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open } },
            lease: createLease(agentId),
            backend: contributions.backend,
            agent,
            prepareManagedProviderBinding,
            createInvocationServices,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/acme-runner-direct-provider-agent',
                backendTarget: {
                    kind: 'backend',
                    backendId: agentId,
                },
                modelSelection: {
                    v: 1,
                    updatedAt: 102,
                    ref: {
                        agentTargetKey,
                        providerConnectionId: 'pc_direct',
                        modelId: 'provider-model-direct',
                    },
                },
                resolveLateEnvironment: async () => ({
                    environmentVariables: {
                        HAPPIER_CODEX_PROVIDER_API_KEY:
                            'direct-provider-credential',
                        [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
                            serializeProviderBindingLaunchHandoffForEnv(
                                materialization,
                                metadata,
                            ),
                    },
                    unsetEnvironmentVariables: [],
                    sensitiveEnvironmentVariableNames: [],
                }),
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }

        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/acme-runner-direct-provider-agent',
            metadata: { providerBindingV1: metadata },
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort(
                'session-runner-direct-provider',
            ),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);

        expect(prepareManagedProviderBinding).not.toHaveBeenCalled();
        expect(createInvocationServices).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
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
        const createInvocationServices =
            vi.fn(async () => createUnavailablePluginServices());
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

    it('projects session-owned hook, transcript-follow, account-usage, and MCP services with host identity and cancellation', async () => {
        const generationAbortController = new AbortController();
        const followCallerAbortController = new AbortController();
        let followedSignal: AbortSignal | undefined;
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
            recordSnapshot: vi.fn(async () => ({ status: 'recorded' as const })),
            adoptProvisionalRecord: vi.fn(async () => ({
                status: 'adopted' as const,
            })),
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
                            fromRecordId: 'record-1',
                            toRecordId: 'record-2',
                            stableRecordKey: {
                                providerId: 'openai-codex',
                                accountSubjectId: 'acct-1',
                                subjectKind: 'account',
                                quotaScope: 'account',
                            },
                            proof: { kind: 'provider_account_id_match' },
                            observedAtMs: 1,
                        },
                    });
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
            adoption: expect.objectContaining({ providerId: 'openai-codex' }),
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
        await expect(projectedMcp?.resolveServers()).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_generation_stale',
        });
        expect(resolveForSession).not.toHaveBeenCalled();
        await created.operations.resetOrDisposeRuntime();
    });

    it('rejects MCP resolution that settles after the exact session is no longer current', async () => {
        let current = true;
        let settleResolution!: (servers: readonly ResolvedSessionMcpServer[]) => void;
        const resolveForSession = vi.fn(() => new Promise<readonly ResolvedSessionMcpServer[]>((resolve) => {
            settleResolution = resolve;
        }));
        const services = createNativeAgentSessionHostServices({
            owners: Object.freeze({
                ...createSessionHostServiceOwners(),
                mcp: Object.freeze({ resolveForSession }),
            }),
            agentId: 'acme-currentness-agent',
            sessionId: 'currentness-session',
            directory: '/tmp/acme-currentness-agent',
            signal: new AbortController().signal,
            isCurrent: () => current,
            session: {
                sessionId: 'currentness-session',
                updateMetadata: async () => undefined,
                enqueueAgentMessageCommitted: async () => undefined,
            } as never,
            publications: {
                models: Object.freeze({}),
                activeInput: Object.freeze({}),
            } as never,
            readToolExecutionCapability: () => null,
        });

        const pending = services.mcp.resolveServers();
        await Promise.resolve();
        expect(resolveForSession).toHaveBeenCalledWith({
            sessionId: 'currentness-session',
            directory: '/tmp/acme-currentness-agent',
        });

        current = false;
        settleResolution([{
            id: 'remote-tools',
            name: 'Remote tools',
            transport: { kind: 'http', url: 'https://mcp.example.test/tools' },
            scope: {
                sessionId: 'currentness-session',
                directory: '/tmp/acme-currentness-agent',
            },
        }]);

        await expect(pending).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_generation_stale',
        });
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
            if (!capturedContext.current.services.sessions.current) throw new Error('expected the current Session handle');
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
            })).rejects.toMatchObject({
                code: 'plugin_session_media_scope_retired',
            });

            current = true;
            await created.operations.resetOrDisposeRuntime();
            await expect(source.publishGenerated({
                localId: 'native-generated-disposed',
                path: join(sourceRoot, 'disposed.png'),
            })).rejects.toMatchObject({
                code: 'plugin_session_media_scope_retired',
            });
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

    it('awaits PluginServices before opening the real Codex ACP factory', async () => {
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
            const events: string[] = [];
            let finishPreparingServices: (() => void) | null = null;
            const servicesPrepared = new Promise<void>((resolve) => {
                finishPreparingServices = resolve;
            });
            const exec = createStablePluginExecService({
                allowedExecutables: [{
                    kind: 'managedDependency',
                    id: 'codex-acp',
                }],
                signal: generationController.signal,
                isGenerationCurrent: () => !generationController.signal.aborted,
                async resolveExecutable(executable) {
                    expect(executable).toEqual({
                        kind: 'managedDependency',
                        id: 'codex-acp',
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
            const agentId = 'codex';
            const createCodexAgentRuntime =
                await loadRealAgentRuntimeFactory(
                    'packages/plugins/codex/src/agent/runtime/engine.ts',
                    'createCodexAgentRuntime',
                );
            const externalContributions =
                createExternalContributionFixtures(agentId);
            const contributions = {
                backend: {
                    ...externalContributions.backend,
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: 'happier.agent.codex',
                },
                agent: {
                    ...externalContributions.agent,
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    richDefinition: {
                        ...externalContributions.agent.richDefinition!,
                        provenance: 'first_party',
                    },
                    pluginId: 'happier.agent.codex',
                },
            } satisfies Readonly<{
                backend: ResolvedAgentRuntimeContribution;
                agent: ResolvedAgentContribution;
            }>;
            const lease = {
                ...createLease(agentId),
                pluginId: 'happier.agent.codex',
            } satisfies AgentRuntimeRegistrationLease;
            const plan = await createNativeAgentRuntimeSessionPlan({
                createRuntime: async ({ signal }) => {
                    events.push('create-runtime');
                    const runtime = await createCodexAgentRuntime({
                        plugin: {
                            id: 'happier.agent.codex',
                            version: '0.0.0',
                        },
                        agent: { id: agentId },
                        signal,
                    });
                    if (!runtime.sessions) {
                        throw new Error(
                            'Real Codex factory did not expose sessions',
                        );
                    }
                    const sessions = runtime.sessions;
                    return {
                        ...runtime,
                        sessions: {
                            ...sessions,
                            open: async (request, context) => {
                                events.push('open');
                                composedSession =
                                    await sessions.open(request, context);
                                return composedSession;
                            },
                        },
                    };
                },
                authorizeNewTurn: async () => ({
                    status: 'admitted' as const,
                }),
                lease,
                backend: contributions.backend,
                agent: contributions.agent,
                createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
                sessionInput: buildPluginSessionBindingInput({
                    credentials,
                    directory,
                    backendTarget: { kind: 'backend', backendId: agentId },
                    sessionConfigOptionOverrides: {
                        v: 1,
                        updatedAt: 1,
                        overrides: {
                            codexBackendMode: {
                                value: 'acp',
                                updatedAt: 1,
                            },
                        },
                    },
                }),
                createInvocationServices: async () => {
                    events.push('prepare-services');
                    await servicesPrepared;
                    events.push('services-ready');
                    return Object.freeze({
                        ...invocationServices,
                        connectedAccounts: Object.freeze({
                            ...invocationServices.connectedAccounts,
                            getBinding: async () => null,
                            watch: (
                                _purpose: Parameters<
                                    HostPluginServices[
                                        'connectedAccounts'
                                    ]['watch']
                                >[0],
                                listener: Parameters<
                                    HostPluginServices[
                                        'connectedAccounts'
                                    ]['watch']
                                >[1],
                            ): ReturnType<
                                HostPluginServices[
                                    'connectedAccounts'
                                ]['watch']
                            > => {
                                queueMicrotask(() => {
                                    void listener({ kind: 'resync' });
                                });
                                return { dispose: () => undefined };
                            },
                        }),
                        exec,
                    });
                },
                generationSignal: generationController.signal,
            });

            if (!plan.config.createSessionRuntime) throw new Error('expected a session runtime factory');
            const createSession =
                plan.config.createSessionRuntime({
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
            await vi.waitFor(() => {
                expect(events).toEqual(['prepare-services']);
            });
            expect(composedSession).toBeNull();
            const finishServices:
                unknown = finishPreparingServices;
            if (typeof finishServices !== 'function') {
                throw new Error(
                    'Expected PluginServices preparation release',
                );
            }
            finishServices();
            const created = await createSession;

            expect(events).toEqual([
                'prepare-services',
                'services-ready',
                'create-runtime',
                'open',
            ]);
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

    it('awaits PluginServices before opening the real Claude native factory and fails before either effect', async () => {
        const directory = '/tmp/happier-real-claude-runner';
        const events: string[] = [];
        let finishPreparingServices: (() => void) | null = null;
        const servicesPrepared = new Promise<void>((resolve) => {
            finishPreparingServices = resolve;
        });
        const invocationServices = createUnavailablePluginServices();
        const processExit = new Promise<never>(() => undefined);
        const processHandle: PluginProtocolClientHandle<'jsonStream'> = {
            client: {
                async write() {},
                subscribe() {
                    return { dispose: () => undefined };
                },
                async dispose() {},
            },
            process: {
                async write() {},
                async closeStdin() {},
                wait: () => processExit,
                onOutput: () => ({ dispose: () => undefined }),
                async dispose() {},
            },
            wait: () => processExit,
            async dispose() {},
        };
        const agentId = 'claude';
        const createClaudeAgentRuntime =
            await loadRealAgentRuntimeFactory(
                'packages/plugins/claude/src/agent/runtime/nativeRuntime.ts',
                'createClaudeAgentRuntime',
            );
        const externalContributions =
            createExternalContributionFixtures(agentId);
        const contributions = {
            backend: {
                ...externalContributions.backend,
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId: 'happier.agent.claude',
            },
            agent: {
                ...externalContributions.agent,
                provenance: 'first_party',
                source: { kind: 'bundled' },
                richDefinition: {
                    ...externalContributions.agent.richDefinition!,
                    provenance: 'first_party',
                },
                pluginId: 'happier.agent.claude',
            },
        } satisfies Readonly<{
            backend: ResolvedAgentRuntimeContribution;
            agent: ResolvedAgentContribution;
        }>;
        const lease = {
            ...createLease(agentId),
            pluginId: 'happier.agent.claude',
        } satisfies AgentRuntimeRegistrationLease;
        const createRuntime = vi.fn(async ({ signal }: Readonly<{
            signal: AbortSignal;
        }>) => {
            events.push('create-runtime');
            const runtime = await createClaudeAgentRuntime({
                plugin: {
                    id: 'happier.agent.claude',
                    version: '0.0.0',
                },
                agent: { id: agentId },
                signal,
            });
            if (!runtime.sessions) {
                throw new Error(
                    'Real Claude factory did not expose sessions',
                );
            }
            const sessions = runtime.sessions;
            return {
                ...runtime,
                sessions: {
                    ...sessions,
                    open: async (
                        request: Parameters<
                            NonNullable<AgentRuntime['sessions']>['open']
                        >[0],
                        context: Parameters<
                            NonNullable<AgentRuntime['sessions']>['open']
                        >[1],
                    ) => {
                        events.push('open');
                        return await sessions.open(request, context);
                    },
                },
            };
        });
        const buildPlan = async (
            createInvocationServices:
                Parameters<
                    typeof createNativeAgentRuntimeSessionPlan
                >[0]['createInvocationServices'],
        ) => await createNativeAgentRuntimeSessionPlan({
            createRuntime,
            authorizeNewTurn: async () => ({
                status: 'admitted' as const,
            }),
            lease,
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory,
                backendTarget: {
                    kind: 'backend',
                    backendId: agentId,
                },
            }),
            ...(createInvocationServices
                ? { createInvocationServices }
                : {}),
        });
        const plan = await buildPlan(async () => {
            events.push('prepare-services');
            await servicesPrepared;
            events.push('services-ready');
            return Object.freeze({
                ...invocationServices,
                settings: Object.freeze({
                    ...invocationServices.settings,
                    get: async () => null,
                }),
                connectedAccounts: Object.freeze({
                    ...invocationServices.connectedAccounts,
                    getBinding: async () => null,
                    watch: (
                        _purpose: Parameters<
                            HostPluginServices[
                                'connectedAccounts'
                            ]['watch']
                        >[0],
                        listener: Parameters<
                            HostPluginServices[
                                'connectedAccounts'
                            ]['watch']
                        >[1],
                    ): ReturnType<
                        HostPluginServices[
                            'connectedAccounts'
                        ]['watch']
                    > => {
                        queueMicrotask(() => {
                            void listener({ kind: 'resync' });
                        });
                        return { dispose: () => undefined };
                    },
                }),
                exec: Object.freeze({
                    ...invocationServices.exec,
                    systemTools: Object.freeze({
                        resolve: async () => Object.freeze({
                            executable: Object.freeze({
                                kind: 'systemTool' as const,
                                id: 'claude-cli',
                            }),
                            executablePath: '/managed/claude',
                        }),
                    }),
                    // Claude opens only JSON-stream here; keep the generic
                    // protocol-client boundary cast inside this test fixture.
                    clients: Object.freeze({
                        spawn: async () => processHandle,
                    }) as unknown as HostPluginServices['exec']['clients'],
                }),
            });
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }
        const createSession = plan.config.createSessionRuntime({
            directory,
            metadata: {},
            machineId: 'machine-1',
            session: createNativeSessionClientTestPort(
                'host-session-claude',
            ),
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);
        await vi.waitFor(() => {
            expect(events).toEqual(['prepare-services']);
        });
        expect(createRuntime).not.toHaveBeenCalled();
        const finishServices: unknown = finishPreparingServices;
        if (typeof finishServices !== 'function') {
            throw new Error(
                'Expected PluginServices preparation release',
            );
        }
        finishServices();
        const created = await createSession;
        expect(events).toEqual([
            'prepare-services',
            'services-ready',
            'create-runtime',
            'open',
        ]);
        await created.operations.resetOrDisposeRuntime();

        const blockedCreateRuntime = vi.fn(createRuntime);
        const blockedPlan = await createNativeAgentRuntimeSessionPlan({
            createRuntime: blockedCreateRuntime,
            authorizeNewTurn: async () => ({
                status: 'admitted' as const,
            }),
            lease,
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory,
                backendTarget: {
                    kind: 'backend',
                    backendId: agentId,
                },
            }),
            createInvocationServices: async () => {
                throw new Error('PluginServices preparation failed');
            },
        });
        if (!blockedPlan.config.createSessionRuntime) {
            throw new Error('expected a blocked session runtime factory');
        }
        await expect(
            blockedPlan.config.createSessionRuntime({
                directory,
                metadata: {},
                machineId: 'machine-1',
                session: createNativeSessionClientTestPort(
                    'host-session-claude-blocked',
                ),
                transcriptSession: {},
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: {},
                getPermissionMode: () => 'default',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            } as never),
        ).rejects.toThrow('PluginServices preparation failed');
        expect(blockedCreateRuntime).not.toHaveBeenCalled();
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
        const operationServices = createUnavailablePluginServices();
        const currentGlobalExternalSessions = Object.freeze({
            ...operationServices.sessions.external,
        });
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime,
            lease: createLease(agentId),
            backend: contributions.backend,
            agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            createInvocationServices: async (input) => {
                const interactions = createPluginInteractionsService({
                    currentSession: input.session.current,
                    signal: input.signal,
                    isGenerationCurrent: () => true,
                });
                return Object.freeze({
                    ...operationServices,
                    availability: (
                        serviceId: Parameters<HostPluginServices['availability']>[0],
                    ) => (
                        serviceId === 'sessions' || serviceId === 'interactions'
                            ? Object.freeze({ status: 'available' as const })
                            : operationServices.availability(serviceId)
                    ),
                    sessions: Object.freeze({
                        ...operationServices.sessions,
                        external: currentGlobalExternalSessions,
                    }),
                    interactions,
                });
            },
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
        expect(capturedContext.current.services.availability('interactions')).toEqual({ status: 'unavailable' });
        expect(capturedContext.current.services.sessions.subagents.capabilities().observe).toEqual({
            status: 'unavailable',
            code: 'plugin_subagent_durable_custody_unverified',
        });
        await expect(capturedContext.current.services.sessions.subagents.observe({
            observationId: 'worker-1',
            status: 'running',
        })).rejects.toMatchObject({ code: 'plugin_subagent_credentials_unavailable' });
        const publicExternalSessions = hostServices.sessions.external as object;
        expect(publicExternalSessions).toBe(currentGlobalExternalSessions);
        expect(Reflect.ownKeys(publicExternalSessions).sort()).toEqual([
            'attach',
            'capabilities',
            'followTranscript',
            'list',
            'readTranscript',
            'takeover',
        ]);
        for (const methodName of Reflect.ownKeys(publicExternalSessions)) {
            expect(Reflect.get(publicExternalSessions, methodName)).toEqual(expect.any(Function));
        }
        expect(hostServices.sessions.current).not.toBeNull();
        expect(Reflect.get(publicExternalSessions, 'resolveFollowTarget')).toBeUndefined();
        await expect(capturedContext.current.services.interactions.confirm(
            {
                kind: 'confirmation',
                title: 'Continue?',
                message: 'Continue with the operation?',
            },
        )).resolves.toMatchObject({ kind: 'confirmation', status: 'unavailable' });
        expect(handleToolCall).not.toHaveBeenCalled();
        if (!created.nativeRuntime) throw new Error('expected the native session runtime');
        created.nativeRuntime.subscribeRuntimeEvents(() => undefined);
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

    it('keeps the private External Sessions service out of the public Agent context', async () => {
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
        const publicExternalSessions = hostServices.sessions.external as object;
        expect(Reflect.ownKeys(publicExternalSessions).sort()).toEqual([
            'attach',
            'capabilities',
            'followTranscript',
            'list',
            'readTranscript',
            'takeover',
        ]);
        expect(Reflect.get(publicExternalSessions, 'resolveFollowTarget')).toBeUndefined();
        expect(Reflect.get(publicExternalSessions, 'followTranscript')).toEqual(expect.any(Function));
        expect(executeFollow).not.toHaveBeenCalled();
        expect(disposeFollow).not.toHaveBeenCalled();
    });

    it('exposes typed unavailability when no current-session interaction owner exists', async () => {
        const services = createNativeAgentSessionServices({
            permissionHandler: null,
            pluginId: 'acme.plugin',
            contributionId: 'acme-agent',
            runtimeId: 'acme-agent',
            sessionId: 'session-1',
            generationId: 'generation-1',
            isCurrent: () => true,
        });

        expect(services.availability('sessions')).toEqual(expect.objectContaining({ status: 'unavailable' }));
        expect(services.availability('interactions')).toEqual({ status: 'unavailable' });
        expect(services.sessions.current).toBeNull();

        await expect(services.interactions.requestApproval({
            kind: 'approval',
            title: 'Continue?',
            subject: { kind: 'tool', name: 'Continue', input: {} },
        })).resolves.toEqual(expect.objectContaining({
            kind: 'approval',
            status: 'unavailable',
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
            {
                localId: 'input-1',
                turnId: 'turn-1',
                causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1',
                    admittedPermissionCeiling: 'read-only',
                },
            },
        )).resolves.toBeUndefined();
        expect(send).toHaveBeenCalledWith({
            inputIds: ['input-1'],
            input: { text: 'hello' },
            delivery: { kind: 'newTurn', turnId: 'turn-1' },
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
            },
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
            kind: 'provider-session-id',
            providerSessionId: 'provider-session-1',
        })]);
        unsubscribe();
        await runtime.resetOrDisposeRuntime('session_closed');
        expect(disposeRuntimeScope).toHaveBeenCalledOnce();
    });

    it('keeps the host active-turn authority independent when a native plugin mutates its send payload', async () => {
        let readActiveTurnAdmissionWitness:
            (() => NativeAgentNewTurnAdmissionWitness | null)
            | null = null;
        let observedHostAuthority: NativeAgentNewTurnAdmissionWitness['causalPermissionAuthority']
            | null = null;
        const session: AgentSessionRuntime = {
            send: vi.fn(async (request) => {
                if (!request.causalPermissionAuthority) {
                    throw new Error('expected plugin-visible causal authority');
                }
                Object.assign(request.causalPermissionAuthority, {
                    admittedPermissionCeiling: 'yolo' as const,
                });
                observedHostAuthority = readActiveTurnAdmissionWitness?.()
                    ?.causalPermissionAuthority
                    ?? null;
                return { status: 'admitted' as const };
            }),
            watch() {
                return { dispose: () => undefined };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-causal-snapshot',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            undefined,
            undefined,
            (reader) => {
                readActiveTurnAdmissionWitness = reader;
            },
        );

        await expect(runtime.sendTurnPrompt('hello', {
            localId: 'input-causal-snapshot',
            turnId: 'turn-causal-snapshot',
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
            },
        })).resolves.toBeUndefined();

        expect(observedHostAuthority).toEqual({
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'read-only',
        });
        expect(Object.isFrozen(observedHostAuthority)).toBe(true);
    });

    it('replaces the host active-turn authority for steers without sharing plugin payloads or stale authority', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let readActiveTurnAdmissionWitness:
            (() => NativeAgentNewTurnAdmissionWitness | null)
            | null = null;
        const observedHostWitnesses: Array<NativeAgentNewTurnAdmissionWitness | null> = [];
        let sequence = 0;
        const session: AgentSessionRuntime = {
            send: vi.fn<AgentSessionRuntime['send']>(async (request) => {
                if (request.delivery.kind === 'newTurn') {
                    for (const listener of listeners) {
                        listener({
                            sequence: ++sequence,
                            sessionId: 'session-causal-steer-snapshot',
                            emittedAtMs: sequence,
                            kind: 'input-accepted',
                            inputIds: request.inputIds,
                            delivery: request.delivery,
                        });
                        listener({
                            sequence: ++sequence,
                            sessionId: 'session-causal-steer-snapshot',
                            emittedAtMs: sequence,
                            kind: 'turn-start',
                            turnId: request.delivery.turnId,
                            startedBy: 'host',
                        });
                    }
                } else if (request.input.text === 'rejected elevated steer') {
                    return {
                        status: 'unavailable' as const,
                        diagnostic: { code: 'native_steer_unavailable', severity: 'warning' as const },
                        retryable: true,
                    };
                } else {
                    if (request.causalPermissionAuthority) {
                        Object.assign(request.causalPermissionAuthority, {
                            admittedPermissionCeiling: 'yolo' as const,
                        });
                        if (request.causalPermissionAuthority.sourceAuthority) {
                            Object.assign(request.causalPermissionAuthority.sourceAuthority, {
                                mediatorPluginId: 'happier.attacker',
                            });
                        }
                    }
                    observedHostWitnesses.push(readActiveTurnAdmissionWitness?.() ?? null);
                }
                return { status: 'admitted' as const };
            }),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-causal-steer-snapshot',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            undefined,
            undefined,
            (reader) => {
                readActiveTurnAdmissionWitness = reader;
            },
        );

        await runtime.sendTurnPrompt('initial', {
            localId: 'input-causal-steer-initial',
            turnId: 'turn-causal-steer-snapshot',
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'yolo',
            },
        });
        await runtime.steerInFlightTurn('narrowed steer', {
            localId: 'input-causal-steer-narrowed',
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
                sourceAuthority: {
                    kind: 'mediatedExternal',
                    mediatorPluginId: 'happier.channels',
                    sourceRef: 'binding-1',
                    sourceRevisionOrEpoch: 'rev-1',
                    admittedPermissionCeiling: 'read-only',
                    remoteApprovalMaxScope: 'request',
                },
            },
        });
        await expect(runtime.steerInFlightTurn('rejected elevated steer', {
            localId: 'input-causal-steer-rejected',
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'yolo',
            },
        })).rejects.toThrow("rejected steer with status 'unavailable'");
        expect(requireActiveTurnAdmissionWitnessReader(
            readActiveTurnAdmissionWitness,
        )()).toEqual({
            inputId: 'input-causal-steer-narrowed',
            turnId: 'turn-causal-steer-snapshot',
            userMessageSeq: null,
            userMessageSeqs: [],
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
                sourceAuthority: {
                    kind: 'mediatedExternal',
                    mediatorPluginId: 'happier.channels',
                    sourceRef: 'binding-1',
                    sourceRevisionOrEpoch: 'rev-1',
                    admittedPermissionCeiling: 'read-only',
                    remoteApprovalMaxScope: 'request',
                },
            },
        });
        await runtime.steerInFlightTurn('legacy steer without authority', {
            localId: 'input-causal-steer-legacy',
        });

        expect(observedHostWitnesses).toEqual([{
            inputId: 'input-causal-steer-narrowed',
            turnId: 'turn-causal-steer-snapshot',
            userMessageSeq: null,
            userMessageSeqs: [],
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
                sourceAuthority: {
                    kind: 'mediatedExternal',
                    mediatorPluginId: 'happier.channels',
                    sourceRef: 'binding-1',
                    sourceRevisionOrEpoch: 'rev-1',
                    admittedPermissionCeiling: 'read-only',
                    remoteApprovalMaxScope: 'request',
                },
            },
        }, {
            inputId: 'input-causal-steer-legacy',
            turnId: 'turn-causal-steer-snapshot',
            userMessageSeq: null,
            userMessageSeqs: [],
        }]);
        expect(Object.isFrozen(observedHostWitnesses[0])).toBe(true);
        expect(Object.isFrozen(observedHostWitnesses[0]?.causalPermissionAuthority)).toBe(true);
        expect(Object.isFrozen(observedHostWitnesses[0]?.causalPermissionAuthority?.sourceAuthority)).toBe(true);
    });

    it('projects redacted native failure diagnostics into public Host Events and listeners', () => {
        const providerMessageSentinel = 'VOICE_PRIVATE_MESSAGE_SENTINEL: user transcript';
        const providerAdditionalDetailsSentinel = 'VOICE_PRIVATE_DETAILS_SENTINEL: startup instructions';
        const spoofedAgentId = 'SPOOFED_NATIVE_DIAGNOSTIC_AGENT';
        const spoofedAgentTurnId = 'SPOOFED_NATIVE_DIAGNOSTIC_TURN';
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const hostEvents: unknown[] = [];
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-privacy',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            (event) => hostEvents.push(event),
        );
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
        hostEvents.length = 0;

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
                    remediation: { kind: 'retry' },
                    details: {
                        v: 1,
                        source: 'permission_blocked',
                        agentId: spoofedAgentId,
                        agentTurnId: spoofedAgentTurnId,
                        errorClass: 'CodexAppServerTurnFailure',
                        runtimeIssueSource: 'agent_session_error',
                        providerMessage: providerMessageSentinel,
                        providerAdditionalDetails: providerAdditionalDetailsSentinel,
                    },
                },
            });
        }

        const expectedPublicEvents = [{
            sessionId: 'session-privacy',
            emittedAtMs: 7,
            sequence: 2,
            kind: 'turn-failed',
            turnId: 'turn-private',
            diagnostic: {
                code: 'codex_app_server_turn_failed',
                severity: 'error',
                message: 'Codex app-server turn failed.',
                remediation: { kind: 'retry' },
                details: { v: 1, source: 'permission_blocked' },
            },
        }];
        expect(events).toEqual(expectedPublicEvents);
        expect(hostEvents).toEqual(expectedPublicEvents);
        expect(JSON.stringify(events)).not.toContain(providerMessageSentinel);
        expect(JSON.stringify(events)).not.toContain(providerAdditionalDetailsSentinel);
        expect(JSON.stringify(events)).not.toContain(spoofedAgentId);
        expect(JSON.stringify(events)).not.toContain(spoofedAgentTurnId);
        expect(JSON.stringify(hostEvents)).not.toContain(providerMessageSentinel);
        expect(JSON.stringify(hostEvents)).not.toContain(providerAdditionalDetailsSentinel);
        expect(JSON.stringify(hostEvents)).not.toContain(spoofedAgentId);
        expect(JSON.stringify(hostEvents)).not.toContain(spoofedAgentTurnId);
    });

    it('preserves a native session auth diagnostic while stripping spoofed detail fields', () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const runtime = createNativeAgentSessionOperations(session, 'session-auth-source');
        const events: unknown[] = [];
        runtime.subscribeRuntimeEvents((event) => events.push(event));

        for (const listener of listeners) {
            listener({
                sequence: 1,
                sessionId: 'session-auth-source',
                emittedAtMs: 11,
                kind: 'turn-start',
                turnId: 'turn-auth-source',
                startedBy: 'provider',
            });
        }
        events.length = 0;

        for (const listener of listeners) {
            listener({
                sequence: 2,
                sessionId: 'session-auth-source',
                emittedAtMs: 12,
                kind: 'turn-failed',
                turnId: 'turn-auth-source',
                diagnostic: {
                    code: 'native_provider_session_error',
                    severity: 'error',
                    message: 'Token refresh failed: 401',
                    details: {
                        v: 1,
                        source: 'auth_error',
                        agentId: 'SPOOFED_NATIVE_AUTH_AGENT',
                    },
                },
            });
        }

        expect(events).toEqual([expect.objectContaining({
            kind: 'turn-failed',
            turnId: 'turn-auth-source',
            diagnostic: {
                code: 'native_provider_session_error',
                severity: 'error',
                message: 'Token refresh failed: 401',
                details: {
                    v: 1,
                    source: 'auth_error',
                },
            },
        })]);
        expect(JSON.stringify(events)).not.toContain('SPOOFED_NATIVE_AUTH_AGENT');
    });

    it('preserves bounded native diagnostics while redacting private detail bags in public Host Events and listeners', async () => {
        const providerMessageSentinel = 'NATIVE_PRIVATE_MESSAGE_SENTINEL: user transcript';
        const providerAdditionalDetailsSentinel = 'NATIVE_PRIVATE_DETAILS_SENTINEL: startup instructions';
        const spoofedAgentId = 'SPOOFED_NATIVE_DIAGNOSTIC_AGENT';
        const spoofedAgentTurnId = 'SPOOFED_NATIVE_DIAGNOSTIC_TURN';
        type RuntimeDiagnostic = Extract<
            AgentSessionRuntimeEvent,
            { kind: 'turn-failed' }
        >['diagnostic'];

        const privateDiagnostic = (params: Readonly<{
            code: string;
            severity: RuntimeDiagnostic['severity'];
            message: string;
            remediation: NonNullable<RuntimeDiagnostic['remediation']>;
            source: string;
        }>): RuntimeDiagnostic => ({
            code: params.code,
            severity: params.severity,
            message: params.message,
            remediation: params.remediation,
            details: {
                v: 1,
                source: params.source,
                providerMessage: providerMessageSentinel,
                providerAdditionalDetails: providerAdditionalDetailsSentinel,
                agentId: spoofedAgentId,
                agentTurnId: spoofedAgentTurnId,
            },
        });
        const createHarness = (sessionId: string) => {
            const nativeListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
            const session: AgentSessionRuntime = {
                send: vi.fn(async () => ({ status: 'admitted' as const })),
                watch(listener) {
                    nativeListeners.add(listener);
                    return { dispose: () => { nativeListeners.delete(listener); } };
                },
                dispose: vi.fn(),
            };
            const hostEvents: unknown[] = [];
            const listenerEvents: unknown[] = [];
            const runtime = createNativeAgentSessionOperations(
                session,
                sessionId,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                (event) => hostEvents.push(event),
            );
            runtime.subscribeRuntimeEvents((event) => listenerEvents.push(event));
            return {
                runtime,
                hostEvents,
                listenerEvents,
                publish(event: AgentSessionRuntimeEvent): void {
                    for (const listener of nativeListeners) listener(event);
                },
                clear(): void {
                    hostEvents.length = 0;
                    listenerEvents.length = 0;
                },
            };
        };
        const readDiagnostic = (event: AgentSessionRuntimeEvent): RuntimeDiagnostic => {
            switch (event.kind) {
                case 'input-rejected':
                case 'turn-failed':
                    return event.diagnostic;
                case 'input-custody-unknown':
                case 'input-delivery-failed':
                    return event.issue;
                case 'turn-cancelled':
                case 'runtime-ended':
                    if (event.diagnostic) return event.diagnostic;
                    break;
                case 'context-compaction':
                    if ('diagnostic' in event && event.diagnostic) return event.diagnostic;
                    break;
                default:
                    break;
            }
            throw new Error(`expected a diagnostic-bearing event, received '${event.kind}'`);
        };
        const assertProjection = (
            hostEvents: readonly unknown[],
            listenerEvents: readonly unknown[],
            expectedKind: string,
            expected: RuntimeDiagnostic,
            expectedSource: string | null,
        ): void => {
            expect(hostEvents).toEqual(listenerEvents);
            expect(listenerEvents).toHaveLength(1);
            const event = AgentSessionRuntimeEventSchema.parse(listenerEvents[0]);
            expect(event.kind).toBe(expectedKind);
            expect(readDiagnostic(event)).toEqual({
                code: expected.code,
                severity: expected.severity,
                ...(expected.message !== undefined ? { message: expected.message } : {}),
                ...(expected.remediation !== undefined ? { remediation: expected.remediation } : {}),
                ...(expectedSource === null ? {} : { details: { v: 1, source: expectedSource } }),
            });
            const serialized = JSON.stringify({ hostEvents, listenerEvents });
            expect(serialized).not.toContain(providerMessageSentinel);
            expect(serialized).not.toContain(providerAdditionalDetailsSentinel);
            expect(serialized).not.toContain(spoofedAgentId);
            expect(serialized).not.toContain(spoofedAgentTurnId);
        };

        const rejectedDiagnostic = privateDiagnostic({
            code: 'native_input_rejected',
            severity: 'warning',
            message: 'The native runtime rejected the input.',
            remediation: { kind: 'retry' },
            source: 'permission_blocked',
        });
        const rejected = createHarness('session-diagnostic-input-rejected');
        await rejected.runtime.sendTurnPrompt('rejected input', {
            localId: 'input-diagnostic-rejected',
            turnId: 'turn-diagnostic-rejected',
        });
        rejected.clear();
        rejected.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-input-rejected',
            emittedAtMs: 1,
            kind: 'input-rejected',
            inputIds: ['input-diagnostic-rejected'],
            diagnostic: rejectedDiagnostic,
            retryable: true,
        });
        assertProjection(
            rejected.hostEvents,
            rejected.listenerEvents,
            'input-rejected',
            rejectedDiagnostic,
            'permission_blocked',
        );

        const custodyDiagnostic = privateDiagnostic({
            code: 'native_outcome_unknown',
            severity: 'warning',
            message: 'The native runtime cannot confirm input custody.',
            remediation: { kind: 'retry' },
            source: 'unknown',
        });
        const custody = createHarness('session-diagnostic-input-custody');
        await custody.runtime.sendTurnPrompt('uncertain input', {
            localId: 'input-diagnostic-custody',
            turnId: 'turn-diagnostic-custody',
        });
        custody.clear();
        custody.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-input-custody',
            emittedAtMs: 1,
            kind: 'input-custody-unknown',
            inputIds: ['input-diagnostic-custody'],
            issue: custodyDiagnostic,
        });
        assertProjection(
            custody.hostEvents,
            custody.listenerEvents,
            'input-custody-unknown',
            custodyDiagnostic,
            'unknown',
        );

        const deliveryDiagnostic = privateDiagnostic({
            code: 'native_delivery_failed',
            severity: 'error',
            message: 'The native runtime could not deliver the input.',
            remediation: { kind: 'installDependency', dependencyId: 'native-runtime' },
            source: 'dependency_failure',
        });
        const delivery = createHarness('session-diagnostic-input-delivery');
        await delivery.runtime.sendTurnPrompt('failed delivery', {
            localId: 'input-diagnostic-delivery',
            turnId: 'turn-diagnostic-delivery',
        });
        delivery.clear();
        delivery.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-input-delivery',
            emittedAtMs: 1,
            kind: 'input-delivery-failed',
            inputIds: ['input-diagnostic-delivery'],
            delivery: { kind: 'newTurn', turnId: 'turn-diagnostic-delivery' },
            issue: deliveryDiagnostic,
            duplicateRisk: 'possible',
        });
        assertProjection(
            delivery.hostEvents,
            delivery.listenerEvents,
            'input-delivery-failed',
            deliveryDiagnostic,
            'dependency_failure',
        );

        const failedDiagnostic = privateDiagnostic({
            code: 'native_turn_failed',
            severity: 'error',
            message: 'The native turn failed.',
            remediation: { kind: 'retry' },
            source: 'agent_session_error',
        });
        const failed = createHarness('session-diagnostic-turn-failed');
        failed.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-turn-failed',
            emittedAtMs: 1,
            kind: 'turn-start',
            turnId: 'turn-diagnostic-failed',
            startedBy: 'provider',
        });
        failed.clear();
        failed.publish({
            sequence: 2,
            sessionId: 'session-diagnostic-turn-failed',
            emittedAtMs: 2,
            kind: 'turn-failed',
            turnId: 'turn-diagnostic-failed',
            diagnostic: failedDiagnostic,
        });
        assertProjection(
            failed.hostEvents,
            failed.listenerEvents,
            'turn-failed',
            failedDiagnostic,
            'agent_session_error',
        );

        const cancelledDiagnostic = privateDiagnostic({
            code: 'native_turn_cancelled',
            severity: 'warning',
            message: 'The native turn was cancelled.',
            remediation: { kind: 'openUrl', url: 'https://example.test/native-runtime/retry' },
            source: 'stream_error',
        });
        const cancelled = createHarness('session-diagnostic-turn-cancelled');
        cancelled.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-turn-cancelled',
            emittedAtMs: 1,
            kind: 'turn-start',
            turnId: 'turn-diagnostic-cancelled',
            startedBy: 'provider',
        });
        cancelled.clear();
        cancelled.publish({
            sequence: 2,
            sessionId: 'session-diagnostic-turn-cancelled',
            emittedAtMs: 2,
            kind: 'turn-cancelled',
            turnId: 'turn-diagnostic-cancelled',
            cause: 'providerCancelled',
            diagnostic: cancelledDiagnostic,
        });
        assertProjection(
            cancelled.hostEvents,
            cancelled.listenerEvents,
            'turn-cancelled',
            cancelledDiagnostic,
            'stream_error',
        );

        const runtimeEndedDiagnostic = privateDiagnostic({
            code: 'pi_rpc_unexpected_exit',
            severity: 'error',
            message: 'The Pi RPC process exited unexpectedly.',
            remediation: { kind: 'openSettings', path: 'agents.pi.runtime' },
            source: 'agent_process_exit',
        });
        const runtimeEnded = createHarness('session-diagnostic-runtime-ended');
        runtimeEnded.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-runtime-ended',
            emittedAtMs: 1,
            kind: 'runtime-ended',
            cause: 'processExited',
            retryable: false,
            diagnostic: runtimeEndedDiagnostic,
        });
        assertProjection(
            runtimeEnded.hostEvents,
            runtimeEnded.listenerEvents,
            'runtime-ended',
            runtimeEndedDiagnostic,
            'agent_process_exit',
        );

        const compactionFailedDiagnostic = privateDiagnostic({
            code: 'native_compaction_failed',
            severity: 'error',
            message: 'The native compaction failed.',
            remediation: {
                kind: 'selectAccount',
                service: { pluginId: 'happier.agent.native', localId: 'native' },
            },
            source: 'agent_status_error',
        });
        const compactionFailed = createHarness('session-diagnostic-compaction-failed');
        compactionFailed.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-compaction-failed',
            emittedAtMs: 1,
            kind: 'context-compaction',
            compactionId: 'compaction-diagnostic-failed',
            phase: 'failed',
            trigger: 'manual',
            diagnostic: compactionFailedDiagnostic,
        });
        assertProjection(
            compactionFailed.hostEvents,
            compactionFailed.listenerEvents,
            'context-compaction',
            compactionFailedDiagnostic,
            'agent_status_error',
        );

        const compactionCancelledDiagnostic = privateDiagnostic({
            code: 'native_compaction_cancelled',
            severity: 'info',
            message: 'The native compaction was cancelled.',
            remediation: { kind: 'retry' },
            source: 'unbounded_private_source',
        });
        const compactionCancelled = createHarness('session-diagnostic-compaction-cancelled');
        compactionCancelled.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-compaction-cancelled',
            emittedAtMs: 1,
            kind: 'context-compaction',
            compactionId: 'compaction-diagnostic-cancelled',
            phase: 'cancelled',
            trigger: 'manual',
            diagnostic: compactionCancelledDiagnostic,
        });
        assertProjection(
            compactionCancelled.hostEvents,
            compactionCancelled.listenerEvents,
            'context-compaction',
            compactionCancelledDiagnostic,
            null,
        );

        const compactionOutcomeUnknownDiagnostic = privateDiagnostic({
            code: 'native_compaction_outcome_unknown',
            severity: 'warning',
            message: 'The native compaction outcome is unknown.',
            remediation: { kind: 'openSettings', path: 'agents.native.compaction' },
            source: 'unknown',
        });
        const compactionOutcomeUnknown = createHarness('session-diagnostic-compaction-outcome-unknown');
        compactionOutcomeUnknown.publish({
            sequence: 1,
            sessionId: 'session-diagnostic-compaction-outcome-unknown',
            emittedAtMs: 1,
            kind: 'context-compaction',
            compactionId: 'compaction-diagnostic-outcome-unknown',
            phase: 'outcomeUnknown',
            trigger: 'manual',
            diagnostic: compactionOutcomeUnknownDiagnostic,
        });
        assertProjection(
            compactionOutcomeUnknown.hostEvents,
            compactionOutcomeUnknown.listenerEvents,
            'context-compaction',
            compactionOutcomeUnknownDiagnostic,
            'unknown',
        );
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
            canInterruptForPendingInput: () => false,
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
            canInterruptForPendingInput(): boolean;
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
        expect(nativeRuntime.canInterruptForPendingInput()).toBe(false);
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
        activeInputBinding = activeInputService.bind({
            isTurnInFlight: () => true,
            canSteer: () => true,
            onPromptQueued: queued,
            applyPermissionIntentDuringTurn,
            clearTerminalComposer,
            interruptPendingInputAndRun,
        });
        expect(nativeRuntime.canInterruptForPendingInput()).toBe(true);
        activeInputBinding.dispose();
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
            kind: 'provider-session-id',
            providerSessionId: 'provider-session-buffered',
        })]);
    });

    it('projects the native command catalog through the existing slash-command metadata owner', () => {
        const buffered: AgentSessionRuntimeEvent[] = [{
            sequence: 1,
            sessionId: 'session-commands',
            emittedAtMs: 1,
            kind: 'available-commands',
            commands: [
                { name: '/goal', description: 'Set the session goal' },
                { name: 'SKILL:Review' },
            ],
        }];
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                for (const event of buffered.splice(0)) listener(event);
                return { dispose: vi.fn() };
            },
            dispose: vi.fn(),
        };
        const updates: Array<(metadata: Metadata) => Metadata> = [];
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-commands',
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
                updateMetadata: (updater) => { updates.push(updater); },
            },
        );

        runtime.subscribeRuntimeEvents(() => undefined);

        expect(updates).toHaveLength(1);
        expect(runtime.isProviderNativeCommand?.('/goal fix authentication')).toBe(true);
        expect(runtime.isProviderNativeCommand?.('/SKILL:Review')).toBe(true);
        expect(runtime.isProviderNativeCommand?.('/unknown')).toBe(false);
        expect(updates[0]!({
            path: '/tmp/test',
            host: 'test',
            homeDir: '/tmp',
            happyHomeDir: '/tmp/.happier',
            happyLibDir: '/tmp/.happier/lib',
            happyToolsDir: '/tmp/.happier/tools',
        })).toMatchObject({
            slashCommands: ['goal', 'skill:review'],
            slashCommandDetails: [
                { command: 'goal', description: 'Set the session goal' },
                { command: 'skill:review' },
            ],
        });
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
        const runtime = createNativeAgentSessionOperations(
            session,
            'session-checkpoint',
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
                onRollbackBoundary: ({ event, startUserMessageSeq }) => {
                    mutations.push({
                        v: 1,
                        sessionId: 'session-checkpoint',
                        mutationId: `test-rollback-${event.sequence}`,
                        observedAt: event.emittedAtMs,
                        agentId: 'codex',
                        action: 'mark_rollback_eligible',
                        turnId: event.turnId,
                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                        ...(typeof event.agentRollbackOrdinal === 'number'
                            ? { agentRollbackOrdinal: event.agentRollbackOrdinal }
                            : {}),
                        transcriptAnchors: {
                            startUserMessageSeq,
                            ...(event.providerCheckpoint !== undefined
                                ? { providerCheckpoint: event.providerCheckpoint }
                                : {}),
                        },
                    });
                },
            },
        );
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

    it('fences a native runtime-ended fact while preserving its safe issue for the next attempted turn', async () => {
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
                diagnostic: {
                    code: 'pi_rpc_unexpected_exit',
                    severity: 'error',
                    message: 'Pi RPC process exited after authentication failed',
                },
            });
        }

        runtime.beginTurnLifecycle();
        let nextTurnError: unknown;
        try {
            await runtime.sendTurnPrompt(
                'retry after process exit',
                { localId: 'queue-local-after-runtime-ended', turnId: 'turn-after-runtime-ended' },
            );
        } catch (error) {
            nextTurnError = error;
        }

        expect(nextTurnError).toBeInstanceOf(Error);
        expect(nextTurnError).toMatchObject({
            message: expect.stringContaining('agent_session_error'),
        });
        expect((nextTurnError as Error).message).not.toContain('pi_rpc_unexpected_exit');
        expect(classifyPrimarySessionRuntimeIssue({
            cause: 'session_error',
            error: nextTurnError,
            occurredAt: 5,
        })).toMatchObject({
            source: 'agent_session_error',
            occurredAt: 5,
        });
        await expect(runtime.waitForTurnCompletion({ timeoutMs: 25 }))
            .rejects.toBe(nextTurnError);
        expect(eventKinds).toEqual(['input-accepted', 'turn-start', 'turn-complete', 'runtime-ended']);
        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);
        expect(mutations).not.toContainEqual(expect.objectContaining({ action: 'end_session' }));
        expect(session.send).toHaveBeenCalledTimes(1);
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
        const canonicalEvents: Array<{ kind: string; turnId?: string }> = [];
        runtime.subscribeRuntimeEvents((event) => {
            if ('kind' in event) canonicalEvents.push(event);
        });
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
            expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'provider-session-1' });
            expect(warn).toHaveBeenCalledTimes(9);
        } finally {
            warn.mockRestore();
        }
    });

    it('observes canonical Agent tool results once with their correlated accepted input', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const session: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const observeAfter = vi.fn(async () => undefined);
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
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { capability: 'observable', observeAfter },
        );
        runtime.subscribeRuntimeEvents(() => undefined);
        const publish = (event: AgentSessionRuntimeEvent): void => {
            for (const listener of listeners) listener(event);
        };

        publish({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 1,
            kind: 'turn-start',
            turnId: 'turn-1',
            startedBy: 'provider',
        });
        publish({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'tool-call',
            turnId: 'turn-1',
            toolCallId: 'call-1',
            toolName: 'Bash',
            input: { command: 'pwd' },
        });
        publish({
            sequence: 3,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'tool-result',
            turnId: 'turn-1',
            toolCallId: 'call-1',
            output: { stdout: '/workspace' },
        });
        publish({
            sequence: 4,
            sessionId: 'session-1',
            emittedAtMs: 4,
            kind: 'tool-result',
            turnId: 'turn-1',
            toolCallId: 'call-1',
            output: { stdout: 'duplicate' },
        });

        await vi.waitFor(() => expect(observeAfter).toHaveBeenCalledOnce());
        expect(observeAfter).toHaveBeenCalledWith({
            turnId: 'turn-1',
            callId: 'call-1',
            name: 'Bash',
            input: { command: 'pwd' },
            outcome: { status: 'succeeded', result: { stdout: '/workspace' } },
            timestampMs: 3,
        });
        await runtime.resetOrDisposeRuntime('runtime_recovery');
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
        const canonicalEvents: AgentSessionRuntimeEvent[] = [];
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));
        runtime.subscribeRuntimeEvents((event) => {
            if ('kind' in event) canonicalEvents.push(event);
        });

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

    it('restores the preceding steer witness when custody becomes unknown', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let readActiveTurnAdmissionWitness:
            (() => NativeAgentNewTurnAdmissionWitness | null)
            | null = null;
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
            undefined,
            undefined,
            undefined,
            (reader) => {
                readActiveTurnAdmissionWitness = reader;
            },
        );
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await runtime.sendTurnPrompt(
            'start turn before steer',
            {
                localId: 'queue-local-start',
                turnId: 'turn-steer-unknown',
                causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1',
                    admittedPermissionCeiling: 'yolo',
                },
            },
        );
        await expect(runtime.steerInFlightTurn(
            'steer with unknown custody',
            {
                localId: 'queue-local-steer-unknown',
                causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1',
                    admittedPermissionCeiling: 'read-only',
                },
            },
        )).rejects.toThrow("rejected steer with status 'unavailable'");

        expect(send.mock.calls[1]?.[0]).toMatchObject({
            inputIds: ['queue-local-steer-unknown'],
            delivery: { kind: 'steer', turnId: 'turn-steer-unknown' },
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'read-only',
            },
        });

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
        expect(requireActiveTurnAdmissionWitnessReader(
            readActiveTurnAdmissionWitness,
        )()).toEqual({
            inputId: 'queue-local-start',
            turnId: 'turn-steer-unknown',
            userMessageSeq: null,
            userMessageSeqs: [],
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'yolo',
            },
        });
    });

    it('restores the preceding steer witness when native send throws before custody can be observed', async () => {
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        let readActiveTurnAdmissionWitness:
            (() => NativeAgentNewTurnAdmissionWitness | null)
            | null = null;
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
            throw new Error('native steer write lost');
        });
        const session: AgentSessionRuntime = {
            send,
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
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
            undefined,
            undefined,
            undefined,
            (reader) => {
                readActiveTurnAdmissionWitness = reader;
            },
        );
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => deliveryOutcomes.push(outcome));

        await runtime.sendTurnPrompt(
            'start turn before failed steer',
            {
                localId: 'queue-local-steer-throw-start',
                turnId: 'turn-steer-throw',
                causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1',
                    admittedPermissionCeiling: 'yolo',
                },
            },
        );
        await expect(runtime.steerInFlightTurn(
            'steer whose write outcome is unknown',
            {
                localId: 'queue-local-steer-throw',
                causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1',
                    admittedPermissionCeiling: 'read-only',
                },
            },
        )).rejects.toThrow('native steer write lost');

        expect(deliveryOutcomes).toEqual([{
            type: 'input-accepted',
            localId: 'queue-local-steer-throw-start',
            userMessageSeq: null,
            delivery: { kind: 'newTurn', turnId: 'turn-steer-throw' },
        }, {
            type: 'input-custody-unknown',
            localId: 'queue-local-steer-throw',
            userMessageSeq: null,
            issue: { code: 'native_send_outcome_unknown', severity: 'error' },
        }]);
        expect(requireActiveTurnAdmissionWitnessReader(
            readActiveTurnAdmissionWitness,
        )()).toEqual({
            inputId: 'queue-local-steer-throw-start',
            turnId: 'turn-steer-throw',
            userMessageSeq: null,
            userMessageSeqs: [],
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1',
                admittedPermissionCeiling: 'yolo',
            },
        });
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

    it('publishes exact terminal pre-provider evidence when daemon admission is unavailable', async () => {
        const send = vi.fn<AgentSessionRuntime['send']>(async () => ({
            status: 'admitted',
        }));
        const runtime = createNativeAgentSessionOperations(
            {
                send,
                watch: () => ({ dispose: () => undefined }),
                dispose: vi.fn(),
            },
            'session-1',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            undefined,
            async () => {
                throw createNativeAgentSessionEffectBoundaryError(
                    'authority_unavailable_before_effect',
                );
            },
        );
        const deliveryOutcomes: unknown[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => {
            deliveryOutcomes.push(outcome);
        });

        await expect(runtime.sendTurnPrompt(
            'admit me',
            {
                localId: 'queue-local-admission-unavailable',
                turnId: 'turn-admission-unavailable',
                userMessageSeq: 42,
                userMessageSeqs: [42],
            },
        )).rejects.toMatchObject({
            kind: 'authority_unavailable_before_effect',
        });

        expect(deliveryOutcomes).toEqual([{
            type: 'input-rejected-before-provider',
            localId: 'queue-local-admission-unavailable',
            userMessageSeq: 42,
            userMessageSeqs: [42],
            reason: 'provider_unavailable_before_acceptance',
            diagnostic: {
                code: 'daemon_turn_admission_unavailable',
                severity: 'error',
            },
            retryable: true,
            retireLocalCustodyAfterDurableBlock: true,
        }]);
        expect(send).not.toHaveBeenCalled();
    });

    it('aborts in-flight daemon admission and never crosses the Provider boundary after cancellation', async () => {
        const send = vi.fn<AgentSessionRuntime['send']>(async () => ({
            status: 'admitted',
        }));
        const cancel = vi.fn<NonNullable<AgentSessionRuntime['cancel']>>(
            async (request) => ({
                status: 'requested',
                turnId: request.turnId,
            }),
        );
        let admissionSignal: AbortSignal | null = null;
        const authorizeNewTurn = vi.fn(
            async (
                _witness: NativeAgentNewTurnAdmissionWitness,
                options: Readonly<{ signal: AbortSignal }>,
            ) => {
                admissionSignal = options.signal;
                await new Promise<never>((_resolve, reject) => {
                    options.signal.addEventListener(
                        'abort',
                        () => reject(options.signal.reason),
                        { once: true },
                    );
                });
                return { status: 'admitted' as const };
            },
        );
        const runtime = createNativeAgentSessionOperations(
            {
                send,
                cancel,
                watch: () => ({ dispose: () => undefined }),
                dispose: vi.fn(),
            },
            'session-1',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            undefined,
            authorizeNewTurn,
        );
        const sending = runtime.sendTurnPrompt(
            'cancel during admission',
            {
                localId: 'queue-local-admission',
                turnId: 'turn-admission',
            },
        );

        await expect(runtime.cancelTurn()).resolves.toBeUndefined();
        await expect(sending).rejects.toThrow(
            'cancelled before admission',
        );
        expect((admissionSignal as AbortSignal | null)?.aborted)
            .toBe(true);
        expect(send).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
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

    const rejectedStructuredInputCases = [
        ['a non-JSON structured input value', { invalid: undefined }],
    ] as const;

    it.each(rejectedStructuredInputCases)(
        'rejects %s before native new-turn delivery instead of omitting it',
        async (_description, structuredInput) => {
            const send = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
            const session: AgentSessionRuntime = {
                send,
                watch: () => ({ dispose: () => undefined }),
                dispose: vi.fn(),
            };
            const runtime = createNativeAgentSessionOperations(session, 'session-1');

            await expect(runtime.sendTurnPrompt(
                'must not dispatch a silently dropped structured input',
                {
                    localId: 'queue-local-invalid-new-turn',
                    turnId: 'turn-invalid-new-turn',
                    structuredInput,
                } as unknown as RuntimeTurnPromptMeta,
            )).rejects.toThrow();

            expect(send).not.toHaveBeenCalled();
        },
    );

    it.each(rejectedStructuredInputCases)(
        'rejects %s before native steer delivery instead of omitting it',
        async (_description, structuredInput) => {
            const send = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' }));
            const session: AgentSessionRuntime = {
                send,
                watch: () => ({ dispose: () => undefined }),
                dispose: vi.fn(),
            };
            const runtime = createNativeAgentSessionOperations(session, 'session-1');

            await runtime.sendTurnPrompt('start an active turn', {
                localId: 'queue-local-valid-new-turn',
                turnId: 'turn-valid-new-turn',
            });
            await expect(runtime.steerInFlightTurn(
                'must not dispatch a silently dropped structured input',
                {
                    localId: 'queue-local-invalid-steer',
                    structuredInput,
                } as unknown as RuntimeTurnPromptMeta,
            )).rejects.toThrow();

            expect(send).toHaveBeenCalledOnce();
        },
    );
});

describe('native Agent terminal transcript follow admission (ES-PEP-03/ES-PEP-05)', () => {
    type TerminalFollowHarness = Readonly<{
        modeLoop: NonNullable<Awaited<ReturnType<
            NonNullable<Awaited<ReturnType<typeof createNativeAgentRuntimeSessionPlan>>['config']['createSessionRuntime']>
        >>['terminalRemoteModeLoop']>;
        terminalLaunch: ReturnType<typeof vi.fn>;
        executeProviderSessionFollow: ReturnType<typeof vi.fn>;
        executeFollow: ReturnType<typeof vi.fn>;
    }>;

    async function createTerminalFollowHarness(options: Readonly<{
        agentId: string;
        declaresTerminalFollow?: boolean;
        loadCommittedBaseline?: () => Promise<Readonly<{
            localIds: Set<string>;
            complete: boolean;
        }>>;
        providerSessionFollow: (
            request: Readonly<{
                listener: (
                    event: HostExternalTranscriptFollowEvent,
                ) => void | Promise<void>;
            }>,
        ) => Promise<unknown>;
        configuredSources?: readonly unknown[];
        externalSessionProviderOps?: BackendExecutionSurfaces['externalSession'];
        /** Canonical `externalSessionV1` link authority already on the Session. */
        linkedExternalSession?: Readonly<Record<string, unknown>>;
        /** Exact-generation physical follow for a resolved configured target. */
        externalSessionFollow?: (request: Readonly<{
            ref: Readonly<{ agentId: string; sourceId: string; remoteSessionId: string }>;
            source: Readonly<Record<string, unknown>>;
        }>) => Promise<unknown>;
        launch: (request: HostTerminalLaunchRequest) => Promise<unknown>;
    }>): Promise<TerminalFollowHarness> {
        const base = createExternalContributionFixtures(options.agentId);
        // Without `declaresTerminalFollow` the fixture carries no
        // `surfaces.externalSession` at all: the shape of every shipped Agent
        // plugin today, none of which declares terminal follow. With it, the
        // Agent carries the cold `terminalFollow.userRowClassification` opt-in
        // that makes terminal follow a launch precondition (ES-PEP-03/05).
        const agent = options.declaresTerminalFollow
            ? {
                ...base.agent,
                richDefinition: {
                    ...base.agent.richDefinition,
                    definition: {
                        ...base.agent.richDefinition.definition,
                        surfaces: {
                            externalSession: {
                                sources: [{
                                    sourceKind: 'terminal',
                                    terminalFollow: {
                                        userRowClassification: 'explicitV1',
                                    },
                                    schema: {
                                        fields: [{
                                            name: 'kind',
                                            kind: 'literal',
                                            value: 'terminal',
                                        }],
                                    },
                                    key: {
                                        segments: [{
                                            kind: 'literal',
                                            value: 'terminal',
                                        }],
                                    },
                                }],
                            },
                        },
                    },
                },
            } as typeof base.agent
            : options.configuredSources
                ? {
                    ...base.agent,
                    richDefinition: {
                        ...base.agent.richDefinition,
                        definition: {
                            ...base.agent.richDefinition.definition,
                            surfaces: {
                                externalSession: {
                                    sources: options.configuredSources,
                                },
                            },
                        },
                    },
                } as typeof base.agent
                : base.agent;
        const executeProviderSessionFollow = vi.fn(options.providerSessionFollow);
        const executeFollow = vi.fn(
            options.externalSessionFollow
            ?? (async () => ({
                status: 'unavailable' as const,
                code: 'plugin_external_follow_unavailable',
            })),
        );
        const bindSession = vi.fn(() => ({
            executeFollow,
            executeProviderSessionFollow,
            retire: async () => undefined,
        }));
        const open = vi.fn(async () => ({
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener: (event: AgentSessionRuntimeEvent) => void) {
                listener({
                    sequence: 1,
                    sessionId: `session-${options.agentId}`,
                    emittedAtMs: 1,
                    kind: 'provider-session-id',
                    providerSessionId: `provider-${options.agentId}`,
                });
                return { dispose: () => undefined };
            },
            dispose: vi.fn(),
        }));
        const terminalLaunch = vi.fn(options.launch);
        const executionSurfaces: BackendExecutionSurfaces = {
            ...createEmptyBackendExecutionSurfaces(),
            terminalRuntime: { launch: terminalLaunch },
            ...(options.externalSessionProviderOps
                ? { externalSession: options.externalSessionProviderOps }
                : {}),
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: {
                sessions: { open },
                surfaces: {
                    terminal: { resolveLaunch: () => ({ argv: ['--terminal'] }) },
                },
            },
            lease: createLease(options.agentId),
            backend: base.backend,
            agent,
            executionSurfaces,
            externalSessionHostOperations: { bindSession },
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: `/tmp/${options.agentId}`,
                backendTarget: {
                    kind: 'backend',
                    backendId: options.agentId,
                    sourceKind: 'built_in',
                },
            }),
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        } as never);
        if (!plan.config.createSessionRuntime) {
            throw new Error('expected a session runtime factory');
        }
        const sessionMetadata: Record<string, unknown> = {
            terminalRuntime: { promptInteractive: true },
            ...(options.linkedExternalSession
                ? { externalSessionV1: options.linkedExternalSession }
                : {}),
        };
        const sessionPort = createNativeSessionClientTestPort(
            `session-${options.agentId}`,
            {
                fetchCommittedTranscriptLocalIdBaseline:
                    options.loadCommittedBaseline
                    ?? (async () => ({
                        localIds: new Set<string>(),
                        complete: true,
                    })),
                getMetadataSnapshot: () => sessionMetadata,
            },
        );
        const runWithTerminalModelSelection = async <T>(
            effect: (
                selection: null,
                runWithCurrentPublisherPermit: <U>(
                    localEffect: () => Promise<U>,
                ) => Promise<
                    | Readonly<{ status: 'completed'; value: U }>
                    | Readonly<{ status: 'blocked' }>
                >,
            ) => Promise<T>,
        ) => ({
            status: 'completed' as const,
            value: await effect(null, async (localEffect) => ({
                status: 'completed' as const,
                value: await localEffect(),
            })),
        });
        const created = await plan.config.createSessionRuntime({
            directory: `/tmp/${options.agentId}`,
            metadata: sessionMetadata,
            machineId: 'machine-1',
            agentTargetKey: `backend:${options.agentId}`,
            session: sessionPort,
            transcriptSession: {},
            messageQueue: new MessageQueue2<
                { permissionMode: string },
                { text: string }
            >((mode) => mode.permissionMode),
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
            runWithTerminalModelSelection,
        } as never);
        const modeLoop = created.terminalRemoteModeLoop;
        if (!modeLoop) throw new Error('expected a terminal remote mode loop');
        created.operations.subscribeRuntimeEvents(() => undefined);
        await vi.waitFor(() => expect(open).toHaveBeenCalled());
        return { modeLoop, terminalLaunch, executeProviderSessionFollow, executeFollow };
    }

    it('fails a configured Agent closed instead of following through the generic provider-session route', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        try {
            // A contribution whose configured sources cannot materialize — here
            // by exceeding the canonical per-contribution source ceiling — makes
            // the configured External Sessions lifecycle fail construction. That
            // is not "this Agent has no configured source": the generic
            // provider-session route resolves its own follow target through a
            // second Account/materialization route, so it must not silently take
            // over a configured Agent's terminal follow.
            const harness = await createTerminalFollowHarness({
                agentId: 'acme-configured-construction-failure-agent',
                configuredSources: [{
                    sourceKind: 'terminal',
                    schema: {
                        fields: [
                            { name: 'kind', kind: 'literal', value: 'terminal' },
                            { name: 'projectId', kind: 'string' },
                        ],
                    },
                    key: {
                        segments: [
                            { kind: 'literal', value: 'terminal' },
                            { kind: 'field', field: 'projectId' },
                        ],
                    },
                    instances: Array.from({ length: 33 }, (_unused, index) => ({
                        kind: 'default',
                        constants: { projectId: `project-${index}` },
                    })),
                }],
                externalSessionProviderOps: {
                    validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
                    listCandidates: vi.fn(async () => ({ candidates: [], nextCursor: null })),
                    resolveLinkIdentity: vi.fn(async ({ source, remoteSessionId }) => ({
                        source,
                        remoteSessionId,
                    })),
                    pageTranscript: vi.fn(async () => ({
                        items: [],
                        nextCursor: null,
                        tailCursor: null,
                        hasMore: false,
                        truncated: false,
                    })),
                    readAfterTranscript: vi.fn(async () => ({
                        outcome: 'already_current' as const,
                    })),
                } as unknown as BackendExecutionSurfaces['externalSession'],
                providerSessionFollow: async () => ({
                    status: 'following' as const,
                    startingCursor: 'generic-route-must-not-win',
                    subscription: { dispose: async () => undefined },
                }),
                launch: async (request) => {
                    const permitted = await request.runWithCurrentPublisherPermit(
                        async () => ({
                            type: 'control_returned' as const,
                            reason: 'pending_input' as const,
                        }),
                    );
                    if (permitted.status === 'blocked') {
                        throw new HostTerminalModelSelectionBlockedError();
                    }
                    return permitted.value;
                },
            });

            await expect(
                harness.modeLoop.runTerminal({ entry: 'initial' }),
            ).resolves.toEqual({ type: 'switch' });
            expect(harness.executeProviderSessionFollow).not.toHaveBeenCalled();
            expect(harness.executeFollow).not.toHaveBeenCalled();
            // A non-declaring Agent still launches; follow simply degrades.
            expect(harness.terminalLaunch).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('transcript follow'),
                expect.objectContaining({
                    code: 'plugin_external_follow_unavailable',
                }),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('follows a linked Session through its exact bound configured source instead of the configured aggregate', async () => {
        const agentId = 'acme-bound-source-agent';
        // Two configured sources of the same Agent both answer for the terminal's
        // provider session id. Scanning the aggregate makes the Session's own
        // transcript look like an ambiguous identity; the Session already holds
        // an exact source binding from its link authority and must use it.
        const resolveLinkIdentity = vi.fn(async ({ source, remoteSessionId }: Readonly<{
            source: Readonly<Record<string, unknown>>;
            remoteSessionId: string;
        }>) => ({ source, remoteSessionId }));
        const harness = await createTerminalFollowHarness({
            agentId,
            configuredSources: ['terminalAlpha', 'terminalBeta'].map((sourceKind) => ({
                sourceKind,
                terminalFollow: { userRowClassification: 'explicitV1' },
                schema: {
                    fields: [{ name: 'kind', kind: 'literal', value: sourceKind }],
                },
                key: { segments: [{ kind: 'literal', value: sourceKind }] },
                instances: [{ kind: 'default', constants: {} }],
            })),
            linkedExternalSession: {
                v: 1,
                agentId,
                machineId: 'machine-1',
                remoteSessionId: `provider-${agentId}`,
                // Provider-normalized: it carries a canonical field the
                // configured instance never declared, so matching by configured
                // key would not find its entry.
                source: {
                    kind: 'terminalBeta',
                    workspacePath: '/canonical/beta',
                },
                linkedAtMs: 1,
            },
            externalSessionProviderOps: {
                validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
                listCandidates: vi.fn(async () => ({ candidates: [], nextCursor: null })),
                resolveLinkIdentity,
                pageTranscript: vi.fn(async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: null,
                    hasMore: false,
                    truncated: false,
                })),
                readAfterTranscript: vi.fn(async () => ({
                    outcome: 'already_current' as const,
                })),
            } as unknown as BackendExecutionSurfaces['externalSession'],
            externalSessionFollow: async () => ({
                status: 'following' as const,
                startingCursor: 'cursor-bound',
                subscription: { dispose: async () => undefined },
            }),
            providerSessionFollow: async () => ({
                status: 'unavailable' as const,
                code: 'plugin_external_follow_unavailable',
            }),
            launch: async (request) => {
                const permitted = await request.runWithCurrentPublisherPermit(
                    async () => ({
                        type: 'control_returned' as const,
                        reason: 'pending_input' as const,
                    }),
                );
                if (permitted.status === 'blocked') {
                    throw new HostTerminalModelSelectionBlockedError();
                }
                return permitted.value;
            },
        });

        await expect(
            harness.modeLoop.runTerminal({ entry: 'initial' }),
        ).resolves.toEqual({ type: 'switch' });
        expect(harness.executeFollow).toHaveBeenCalledOnce();
        expect(harness.executeFollow).toHaveBeenCalledWith(
            expect.objectContaining({
                ref: expect.objectContaining({
                    agentId,
                    sourceId: 'terminalBeta',
                    remoteSessionId: `provider-${agentId}`,
                }),
                source: expect.objectContaining({ kind: 'terminalBeta' }),
            }),
        );
        // The unbound sibling source is never consulted, so no aggregate scan
        // can report the Session's own transcript as ambiguous.
        expect(resolveLinkIdentity).toHaveBeenCalledOnce();
        expect(resolveLinkIdentity).toHaveBeenCalledWith(
            expect.objectContaining({
                source: expect.objectContaining({ kind: 'terminalBeta' }),
            }),
        );
        expect(harness.executeProviderSessionFollow).not.toHaveBeenCalled();
    });

    it('launches the terminal for a non-declaring Agent when the follow bind reports typed unavailability', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        try {
            const harness = await createTerminalFollowHarness({
                agentId: 'acme-follow-unavailable-agent',
                providerSessionFollow: async () => ({
                    status: 'unavailable' as const,
                    code: 'plugin_external_follow_unavailable',
                }),
                launch: async (request) => {
                    const permitted = await request.runWithCurrentPublisherPermit(
                        async () => ({
                            type: 'control_returned' as const,
                            reason: 'pending_input' as const,
                        }),
                    );
                    if (permitted.status === 'blocked') {
                        throw new HostTerminalModelSelectionBlockedError();
                    }
                    return permitted.value;
                },
            });

            await expect(
                harness.modeLoop.runTerminal({ entry: 'initial' }),
            ).resolves.toEqual({ type: 'switch' });
            expect(harness.executeProviderSessionFollow).toHaveBeenCalledOnce();
            expect(harness.terminalLaunch).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('transcript follow'),
                expect.objectContaining({
                    code: 'plugin_external_follow_unavailable',
                }),
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('keeps a non-declaring Agent terminal running and disposes the binding when follow fails mid-run', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        try {
            const disposeFollow = vi.fn(async () => undefined);
            let reportFollowFailure!: (
                event: HostExternalTranscriptFollowEvent,
            ) => void | Promise<void>;
            let releaseLaunch!: () => void;
            const captured: { launchSignal: AbortSignal | null } = { launchSignal: null };
            const harness = await createTerminalFollowHarness({
                agentId: 'acme-follow-midrun-agent',
                providerSessionFollow: async (request) => {
                    reportFollowFailure = request.listener;
                    return {
                        status: 'following' as const,
                        startingCursor: 'cursor-0',
                        subscription: { dispose: disposeFollow },
                    };
                },
                launch: async (request) => {
                    captured.launchSignal = request.signal ?? null;
                    return await new Promise((resolve) => {
                        releaseLaunch = () => resolve({
                            type: 'control_returned' as const,
                            reason: 'pending_input' as const,
                        });
                    });
                },
            });

            const run = harness.modeLoop.runTerminal({ entry: 'initial' });
            await vi.waitFor(() => expect(harness.terminalLaunch).toHaveBeenCalledOnce());
            await reportFollowFailure({
                kind: 'terminated',
                reason: 'providerFailure',
                cursor: 'cursor-1',
                code: 'plugin_external_follow_provider_failed',
            });
            await vi.waitFor(() => expect(disposeFollow).toHaveBeenCalled());
            expect(captured.launchSignal?.aborted).toBe(false);
            releaseLaunch();
            await expect(run).resolves.toEqual({ type: 'switch' });
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('transcript follow'),
                expect.objectContaining({
                    code: 'plugin_external_follow_provider_failed',
                }),
            );
        } finally {
            warn.mockRestore();
        }
    });

    const followingProviderSession = async () => ({
        status: 'following' as const,
        startingCursor: 'cursor-0',
        subscription: { dispose: async () => undefined },
    });

    it('creates no child when a declaring Agent\'s committed baseline load throws', async () => {
        // ES-PEP-03: a thrown baseline load causes zero follow/tail/launch.
        const harness = await createTerminalFollowHarness({
            agentId: 'acme-follow-barrier-baseline-agent',
            declaresTerminalFollow: true,
            loadCommittedBaseline: async () => {
                throw new Error('committed baseline unavailable');
            },
            providerSessionFollow: followingProviderSession,
            launch: async () => ({
                type: 'control_returned' as const,
                reason: 'pending_input' as const,
            }),
        });

        await expect(
            harness.modeLoop.runTerminal({ entry: 'initial' }),
        ).rejects.toMatchObject({
            name: 'HostTerminalTranscriptFollowAdmissionError',
            code: 'native_agent_terminal_transcript_follow_admission_failed',
            followCode: 'plugin_external_follow_unavailable',
            phase: 'bind',
        });
        expect(harness.executeProviderSessionFollow).not.toHaveBeenCalled();
        expect(harness.terminalLaunch).not.toHaveBeenCalled();
    });

    it('creates no child when a declaring Agent\'s follow bind reports typed unavailability', async () => {
        // ES-PEP-05: `launch()` cannot run before the follow binding is ready.
        const harness = await createTerminalFollowHarness({
            agentId: 'acme-follow-barrier-bind-agent',
            declaresTerminalFollow: true,
            providerSessionFollow: async () => ({
                status: 'unavailable' as const,
                code: 'plugin_external_follow_unavailable',
            }),
            launch: async () => ({
                type: 'control_returned' as const,
                reason: 'pending_input' as const,
            }),
        });

        await expect(
            harness.modeLoop.runTerminal({ entry: 'initial' }),
        ).rejects.toMatchObject({
            name: 'HostTerminalTranscriptFollowAdmissionError',
            followCode: 'plugin_external_follow_unavailable',
            phase: 'bind',
        });
        expect(harness.executeProviderSessionFollow).toHaveBeenCalledOnce();
        expect(harness.terminalLaunch).not.toHaveBeenCalled();
    });

    it('permits an explicit fresh retry after a declaring Agent admission failure', async () => {
        // ES-PEP-03: baseline failure "permits an explicit later retry".
        let baselineFails = true;
        const harness = await createTerminalFollowHarness({
            agentId: 'acme-follow-barrier-retry-agent',
            declaresTerminalFollow: true,
            loadCommittedBaseline: async () => {
                if (baselineFails) throw new Error('committed baseline unavailable');
                return { localIds: new Set<string>(), complete: true };
            },
            providerSessionFollow: followingProviderSession,
            launch: async () => ({
                type: 'control_returned' as const,
                reason: 'pending_input' as const,
            }),
        });

        await expect(
            harness.modeLoop.runTerminal({ entry: 'initial' }),
        ).rejects.toMatchObject({ phase: 'bind' });
        expect(harness.terminalLaunch).not.toHaveBeenCalled();

        baselineFails = false;
        await expect(
            harness.modeLoop.runTerminal({ entry: 'initial' }),
        ).resolves.toEqual({ type: 'switch' });
        expect(harness.executeProviderSessionFollow).toHaveBeenCalledOnce();
        expect(harness.terminalLaunch).toHaveBeenCalledOnce();
    });

    it('races terminal completion and wins with a typed failure when a declaring Agent follow fails mid-run', async () => {
        // ES-PEP-05: "race terminal completion against binding failure".
        let reportFollowFailure!: (
            event: HostExternalTranscriptFollowEvent,
        ) => void | Promise<void>;
        const captured: { launchSignal: AbortSignal | null } = { launchSignal: null };
        const harness = await createTerminalFollowHarness({
            agentId: 'acme-follow-barrier-active-agent',
            declaresTerminalFollow: true,
            providerSessionFollow: async (request) => {
                reportFollowFailure = request.listener;
                return {
                    status: 'following' as const,
                    startingCursor: 'cursor-0',
                    subscription: { dispose: async () => undefined },
                };
            },
            launch: async (request) => {
                captured.launchSignal = request.signal ?? null;
                return await new Promise(() => undefined);
            },
        });

        const run = harness.modeLoop.runTerminal({ entry: 'initial' });
        await vi.waitFor(() => expect(harness.terminalLaunch).toHaveBeenCalledOnce());
        await reportFollowFailure({
            kind: 'terminated',
            reason: 'providerFailure',
            cursor: 'cursor-1',
            code: 'plugin_external_follow_provider_failed',
        });

        await expect(run).rejects.toMatchObject({
            name: 'HostTerminalTranscriptFollowAdmissionError',
            followCode: 'plugin_external_follow_provider_failed',
            phase: 'active',
        });
        // The race is only won if the child actually stops.
        expect(captured.launchSignal?.aborted).toBe(true);
    });

    it('still fails the terminal run when the terminal launch itself fails', async () => {
        const launchFailure = new Error('terminal spawn failed');
        const harness = await createTerminalFollowHarness({
            agentId: 'acme-follow-launch-failure-agent',
            providerSessionFollow: async () => ({
                status: 'unavailable' as const,
                code: 'plugin_external_follow_unavailable',
            }),
            launch: async () => { throw launchFailure; },
        });

        await expect(
            harness.modeLoop.runTerminal({ entry: 'initial' }),
        ).rejects.toBe(launchFailure);
        expect(harness.terminalLaunch).toHaveBeenCalledOnce();
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
