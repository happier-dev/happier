import {
    copyFile,
    cp,
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
    AgentExecutionRunEvent,
    AgentSessionOpenRequest,
    AgentSessionRuntime,
    AgentSessionRuntimeContext,
    AgentSessionRuntimeEvent,
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    createExecutionRunHostBackendFromSessionRuntime,
} from '@happier-dev/plugin-sdk/host/registration';
import type {
    JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
    PluginJsonStreamClient,
    PluginProtocolClientHandle,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { SettingsScopeRef } from '@happier-dev/plugin-sdk/settings';
import { describe, expect, it, vi } from 'vitest';

import {
    readAgentExecutionRunCapabilities,
    readAgentSessionCapabilities,
} from '@/plugins/projection/registry/agentContributionDefinition';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import {
    BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
    BUNDLED_FIRST_PARTY_PLUGIN_METADATA,
} from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';
import { readPluginManifest } from '@/plugins/manifest/read';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import {
    createImmutablePluginGenerationRecordFromSource,
    persistValidatedAgentSessionRunnerFactories,
    prepareImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    composeNativeAgentSessionRuntimeContext,
    createNativeAgentSessionHostServices,
    type NativeAgentSessionHostServiceOwners,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';

import { createAgentSessionRunnerFactoryBinding } from './agentSessionRunnerFactoryBinding';
import { loadRetainedAgentRuntimeLeaf } from './loadRetainedAgentRuntimeLeaf';

const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../..',
);

type UnsequencedSessionEvent<T> = T extends AgentSessionRuntimeEvent
    ? Omit<T, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never;

type TerminalHostService = NonNullable<
    AgentSessionRuntimeContext['session']['services']['terminalHost']
>;
function readAgentRegistration(
    registrations: readonly ContributionRuntimeRegistration[],
    localAgentId: string,
) {
    const registration = registrations.find((candidate) => (
        candidate.family === 'agents' && candidate.localId === localAgentId
    ));
    return registration?.family === 'agents' ? registration.value : null;
}

const ACP_AGENT_IDS = new Set([
    'auggie',
    'codex',
    'copilot',
    'cursor',
    'gemini',
    'grok',
    'kilo',
    'kimi',
    'kiro',
    'ohMyPi',
    'opencode',
    'qwen',
]);

const EXTERNAL_SESSION_AGENT_IDS = new Set([
    'antigravity',
    'claude',
    'codex',
    'ohMyPi',
    'opencode',
    'pi',
]);

function createConfiguration(agentId: string) {
    const option = (value: string) => ({ value, updatedAtMs: 1 });
    return {
        mode: {
            value: agentId === 'codex'
                ? 'acp'
                : agentId === 'antigravity'
                    ? 'cliPrint'
                    : null,
            updatedAtMs: 1,
        },
        model: { value: null, updatedAtMs: 1 },
        permissionIntent: {
            value: 'safe-yolo' as const,
            updatedAtMs: 1,
        },
        options: {
            ...(agentId === 'codex'
                ? { codexBackendMode: option('acp') }
                : {}),
            ...(agentId === 'opencode'
                ? { opencodeBackendMode: option('acp') }
                : {}),
        },
    } satisfies NonNullable<AgentSessionOpenRequest['configuration']>;
}

const createOpenRequest = (
    agentId: string,
    kind: 'create' | 'resume',
): AgentSessionOpenRequest => {
    const configuration = createConfiguration(agentId);
    const launchEnvironment = agentId === 'gemini'
        ? {
            values: { GEMINI_API_KEY: 'matrix-gemini-key' },
            unset: [],
        }
        : undefined;
    return kind === 'create'
        ? {
            kind,
            sessionId: `session-${agentId}-create`,
            cwd: '/workspace',
            configuration,
            ...(launchEnvironment ? { launchEnvironment } : {}),
        }
        : {
            kind,
            sessionId: `session-${agentId}-resume`,
            cwd: '/workspace',
            providerSessionId: `provider-${agentId}`,
            configuration,
            ...(launchEnvironment ? { launchEnvironment } : {}),
        };
};

function createBoundarySession(): AgentSessionRuntime {
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let sequence = 0;
    const publish = (event: UnsequencedSessionEvent<AgentSessionRuntimeEvent>): void => {
        for (const listener of listeners) {
            listener({
                ...event,
                sequence: ++sequence,
                sessionId: 'matrix-boundary-session',
                emittedAtMs: sequence,
            } as AgentSessionRuntimeEvent);
        }
    };
    return {
        send: vi.fn(async (request) => {
            publish({
                kind: 'input-accepted',
                inputIds: request.inputIds,
                delivery: request.delivery,
            });
            publish({
                kind: 'turn-start',
                turnId: request.delivery.turnId,
                startedBy: 'host',
            });
            publish({
                kind: 'turn-complete',
                turnId: request.delivery.turnId,
            });
            return { status: 'admitted' as const };
        }),
        cancel: vi.fn(async ({ turnId }) => ({
            status: 'requested' as const,
            turnId,
        })),
        watch: (listener) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        dispose: vi.fn(async () => undefined),
    };
}

async function exerciseSessionLifecycle(
    session: AgentSessionRuntime,
    suffix: string,
): Promise<void> {
    const turnId = `turn-${suffix}`;
    await expect(session.send({
        inputIds: [`input-${suffix}`],
        input: { text: `hello ${suffix}` },
        delivery: { kind: 'newTurn', turnId },
    })).resolves.toEqual({ status: 'admitted' });
    await expect(session.cancel?.({
        turnId,
        reason: 'user',
    })).resolves.toMatchObject({
        status: 'requested',
        turnId,
    });
    await expect(session.dispose('session_closed')).resolves.toBeUndefined();
}

async function withinMatrixDeadline<T>(
    label: string,
    operation: Promise<T>,
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(
                        `First-party runner matrix timed out at ${label}`,
                    ));
                }, 10_000);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function createMatrixSettingsService(
    values: Readonly<Record<string, JsonValue>> = {},
) {
    const unavailableServices = createUnavailablePluginServices();
    return {
        ...unavailableServices.settings,
        forScope(scope: SettingsScopeRef) {
            return {
                ...unavailableServices.settings.forScope(scope),
                get: async (key: string) => values[key] ?? null,
            };
        },
    };
}

function createAcpBoundaryContext(
    agentId: string,
    sessions: AgentSessionRuntime[],
    hostSessionId: string = `session-${agentId}`,
): AgentSessionRuntimeContext {
    const pluginId = `happier.agent.${agentId.toLowerCase()}`;
    const sessionId = hostSessionId;
    const signal = new AbortController().signal;
    const unavailableServices = createUnavailablePluginServices();
    const owners = Object.freeze({
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
                permissionForwarderScript:
                    '/runtime/permission-forwarder.cjs',
            }),
            createPluginDir: async () => '/tmp/plugin-dir',
            disposePluginDir: async () => undefined,
            publishProviderTranscript: async () => undefined,
        }),
        transcripts: Object.freeze({
            fileFollow: Object.freeze({
                follow: async () => Object.freeze({
                    id: 'matrix-transcript-follow',
                    drainNow: async () => undefined,
                    close: async () => undefined,
                }),
            }),
        }),
        accountUsage: Object.freeze({
            resolveSourceContext: async () => null,
            recordSnapshot: async () => Object.freeze({
                status: 'unavailable' as const,
                reason: 'daemon_unavailable' as const,
            }),
            adoptProvisionalRecord: async () => Object.freeze({
                status: 'unavailable' as const,
                reason: 'daemon_unavailable' as const,
            }),
        }),
        mcp: Object.freeze({
            resolveForSession: async () => Object.freeze([]),
        }),
        toolExecution: Object.freeze({
            before: async (request) => Object.freeze({
                status: 'continue' as const,
                input: request.input,
            }),
            observeAfter: async () => undefined,
        }),
        dispose: async () => undefined,
    }) satisfies NativeAgentSessionHostServiceOwners;
    const sessionServices = createNativeAgentSessionHostServices({
        owners,
        agentId,
        sessionId,
        directory: '/workspace',
        signal,
        isCurrent: () => true,
        session: {
            sessionId,
            updateMetadata: vi.fn(),
            enqueueAgentMessageCommitted: vi.fn(),
        },
        publications: {
            models: Object.freeze({
                bind: () => Object.freeze({ dispose: () => undefined }),
            }),
            activeInput: Object.freeze({
                bind: () => Object.freeze({ dispose: () => undefined }),
                publishStatus: () => undefined,
            }),
        },
        readToolExecutionCapability: () => null,
        toolsDelivery: 'unsupported',
    });
    const services = Object.freeze({
        ...unavailableServices,
        logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        },
        settings: createMatrixSettingsService(),
        connectedAccounts: {
            ...unavailableServices.connectedAccounts,
            getBinding: async () => null,
            materialize: async () => {
                throw new Error(
                    'ACP matrix did not grant a connected account',
                );
            },
            watch: (
                _purpose: string,
                listener: (event: Readonly<{ kind: 'resync' }>) =>
                    void | Promise<void>,
            ) => {
                queueMicrotask(() => {
                    void listener({ kind: 'resync' });
                });
                return { dispose: () => undefined };
            },
        },
        exec: {
            ...unavailableServices.exec,
            run: async () => ({
                termination: {
                    observed: {
                        kind: 'exit' as const,
                        exitCode: 0,
                    },
                    requestedBy: { kind: 'none' as const },
                },
                stdout: new TextEncoder().encode('--acp'),
                stderr: new Uint8Array(),
                stdoutTruncated: false,
                stderrTruncated: false,
            }),
        },
    });
    return composeNativeAgentSessionRuntimeContext({
        identity: {
            pluginId,
            pluginVersion: '0.0.0',
            agentId,
        },
        contributionId: agentId,
        invokedAtMs: 1,
        sessionId,
        signal,
        services,
        sessionServices,
        ui: undefined,
        protocols: Object.freeze({
            acp: {
                open: async () => {
                    const session = createBoundarySession();
                    sessions.push(session);
                    return session;
                },
            },
        }),
        workState: {
            publisher: () => ({
                publish: async () => ({
                    status: 'unavailable' as const,
                    diagnostic: {
                        code: 'matrix_work_state_unavailable',
                        severity: 'info' as const,
                    },
                }),
            }),
        },
    });
}

function createAntigravityExecBoundaryContext(input: Readonly<{
    hostSessionId: string;
}>): Readonly<{
    context: AgentSessionRuntimeContext;
    runStarted: Promise<void>;
}> {
    const unavailableServices = createUnavailablePluginServices();
    let markRunStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolveStarted) => {
        markRunStarted = resolveStarted;
    });
    const context = {
        plugin: {
            id: 'happier.agent.antigravity',
            version: '0.0.0',
        },
        contribution: {
            id: 'antigravity',
            qualifiedId:
                'happier.agent.antigravity/agents/antigravity',
        },
        surface: 'agent',
        signal: new AbortController().signal,
        services: {
            ...unavailableServices,
            connectedAccounts: {
                ...unavailableServices.connectedAccounts,
                getBinding: async () => null,
                watch: (
                    _purpose: Parameters<
                        typeof unavailableServices.connectedAccounts.watch
                    >[0],
                    listener: Parameters<
                        typeof unavailableServices.connectedAccounts.watch
                    >[1],
                ): ReturnType<
                    typeof unavailableServices.connectedAccounts.watch
                > => {
                    queueMicrotask(() => {
                        void listener({ kind: 'resync' });
                    });
                    return { dispose: () => undefined };
                },
            },
            exec: {
                ...unavailableServices.exec,
                systemTools: {
                    resolve: async () => ({
                        executable: {
                            kind: 'systemTool' as const,
                            id: 'antigravity-cli',
                        },
                        executablePath: '/managed/antigravity',
                    }),
                },
                run: async (
                    _request: unknown,
                    options?: Readonly<{ signal?: AbortSignal }>,
                ) => {
                    markRunStarted?.();
                    return await new Promise<never>((_resolve, reject) => {
                        options?.signal?.addEventListener('abort', () => {
                            const error = new Error(
                                'Antigravity boundary run cancelled',
                            );
                            Object.assign(error, {
                                code: 'antigravity_cliprint_cancelled',
                            });
                            reject(error);
                        }, { once: true });
                    });
                },
            },
        },
        ui: {},
        agent: { id: 'antigravity' },
        protocols: {
            acp: {
                open: async () => {
                    throw new Error('Antigravity is not ACP');
                },
            },
        },
        session: { id: input.hostSessionId, services: {} },
        workState: {},
    } as unknown as AgentSessionRuntimeContext;
    return { context, runStarted };
}

async function exerciseAntigravitySessionLifecycle(
    session: AgentSessionRuntime,
    runStarted: Promise<void>,
    suffix: string,
): Promise<void> {
    const turnId = `turn-${suffix}`;
    const send = session.send({
        inputIds: [`input-${suffix}`],
        input: { text: `hello ${suffix}` },
        delivery: { kind: 'newTurn', turnId },
    });
    await runStarted;
    await expect(session.cancel?.({
        turnId,
        reason: 'user',
    })).resolves.toEqual({
        status: 'requested',
        turnId,
    });
    await expect(send).resolves.toMatchObject({
        status: 'unavailable',
        retryable: true,
    });
    await expect(session.dispose('session_closed')).resolves.toBeUndefined();
}

function createClaudeExecBoundaryContext(input: Readonly<{
    hostSessionId: string;
}>): AgentSessionRuntimeContext {
    const processExit =
        new Promise<
            Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>
        >(() => undefined);
    const handle: PluginProtocolClientHandle<'jsonStream'> = {
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
    return {
        plugin: {
            id: 'happier.agent.claude',
            version: '0.0.0',
        },
        contribution: {
            id: 'claude',
            qualifiedId: 'happier.agent.claude/agents/claude',
        },
        surface: 'agent',
        signal: new AbortController().signal,
        services: {
            logger: {
                debug: () => undefined,
                info: () => undefined,
                warn: () => undefined,
                error: () => undefined,
            },
            settings: createMatrixSettingsService({
                claudeUnifiedTerminalEnabled: true,
            }),
            storage: {
                session: {
                    get: async () => null,
                    set: async () => undefined,
                },
            },
            connectedAccounts: {
                getBinding: async () => null,
                materialize: async () => {
                    throw new Error(
                        'Claude matrix did not grant a connected account',
                    );
                },
                requestSelection: async () => ({
                    status: 'cancelled' as const,
                }),
                watch: (
                    _purpose: string,
                    listener: (event: Readonly<{ kind: 'resync' }>) =>
                        void | Promise<void>,
                ) => {
                    queueMicrotask(() => {
                        void listener({ kind: 'resync' });
                    });
                    return { dispose: () => undefined };
                },
            },
            exec: {
                systemTools: {
                    resolve: async () => ({
                        executable: {
                            kind: 'systemTool' as const,
                            id: 'claude-cli',
                        },
                        executablePath: '/managed/claude',
                    }),
                },
                clients: {
                    spawn: async () => handle,
                },
            },
        },
        ui: {
            confirm: async () => false,
        },
        agent: { id: 'claude' },
        protocols: {
            acp: {
                open: async () => {
                    throw new Error('Claude is not ACP');
                },
            },
        },
        session: {
            id: input.hostSessionId,
            services: {
                features: {
                    isEnabled: (featureId: string) =>
                        featureId === 'agents.claude.unifiedTerminal',
                },
                terminalHost: {
                    resolve: async () => ({
                        status: 'resolved' as const,
                        hostKind: 'zellij' as const,
                        reason: 'zellij_forced' as const,
                    }),
                    createOrAttachHost: async () => ({
                        kind: 'zellij' as const,
                        sessionName:
                            `matrix-${input.hostSessionId}`,
                        paneId: 'pane-1',
                        attachMetadata: {
                            attachStrategy: 'terminal_host' as const,
                            topology: 'exclusive' as const,
                            locality: 'same_machine' as const,
                            maxClients: null,
                            requiresLocalAttachmentInfo: true,
                            liveProbe: 'required' as const,
                        },
                    }),
                    injectUserPrompt: async (
                        _handle: Parameters<
                            TerminalHostService['injectUserPrompt']
                        >[0],
                        prompt: Parameters<
                            TerminalHostService['injectUserPrompt']
                        >[1],
                    ) => ({
                        status: 'injected' as const,
                        injectedAt: 123,
                        bytesWritten: prompt.text.length,
                        hostKind: 'zellij' as const,
                        hostSessionName:
                            `matrix-${input.hostSessionId}`,
                        paneId: 'pane-1',
                    }),
                    interruptTurn: async () => undefined,
                    evaluateLiveness: async () => ({
                        paneAlive: true,
                        observedAt: 100,
                    }),
                    captureInputState: async () => ({
                        stable: true,
                        currentInput: 'What would you like to work on?',
                        observedAt: 101,
                    }),
                    controlPort: async () => null,
                    dispose: async () => undefined,
                },
                activeInput: {
                    bind: () => ({ dispose: () => undefined }),
                },
                models: {
                    bind: () => ({ dispose: () => undefined }),
                },
                sessionHooks: {
                    startServer: async () => ({
                        port: 43123,
                        sessionHookSecretFile:
                            '/tmp/happier-matrix-session.secret',
                        permissionHookSecretFile:
                            '/tmp/happier-matrix-permission.secret',
                        stop: () => undefined,
                        dispose: async () => undefined,
                    }),
                    resolveForwarderAssets: async () => ({
                        nodeExecutable: '/managed/node',
                        sessionForwarderScript:
                            '/managed/session-forwarder.cjs',
                        permissionForwarderScript:
                            '/managed/permission-forwarder.cjs',
                    }),
                    createPluginDir: async () =>
                        '/tmp/happier-matrix-claude-plugin',
                    disposePluginDir: async () => undefined,
                    publishProviderTranscript: async () => undefined,
                },
                transcripts: {
                    fileFollow: {
                        follow: async () => ({
                            id: 'matrix-transcript-follow',
                            drainNow: async () => undefined,
                            close: async () => undefined,
                        }),
                    },
                },
                accountUsage: {
                    resolveSourceContext: async () => null,
                    recordSnapshot: async () => ({
                        status: 'recorded' as const,
                        recordId: 'matrix-usage',
                    }),
                },
                auth: {
                    refreshRuntimeAuth: async () => ({
                        status: 'unavailable' as const,
                    }),
                },
                systemRecords: {
                    read: async () => null,
                    write: async () => undefined,
                },
                workflowActivity: {
                    publishHeadlines: async () => undefined,
                },
            },
        },
        workState: {
            publisher: () => ({
                publish: async () => undefined,
            }),
        },
    } as unknown as AgentSessionRuntimeContext;
}

function createPiExecBoundaryContext(input: Readonly<{
    hostSessionId: string;
    resumeProviderSessionId?: string;
}>): AgentSessionRuntimeContext {
    const baseContext = createAcpBoundaryContext('pi', [], input.hostSessionId);
    let listener:
        ((record: JsonValue) => void | Promise<void>)
        | undefined;
    let providerSessionId = input.resumeProviderSessionId ?? null;
    const isJsonObject = (
        value: unknown,
    ): value is Readonly<Record<string, JsonValue>> => (
        value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
    );
    const client: PluginJsonStreamClient = {
        async write(value) {
            if (
                !isJsonObject(value)
                || typeof value.id !== 'string'
                || typeof value.type !== 'string'
            ) {
                throw new Error('Pi boundary received an invalid RPC command');
            }
            if (value.type === 'new_session') {
                providerSessionId = `provider-${input.hostSessionId}`;
            }
            const response = {
                type: 'response',
                id: value.id,
                command: value.type,
                success: true,
                ...(value.type === 'get_state'
                    ? { data: { sessionId: providerSessionId } }
                    : {}),
            } satisfies JsonValue;
            queueMicrotask(() => {
                void listener?.(response);
            });
        },
        subscribe(next) {
            listener = next;
            return {
                dispose: () => {
                    if (listener === next) listener = undefined;
                },
            };
        },
        async dispose() {},
    };
    const processExit =
        new Promise<
            Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>
        >(() => undefined);
    const handle: PluginProtocolClientHandle<'jsonStream'> = {
        client,
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
    return Object.freeze({
        ...baseContext,
        services: Object.freeze({
            ...baseContext.services,
            logger: {
                ...baseContext.services.logger,
                debug: () => undefined,
                info: () => undefined,
                warn: () => undefined,
                error: () => undefined,
            },
            connectedAccounts: {
                ...baseContext.services.connectedAccounts,
                getBinding: async () => null,
                watch: (
                    _purpose: Parameters<
                        typeof baseContext.services.connectedAccounts.watch
                    >[0],
                    connectedAccountListener: Parameters<
                        typeof baseContext.services.connectedAccounts.watch
                    >[1],
                ): ReturnType<
                    typeof baseContext.services.connectedAccounts.watch
                > => {
                    queueMicrotask(() => {
                        void connectedAccountListener({ kind: 'resync' });
                    });
                    return { dispose: () => undefined };
                },
            },
            exec: {
                ...baseContext.services.exec,
                systemTools: {
                    resolve: async () => ({
                        executable: {
                            kind: 'systemTool' as const,
                            id: 'pi-cli',
                        },
                        executablePath: '/managed/pi',
                    }),
                },
                clients: {
                    spawn: async () => handle,
                },
            },
        }),
        protocols: {
            ...baseContext.protocols,
            acp: {
                open: async () => {
                    throw new Error('Pi is not ACP');
                },
            },
        },
    });
}

describe('first-party runner Agent factory matrix', () => {
    it('loads every real Session runtime through its retained generation binding', async () => {
        const happyHomeDir = await mkdtemp(
            resolve(repoRoot, '.happier-first-party-runner-matrix-'),
        );
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const contributes = createResolvedContributionRegistry(
            resolveBuiltInContributions(),
        );
        const sessionAgents = contributes.agents
            .filter((entry) => readAgentSessionCapabilities(
                entry.richDefinition?.definition,
            ) !== null)
            .sort((left, right) => left.id.localeCompare(right.id));

        expect(sessionAgents.map((entry) => entry.id)).toEqual([
            'antigravity',
            'auggie',
            'claude',
            'codex',
            'copilot',
            'cursor',
            'gemini',
            'grok',
            'kilo',
            'kimi',
            'kiro',
            'ohMyPi',
            'opencode',
            'pi',
            'qwen',
        ]);

        const loadedByAgentId = new Map<string, AgentRuntimeFactory>();
        try {
            for (const agent of sessionAgents) {
                const pluginId = agent.pluginId;
                const localAgentId = agent.identity?.localId;
                if (!pluginId || !localAgentId) {
                    throw new Error(
                        `Missing canonical contribution identity for '${agent.id}'`,
                    );
                }
                const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(
                    (entry) => entry.pluginId === pluginId,
                );
                const bundledLocator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
                    (entry) => entry.pluginId === pluginId,
                );
                if (!metadata || !bundledLocator?.daemonEntryPath) {
                    throw new Error(
                        `Missing bundled source locator for '${agent.id}'`,
                    );
                }
                const packageRoot = resolve(
                    repoRoot,
                    'packages',
                    'plugins',
                    metadata.pluginPackageId,
                );
                const stagedSourceRoot = resolve(
                    happyHomeDir,
                    'fixture-sources',
                    metadata.pluginPackageId,
                );
                await mkdir(stagedSourceRoot, { recursive: true });
                await copyFile(
                    resolve(packageRoot, 'package.json'),
                    resolve(stagedSourceRoot, 'package.json'),
                );
                await mkdir(
                    resolve(stagedSourceRoot, '.happier-plugin'),
                    { recursive: true },
                );
                await writeFile(
                    resolve(
                        stagedSourceRoot,
                        '.happier-plugin',
                        'plugin.json',
                    ),
                    JSON.stringify(bundledLocator.manifest),
                    'utf8',
                );
                await cp(
                    resolve(packageRoot, 'src'),
                    resolve(stagedSourceRoot, 'src'),
                    { recursive: true },
                );
                const packageLocalZod = resolve(
                    packageRoot,
                    'node_modules',
                    'zod',
                );
                if (existsSync(packageLocalZod)) {
                    await cp(
                        packageLocalZod,
                        resolve(stagedSourceRoot, 'node_modules', 'zod'),
                        { recursive: true },
                    );
                }
                const generated = await createImmutablePluginGenerationRecordFromSource({
                    pluginId,
                    sourceRootPath: stagedSourceRoot,
                    manifestRelativePath:
                        '.happier-plugin/plugin.json',
                    distribution: {
                        kind: 'localPath',
                        canonicalPath: stagedSourceRoot,
                    },
                    updatePolicy: 'manual',
                    createdAtMs: 1,
                });
                const prepared = await prepareImmutablePluginGeneration({
                    paths,
                    sourceRootPath: stagedSourceRoot,
                    record: generated,
                });
                const immutableManifest = await readPluginManifest({ sourceProvenance: 'localSource',
                    manifestPath: resolve(
                        prepared.rootPath,
                        '.happier-plugin',
                        'plugin.json',
                    ),
                    manifestAuthority: 'bundled_first_party',
                    enforceEngineCompatibility: false,
                });
                if (!immutableManifest.ok) {
                    throw new Error(
                        `Invalid immutable manifest for '${agent.id}': ${
                            JSON.stringify(immutableManifest.diagnostics)
                        }`,
                    );
                }
                expect(immutableManifest.manifest.id, agent.id)
                    .toBe(pluginId);
                expect(
                    immutableManifest.manifest.contributes.agents.some(
                        (candidate) => candidate.id === localAgentId,
                    ),
                    agent.id,
                ).toBe(true);
                const resolveActivationSource =
                    createBundledActivationSourceResolver({
                        bundledPackageNames: [metadata.packageName],
                        repoRoot,
                    });
                const source = resolveActivationSource({
                    pluginId,
                    daemonEntryPath: bundledLocator.daemonEntryPath,
                });
                if (!source) {
                    throw new Error(
                        `Missing bundled activation source for '${agent.id}'`,
                    );
                }
                const module = await source.load();
                const activation = await activateContributionModule({
                    pluginId,
                    manifestAuthority: 'bundled_first_party',
                    generation: generated.immutableGenerationId,
                    manifest: immutableManifest.manifest,
                    moduleNamespace: module,
                    isGenerationCurrent: () => true,
                    resolveRelativeModule: source.resolveRelativeModule,
                });
                if (activation.status !== 'active') {
                    throw new Error(
                        `Failed to activate bundled plugin '${agent.id}': ${
                            JSON.stringify(activation.diagnostics)
                        }`,
                    );
                }
                try {
                    const registration = readAgentRegistration(
                        activation.registrations,
                        localAgentId,
                    );
                    if (agent.id === 'kiro') {
                        expect(registration?.factory).toBeUndefined();
                        expect(registration?.sessionRunnerFactory).toBeUndefined();
                        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
                            happyHomeDir,
                            contributes: createResolvedContributionRegistry({
                                agents: [agent],
                                activationTargets: [],
                            }),
                            generation: 1,
                            generationAuthority: {
                                commit: null,
                                generations: new Map([[pluginId, {
                                    pluginId,
                                    immutableGenerationId: generated.immutableGenerationId,
                                    rootPath: prepared.rootPath,
                                    record: generated,
                                }]]),
                                rejectedGenerations: new Map(),
                                unavailableBundledPackageNames: new Set(),
                                isCurrent: async () => true,
                            },
                        });
                        try {
                            const lease = runtimeRegistry.agentRuntimesByAgentId.get(agent.id);
                            if (!lease?.hasPrimaryRuntime) {
                                throw new Error('Kiro declarative ACP runtime was not synthesized by the host');
                            }
                            expect(lease.sessionRunnerFactoryBinding).toMatchObject({
                                kind: 'host_declarative_acp_v1',
                                pluginId,
                                localAgentId,
                                immutableGenerationId: generated.immutableGenerationId,
                            });
                            const runtime = await lease.createRuntime({
                                signal: new AbortController().signal,
                            });
                            expect(runtime.sessions).toBeDefined();
                            expect(runtime.executionRuns).toBeUndefined();

                            const boundarySessions: AgentSessionRuntime[] = [];
                            const context = createAcpBoundaryContext(agent.id, boundarySessions);
                            const session = await runtime.sessions!.open(
                                createOpenRequest(agent.id, 'create'),
                                context,
                            );
                            await exerciseSessionLifecycle(session, 'kiro-declarative-session');

                            const run = await createExecutionRunHostBackendFromSessionRuntime({
                                request: {
                                    kind: 'create',
                                    runId: 'kiro-host-derived-run',
                                    cwd: '/workspace',
                                    profile: { pluginId, localId: localAgentId },
                                    input: { text: 'hello from the host-derived Run' },
                                },
                                sessionId: 'kiro-host-derived-run',
                                openSession: async (request) => await runtime.sessions!.open(
                                    request,
                                    context,
                                ),
                            });
                            const runEvents: AgentExecutionRunEvent[] = [];
                            const runWatch = run.watch((event) => runEvents.push(event));
                            try {
                                expect(runEvents.map((event) => event.kind)).toContain('run-start');
                                expect(runEvents.map((event) => event.kind)).toContain('run-complete');
                                expect(boundarySessions).toHaveLength(2);
                            } finally {
                                runWatch.dispose();
                                await run.dispose();
                            }
                        } finally {
                            await runtimeRegistry.dispose();
                        }
                        continue;
                    }
                    const locator = registration?.sessionRunnerFactory;
                    const registeredFactory = registration?.factory;
                    if (!locator || !registeredFactory) {
                        throw new Error(
                            `Missing session runner registration for '${agent.id}'`,
                        );
                    }
                    const resolution = await source.resolveRelativeModule(
                        locator.module,
                    );
                    expect(
                        resolution.module[locator.export],
                        agent.id,
                    ).toBe(registeredFactory);
                    if (EXTERNAL_SESSION_AGENT_IDS.has(agent.id)) {
                        expect(
                            locator.externalSessionsExport,
                            agent.id,
                        ).toBeTypeOf('string');
                        if (!registration.externalSessions) {
                            throw new Error(
                                `Missing External Sessions companion for '${agent.id}'`,
                            );
                        }
                    } else {
                        expect(
                            locator.externalSessionsExport,
                            agent.id,
                        ).toBeUndefined();
                    }
                    await persistValidatedAgentSessionRunnerFactories({
                        paths,
                        record: generated,
                        manifestAuthority: 'bundled_first_party',
                        factories: [{
                            localAgentId,
                            locator,
                            normalizedModulePath:
                                resolution.normalizedModulePath,
                            loadMode: resolution.loadMode,
                        }],
                    });
                    const binding =
                        createAgentSessionRunnerFactoryBinding({
                            v: 1,
                            pluginId,
                            pluginVersion: metadata.packageVersion,
                            agentId: agent.id,
                            localAgentId,
                            immutableGenerationId:
                                generated.immutableGenerationId,
                            locator,
                            normalizedModulePath:
                                resolution.normalizedModulePath,
                            loadMode: resolution.loadMode,
                        });
                    const leaf = await loadRetainedAgentRuntimeLeaf({
                        paths,
                        binding,
                    }).catch((error: unknown) => {
                        throw new Error(
                            `Failed to load runner factory for '${agent.id}'`,
                            { cause: error },
                        );
                    });
                    if (EXTERNAL_SESSION_AGENT_IDS.has(agent.id)) {
                        expect(
                            Object.keys(leaf.externalSessions ?? {}).sort(),
                            agent.id,
                        ).toEqual(
                            Object.keys(registration.externalSessions ?? {}).sort(),
                        );
                    } else {
                        expect(leaf.externalSessions, agent.id).toBeUndefined();
                    }
                    const runtime = await leaf.factory({
                        plugin: {
                            id: pluginId,
                            version: metadata.packageVersion,
                        },
                        agent: { id: localAgentId },
                        signal: new AbortController().signal,
                    });
                    expect(runtime.sessions, agent.id).toBeDefined();
                    loadedByAgentId.set(agent.id, leaf.factory);
                } finally {
                    await activation.dispose();
                    await rm(prepared.rootPath, {
                        recursive: true,
                        force: true,
                    });
                }
            }
            expect([...loadedByAgentId.keys()]).toHaveLength(14);

            for (const agent of sessionAgents) {
                if (agent.id === 'kiro') continue;
                const factory = loadedByAgentId.get(agent.id);
                if (!factory) {
                    throw new Error(
                        `Missing loaded '${agent.id}' factory`,
                    );
                }
                const runtime = await factory({
                    plugin: {
                        id: agent.pluginId
                            ?? `happier.agent.${agent.id.toLowerCase()}`,
                        version: '0.0.0',
                    },
                    agent: { id: agent.identity?.localId ?? agent.id },
                    signal: new AbortController().signal,
                });
                if (!runtime.sessions) {
                    throw new Error(
                        `Loaded '${agent.id}' runtime has no sessions`,
                    );
                }
                for (const kind of ['create', 'resume'] as const) {
                    const request = createOpenRequest(agent.id, kind);
                    if (ACP_AGENT_IDS.has(agent.id)) {
                        const boundarySessions: AgentSessionRuntime[] = [];
                        const session = await withinMatrixDeadline(
                            `${agent.id}:${kind}:open`,
                            Promise.resolve(runtime.sessions.open(
                                request,
                                createAcpBoundaryContext(
                                    agent.id,
                                    boundarySessions,
                                ),
                            )),
                        );
                        await withinMatrixDeadline(
                            `${agent.id}:${kind}:lifecycle`,
                            exerciseSessionLifecycle(
                                session,
                                `${agent.id}-${kind}`,
                            ),
                        );
                        expect(
                            boundarySessions,
                            `${agent.id}:${kind}`,
                        ).toHaveLength(1);
                        continue;
                    }
                    if (agent.id === 'antigravity') {
                        const boundary =
                            createAntigravityExecBoundaryContext({
                                hostSessionId: request.sessionId,
                            });
                        const session = await withinMatrixDeadline(
                            `${agent.id}:${kind}:open`,
                            Promise.resolve(runtime.sessions.open(
                                request,
                                boundary.context,
                            )),
                        );
                        await withinMatrixDeadline(
                            `${agent.id}:${kind}:lifecycle`,
                            exerciseAntigravitySessionLifecycle(
                                session,
                                boundary.runStarted,
                                `${agent.id}-${kind}`,
                            ),
                        );
                        continue;
                    }
                    if (agent.id === 'claude') {
                        const session = await withinMatrixDeadline(
                            `${agent.id}:${kind}:open`,
                            Promise.resolve(runtime.sessions.open(
                                request,
                                createClaudeExecBoundaryContext({
                                    hostSessionId: request.sessionId,
                                }),
                            )),
                        );
                        await withinMatrixDeadline(
                            `${agent.id}:${kind}:lifecycle`,
                            exerciseSessionLifecycle(
                                session,
                                `${agent.id}-${kind}`,
                            ),
                        );
                        continue;
                    }
                    if (agent.id === 'pi') {
                        const session = await withinMatrixDeadline(
                            `${agent.id}:${kind}:open`,
                            Promise.resolve(runtime.sessions.open(
                                request,
                                createPiExecBoundaryContext({
                                    hostSessionId: request.sessionId,
                                    ...(kind === 'resume'
                                        ? {
                                            resumeProviderSessionId:
                                                'provider-pi',
                                        }
                                        : {}),
                                }),
                            )),
                        );
                        await withinMatrixDeadline(
                            `${agent.id}:${kind}:lifecycle`,
                            exerciseSessionLifecycle(
                                session,
                                `${agent.id}-${kind}`,
                            ),
                        );
                        continue;
                    }
                    throw new Error(
                        `Missing lifecycle boundary for '${agent.id}'`,
                    );
                }
            }

            const executionOnlyAgents = contributes.agents
                .filter((entry) => (
                    readAgentSessionCapabilities(
                        entry.richDefinition?.definition,
                    ) === null
                    && readAgentExecutionRunCapabilities(
                        entry.richDefinition?.definition,
                    ) !== null
                ))
                .sort((left, right) => left.id.localeCompare(right.id));
            expect(
                executionOnlyAgents.map((entry) => entry.id),
            ).toEqual(['coderabbit', 'deepsec']);
            for (const agent of executionOnlyAgents) {
                const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(
                    (entry) => entry.pluginId === agent.pluginId,
                );
                const bundledLocator =
                    BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
                        (entry) => entry.pluginId === agent.pluginId,
                    );
                if (!metadata || !bundledLocator?.daemonEntryPath) {
                    throw new Error(
                        `Missing execution-only source for '${agent.id}'`,
                    );
                }
                const resolveActivationSource =
                    createBundledActivationSourceResolver({
                        bundledPackageNames: [metadata.packageName],
                        repoRoot,
                    });
                const source = resolveActivationSource({
                    pluginId: metadata.pluginId,
                    daemonEntryPath: bundledLocator.daemonEntryPath,
                });
                if (!source) {
                    throw new Error(
                        `Missing execution-only activation for '${agent.id}'`,
                    );
                }
                const module = await source.load();
                const manifest = readCanonicalPluginManifest(bundledLocator.manifest);
                if (!manifest) {
                    throw new Error(
                        `Invalid execution-only manifest for '${agent.id}'`,
                    );
                }
                const activation = await activateContributionModule({
                    pluginId: metadata.pluginId,
                    manifestAuthority: 'bundled_first_party',
                    generation: 'first-party-agent-runtime-factory-matrix',
                    manifest,
                    moduleNamespace: module,
                    isGenerationCurrent: () => true,
                });
                if (activation.status !== 'active') {
                    throw new Error(
                        `Failed to activate execution-only plugin '${agent.id}': ${
                            JSON.stringify(activation.diagnostics)
                        }`,
                    );
                }
                try {
                    const registration = readAgentRegistration(
                        activation.registrations,
                        agent.identity?.localId ?? agent.id,
                    );
                    if (!registration) {
                        throw new Error(
                            `Missing execution-only registration for '${agent.id}'`,
                        );
                    }
                    const executionFactory = registration.factory;
                    if (!executionFactory) {
                        throw new Error(
                            `Missing execution-only factory for '${agent.id}'`,
                        );
                    }
                    expect(
                        registration.sessionRunnerFactory,
                        agent.id,
                    ).toBeUndefined();
                    const runtime = await executionFactory({
                        plugin: {
                            id: metadata.pluginId,
                            version: metadata.packageVersion,
                        },
                        agent: {
                            id: agent.identity?.localId ?? agent.id,
                        },
                        signal: new AbortController().signal,
                    });
                    expect(runtime.sessions, agent.id).toBeUndefined();
                    expect(
                        runtime.executionRuns,
                        agent.id,
                    ).toBeDefined();
                } finally {
                    await activation.dispose();
                }
            }
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    }, 180_000);
});
