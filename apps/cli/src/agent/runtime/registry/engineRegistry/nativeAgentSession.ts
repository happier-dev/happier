import { randomUUID } from 'node:crypto';

import {
    AgentLaunchEnvironmentV1Schema,
    AgentRuntimeJsonValueV1Schema,
    AgentSessionConfigurationSnapshotV1Schema,
    type RuntimeEventV1,
} from '@happier-dev/protocol/runtime';
import {
    applySessionProviderBindingMetadataV1,
    ExternalSessionsAgentIdSchema,
    readSessionProviderBindingMetadataV1,
    redactBugReportSensitiveText,
    registerSensitiveDiagnosticValues,
    SessionWorkflowActivityHeadlineV1Schema,
    type SessionProviderBindingMetadataV1,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';
import {
    parsePermissionIntentAlias,
    resolvePermissionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import type {
    HostTerminalOrchestration,
    HostTerminalRunResult,
} from '@/agent/runtime/session/terminal/contract';
import type {
    AgentRuntime,
    AgentSessionCatalogControl,
    AgentSessionControlContext,
    AgentSessionGoalControl,
    AgentSessionGoalMutation,
    AgentSessionMcpLaunchConfig,
    AgentSessionMcpServer,
    AgentSessionHostServices,
    AgentSessionRuntimeContext,
    AgentAcpRuntimeOptions,
    AgentSessionConfigurationSnapshot,
    AgentSessionConfigurationUpdate,
    AgentSessionOpenRequest,
    AgentSessionRuntime,
    AgentSessionRuntimeEvent,
    AgentSessionUsageLimitRecoveryControl,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk/runtime';
import { configuration as happierConfiguration } from '@/configuration';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import {
    readAgentSessionCapabilities,
    type AgentSessionCapabilities,
} from '@/plugins/projection/registry/agentContributionDefinition';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistryTypes';
import {
    createNativeAgentHostSessionRuntimePlan,
    resolvePublicSessionModelSelection,
} from '@/plugins/runtime/runtimeCore/plugin/session';
import type {
    PluginRuntimeHookOperations,
    PluginRuntimePromptDeliveryOutcome,
} from '@/plugins/runtime/runtimeCore/plugin/sessionRuntimeHooks';
import type { PluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { HostSessionTerminalRemoteModeLoop } from '@/agent/runtime/session/loop/terminalRemoteModeRuntime';
import type {
    HostSessionRuntimeConfig,
    HostSessionRuntimeFactoryParams,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type {
    RuntimeTurnCompletionOptions,
    RuntimeTurnConfigUpdate,
    RuntimeConfigUpdateOutcomeV1,
    RuntimeTurnDisposeReason,
    RuntimeTurnOperations,
    RuntimeTurnPromptMeta,
    RuntimeTurnSessionOpenIntent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { createRuntimeTurnFailureAlreadySurfacedError } from '@/agent/runtime/turns/runtimeTurnOperations';
import { fetchAccountProfile } from '@/api/accountProfile';
import { ensureExternalSessionLink } from '@/api/session/external/linking/ensureExternalSessionLink';
import {
    createLiveConfiguredPluginExternalSessionsAdapter,
    type ConfiguredExternalSessionSourceAccountProjection,
} from '@/session/external/configuredSourceMaterializer';
import { createExternalSessionSourceKeyOwnerFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import type { PluginExternalSessionsProviderOps } from '@/session/external/pluginExternalSessionsAdapter';
import {
    getActiveAccountSettingsSnapshot,
    resolveActiveAccountSettingsSnapshotRevision,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createNativeAgentSessionServices } from './nativeAgentSessionInteractions';
import type { ExternalSessionHostOperationPort } from '@/session/external/hostOperationOwner';
import type { RuntimeExactProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import { createAgentSessionTurnInvariant } from '@/agent/runtime/session/turn/agentSessionTurnInvariant';
import { logger } from '@/ui/logger';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import {
    createPublicAcpSession,
    type PublicAcpSystemTools,
} from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import type { UsageObservation } from '@/usage/usageObservation';
import type { ResolvedSessionMcpServer } from '@/mcp/runtimeTypes';
import { createNativeAgentSessionWorkStateService } from './nativeAgentSessionWorkState';
import { createPluginInvocationUi } from '@/plugins/runtime/invocation/services/ui';
import { createPluginSessionMediaHostAdapter } from './nativeAgentSessionMedia';
import type { McpServerConfig } from '@/agent/core/AgentTypes';
import {
    resolvePluginExecManagedDependencyForHost,
    resolvePluginExecSystemToolForHost,
} from '@/plugins/runtime/invocation/services/exec';
import {
    buildSessionRollbackRangesV1,
    readSessionRollbackRangesV1FromMetadata,
    SessionTurnProviderCheckpointV1Schema,
    type SessionRollbackRpcParams,
    type SessionRollbackRpcResult,
} from '@happier-dev/protocol';
import { PluginTerminalHostError } from '@/plugins/runtime/context/terminalHost';
import { createCurrentSessionPresentationService } from '@/session/presentation/currentSessionPresentationService';
import { registerCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import {
    createNativeAgentSessionPublications,
    type NativeAgentSessionPublications,
} from './nativeAgentSessionPublications';
import { createSessionSystemRecordPayloadService } from '@/session/systemRecords/sessionSystemRecordPayloadService';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import {
    consumeProviderBindingLaunchHandoffFromEnvironments,
    HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
} from '@/plugins/runtime/providerBindings/handoff';
import { beginProviderBindingRuntimeDiagnosticRedaction } from '@/plugins/runtime/providerBindings/runtimeDiagnosticRedaction';
import { abandonDaemonAgentRuntimePreparedSession } from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeClient';
import {
    type NativeAgentSessionHostServiceOwners,
} from './nativeAgentSessionHostServiceOwners';
import { createPluginExecSystemToolGrantStore } from '@/plugins/runtime/exec/system/tools/grants';
import { createTerminalRuntimeHostOrchestration } from '@/agent/runtime/session/terminal/orchestration';
import { createTerminalRuntimeProjectionHostService } from '@/agent/runtime/session/terminal/projection';
import { createHostTerminalTranscriptFollowService } from '@/agent/runtime/session/terminal/transcriptFollow';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import {
    AGENT_SESSION_CONTINUATION_UNREACHABLE_ERROR_NAME,
} from '@/session/shared/spawnSessionContract';

export type { NativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';

type NativeAgentTerminalExecutionSurface = NonNullable<BackendExecutionSurfaces['terminalRuntime']>;

function readNativeAgentTerminalRunResult(value: unknown): HostTerminalRunResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Native Agent terminal execution owner returned an invalid result');
    }
    const result = value as Readonly<Record<string, unknown>>;
    if (
        result.type === 'process_exited'
        && typeof result.exitCode === 'number'
        && Number.isFinite(result.exitCode)
    ) {
        return value as HostTerminalRunResult;
    }
    if (
        result.type === 'control_returned'
        && (
            result.reason === 'switch_requested'
            || result.reason === 'pending_input'
            || result.reason === 'terminal_recovery'
        )
    ) {
        return value as HostTerminalRunResult;
    }
    throw new Error('Native Agent terminal execution owner returned an invalid result');
}

function waitForNativeAgentTerminalRemoteDisposition(params: Readonly<{
    signal: AbortSignal;
    switching: HostTerminalOrchestration['switching'] | null;
}>): Promise<'switch' | 'exit'> {
    if (params.signal.aborted) return Promise.resolve('exit');
    if (!params.switching) {
        return new Promise((resolve) => {
            params.signal.addEventListener(
                'abort',
                () => resolve('exit'),
                { once: true },
            );
        });
    }
    const switching = params.switching;
    return new Promise((resolve, reject) => {
        let settled = false;
        let subscription: ReturnType<
            HostTerminalOrchestration['switching']['register']
        > | null = null;
        const settle = (result: 'switch' | 'exit') => {
            if (settled) return;
            settled = true;
            params.signal.removeEventListener('abort', onAbort);
            subscription?.unsubscribe();
            subscription = null;
            resolve(result);
        };
        const onAbort = () => settle('exit');
        try {
            subscription = switching.register(async (request) => {
                if (request.target === 'remote') return true;
                if (request.target !== 'local') return false;
                settle('switch');
                return true;
            });
        } catch (error) {
            reject(error);
            return;
        }
        params.signal.addEventListener('abort', onAbort, { once: true });
        if (params.signal.aborted) settle('exit');
    });
}

function createNativeAgentTerminalModeBinding<TRuntime extends RuntimeTurnOperations>(params: Readonly<{
    runtime: TRuntime;
    terminal: NativeAgentTerminalExecutionSurface;
    agentId: string;
    sessionId: string;
    directory: string;
    readMetadata: () => Readonly<Record<string, unknown>>;
    environment?: Readonly<Record<string, string>>;
    unsetEnvironmentVariables?: readonly string[];
    generationSignal?: AbortSignal;
    host: HostTerminalOrchestration | null;
}>): Readonly<{
    runtime: TRuntime;
    terminalRemoteModeLoop: HostSessionTerminalRemoteModeLoop | null;
}> {
    const launch = params.terminal.launch;
    if (!launch) {
        return Object.freeze({
            runtime: params.runtime,
            terminalRemoteModeLoop: null,
        });
    }

    const lifecycleAbortController = new AbortController();
    const signal = AbortSignal.any([
        lifecycleAbortController.signal,
        ...(params.generationSignal ? [params.generationSignal] : []),
    ]);
    const modeLoop: HostSessionTerminalRemoteModeLoop = Object.freeze({
        startingMode: 'remote',
        remoteExitCode: 0,
        async runTerminal() {
            try {
                const metadata = params.readMetadata();
                let providerSessionId: string | null = null;
                try {
                    const candidate =
                        params.runtime.readSessionIdentity().sessionId;
                    providerSessionId =
                        candidate
                        && candidate === candidate.trim()
                            ? candidate
                            : null;
                } catch {
                    providerSessionId = null;
                }
                if (params.host?.transcriptFollow) {
                    if (!providerSessionId) {
                        throw new Error(
                            'native_agent_terminal_provider_session_unavailable',
                        );
                    }
                    const follow =
                        await params.host.transcriptFollow.bindProviderSession({
                            agentId: params.agentId,
                            providerSessionId,
                        });
                    if (follow.status === 'unavailable') {
                        throw new Error(follow.code);
                    }
                }
                const result = readNativeAgentTerminalRunResult(await launch({
                    sessionId: params.sessionId,
                    directory: params.directory,
                    metadata: providerSessionId
                        ? {
                            ...metadata,
                            providerSessionId,
                        }
                        : metadata,
                    ...(params.environment || params.unsetEnvironmentVariables
                        ? {
                            isolation: {
                                ...(params.environment ? { env: params.environment } : {}),
                                ...(params.unsetEnvironmentVariables
                                    ? { unsetEnvKeys: params.unsetEnvironmentVariables }
                                    : {}),
                            },
                        }
                        : {}),
                    signal,
                    ...(params.host ? { host: params.host } : {}),
                }));
                return result.type === 'process_exited'
                    ? { type: 'exit' as const, code: result.exitCode }
                    : { type: 'switch' as const };
            } finally {
                await params.host?.transcriptFollow
                    ?.releaseActiveBindings()
                    .catch(() => undefined);
            }
        },
        runRemote: async () => await waitForNativeAgentTerminalRemoteDisposition({
            signal,
            switching: params.host?.switching ?? null,
        }),
        onModeChange: () => undefined,
    });

    const runtime = Object.freeze({
        ...params.runtime,
        async resetOrDisposeRuntime(
            reason?: RuntimeTurnDisposeReason,
            nextSessionOpenIntent?: RuntimeTurnSessionOpenIntent,
        ) {
            lifecycleAbortController.abort();
            await params.runtime.resetOrDisposeRuntime(reason, nextSessionOpenIntent);
        },
    });
    return Object.freeze({
        runtime,
        terminalRemoteModeLoop: modeLoop,
    });
}

function parseNativeAgentForkSource(
    value: unknown,
): Extract<AgentSessionOpenRequest, { kind: 'fork' }>['source'] | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const sessionId = readNonBlankOpaqueIdentifier(record.sessionId);
    const providerSessionId = readNonBlankOpaqueIdentifier(record.providerSessionId);
    const cwd = typeof record.cwd === 'string' ? record.cwd.trim() : '';
    if (!sessionId || !providerSessionId || !cwd) return null;
    if (record.target === undefined) {
        return Object.freeze({ sessionId, providerSessionId, cwd });
    }
    if (!record.target || typeof record.target !== 'object' || Array.isArray(record.target)) {
        return null;
    }
    const target = record.target as Readonly<Record<string, unknown>>;
    const turnId = readNonBlankOpaqueIdentifier(target.turnId);
    const checkpoint = SessionTurnProviderCheckpointV1Schema.safeParse(target.providerCheckpoint);
    if (!turnId || !checkpoint.success) return null;
    return Object.freeze({
        sessionId,
        providerSessionId,
        cwd,
        target: Object.freeze({
            turnId,
            providerCheckpoint: checkpoint.data,
        }),
    });
}

type NativeAgentTerminalHostScope = Readonly<{
    service: NonNullable<AgentSessionHostServices['terminalHost']>;
    dispose(): Promise<void>;
}>;

type AgentTerminalHostService = NonNullable<AgentSessionHostServices['terminalHost']>;

function createNativeAgentTerminalHostScope(params: Readonly<{
    owner: AgentTerminalHostService;
    signal: AbortSignal;
    isCurrent: () => boolean;
    session: ApiSessionClient;
    reportSessionMetadataToDaemon: (input: Readonly<{
        sessionId: string;
        metadata: Metadata;
    }>) => Promise<void>;
}>): NativeAgentTerminalHostScope {
    const ownedHandles = new Set<Awaited<ReturnType<AgentTerminalHostService['createOrAttachHost']>>>();
    const disposedHandles = new Set<Awaited<ReturnType<AgentTerminalHostService['createOrAttachHost']>>>();
    const disposalByHandle = new Map<
        Awaited<ReturnType<AgentTerminalHostService['createOrAttachHost']>>,
        Promise<void>
    >();
    let scopeDisposed = false;

    const assertScopeAvailable = (): void => {
        let current = false;
        try {
            current = params.isCurrent();
        } catch {
            current = false;
        }
        if (scopeDisposed || params.signal.aborted || !current) {
            throw new PluginTerminalHostError(
                'PLUGIN_TERMINAL_HOST_SCOPE_RETIRED',
                'The native Agent terminal-host session scope is retired or unavailable',
            );
        }
    };
    const assertOwnedHandle = (
        handle: Awaited<ReturnType<AgentTerminalHostService['createOrAttachHost']>>,
    ): void => {
        if (!ownedHandles.has(handle)) {
            throw new PluginTerminalHostError(
                'PLUGIN_TERMINAL_HOST_HANDLE_NOT_ACTIVE',
                'The terminal-host handle is not active in this native Agent session scope',
            );
        }
    };
    const disposeHandle = async (
        handle: Awaited<ReturnType<AgentTerminalHostService['createOrAttachHost']>>,
        intent: Parameters<AgentTerminalHostService['dispose']>[1],
    ): Promise<void> => {
        if (disposedHandles.has(handle)) return;
        const existing = disposalByHandle.get(handle);
        if (existing) return await existing;
        assertOwnedHandle(handle);
        const disposal = Promise.resolve(params.owner.dispose(handle, intent)).then(() => {
            ownedHandles.delete(handle);
            disposedHandles.add(handle);
        });
        disposalByHandle.set(handle, disposal);
        return await disposal;
    };

    const service: NonNullable<AgentSessionHostServices['terminalHost']> = Object.freeze({
        async resolve(request) {
            assertScopeAvailable();
            return await params.owner.resolve(request);
        },
        async createOrAttachHost(request) {
            assertScopeAvailable();
            const handle = await params.owner.createOrAttachHost(request);
            ownedHandles.add(handle);
            try {
                assertScopeAvailable();
            } catch (error) {
                await disposeHandle(handle, {
                    kind: 'preserve_host',
                    reason: 'runtime_recovery',
                }).catch(() => undefined);
                throw error;
            }
            try {
                let updatedMetadata: Metadata | null = null;
                await params.session.updateMetadata((metadata) => {
                    updatedMetadata = {
                        ...metadata,
                        terminal: buildTerminalMetadataFromHostHandle(handle),
                    };
                    return updatedMetadata;
                });
                if (updatedMetadata) {
                    await params.reportSessionMetadataToDaemon({
                        sessionId: params.session.sessionId,
                        metadata: updatedMetadata,
                    });
                }
            } catch (error) {
                logger.debug(
                    '[native-agent] Failed to publish attached terminal-host metadata (non-fatal)',
                    error,
                );
            }
            return handle;
        },
        async injectUserPrompt(handle, input) {
            assertScopeAvailable();
            assertOwnedHandle(handle);
            return await params.owner.injectUserPrompt(handle, input);
        },
        async interruptTurn(handle) {
            assertScopeAvailable();
            assertOwnedHandle(handle);
            return await params.owner.interruptTurn(handle);
        },
        async evaluateLiveness(handle) {
            assertScopeAvailable();
            assertOwnedHandle(handle);
            return await params.owner.evaluateLiveness(handle);
        },
        async captureInputState(handle) {
            assertScopeAvailable();
            assertOwnedHandle(handle);
            return await params.owner.captureInputState(handle);
        },
        async controlPort(handle) {
            assertScopeAvailable();
            assertOwnedHandle(handle);
            return await params.owner.controlPort(handle);
        },
        async dispose(handle, intent) {
            return await disposeHandle(handle, intent);
        },
    });

    return Object.freeze({
        service,
        async dispose() {
            if (scopeDisposed) return;
            scopeDisposed = true;
            const results = await Promise.allSettled([...ownedHandles].map((handle) => disposeHandle(handle, {
                kind: 'preserve_host',
                reason: 'runtime_recovery',
            })));
            const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failure) throw failure.reason;
        },
    });
}

function combineSessionOperationSignal(
    sessionSignal: AbortSignal,
    callerSignal?: AbortSignal,
): AbortSignal {
    sessionSignal.throwIfAborted();
    if (!callerSignal || callerSignal === sessionSignal) return sessionSignal;
    const signal = AbortSignal.any([sessionSignal, callerSignal]);
    signal.throwIfAborted();
    return signal;
}

function createPublicAcpSystemToolsAdapter(
    exec: PluginServices['exec'],
    pluginId: string,
): PublicAcpSystemTools {
    return Object.freeze({
        async resolve(request) {
            const resolved = await resolvePluginExecSystemToolForHost(exec, request);
            const executable = resolved.executable;
            const localId = typeof executable.id === 'string'
                ? executable.id
                : executable.id.pluginId === pluginId
                    ? executable.id.localId
                    : null;
            if (executable.kind !== 'systemTool' || localId !== request.toolId) {
                throw new Error(
                    `ACP system tool '${request.toolId}' did not resolve to its exact declared executable`,
                );
            }
            return Object.freeze({
                toolId: request.toolId,
                launch: Object.freeze({
                    kind: 'binary',
                    executablePath: resolved.command,
                    ...(resolved.args ? { args: resolved.args } : {}),
                    ...(resolved.env ? { env: resolved.env } : {}),
                }),
            });
        },
    });
}

export function createNativeAgentSessionHostServices(params: Readonly<{
    owners: NativeAgentSessionHostServiceOwners;
    agentId: string;
    sessionId: string;
    directory: string;
    signal: AbortSignal;
    isCurrent: () => boolean;
    terminalHost?: NonNullable<AgentSessionHostServices['terminalHost']>;
    session: Pick<ApiSessionClient, 'updateMetadata'>;
    systemRecords: AgentSessionHostServices['systemRecords'];
    publications: NativeAgentSessionPublications['services'];
}>): AgentSessionHostServices {
    const isSessionScopeCurrent = (): boolean => {
        let current = false;
        try {
            current = params.isCurrent();
        } catch {
            current = false;
        }
        return !params.signal.aborted && current;
    };
    const assertSessionScopeAvailable = (service: string): void => {
        if (!isSessionScopeCurrent()) {
            throw new Error(`The native Agent ${service} session scope is retired or unavailable`);
        }
    };
    const features: AgentSessionHostServices['features'] = Object.freeze({
        isEnabled(featureId: string): boolean {
            if (params.signal.aborted) return false;
            try {
                return params.isCurrent() && params.owners.features.isEnabled(featureId) === true;
            } catch {
                return false;
            }
        },
    });
    const sessionHooks: AgentSessionHostServices['sessionHooks'] = Object.freeze({
        async startServer(
            request: Parameters<AgentSessionHostServices['sessionHooks']['startServer']>[0],
        ) {
            params.signal.throwIfAborted();
            return await params.owners.sessionHooks.startServer({
                ...request,
                providerId: params.agentId,
                sessionId: params.sessionId,
                lifecycle: { kind: 'session', sessionId: params.sessionId },
            });
        },
        async resolveForwarderAssets() {
            params.signal.throwIfAborted();
            return await params.owners.sessionHooks.resolveForwarderAssets();
        },
        async createPluginDir(
            request: Parameters<AgentSessionHostServices['sessionHooks']['createPluginDir']>[0],
        ) {
            params.signal.throwIfAborted();
            return await params.owners.sessionHooks.createPluginDir({
                ...request,
                providerId: params.agentId,
                lifecycle: { kind: 'session', sessionId: params.sessionId },
            });
        },
        async disposePluginDir(pluginDir: string) {
            return await params.owners.sessionHooks.disposePluginDir(pluginDir);
        },
        async publishProviderTranscript(
            request: Parameters<AgentSessionHostServices['sessionHooks']['publishProviderTranscript']>[0],
        ) {
            params.signal.throwIfAborted();
            return await params.owners.sessionHooks.publishProviderTranscript({
                ...request,
                providerId: params.agentId,
                sessionId: params.sessionId,
            });
        },
    });
    const fileFollow: AgentSessionHostServices['transcripts']['fileFollow'] = Object.freeze({
        async follow(
            input: Parameters<AgentSessionHostServices['transcripts']['fileFollow']['follow']>[0],
        ) {
            return await params.owners.transcripts.fileFollow.follow({
                ...input,
                signal: combineSessionOperationSignal(params.signal, input.signal),
            });
        },
    });
    const accountUsage: AgentSessionHostServices['accountUsage'] = Object.freeze({
        async resolveSourceContext(
            input: Parameters<AgentSessionHostServices['accountUsage']['resolveSourceContext']>[0],
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            return await params.owners.accountUsage.resolveSourceContext(input, {
                signal: combineSessionOperationSignal(params.signal, options?.signal),
            });
        },
        async recordSnapshot(
            input: Parameters<AgentSessionHostServices['accountUsage']['recordSnapshot']>[0],
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            return await params.owners.accountUsage.recordSnapshot({
                ...input,
                sessionId: params.sessionId,
            }, {
                signal: combineSessionOperationSignal(params.signal, options?.signal),
            });
        },
        async adoptProvisionalRecord(
            input: Parameters<AgentSessionHostServices['accountUsage']['adoptProvisionalRecord']>[0],
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            return await params.owners.accountUsage.adoptProvisionalRecord({
                ...input,
                sessionId: params.sessionId,
                adoption: {
                    ...input.adoption,
                    providerId: params.agentId,
                },
            }, {
                signal: combineSessionOperationSignal(params.signal, options?.signal),
            });
        },
    });
    const auth: AgentSessionHostServices['auth'] = Object.freeze({
        async refreshRuntimeAuth(
            request: Parameters<AgentSessionHostServices['auth']['refreshRuntimeAuth']>[0],
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            return await params.owners.auth.services.refreshRuntimeAuth({
                ...request,
                agentId: params.agentId,
            }, {
                signal: combineSessionOperationSignal(params.signal, options?.signal),
            });
        },
    });
    const projectMcpServer = (server: ResolvedSessionMcpServer): AgentSessionMcpServer => {
        const transport = server.transport;
        if (transport.kind === 'http' || transport.kind === 'sse') {
            return Object.freeze({
                id: server.id,
                name: server.name,
                transport: Object.freeze({ kind: transport.kind, url: transport.url }),
            });
        }
        if (transport.kind === 'managed') {
            return Object.freeze({
                id: server.id,
                name: server.name,
                transport: Object.freeze({
                    kind: 'managed' as const,
                    ...(transport.url === undefined ? {} : { url: transport.url }),
                }),
            });
        }
        if (transport.kind === 'hosted' || transport.kind === 'stdio') {
            return Object.freeze({
                id: server.id,
                name: server.name,
                transport: Object.freeze({ kind: transport.kind }),
            });
        }
        throw new Error('Unsupported native Agent MCP transport');
    };
    const mcp: AgentSessionHostServices['mcp'] = Object.freeze({
        async resolveServers(options?: Readonly<{ signal?: AbortSignal }>) {
            const signal = combineSessionOperationSignal(params.signal, options?.signal);
            const resolved = await params.owners.mcp.resolveForSession({
                sessionId: params.sessionId,
                directory: params.directory,
            });
            signal.throwIfAborted();
            return Object.freeze(resolved.map(projectMcpServer));
        },
    });
    const systemRecords: AgentSessionHostServices['systemRecords'] = Object.freeze({
        async write(request) {
            assertSessionScopeAvailable('system-record');
            await params.systemRecords.write(request);
        },
        async read(request) {
            assertSessionScopeAvailable('system-record');
            return await params.systemRecords.read(request);
        },
    });
    const workflowActivity: AgentSessionHostServices['workflowActivity'] = Object.freeze({
        async publishHeadline(headline) {
            assertSessionScopeAvailable('workflow-activity');
            const parsed = SessionWorkflowActivityHeadlineV1Schema.parse(headline);
            let retiredDuringMerge = false;
            await params.session.updateMetadata((current) => {
                if (!isSessionScopeCurrent()) {
                    retiredDuringMerge = true;
                    return current;
                }
                return {
                    ...current,
                    sessionWorkflowActivityHeadlineV1: parsed,
                };
            });
            if (retiredDuringMerge) {
                throw new Error('The native Agent workflow-activity session scope is retired or unavailable');
            }
        },
    });
    return Object.freeze({
        features,
        ...(params.terminalHost ? { terminalHost: params.terminalHost } : {}),
        models: params.publications.models,
        activeInput: params.publications.activeInput,
        sessionHooks,
        transcripts: Object.freeze({ fileFollow }),
        accountUsage,
        auth,
        mcp,
        systemRecords,
        workflowActivity,
    });
}

function cloneNativeAgentSessionMcpServers(
    mcpServers: Readonly<Record<string, McpServerConfig>>,
): Readonly<Record<string, AgentSessionMcpLaunchConfig>> | undefined {
    const entries = Object.entries(mcpServers);
    if (entries.length === 0) return undefined;
    const cloned: Record<string, AgentSessionMcpLaunchConfig> = {};
    for (const [name, server] of entries) {
        cloned[name] = Object.freeze({
            command: server.command,
            ...(server.args === undefined ? {} : { args: Object.freeze([...server.args]) }),
            ...(server.env === undefined ? {} : { env: Object.freeze({ ...server.env }) }),
        });
    }
    return Object.freeze(cloned);
}

function buildNativeAgentSessionOpenInputs(
    input: PluginSessionBindingInput,
    metadata: Readonly<Record<string, unknown>>,
    providerBindingMaterialization: HostSessionRuntimeFactoryParams['providerBindingMaterialization'],
    hostPermissionMode: string,
    buildOptions: Readonly<{ allowPendingProviderBinding?: boolean }> = {},
): Readonly<{
    launchEnvironment: NonNullable<AgentSessionOpenRequest['launchEnvironment']>;
    configuration: AgentSessionConfigurationSnapshot;
    providerBinding?: NonNullable<AgentSessionOpenRequest['providerBinding']>;
}> {
    const environmentValues = { ...(input.bootstrap.environmentVariables ?? {}) };
    delete environmentValues[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    const launchEnvironment = AgentLaunchEnvironmentV1Schema.parse({
        values: environmentValues,
        unset: (input.bootstrap.unsetEnvironmentVariables ?? []).filter(
            (key) => key !== HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
        ),
    });
    const permission = input.runtimePreferences.permission;
    const metadataPermission = resolvePermissionIntentFromSessionMetadata(metadata);
    const sessionMode = input.runtimePreferences.sessionMode;
    const launchModelSelection = input.runtimePreferences.modelSelection;
    const modelSelection = resolvePublicSessionModelSelection({ sessionInput: input, metadata });
    const options = Object.fromEntries(
        Object.entries(input.runtimePreferences.configurationOptions?.overrides ?? {}).map(
            ([id, option]) => [id, { value: option.value, updatedAtMs: option.updatedAt }],
        ),
    );
    const configuration = AgentSessionConfigurationSnapshotV1Schema.parse({
        mode: {
            value: sessionMode?.id ?? null,
            updatedAtMs: sessionMode?.updatedAt ?? 0,
        },
        model: {
            value: modelSelection?.ref.modelId ?? null,
            updatedAtMs: modelSelection?.updatedAt ?? 0,
        },
        permissionIntent: {
            value: permission
                ? parsePermissionIntentAlias(permission.mode)
                : metadataPermission?.intent ?? parsePermissionIntentAlias(hostPermissionMode),
            updatedAtMs: permission?.updatedAt ?? metadataPermission?.updatedAt ?? 0,
        },
        options,
    });
    const providerConnectionId = modelSelection?.ref.providerConnectionId ?? null;
    if (providerConnectionId === null) {
        if (providerBindingMaterialization !== undefined) {
            throw new Error('Native model selection cannot include Provider binding materialization');
        }
        return Object.freeze({ launchEnvironment, configuration });
    }
    if (providerBindingMaterialization === undefined) {
        if (buildOptions.allowPendingProviderBinding === true) {
            return Object.freeze({ launchEnvironment, configuration });
        }
        throw new Error('Provider-bound native Agent session requires Provider binding materialization');
    }
    if (!modelSelection) {
        throw new Error('Provider-bound native Agent session requires an exact model selection');
    }
    const providerBindingMetadata = readSessionProviderBindingMetadataV1(metadata);
    if (
        !providerBindingMetadata?.model
        || providerBindingMetadata.connectionId !== providerConnectionId
        || providerBindingMetadata.model.id !== modelSelection.ref.modelId
    ) {
        throw new Error('Provider-bound native Agent session requires the exact launch model descriptor');
    }
    if (
        launchModelSelection?.ref.agentTargetKey !== modelSelection?.ref.agentTargetKey
        || launchModelSelection?.ref.providerConnectionId !== providerConnectionId
        || launchModelSelection?.ref.modelId !== modelSelection?.ref.modelId
    ) {
        throw new Error('Attached Provider model selection does not match launch binding');
    }
    return Object.freeze({
        launchEnvironment,
        configuration,
        providerBinding: Object.freeze({
            connectionId: providerConnectionId,
            model: providerBindingMetadata.model,
            materialization: providerBindingMaterialization,
        }),
    });
}

function applyNativeAgentConfigurationUpdate(
    current: AgentSessionConfigurationSnapshot,
    update: RuntimeTurnConfigUpdate,
): Readonly<{
    snapshot: AgentSessionConfigurationSnapshot;
    request: AgentSessionConfigurationUpdate;
}> {
    const updatedAtMs = Date.now();
    const configOption = update.configOption;
    const configOptionId = configOption && typeof configOption.id === 'string'
        ? configOption.id.trim()
        : '';
    const configOptionValue = configOption?.value;
    const hasConfigOptionValue = configOptionId.length > 0 && (
        configOptionValue === null
        || typeof configOptionValue === 'string'
        || typeof configOptionValue === 'number'
        || typeof configOptionValue === 'boolean'
    );
    const snapshot = AgentSessionConfigurationSnapshotV1Schema.parse({
        mode: typeof update.modeId === 'string'
            ? { value: update.modeId, updatedAtMs }
            : current.mode,
        model: typeof update.modelId === 'string'
            ? { value: update.modelId, updatedAtMs }
            : current.model,
        permissionIntent: typeof update.permissionMode === 'string'
            ? { value: parsePermissionIntentAlias(update.permissionMode), updatedAtMs }
            : current.permissionIntent,
        options: hasConfigOptionValue
            ? {
                ...current.options,
                [configOptionId]: { value: configOptionValue, updatedAtMs },
            }
            : current.options,
    });
    return {
        snapshot,
        request: {
            ...snapshot,
            ...(update.providerBinding ? { providerBinding: update.providerBinding } : {}),
        },
    };
}

function toHostConfigurationOutcome(
    result: Awaited<ReturnType<NonNullable<AgentSessionRuntime['updateConfiguration']>>>,
): RuntimeConfigUpdateOutcomeV1 {
    if (result.status === 'applied') {
        return { status: 'applied', timing: 'current_window' };
    }
    if (result.status === 'deferred') {
        return { status: 'applied', timing: 'before_next_prompt' };
    }
    return {
        status: result.status === 'unsupported' ? 'unsupported' : 'failed',
        reason: diagnosticMessage('diagnostic' in result ? result.diagnostic : {
            code: 'agent_session_configuration_failed',
        }),
    };
}

type NativeAgentSessionUsagePublisher = Readonly<{
    provider: string;
    publish(input: Readonly<{
        observedAt: number;
        observation: UsageObservation;
        turnId: string | null;
        externalKey: string;
    }>): void | Promise<void>;
}>;

type NativeAgentSessionDirectFacets = Readonly<{
    goals?: AgentSessionGoalControl;
    catalog?: AgentSessionCatalogControl;
    usageLimitRecovery?: AgentSessionUsageLimitRecoveryControl;
    context: AgentSessionRuntimeContext;
    cwd: string;
    connectedAccounts: NonNullable<AgentSessionOpenRequest['connectedAccounts']>;
    capabilities: AgentSessionCapabilities;
}>;

type NativeAgentSessionInteractionLifecycle = Readonly<{
    onTurnTerminal(
        event: Extract<
            AgentSessionRuntimeEvent,
            { kind: 'turn-complete' | 'turn-failed' | 'turn-cancelled' }
        >,
    ): void | Promise<void>;
    subscribeCommittedUserMessageSeq?(
        listener: (observation: Readonly<{ localId: string; seq: number }>) => void,
    ): () => void;
    getCommittedUserMessageSeq?(localId: string): number | null;
    getLastObservedMessageSeq?(): number;
    updateMetadata?(updater: (metadata: Metadata) => Metadata): Promise<void> | void;
}>;

type NativeAgentSessionDirectHostControls = Readonly<{
    rollbackConversation?: (request: SessionRollbackRpcParams) => Promise<SessionRollbackRpcResult>;
    refreshGoal?: () => Promise<unknown>;
    setGoal?: (
        objective: string | undefined,
        options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
    ) => Promise<unknown>;
    clearGoal?: () => Promise<unknown>;
    listVendorPlugins?: () => Promise<unknown>;
    listSkills?: () => Promise<unknown>;
    checkUsageLimitRecoveryNow?: (request: Readonly<{
        sessionId: string;
        agentId?: string;
        resumePromptMode?: 'standard' | 'off' | 'custom';
    }>) => Promise<unknown>;
    consumeUsageLimitResetCredit?: (request: Readonly<{
        sessionId: string;
        agentId?: string;
        issueFingerprint?: string;
        resumePromptMode?: 'standard' | 'off' | 'custom';
    }>) => Promise<unknown>;
}>;

function createNativeAgentSessionControlContext(params: Readonly<{
    context: AgentSessionRuntimeContext;
    cwd: string;
    activity: 'active' | 'inactive';
    connectedAccounts: NonNullable<AgentSessionOpenRequest['connectedAccounts']>;
    providerSessionId?: string;
}>): AgentSessionControlContext {
    return Object.freeze({
        plugin: params.context.plugin,
        contribution: params.context.contribution,
        surface: params.context.surface,
        signal: params.context.signal,
        services: params.context.services,
        ui: params.context.ui,
        agent: params.context.agent,
        protocols: params.context.protocols,
        session: Object.freeze({
            id: params.context.session.id,
            cwd: params.cwd,
            activity: params.activity,
            ...(params.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
            connectedAccounts: Object.freeze([...params.connectedAccounts]),
        }),
    });
}

function directControlFailureResult(
    result: Readonly<{ status: string; diagnostic?: Readonly<{ code: string; message?: string }> }>,
): Readonly<{ ok: false; errorCode: string; error: string }> {
    const errorCode = result.diagnostic?.code ?? `agent_session_control_${result.status}`;
    return Object.freeze({
        ok: false,
        errorCode,
        error: result.diagnostic?.message ?? errorCode,
    });
}

function diagnosticMessage(diagnostic: Readonly<{ code: string; message?: string }>): string {
    return diagnostic.message ?? diagnostic.code;
}

function buildNativeAgentSessionRuntimeIssue(
    event: Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>,
): SessionRuntimeIssueV1 {
    const code = event.diagnostic.code.trim().slice(0, 256) || 'agent_session_error';
    const sanitizedPreview = event.diagnostic.message?.trim().slice(0, 2_000);
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code,
        source: 'agent_session_error',
        occurredAt: event.emittedAtMs,
        ...(sanitizedPreview ? { sanitizedPreview } : {}),
    };
}

function readConfiguredExternalSessionProviderOps(
    value: BackendExecutionSurfaces['externalSession'] | undefined,
): PluginExternalSessionsProviderOps | null {
    if (!value
        || typeof value.validateSource !== 'function'
        || typeof value.listCandidates !== 'function'
        || typeof value.pageTranscript !== 'function'
        || typeof value.readAfterTranscript !== 'function') {
        return null;
    }
    return {
        validateSource: value.validateSource,
        listCandidates: value.listCandidates,
        pageTranscript: value.pageTranscript,
        readAfterTranscript: value.readAfterTranscript,
        ...(value.resolveLinkIdentity
            ? { resolveLinkIdentity: value.resolveLinkIdentity }
            : {}),
    };
}

function hasConnectedServiceProfileSourceInstances(agent: ResolvedAgentContribution): boolean {
    return agent.richDefinition?.definition.surfaces?.externalSession.sources.some(
        (source) => source.instances?.some((instance) => instance.kind === 'connectedServiceProfiles') === true,
    ) === true;
}

function toRuntimeEvent(
    event: AgentSessionRuntimeEvent,
    context?: Readonly<{ rollbackStartUserMessageSeq?: number }>,
): RuntimeEventV1 | null {
    const base = {
        sessionId: event.sessionId,
        emittedAtMs: event.emittedAtMs,
        ordering: event.sequence,
    };
    switch (event.kind) {
        case 'provider-session-id':
            return { ...base, kind: 'session-id-publish', publishedSessionId: event.providerSessionId, source: 'agent-runtime' };
        case 'turn-start':
            return { ...base, kind: 'turn-start', turnId: event.turnId, startedBy: event.startedBy };
        case 'turn-progress':
            return { ...base, kind: 'turn-progress', turnId: event.turnId };
        case 'turn-agent-id-observed':
            return { ...base, kind: 'turn-agent-id-observed', turnId: event.turnId, agentTurnId: event.agentTurnId };
        case 'turn-complete':
            return { ...base, kind: 'turn-complete', turnId: event.turnId };
        case 'turn-failed':
            return {
                ...base,
                kind: 'turn-failed',
                turnId: event.turnId,
                issue: buildNativeAgentSessionRuntimeIssue(event),
            };
        case 'turn-cancelled':
            return { ...base, kind: 'turn-cancelled', turnId: event.turnId, reason: event.cause };
        case 'runtime-ended':
            return null;
        case 'message-delta':
            return {
                ...base,
                kind: 'message-delta',
                turnId: event.turnId,
                ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
                delta: { text: event.text, thinking: event.channel === 'reasoning' },
            };
        case 'tool-call':
            return {
                ...base,
                kind: 'tool-call',
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                toolInput: event.input,
                ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
            };
        case 'tool-progress':
            return {
                ...base,
                kind: 'tool-progress',
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                progress: event.progress,
                ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
            };
        case 'tool-result':
            return {
                ...base,
                kind: 'tool-result',
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                output: event.output,
                ...(event.isError === undefined ? {} : { isError: event.isError }),
                ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
            };
        case 'transcript-message-committed':
            return event.role === 'user'
                ? { ...base, kind: 'transcript-user-text', text: event.text, localId: event.messageId }
                : {
                    ...base,
                    kind: 'transcript-agent-message-committed',
                    agentId: event.role === 'reasoning' ? 'reasoning' : 'agent',
                    localId: event.messageId,
                    body: { type: 'text', text: event.text },
                    ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
                };
        case 'file-edit':
            return {
                ...base,
                kind: 'diff-emit',
                origin: 'agent-runtime',
                diff: {
                    editId: event.editId,
                    path: event.path,
                    ...(event.description ? { description: event.description } : {}),
                    ...(event.diff ? { diff: event.diff } : {}),
                    ...(event.oldContent ? { oldContent: event.oldContent } : {}),
                    ...(event.newContent ? { newContent: event.newContent } : {}),
                },
            };
        case 'usage-observed': {
            const totals: Record<string, number> = {};
            for (const [key, value] of Object.entries(event.tokens ?? {})) {
                if (typeof value === 'number') totals[key] = value;
            }
            return { ...base, kind: 'token-count', source: event.source, scope: event.scope, totals };
        }
        case 'context-compaction':
            if (event.phase === 'outcomeUnknown') {
                return {
                    ...base,
                    kind: 'backend-error',
                    error: { message: diagnosticMessage(event.diagnostic), code: event.diagnostic.code },
                };
            }
            return {
                ...base,
                kind: 'context-compaction',
                phase: event.phase,
                lifecycleId: event.compactionId,
                source: 'agent-event',
                trigger: event.trigger === 'automatic' ? 'auto' : event.trigger,
                ...(event.turnId ? { turnId: event.turnId } : {}),
                ...('tokenCountBefore' in event && event.tokenCountBefore !== undefined
                    ? { tokenCountBefore: event.tokenCountBefore }
                    : {}),
                ...('tokenCountAfter' in event && event.tokenCountAfter !== undefined
                    ? { tokenCountAfter: event.tokenCountAfter }
                    : {}),
                ...('tokenCountSource' in event && event.tokenCountSource !== undefined
                    ? { tokenCountSource: event.tokenCountSource }
                    : {}),
            };
        case 'turn-rollback-boundary':
            return {
                ...base,
                kind: 'turn-rollback-boundary-observed',
                turnId: event.turnId,
                ...(context?.rollbackStartUserMessageSeq !== undefined
                    ? { startUserMessageSeq: context.rollbackStartUserMessageSeq }
                    : {}),
                ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                ...(typeof event.agentRollbackOrdinal === 'number'
                    ? { agentRollbackOrdinal: event.agentRollbackOrdinal }
                    : {}),
                ...(event.providerCheckpoint !== undefined
                    ? { providerCheckpoint: event.providerCheckpoint }
                    : {}),
            };
        case 'input-accepted':
        case 'input-rejected':
        case 'input-custody-unknown':
        case 'input-delivery-failed':
        case 'runtime-activity-snapshot':
            return null;
    }
}

function toUsageObservation(
    event: Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>,
    provider: string,
): UsageObservation {
    return {
        provider,
        source: event.source,
        scope: event.scope,
        key: null,
        modelId: event.modelId ?? event.context?.modelId ?? null,
        tokens: event.tokens ?? null,
        cost: event.cost ?? null,
        contextUsedTokens: event.context?.usedTokens ?? null,
        contextWindowTokens: event.context?.windowTokens ?? null,
        ...(event.context ? { contextSnapshot: event.context } : {}),
    };
}

type NativeInputCorrelation = Readonly<{
    inputId: string;
    turnId: string;
    deliveryKind: 'newTurn' | 'steer';
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;

function resolveNativeInputCorrelation(
    meta: RuntimeTurnPromptMeta | undefined,
    deliveryKind: NativeInputCorrelation['deliveryKind'],
    fallbackTurnId: string,
): NativeInputCorrelation | null {
    const suppliedIds = [
        ...(meta?.localId ? [meta.localId] : []),
        ...(meta?.localIds ?? []),
    ];
    if (suppliedIds.some((value) => readNonBlankOpaqueIdentifier(value) === null)) return null;
    const inputIds = [...new Set(suppliedIds)];
    if (inputIds.length !== 1) return null;
    const inputId = inputIds[0];
    if (!inputId) return null;
    return Object.freeze({
        inputId,
        turnId: meta?.turnId || fallbackTurnId,
        deliveryKind,
        userMessageSeq: meta?.userMessageSeq ?? null,
        ...(meta?.userMessageSeqs ? { userMessageSeqs: [...meta.userMessageSeqs] } : {}),
    });
}

function hasExactCorrelation(
    correlation: NativeInputCorrelation,
    event: Extract<AgentSessionRuntimeEvent, {
        kind: 'input-accepted' | 'input-rejected' | 'input-custody-unknown' | 'input-delivery-failed';
    }>,
): boolean {
    if (event.inputIds.length !== 1 || event.inputIds[0] !== correlation.inputId) return false;
    if (event.kind !== 'input-accepted' && event.kind !== 'input-delivery-failed') return true;
    return event.delivery.turnId === correlation.turnId
        && event.delivery.kind === correlation.deliveryKind;
}

function sanitizeNativeAgentSessionBoundaryError(
    error: unknown,
    forceSafeShape: boolean,
): unknown {
    if (!(error instanceof Error)) {
        return new Error(redactBugReportSensitiveText(String(error)));
    }
    const name =
        redactBugReportSensitiveText(error.name).trim()
        || 'Error';
    const message = redactBugReportSensitiveText(error.message);
    const stack = typeof error.stack === 'string'
        ? redactBugReportSensitiveText(error.stack)
        : undefined;
    const hasCause = 'cause' in error;
    if (
        !forceSafeShape
        && !hasCause
        && name === error.name
        && message === error.message
        && stack === error.stack
    ) {
        return error;
    }
    const sanitized = new Error(message);
    sanitized.name = name;
    if (stack !== undefined) {
        sanitized.stack = stack;
    }
    return sanitized;
}

function createAgentSessionContinuationUnreachableError(): Error {
    const error = new Error('Agent session continuation is unreachable.');
    error.name = AGENT_SESSION_CONTINUATION_UNREACHABLE_ERROR_NAME;
    return error;
}

export function createNativeAgentSessionOperations(
    session: AgentSessionRuntime,
    expectedSessionId: string,
    disposeRuntimeScope?: () => void | Promise<void>,
    expectedProviderSessionId?: string,
    usagePublisher?: NativeAgentSessionUsagePublisher,
    initialConfiguration?: AgentSessionConfigurationSnapshot,
    abortSessionScope?: () => void,
    directFacets?: NativeAgentSessionDirectFacets,
    publications?: NativeAgentSessionPublications,
    initialRollbackTurns: readonly Readonly<{
        turnId: string;
        userMessageSeq: number | null;
        providerCheckpoint: Exclude<
            Extract<AgentSessionRuntimeEvent, { kind: 'turn-rollback-boundary' }>['providerCheckpoint'],
            undefined
        >;
    }>[] = [],
    interactionLifecycle?: NativeAgentSessionInteractionLifecycle,
    sanitizeDisposeError?: (error: unknown) => unknown,
): PluginRuntimeHookOperations {
    let disposeStarted = false;
    let disposePromise: Promise<void> | null = null;
    const invariant = createAgentSessionTurnInvariant({
        sessionId: expectedSessionId,
        ...(expectedProviderSessionId ? { expectedProviderSessionId } : {}),
    });
    let deliveryOutcomeHandler: ((outcome: PluginRuntimePromptDeliveryOutcome) => void) | null = null;
    const inputCorrelations = new Map<string, NativeInputCorrelation>();
    const acceptedInputIds = new Set<string>();
    const rejectedInputIds = new Set<string>();
    const uncertainInputIds = new Set<string>();
    let nativeTurnOrdinal = 0;
    let configuration = initialConfiguration;
    const runtimeIncarnationId = randomUUID();
    const rollbackTurns: Array<Readonly<{
        turnId: string;
        localId?: string;
        userMessageSeq: number | null;
        providerCheckpoint?: Extract<
            AgentSessionRuntimeEvent,
            { kind: 'turn-rollback-boundary' }
        >['providerCheckpoint'];
        rollbackBoundaryEvent?: Extract<
            AgentSessionRuntimeEvent,
            { kind: 'turn-rollback-boundary' }
        >;
        didPublishRollbackBoundary?: boolean;
    }>> = initialRollbackTurns.map((turn) => Object.freeze({ ...turn }));
    const pendingRollbackJoinByLocalId = new Map<string, Readonly<{ turnId: string }>>();
    const listeners = new Set<(event: RuntimeEventV1) => void>();
    const canonicalListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    type NativeTurnTerminalEvent = Extract<
        RuntimeEventV1,
        { kind: 'turn-complete' | 'turn-cancelled' | 'turn-failed' }
    >;
    type NativeTurnCompletion = {
        readonly observedTurnIds: Set<string>;
        settled: boolean;
        error: Error | null;
        readonly waiters: Set<{
            resolve: () => void;
            reject: (error: Error) => void;
            timer: NodeJS.Timeout | null;
        }>;
    };
    let turnCompletion: NativeTurnCompletion | null = null;
    const ensureTurnCompletion = (): NativeTurnCompletion => {
        if (!turnCompletion || turnCompletion.settled) {
            turnCompletion = {
                observedTurnIds: new Set(),
                settled: false,
                error: null,
                waiters: new Set(),
            };
        }
        return turnCompletion;
    };
    const settleTurnCompletion = (event?: NativeTurnTerminalEvent, error?: Error): void => {
        const completion = turnCompletion;
        if (!completion || completion.settled) return;
        if (event) {
            const turnId = readNonBlankOpaqueIdentifier(event.turnId);
            if (completion.observedTurnIds.size > 0 && (!turnId || !completion.observedTurnIds.has(turnId))) return;
        }
        completion.settled = true;
        completion.error = error ?? (
            event?.kind === 'turn-failed'
                ? createRuntimeTurnFailureAlreadySurfacedError({
                    message: `Native Agent session turn failed${
                        event.issue.sanitizedPreview?.trim()
                            ? `: ${event.issue.sanitizedPreview.trim()}`
                            : ''
                    }`,
                    event,
                })
                : null
        );
        for (const waiter of Array.from(completion.waiters)) {
            if (waiter.timer) clearTimeout(waiter.timer);
            if (completion.error) waiter.reject(completion.error);
            else waiter.resolve();
        }
        completion.waiters.clear();
    };
    const observeTurnCompletion = (event: RuntimeEventV1): void => {
        const completion = turnCompletion;
        if (!completion || completion.settled) return;
        if (event.kind === 'turn-start') {
            const turnId = readNonBlankOpaqueIdentifier(event.turnId);
            if (turnId) completion.observedTurnIds.add(turnId);
            return;
        }
        if (
            event.kind === 'turn-complete'
            || event.kind === 'turn-cancelled'
            || event.kind === 'turn-failed'
        ) {
            settleTurnCompletion(event);
        }
    };
    const publishRuntimeEvent = (event: RuntimeEventV1): void => {
        observeTurnCompletion(event);
        for (const listener of listeners) listener(event);
    };
    const publishCachedRollbackBoundary = (index: number, userMessageSeq: number): void => {
        const current = rollbackTurns[index];
        if (!current?.rollbackBoundaryEvent || current.didPublishRollbackBoundary === true) return;
        const normalized = toRuntimeEvent(current.rollbackBoundaryEvent, {
            rollbackStartUserMessageSeq: userMessageSeq,
        });
        if (!normalized) return;
        rollbackTurns[index] = Object.freeze({
            ...current,
            userMessageSeq,
            didPublishRollbackBoundary: true,
        });
        publishRuntimeEvent(normalized);
    };
    const observeCommittedUserMessageSeq = (
        observation: Readonly<{ localId: string; seq: number }>,
    ): void => {
        if (disposeStarted) return;
        const localId = readNonBlankOpaqueIdentifier(observation.localId);
        if (localId === null
            || !Number.isSafeInteger(observation.seq)
            || observation.seq < 0) {
            return;
        }
        const pendingJoin = pendingRollbackJoinByLocalId.get(localId);
        if (!pendingJoin) return;
        pendingRollbackJoinByLocalId.delete(localId);

        const correlation = inputCorrelations.get(localId);
        if (
            correlation
            && correlation.turnId === pendingJoin.turnId
            && correlation.userMessageSeq === null
        ) {
            inputCorrelations.set(localId, Object.freeze({
                ...correlation,
                userMessageSeq: observation.seq,
                userMessageSeqs: Object.freeze([observation.seq]),
            }));
        }

        const index = rollbackTurns.findIndex(
            (turn) => turn.turnId === pendingJoin.turnId && turn.localId === localId,
        );
        if (index < 0) return;
        const current = rollbackTurns[index]!;
        if (current.userMessageSeq !== null) return;
        rollbackTurns[index] = Object.freeze({
            ...current,
            userMessageSeq: observation.seq,
        });
        publishCachedRollbackBoundary(index, observation.seq);
    };
    let unsubscribeCommittedUserMessageSeq: (() => void) | null = null;
    if (interactionLifecycle?.subscribeCommittedUserMessageSeq) {
        unsubscribeCommittedUserMessageSeq = interactionLifecycle.subscribeCommittedUserMessageSeq(
            observeCommittedUserMessageSeq,
        );
    }
    const emitDeliveryOutcome = (outcome: RuntimeExactProviderInputOutcome): void => {
        try {
            const { localInputId, ...rest } = outcome;
            deliveryOutcomeHandler?.({
                ...rest,
                localId: localInputId,
            });
        } catch {
            // Queue settlement owns retry/recovery. A consumer callback cannot corrupt runtime observation.
        }
    };
    const observeInputEvidence = (
        event: Extract<AgentSessionRuntimeEvent, {
            kind: 'input-accepted' | 'input-rejected' | 'input-custody-unknown' | 'input-delivery-failed';
        }>,
    ): void => {
        if (expectedSessionId && event.sessionId !== expectedSessionId) return;
        if (event.inputIds.length !== 1) return;
        const inputId = event.inputIds[0];
        const correlation = inputId ? inputCorrelations.get(inputId) : undefined;
        if (!correlation || !hasExactCorrelation(correlation, event)) return;
        if (acceptedInputIds.has(correlation.inputId) && event.kind !== 'input-delivery-failed') return;
        if (rejectedInputIds.has(correlation.inputId) && event.kind !== 'input-rejected') return;
        if (event.kind === 'input-custody-unknown' || event.kind === 'input-delivery-failed') {
            uncertainInputIds.add(correlation.inputId);
        }
        if (event.kind === 'input-rejected') {
            rejectedInputIds.add(correlation.inputId);
            uncertainInputIds.delete(correlation.inputId);
            pendingRollbackJoinByLocalId.delete(correlation.inputId);
        } else if (event.kind === 'input-accepted' && correlation.deliveryKind === 'steer') {
            inputCorrelations.delete(correlation.inputId);
            acceptedInputIds.delete(correlation.inputId);
            uncertainInputIds.delete(correlation.inputId);
        } else if (event.kind === 'input-accepted') {
            acceptedInputIds.add(correlation.inputId);
            uncertainInputIds.delete(correlation.inputId);
            if (correlation.userMessageSeq === null) {
                pendingRollbackJoinByLocalId.set(correlation.inputId, Object.freeze({
                    turnId: correlation.turnId,
                }));
                const alreadyCommittedSeq = interactionLifecycle?.getCommittedUserMessageSeq?.(
                    correlation.inputId,
                ) ?? null;
                if (alreadyCommittedSeq !== null) {
                    observeCommittedUserMessageSeq({
                        localId: correlation.inputId,
                        seq: alreadyCommittedSeq,
                    });
                }
            }
        } else {
            pendingRollbackJoinByLocalId.delete(correlation.inputId);
        }
        const identity = {
            localInputId: correlation.inputId,
            userMessageSeq: correlation.userMessageSeq,
            ...(correlation.userMessageSeqs ? { userMessageSeqs: correlation.userMessageSeqs } : {}),
        };
        if (event.kind === 'input-accepted') {
            emitDeliveryOutcome({
                type: 'input-accepted',
                ...identity,
                delivery: event.delivery,
            });
            return;
        }
        if (event.kind === 'input-rejected') {
            emitDeliveryOutcome({
                type: 'input-rejected',
                ...identity,
                diagnostic: event.diagnostic,
                retryable: event.retryable,
            });
            return;
        }
        if (event.kind === 'input-custody-unknown') {
            emitDeliveryOutcome({
                type: 'input-custody-unknown',
                ...identity,
                issue: event.issue,
            });
            return;
        }
        emitDeliveryOutcome({
            type: 'input-delivery-failed',
            ...identity,
            delivery: event.delivery,
            issue: event.issue,
            duplicateRisk: event.duplicateRisk,
        });
    };
    const observeNativeEvent = (input: AgentSessionRuntimeEvent): void => {
        if (
            input.sessionId === expectedSessionId
            && (
                input.kind === 'input-accepted'
                || input.kind === 'input-rejected'
                || input.kind === 'input-custody-unknown'
                || input.kind === 'input-delivery-failed'
            )
        ) {
            const correlatedInputId = input.inputIds.length === 1 ? input.inputIds[0] : null;
            const correlation = correlatedInputId ? inputCorrelations.get(correlatedInputId) : undefined;
            if (!correlation || !hasExactCorrelation(correlation, input)) {
                logger.warn('[NativeAgentSession] rejected conflicting Queue correlation evidence', {
                    code: 'agent_runtime_input_correlation_conflict',
                    eventKind: input.kind,
                    sequence: input.sequence,
                    ...(correlation ? { turnId: correlation.turnId } : {}),
                });
                return;
            }
        }
        const observation = invariant.observe(input);
        if (observation.status === 'rejected') {
            logger.warn('[NativeAgentSession] rejected canonical runtime event', {
                code: observation.diagnostic.code,
                eventKind: observation.diagnostic.details.eventKind,
                sequence: observation.diagnostic.details.sequence,
                ...(observation.diagnostic.details.turnId
                    ? { turnId: observation.diagnostic.details.turnId }
                    : {}),
            });
            return;
        }
        if (observation.status === 'ignored') return;
        const event = observation.event;
        if (
            interactionLifecycle
            && (
                event.kind === 'turn-complete'
                || event.kind === 'turn-failed'
                || event.kind === 'turn-cancelled'
            )
        ) {
            try {
                void Promise.resolve(interactionLifecycle.onTurnTerminal(event)).catch(() => {
                    logger.debug('[NativeAgentSession] failed to cancel turn-scoped interactions (non-fatal)');
                });
            } catch {
                logger.debug('[NativeAgentSession] failed to cancel turn-scoped interactions (non-fatal)');
            }
        }
        for (const listener of canonicalListeners) listener(event);
        if (event.kind === 'usage-observed' && usagePublisher) {
            try {
                void Promise.resolve(usagePublisher.publish({
                    observedAt: event.emittedAtMs,
                    observation: toUsageObservation(event, usagePublisher.provider),
                    turnId: event.turnId ?? null,
                    externalKey: event.observationId,
                })).catch(() => {
                    logger.debug('[NativeAgentSession] failed to publish usage observation (non-fatal)');
                });
            } catch {
                logger.debug('[NativeAgentSession] failed to publish usage observation (non-fatal)');
            }
        }
        if (
            event.kind === 'input-accepted'
            || event.kind === 'input-rejected'
            || event.kind === 'input-custody-unknown'
            || event.kind === 'input-delivery-failed'
        ) {
            observeInputEvidence(event);
            return;
        }
        if (event.kind === 'turn-start') {
            const correlation = [...inputCorrelations.values()].find(
                (candidate) => candidate.deliveryKind === 'newTurn' && candidate.turnId === event.turnId,
            );
            if (!rollbackTurns.some((turn) => turn.turnId === event.turnId)) {
                rollbackTurns.push(Object.freeze({
                    turnId: event.turnId,
                    ...(correlation ? { localId: correlation.inputId } : {}),
                    userMessageSeq: correlation?.userMessageSeq ?? null,
                }));
            }
            for (const [inputId, correlation] of inputCorrelations) {
                if (correlation.turnId !== event.turnId) continue;
                if (uncertainInputIds.has(inputId) || rejectedInputIds.has(inputId)) continue;
                inputCorrelations.delete(inputId);
                acceptedInputIds.delete(inputId);
                uncertainInputIds.delete(inputId);
            }
        }
        let rollbackStartUserMessageSeq: number | undefined;
        if (event.kind === 'turn-rollback-boundary') {
            const index = rollbackTurns.findIndex((turn) => turn.turnId === event.turnId);
            if (index >= 0) {
                const current = rollbackTurns[index]!;
                rollbackStartUserMessageSeq = current.userMessageSeq ?? undefined;
                rollbackTurns[index] = Object.freeze({
                    ...current,
                    rollbackBoundaryEvent: event,
                    ...(rollbackStartUserMessageSeq === undefined
                        ? {}
                        : { didPublishRollbackBoundary: true }),
                    ...(event.providerCheckpoint !== undefined
                        ? { providerCheckpoint: event.providerCheckpoint }
                        : {}),
                });
            }
            if (rollbackStartUserMessageSeq === undefined) return;
        }
        if (
            event.kind === 'turn-failed'
            || event.kind === 'turn-cancelled'
        ) {
            for (const [localId, pendingJoin] of pendingRollbackJoinByLocalId) {
                if (pendingJoin.turnId === event.turnId) {
                    pendingRollbackJoinByLocalId.delete(localId);
                }
            }
        }
        const normalized = toRuntimeEvent(
            event,
            rollbackStartUserMessageSeq === undefined
                ? undefined
                : { rollbackStartUserMessageSeq },
        );
        if (!normalized) return;
        publishRuntimeEvent(normalized);
    };
    let subscription: ReturnType<AgentSessionRuntime['watch']> | null = null;
    const ensureSubscription = (): void => {
        subscription ??= session.watch(observeNativeEvent);
    };
    const readPendingNewTurnId = (): string | null => {
        const pendingTurnIds = new Set(
            [...inputCorrelations.values()]
                .filter((correlation) => correlation.deliveryKind === 'newTurn')
                .map((correlation) => correlation.turnId),
        );
        return pendingTurnIds.size === 1 ? [...pendingTurnIds][0]! : null;
    };
    const createControlContext = (activity: 'active' | 'inactive'): AgentSessionControlContext => {
        if (!directFacets) throw new Error('Native Agent direct-facet context is unavailable');
        const providerSessionId = invariant.read().providerSessionId ?? undefined;
        return createNativeAgentSessionControlContext({
            context: directFacets.context,
            cwd: directFacets.cwd,
            activity,
            connectedAccounts: directFacets.connectedAccounts,
            ...(providerSessionId ? { providerSessionId } : {}),
        });
    };
    const activeControlUnavailable = (): boolean => disposeStarted
        || invariant.read().runtimeEnded
        || directFacets?.context.signal.aborted === true;
    const directHostControls: NativeAgentSessionDirectHostControls = directFacets
        ? Object.freeze({
            ...(directFacets.capabilities.conversationRollback === true && session.conversationRollback
                ? {
                    async rollbackConversation(request: SessionRollbackRpcParams): Promise<SessionRollbackRpcResult> {
                        const snapshot = invariant.read();
                        if (disposeStarted || snapshot.runtimeEnded || snapshot.activeTurnId !== null) {
                            return {
                                ok: false,
                                errorCode: 'native_conversation_rollback_not_idle',
                                errorMessage: 'Native Agent conversation rollback requires a live idle session.',
                            };
                        }
                        const providerSessionId = snapshot.providerSessionId;
                        if (!providerSessionId) {
                            return {
                                ok: false,
                                errorCode: 'native_conversation_rollback_provider_session_unavailable',
                                errorMessage: 'Native Agent conversation rollback requires a provider session identity.',
                            };
                        }
                        const targetUserMessageSeq = request.target.type === 'before_user_message'
                            ? request.target.userMessageSeq
                            : null;
                        const targetIndex = targetUserMessageSeq === null
                            ? rollbackTurns.length - 1
                            : rollbackTurns.findIndex(
                                (turn) => turn.userMessageSeq === targetUserMessageSeq,
                            );
                        if (targetIndex < 0) {
                            return {
                                ok: false,
                                errorCode: 'native_conversation_rollback_target_unavailable',
                                errorMessage: 'Native Agent conversation rollback target is unavailable.',
                            };
                        }
                        const targetTurn = rollbackTurns[targetIndex];
                        const affectedTurns = rollbackTurns.slice(targetIndex).map((turn) => Object.freeze({
                            turnId: turn.turnId,
                            ...(turn.providerCheckpoint !== undefined
                                ? { providerCheckpoint: turn.providerCheckpoint }
                                : {}),
                        }));
                        if (!targetTurn || affectedTurns.length === 0) {
                            return {
                                ok: false,
                                errorCode: 'native_conversation_rollback_target_unavailable',
                                errorMessage: 'Native Agent conversation rollback target is unavailable.',
                            };
                        }
                        const affectedTurnTuple: [
                            (typeof affectedTurns)[number],
                            ...(typeof affectedTurns)[number][],
                        ] = [
                            affectedTurns[0]!,
                            ...affectedTurns.slice(1),
                        ];
                        const rollbackRange = (() => {
                            const startSeqInclusive = targetTurn.userMessageSeq;
                            const endSeqInclusive = interactionLifecycle?.getLastObservedMessageSeq?.();
                            if (
                                startSeqInclusive === null
                                || !Number.isSafeInteger(startSeqInclusive)
                                || startSeqInclusive < 0
                                || typeof endSeqInclusive !== 'number'
                                || !Number.isSafeInteger(endSeqInclusive)
                                || endSeqInclusive < startSeqInclusive
                            ) {
                                return null;
                            }
                            return Object.freeze({
                                startSeqInclusive,
                                endSeqInclusive,
                            });
                        })();
                        const nativeRequest = Object.freeze({
                            operationId: randomUUID(),
                            target: Object.freeze({ kind: 'beforeTurn' as const, turnId: targetTurn.turnId }),
                            affectedTurns: affectedTurnTuple,
                            providerSessionId,
                            runtimeIncarnationId,
                        });
                        const context = createControlContext('active');
                        const options = Object.freeze({ signal: context.signal });
                        const result = await session.conversationRollback!.rollback(
                            nativeRequest,
                            options,
                        );
                        let applied = result.status === 'applied';
                        if (result.status === 'outcomeUnknown') {
                            const reconciled = await session.conversationRollback!.reconcile(
                                nativeRequest,
                                options,
                            );
                            if (reconciled.status === 'applied') {
                                applied = true;
                            } else {
                                if (reconciled.status === 'notApplied') {
                                    return {
                                        ok: false,
                                        errorCode: 'native_conversation_rollback_not_applied',
                                        errorMessage: 'Native Agent conversation rollback was not applied.',
                                    };
                                }
                                if (!('diagnostic' in reconciled)) {
                                    return {
                                        ok: false,
                                        errorCode: 'native_conversation_rollback_reconciliation_invalid',
                                        errorMessage: 'Native Agent conversation rollback reconciliation was inconclusive.',
                                    };
                                }
                                const code = reconciled.diagnostic.code;
                                return {
                                    ok: false,
                                    errorCode: code,
                                    errorMessage: reconciled.diagnostic.message ?? code,
                                };
                            }
                        } else if (result.status !== 'applied') {
                            return {
                                ok: false,
                                errorCode: result.diagnostic.code,
                                errorMessage: result.diagnostic.message ?? result.diagnostic.code,
                            };
                        }
                        if (rollbackRange && interactionLifecycle?.updateMetadata) {
                            const rolledBackAt = Date.now();
                            await Promise.resolve(interactionLifecycle.updateMetadata((current) => {
                                const existing = readSessionRollbackRangesV1FromMetadata(current);
                                return {
                                    ...current,
                                    sessionRollbackRangesV1: buildSessionRollbackRangesV1({
                                        updatedAt: rolledBackAt,
                                        ranges: [
                                            ...(existing?.ranges ?? []),
                                            {
                                                target: request.target,
                                                ...rollbackRange,
                                                rolledBackAt,
                                            },
                                        ],
                                    }),
                                };
                            })).catch((error) => {
                                logger.debug(
                                    '[NativeAgentSession] failed to publish conversation rollback range metadata (non-fatal)',
                                    error,
                                );
                            });
                        }
                        const removedTurns = rollbackTurns.splice(targetIndex);
                        const restoredToTurnId = removedTurns[0]!.turnId;
                        const emittedAtMs = Date.now();
                        for (const removedTurn of removedTurns) {
                            const boundary = removedTurn.rollbackBoundaryEvent;
                            publishRuntimeEvent({
                                kind: 'turn-rollback-applied',
                                sessionId: expectedSessionId,
                                emittedAtMs,
                                turnId: removedTurn.turnId,
                                restoredToTurnId,
                                ...(boundary?.agentTurnId
                                    ? { agentTurnId: boundary.agentTurnId }
                                    : {}),
                                ...(typeof boundary?.agentRollbackOrdinal === 'number'
                                    ? { agentRollbackOrdinal: boundary.agentRollbackOrdinal }
                                    : {}),
                            });
                        }
                        for (const removedTurn of removedTurns) {
                            if (removedTurn.localId) {
                                pendingRollbackJoinByLocalId.delete(removedTurn.localId);
                            }
                        }
                        return {
                            ok: true,
                            target: request.target,
                            threadId: providerSessionId,
                        };
                    },
                }
                : {}),
            ...(directFacets.capabilities.goals?.active && directFacets.goals
                ? {
                    async refreshGoal() {
                        if (activeControlUnavailable()) {
                            return directControlFailureResult({
                                status: 'unavailable',
                                diagnostic: { code: 'native_goal_control_unavailable' },
                            });
                        }
                        const context = createControlContext('active');
                        const goalContext = Object.freeze({
                            ...context,
                            goalSource: directFacets.context.workState.publisher(
                                directFacets.capabilities.goals!.source,
                            ),
                        });
                        const result = await directFacets.goals!.get(goalContext, { signal: context.signal });
                        return result.status === 'applied' || result.status === 'unchanged' || result.status === 'pending'
                            ? result
                            : directControlFailureResult(result);
                    },
                    async setGoal(
                        objective: string | undefined,
                        options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
                    ) {
                        if (activeControlUnavailable()) {
                            return directControlFailureResult({
                                status: 'unavailable',
                                diagnostic: { code: 'native_goal_control_unavailable' },
                            });
                        }
                        const status = options?.status;
                        if (status !== undefined && status !== 'active' && status !== 'paused' && status !== 'complete') {
                            return directControlFailureResult({
                                status: 'rejected',
                                diagnostic: { code: 'native_goal_status_unsupported' },
                            });
                        }
                        const hasTokenBudget = options !== undefined
                            && Object.prototype.hasOwnProperty.call(options, 'tokenBudget');
                        let mutation: AgentSessionGoalMutation;
                        if (objective !== undefined) {
                            mutation = Object.freeze({
                                objective,
                                ...(status === undefined ? {} : { status }),
                                ...(hasTokenBudget ? { tokenBudget: options?.tokenBudget ?? null } : {}),
                            });
                        } else if (status !== undefined) {
                            mutation = Object.freeze({
                                status,
                                ...(hasTokenBudget ? { tokenBudget: options?.tokenBudget ?? null } : {}),
                            });
                        } else if (hasTokenBudget) {
                            mutation = Object.freeze({ tokenBudget: options?.tokenBudget ?? null });
                        } else {
                            return directControlFailureResult({
                                status: 'rejected',
                                diagnostic: { code: 'native_goal_mutation_required' },
                            });
                        }
                        const context = createControlContext('active');
                        const goalContext = Object.freeze({
                            ...context,
                            goalSource: directFacets.context.workState.publisher(
                                directFacets.capabilities.goals!.source,
                            ),
                        });
                        const result = await directFacets.goals!.set(mutation, goalContext, { signal: context.signal });
                        return result.status === 'applied'
                            || result.status === 'unchanged'
                            || result.status === 'pending'
                            || result.status === 'scheduledForResume'
                            ? result
                            : directControlFailureResult(result);
                    },
                    async clearGoal() {
                        if (activeControlUnavailable()) {
                            return directControlFailureResult({
                                status: 'unavailable',
                                diagnostic: { code: 'native_goal_control_unavailable' },
                            });
                        }
                        const context = createControlContext('active');
                        const goalContext = Object.freeze({
                            ...context,
                            goalSource: directFacets.context.workState.publisher(
                                directFacets.capabilities.goals!.source,
                            ),
                        });
                        const result = await directFacets.goals!.clear(goalContext, { signal: context.signal });
                        return result.status === 'applied'
                            || result.status === 'unchanged'
                            || result.status === 'pending'
                            || result.status === 'scheduledForResume'
                            ? result
                            : directControlFailureResult(result);
                    },
                }
                : {}),
            ...(directFacets.capabilities.catalog?.active && directFacets.catalog
                ? {
                    ...(directFacets.capabilities.catalog.active.includes('vendorPlugins')
                        ? {
                            async listVendorPlugins() {
                                if (activeControlUnavailable()) {
                                    return {
                                        unsupported: true,
                                        vendorPlugins: [],
                                        diagnostic: 'native_vendor_plugin_catalog_unavailable',
                                    };
                                }
                                const context = createControlContext('active');
                                const result = await directFacets.catalog!.list(
                                    { kind: 'vendorPlugins' },
                                    context,
                                    { signal: context.signal },
                                );
                                if (result.status !== 'ok' || result.kind !== 'vendorPlugins') {
                                    const diagnostic = result.status === 'ok'
                                        ? 'native_vendor_plugin_catalog_kind_mismatch'
                                        : result.diagnostic.code;
                                    return {
                                        unsupported: true,
                                        vendorPlugins: [],
                                        diagnostic,
                                    };
                                }
                                return {
                                    vendorPlugins: result.items.map((item) => ({
                                        vendorPluginRef: item.id,
                                        name: item.name,
                                        displayName: item.displayName,
                                        ...(item.description ? { description: item.description } : {}),
                                        installed: item.installed,
                                        enabled: item.enabled,
                                        mentionable: item.mentionable,
                                    })),
                                };
                            },
                        }
                        : {}),
                    ...(directFacets.capabilities.catalog.active.includes('skills')
                        ? {
                            async listSkills() {
                                if (activeControlUnavailable()) {
                                    return {
                                        unsupported: true,
                                        skills: [],
                                        diagnostic: 'native_skill_catalog_unavailable',
                                    };
                                }
                                const context = createControlContext('active');
                                const result = await directFacets.catalog!.list(
                                    { kind: 'skills' },
                                    context,
                                    { signal: context.signal },
                                );
                                if (result.status !== 'ok' || result.kind !== 'skills') {
                                    const diagnostic = result.status === 'ok'
                                        ? 'native_skill_catalog_kind_mismatch'
                                        : result.diagnostic.code;
                                    return {
                                        unsupported: true,
                                        skills: [],
                                        diagnostic,
                                    };
                                }
                                return {
                                    skills: result.items.map((item) => ({
                                        v: 1 as const,
                                        id: item.id,
                                        origin: 'vendor' as const,
                                        backendId: directFacets.context.agent.id,
                                        agentId: directFacets.context.agent.id,
                                        name: item.name,
                                        displayName: item.displayName,
                                        ...(item.description ? { description: item.description } : {}),
                                        ...(item.path ? { path: item.path } : {}),
                                        enabled: item.enabled,
                                    })),
                                };
                            },
                        }
                        : {}),
                }
                : {}),
            ...(directFacets.capabilities.usageLimitRecovery?.active && directFacets.usageLimitRecovery
                ? {
                    ...(directFacets.capabilities.usageLimitRecovery.active.includes('checkNow')
                        ? {
                            async checkUsageLimitRecoveryNow(request: Readonly<{
                                sessionId: string;
                                agentId?: string;
                                resumePromptMode?: 'standard' | 'off' | 'custom';
                            }>) {
                                if (activeControlUnavailable()) {
                                    return {
                                        status: 'unavailable' as const,
                                        diagnostic: {
                                            code: 'native_usage_limit_recovery_unavailable',
                                            severity: 'error' as const,
                                        },
                                        retryable: true,
                                    };
                                }
                                const context = createControlContext('active');
                                return await directFacets.usageLimitRecovery!.execute({
                                    kind: 'checkNow',
                                    ...(request.resumePromptMode
                                        ? { resumePromptMode: request.resumePromptMode }
                                        : {}),
                                }, context, { signal: context.signal });
                            },
                        }
                        : {}),
                    ...(directFacets.capabilities.usageLimitRecovery.active.includes('consumeResetCredit')
                        ? {
                            async consumeUsageLimitResetCredit(request: Readonly<{
                                sessionId: string;
                                agentId?: string;
                                issueFingerprint?: string;
                                resumePromptMode?: 'standard' | 'off' | 'custom';
                            }>) {
                                if (activeControlUnavailable()) {
                                    return {
                                        status: 'unavailable' as const,
                                        diagnostic: {
                                            code: 'native_usage_limit_recovery_unavailable',
                                            severity: 'error' as const,
                                        },
                                        retryable: true,
                                    };
                                }
                                const context = createControlContext('active');
                                if (!request.issueFingerprint) {
                                    return directControlFailureResult({
                                        status: 'rejected',
                                        diagnostic: { code: 'usage_limit_issue_fingerprint_required' },
                                    });
                                }
                                return await directFacets.usageLimitRecovery!.execute({
                                    kind: 'consumeResetCredit',
                                    issueFingerprint: request.issueFingerprint,
                                }, context, { signal: context.signal });
                            },
                        }
                        : {}),
                }
                : {}),
        })
        : Object.freeze({});
    return Object.freeze({
        ...directHostControls,
        ...(publications
            ? {
                models: publications.modelsSource,
                supportsInFlightSteer: () => (
                    directFacets?.capabilities.delivery.includes('steer') === true
                    && publications.readActiveInputBinding() !== null
                ),
                isTurnInFlight: () => {
                    try {
                        return publications.readActiveInputBinding()?.isTurnInFlight() === true;
                    } catch {
                        return false;
                    }
                },
                canSteerPrompt: () => {
                    try {
                        return publications.readActiveInputBinding()?.canSteer() === true;
                    } catch {
                        return false;
                    }
                },
                notifyPromptQueuedDuringTurn: () => {
                    try {
                        publications.readActiveInputBinding()?.onPromptQueued();
                    } catch {
                        // Queue ownership cannot be corrupted by a provider notification failure.
                    }
                },
                async applyConfigDeltaInFlight(delta: Readonly<{ permissionMode: string }>) {
                    const binding = publications.readActiveInputBinding();
                    const permissionIntent = parsePermissionIntentAlias(delta.permissionMode);
                    if (!binding || !permissionIntent) {
                        return {
                            status: 'unsupported' as const,
                            reason: binding
                                ? 'native_agent_permission_intent_invalid'
                                : 'native_agent_active_input_unavailable',
                        };
                    }
                    try {
                        return await binding.applyPermissionIntentDuringTurn(permissionIntent);
                    } catch (error) {
                        return {
                            status: 'failed' as const,
                            reason: error instanceof Error ? error.message : 'native_agent_in_flight_configuration_failed',
                        };
                    }
                },
                async clearTerminalComposer(request: Readonly<{
                    sessionId: string;
                    expectedStateAtMs?: number;
                }>) {
                    const binding = publications.readActiveInputBinding();
                    if (request.sessionId !== expectedSessionId || !binding) {
                        return {
                            ok: false as const,
                            status: 'unsupported' as const,
                            sessionId: expectedSessionId,
                            errorCode: 'unsupported_session_runtime_method',
                            error: request.sessionId !== expectedSessionId
                                ? 'native_agent_terminal_composer_session_mismatch'
                                : 'native_agent_active_input_unavailable',
                        };
                    }
                    try {
                        const result = await binding.clearTerminalComposer({
                            ...(request.expectedStateAtMs === undefined
                                ? {}
                                : { expectedStateAtMs: request.expectedStateAtMs }),
                        });
                        return { ...result, sessionId: expectedSessionId };
                    } catch (error) {
                        return {
                            ok: false as const,
                            status: 'failed' as const,
                            sessionId: expectedSessionId,
                            errorCode: 'native_agent_terminal_composer_clear_failed',
                            error: error instanceof Error ? error.message : 'native_agent_terminal_composer_clear_failed',
                        };
                    }
                },
                async interruptPendingInputAndRun(request: Readonly<{
                    sessionId: string;
                    localId: string;
                    expectedStateAtMs?: number;
                }>) {
                    const binding = publications.readActiveInputBinding();
                    if (request.sessionId !== expectedSessionId || !binding) {
                        return {
                            ok: false as const,
                            status: 'unsupported' as const,
                            sessionId: expectedSessionId,
                            localId: request.localId,
                            errorCode: 'unsupported_session_runtime_method',
                            error: 'native_agent_active_input_unavailable',
                        };
                    }
                    try {
                        const result = await binding.interruptPendingInputAndRun({
                            localId: request.localId,
                            ...(request.expectedStateAtMs === undefined
                                ? {}
                                : { expectedStateAtMs: request.expectedStateAtMs }),
                        });
                        return { ...(result as Record<string, unknown>), sessionId: expectedSessionId, localId: request.localId };
                    } catch (error) {
                        return {
                            ok: false as const,
                            status: 'interrupt_failed' as const,
                            sessionId: expectedSessionId,
                            localId: request.localId,
                            error: error instanceof Error ? error.message : 'native_agent_pending_input_interrupt_failed',
                        };
                    }
                },
            }
            : {}),
        beginTurnLifecycle() {
            ensureTurnCompletion();
        },
        subscribeRuntimeEvents(handler) {
            listeners.add(handler);
            if (!disposeStarted) ensureSubscription();
            return () => listeners.delete(handler);
        },
        subscribeCanonicalAgentSessionEvents(handler) {
            canonicalListeners.add(handler);
            if (!disposeStarted) ensureSubscription();
            return () => canonicalListeners.delete(handler);
        },
        async sendTurnPrompt(prompt: string, meta?: RuntimeTurnPromptMeta): Promise<void> {
            const fallbackTurnId = meta?.turnId
                || `native-turn-${runtimeIncarnationId}-${++nativeTurnOrdinal}`;
            const correlation = resolveNativeInputCorrelation(meta, 'newTurn', fallbackTurnId);
            if (!correlation) {
                throw new Error('Native Agent runtime delivery requires exactly one Queue localId');
            }
            if (disposeStarted || invariant.read().runtimeEnded) {
                throw new Error('Native Agent runtime is ended, disposing, or disposed');
            }
            ensureTurnCompletion();
            ensureSubscription();
            if (inputCorrelations.has(correlation.inputId)) {
                throw new Error('Native Agent runtime delivery cannot reuse an in-flight Queue localId');
            }
            inputCorrelations.set(correlation.inputId, correlation);
            const structuredInput = AgentRuntimeJsonValueV1Schema.safeParse(meta?.structuredInput);
            let result: Awaited<ReturnType<AgentSessionRuntime['send']>>;
            try {
                result = await session.send({
                    inputIds: [correlation.inputId],
                    input: {
                        text: prompt,
                        ...(structuredInput.success ? { structuredInput: structuredInput.data } : {}),
                    },
                    delivery: correlation.deliveryKind === 'steer'
                        ? { kind: 'steer', turnId: correlation.turnId }
                        : { kind: 'newTurn', turnId: correlation.turnId },
                });
            } catch (error) {
                if (!acceptedInputIds.has(correlation.inputId) && !uncertainInputIds.has(correlation.inputId)) {
                    uncertainInputIds.add(correlation.inputId);
                    emitDeliveryOutcome({
                        type: 'input-custody-unknown',
                        localInputId: correlation.inputId,
                        userMessageSeq: correlation.userMessageSeq,
                        ...(correlation.userMessageSeqs ? { userMessageSeqs: correlation.userMessageSeqs } : {}),
                        issue: {
                            code: 'native_send_outcome_unknown',
                            severity: 'error',
                        },
                    });
                }
                throw error;
            }
            if (result.status !== 'admitted') {
                if (
                    !acceptedInputIds.has(correlation.inputId)
                    && !rejectedInputIds.has(correlation.inputId)
                    && !uncertainInputIds.has(correlation.inputId)
                ) {
                    rejectedInputIds.add(correlation.inputId);
                    uncertainInputIds.delete(correlation.inputId);
                    emitDeliveryOutcome({
                        type: 'input-rejected',
                        localInputId: correlation.inputId,
                        userMessageSeq: correlation.userMessageSeq,
                        ...(correlation.userMessageSeqs ? { userMessageSeqs: correlation.userMessageSeqs } : {}),
                        diagnostic: result.diagnostic,
                        retryable: result.retryable,
                    });
                }
            }
            if (result.status !== 'admitted') {
                throw new Error(
                    `Native Agent runtime rejected prompt with status '${result.status}': ${
                        diagnosticMessage(result.diagnostic)
                    }`,
                );
            }
        },
        async steerInFlightTurn(message: string, meta?: RuntimeTurnPromptMeta): Promise<void> {
            const activeTurnId = invariant.read().activeTurnId ?? readPendingNewTurnId();
            if (!activeTurnId) {
                throw new Error('Native Agent runtime steer requires an active turn id');
            }
            const correlation = resolveNativeInputCorrelation(
                meta ? { ...meta, turnId: activeTurnId } : { turnId: activeTurnId },
                'steer',
                activeTurnId,
            );
            if (!correlation) {
                throw new Error('Native Agent runtime delivery requires exactly one Queue localId');
            }
            if (disposeStarted || invariant.read().runtimeEnded) {
                throw new Error('Native Agent runtime is ended, disposing, or disposed');
            }
            ensureTurnCompletion();
            ensureSubscription();
            if (inputCorrelations.has(correlation.inputId)) {
                throw new Error('Native Agent runtime delivery cannot reuse an in-flight Queue localId');
            }
            inputCorrelations.set(correlation.inputId, correlation);
            const structuredInput = AgentRuntimeJsonValueV1Schema.safeParse(meta?.structuredInput);
            const result = await session.send({
                inputIds: [correlation.inputId],
                input: {
                    text: message,
                    ...(structuredInput.success ? { structuredInput: structuredInput.data } : {}),
                },
                delivery: { kind: 'steer', turnId: activeTurnId },
            });
            if (result.status !== 'admitted') {
                if (
                    !acceptedInputIds.has(correlation.inputId)
                    && !rejectedInputIds.has(correlation.inputId)
                    && !uncertainInputIds.has(correlation.inputId)
                ) {
                    rejectedInputIds.add(correlation.inputId);
                    emitDeliveryOutcome({
                        type: 'input-rejected',
                        localInputId: correlation.inputId,
                        userMessageSeq: correlation.userMessageSeq,
                        ...(correlation.userMessageSeqs ? { userMessageSeqs: correlation.userMessageSeqs } : {}),
                        diagnostic: result.diagnostic,
                        retryable: result.retryable,
                    });
                }
                throw new Error(
                    `Native Agent runtime rejected steer with status '${result.status}': ${
                        diagnosticMessage(result.diagnostic)
                    }`,
                );
            }
        },
        async waitForTurnCompletion(opts?: RuntimeTurnCompletionOptions): Promise<void> {
            const completion = turnCompletion ?? ensureTurnCompletion();
            if (completion.settled) {
                if (completion.error) throw completion.error;
                return;
            }
            const requestedTimeoutMs = opts?.timeoutMs;
            const timeoutMs = requestedTimeoutMs === null
                ? null
                : (
                    typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)
                        ? Math.max(0, Math.trunc(requestedTimeoutMs))
                        : 30 * 60_000
                );
            await new Promise<void>((resolve, reject) => {
                const waiter = {
                    resolve: () => {
                        completion.waiters.delete(waiter);
                        resolve();
                    },
                    reject: (error: Error) => {
                        completion.waiters.delete(waiter);
                        reject(error);
                    },
                    timer: null as NodeJS.Timeout | null,
                };
                completion.waiters.add(waiter);
                if (timeoutMs !== null) {
                    waiter.timer = setTimeout(() => {
                        const turnIds = [...completion.observedTurnIds];
                        settleTurnCompletion(
                            undefined,
                            new Error(
                                `Native Agent session turn did not complete within ${timeoutMs}ms${
                                    turnIds.length > 0 ? ` (${turnIds.join(', ')})` : ''
                                }`,
                            ),
                        );
                    }, timeoutMs);
                    waiter.timer.unref?.();
                }
            });
        },
        readSessionIdentity() {
            return { sessionId: invariant.read().providerSessionId };
        },
        setOnPromptDeliveryOutcome(handler) {
            deliveryOutcomeHandler = handler;
            if (handler && !disposeStarted) ensureSubscription();
        },
        async updateSessionRuntimeConfig(update) {
            if (disposeStarted || invariant.read().runtimeEnded) {
                return {
                    status: 'failed',
                    reason: 'Native Agent runtime is ended, disposing, or disposed',
                };
            }
            if (!session.updateConfiguration || !configuration) {
                return {
                    status: 'unsupported',
                    timing: 'not_applicable',
                    reason: 'native_agent_configuration_unsupported',
                };
            }
            const nextConfiguration = applyNativeAgentConfigurationUpdate(configuration, update);
            const result = await session.updateConfiguration(nextConfiguration.request);
            if (result.status === 'applied' || result.status === 'deferred') {
                configuration = nextConfiguration.snapshot;
            }
            return toHostConfigurationOutcome(result);
        },
        async cancelTurn() {
            if (disposeStarted || invariant.read().runtimeEnded) return;
            ensureSubscription();
            const turnId = invariant.read().activeTurnId ?? readPendingNewTurnId();
            if (!turnId || !session.cancel) return;
            const result = await session.cancel({
                turnId,
                reason: 'user',
            });
            if (result.status === 'requested' || result.status === 'notRunning') return;
            throw new Error(
                result.diagnostic
                    ? diagnosticMessage(result.diagnostic)
                    : `Native Agent runtime cancel is ${result.status}`,
            );
        },
        ...(session.compact
            ? {
                async compactContext(command: string) {
                    if (disposeStarted || invariant.read().runtimeEnded) {
                        throw new Error('Native Agent runtime is ended, disposing, or disposed');
                    }
                    ensureSubscription();
                    const normalized = command.trim();
                    const instructions = normalized.replace(/^\/compact(?:\s+|$)/u, '').trim();
                    const result = await session.compact?.({
                        compactionId: `host-compact-${randomUUID()}`,
                        trigger: 'manual',
                        ...(instructions ? { instructions } : {}),
                    });
                    if (!result || result.status !== 'admitted') {
                        throw new Error(result && 'diagnostic' in result
                            ? diagnosticMessage(result.diagnostic)
                            : 'Native Agent compaction is unavailable');
                    }
                },
            }
            : {}),
        async resetOrDisposeRuntime(reason) {
            if (disposePromise) return await disposePromise;
            disposeStarted = true;
            disposePromise = Promise.resolve().then(async () => {
                abortSessionScope?.();
                try {
                    await session.dispose(reason);
                } catch (error) {
                    throw sanitizeDisposeError
                        ? sanitizeDisposeError(error)
                        : error;
                } finally {
                    try {
                        await disposeRuntimeScope?.();
                    } finally {
                        for (const correlation of inputCorrelations.values()) {
                            if (acceptedInputIds.has(correlation.inputId)) continue;
                            if (rejectedInputIds.has(correlation.inputId)) continue;
                            if (uncertainInputIds.has(correlation.inputId)) continue;
                            emitDeliveryOutcome({
                                type: 'input-custody-unknown',
                                localInputId: correlation.inputId,
                                userMessageSeq: correlation.userMessageSeq,
                                ...(correlation.userMessageSeqs ? { userMessageSeqs: correlation.userMessageSeqs } : {}),
                                issue: {
                                    code: 'native_runtime_disposed_with_input_in_flight',
                                    severity: 'warning',
                                },
                            });
                        }
                        inputCorrelations.clear();
                        acceptedInputIds.clear();
                        rejectedInputIds.clear();
                        uncertainInputIds.clear();
                        pendingRollbackJoinByLocalId.clear();
                        unsubscribeCommittedUserMessageSeq?.();
                        unsubscribeCommittedUserMessageSeq = null;
                        invariant.fence();
                        deliveryOutcomeHandler = null;
                        subscription?.dispose();
                        subscription = null;
                        listeners.clear();
                        canonicalListeners.clear();
                    }
                }
            });
            return await disposePromise;
        },
    });
}

function openNativeAgentSessionUntilAbort(
    open: () => AgentSessionRuntime | Promise<AgentSessionRuntime>,
    signal: AbortSignal,
): Promise<AgentSessionRuntime> {
    if (signal.aborted) {
        return Promise.reject(
            signal.reason instanceof Error
                ? signal.reason
                : new Error('Native Agent session open was aborted'),
        );
    }
    const opening = Promise.resolve().then(open);
    return new Promise<AgentSessionRuntime>((resolve, reject) => {
        let settled = false;
        const removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (settled) return;
            settled = true;
            removeAbortListener();
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new Error('Native Agent session open was aborted'),
            );
            void opening.then(
                async (lateSession) => await lateSession.dispose('runtime_recovery'),
                () => undefined,
            ).catch(() => undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        opening.then(
            (session) => {
                if (settled) return;
                settled = true;
                removeAbortListener();
                resolve(session);
            },
            (error: unknown) => {
                if (settled) return;
                settled = true;
                removeAbortListener();
                reject(error);
            },
        );
        if (signal.aborted) onAbort();
    });
}

export async function createNativeAgentRuntimeSessionPlan(params: Readonly<{
    runtime: AgentRuntime;
    identity?: Readonly<{
        pluginId: string;
        pluginVersion: string;
        agentId: string;
        generation: string;
        immutableGenerationId?: string | null;
        /**
         * Local liveness hint only. Authoritative generation admission remains
         * with the daemon-held registration when the runtime is proxied.
         */
        isCurrent(): boolean;
    }>;
    /** Direct in-process callers may provide the real registration lease. */
    lease?: AgentRuntimeRegistrationLease;
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    sessionInput: PluginSessionBindingInput;
    executionSurfaces?: Partial<Pick<BackendExecutionSurfaces, 'externalSession' | 'terminalRuntime'>>;
    externalSessionHostOperations?: Readonly<{
        bindSession(sessionId: string): ExternalSessionHostOperationPort;
    }> | null;
    createSessionHostServiceOwners(input: Readonly<{
        hostRuntimeParams: HostSessionRuntimeFactoryParams;
        sessionId: string;
        directory: string;
        signal: AbortSignal;
    }>): NativeAgentSessionHostServiceOwners;
    createInvocationServices?: (input: Readonly<{
        correlationId: string;
        cwd: string;
        environment: Readonly<Record<string, string>>;
        providerBindingActive: boolean;
        signal: AbortSignal;
        session: Readonly<{
            id: string;
            current: HostCurrentSessionUiServices;
        }>;
    }>) => PluginServices;
    reportSessionMetadataToDaemon?: (input: Readonly<{
        sessionId: string;
        metadata: Metadata;
    }>) => Promise<void>;
    generationSignal?: AbortSignal;
    daemonAgentRuntimeCarrierRetirementSignal?: AbortSignal;
    agentSessionRealtimeVoiceAuthority?:
        HostSessionRuntimeConfig['agentSessionRealtimeVoiceAuthority'];
}>): Promise<HostSessionRuntimePlan> {
    const identity = params.identity ?? params.lease;
    if (!identity) {
        throw new Error('Native Agent runtime identity is required');
    }
    const contributionId = params.agent.identity?.localId ?? identity.agentId;
    const sessions = params.runtime.sessions;
    if (!sessions) {
        throw new Error(`Agent runtime '${identity.agentId}' does not support host sessions`);
    }
    let initialTerminalFollowProviderSession:
        Parameters<
            typeof createHostTerminalTranscriptFollowService
        >[0]['followProviderSession'] | null = null;
    let initialTerminalTranscriptFollowSignal: AbortSignal | null = null;
    const plan = await createNativeAgentHostSessionRuntimePlan({
        backend: params.backend,
        agent: params.agent,
        sessionInput: params.sessionInput,
        ...(params.agentSessionRealtimeVoiceAuthority
            ? {
                agentSessionRealtimeVoiceAuthority:
                    params.agentSessionRealtimeVoiceAuthority,
            }
            : {}),
        ...(params.daemonAgentRuntimeCarrierRetirementSignal
            ? {
                daemonAgentRuntimeCarrierRetirementSignal:
                    params.daemonAgentRuntimeCarrierRetirementSignal,
            }
            : {}),
        ...(params.agent.provenance === 'external'
            ? {
                registeredAgentIdentity: Object.freeze({
                    kind: 'registered_external_agent' as const,
                    pluginId: identity.pluginId,
                    agentId: identity.agentId,
                }),
            }
            : {}),
        createSessionRuntime: async (openIntent, hostRuntimeParams) => {
            const sessionId = hostRuntimeParams.session.sessionId;
            const cwd = hostRuntimeParams.directory;
            if (!sessionId || !cwd) {
                throw new Error(`Agent runtime '${identity.agentId}' requires a session id and working directory`);
            }
            const sessionCapabilities = readAgentSessionCapabilities(
                params.agent.richDefinition?.definition,
            );
            const resumeId = openIntent.kind === 'resume'
                ? openIntent.providerSessionId
                : null;
            const nativeForkSource = openIntent.kind === 'fork'
                ? parseNativeAgentForkSource(openIntent.source)
                : null;
            if (openIntent.kind === 'fork' && !nativeForkSource) {
                throw new Error('Native Agent fork source is invalid');
            }
            if (!sessionCapabilities?.open.includes(openIntent.kind)) {
                throw new Error(
                    `Native Agent '${identity.agentId}' does not declare sessions.open ${openIntent.kind} support`,
                );
            }
            let openInputs = buildNativeAgentSessionOpenInputs(
                params.sessionInput,
                hostRuntimeParams.metadata,
                hostRuntimeParams.providerBindingMaterialization,
                hostRuntimeParams.getPermissionMode(),
                {
                    allowPendingProviderBinding:
                        params.sessionInput.bootstrap.resolveLateEnvironment
                        !== undefined,
                },
            );
            const ownedAbortController = new AbortController();
            const signal = AbortSignal.any([
                ownedAbortController.signal,
                ...(params.generationSignal ? [params.generationSignal] : []),
            ]);
            const assertGenerationCurrent = () => {
                signal.throwIfAborted();
                let current = false;
                try {
                    current = identity.isCurrent();
                } catch {
                    // A failed currentness probe is not authority to enter the generation.
                }
                if (!current) {
                    throw new Error(`Agent runtime '${identity.agentId}' generation retired`);
                }
            };
            assertGenerationCurrent();
            const sessionHostServices = params.createSessionHostServiceOwners({
                hostRuntimeParams,
                sessionId,
                directory: cwd,
                signal,
            });
            const externalSessionHostOperations =
                params.externalSessionHostOperations?.bindSession(sessionId) ?? null;
            let externalSessions: Awaited<ReturnType<typeof createLiveConfiguredPluginExternalSessionsAdapter>>['service'] | undefined;
            let disposeExternalSessions: (() => Promise<void>) | null = null;
            const providerOps = readConfiguredExternalSessionProviderOps(params.executionSurfaces?.externalSession);
            const hasDeclaredInstances = params.agent.richDefinition?.definition.surfaces?.externalSession.sources.some(
                (source) => (source.instances?.length ?? 0) > 0,
            ) === true;
            if (providerOps && hasDeclaredInstances) {
                const readsConnectedProfiles = hasConnectedServiceProfileSourceInstances(params.agent);
                const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
                    agents: [params.agent],
                    contributionGenerationId: identity.generation,
                    activeServerDir: happierConfiguration.activeServerDir,
                    readAccount: async (): Promise<ConfiguredExternalSessionSourceAccountProjection> => (
                        readsConnectedProfiles
                            ? await fetchAccountProfile({ token: params.sessionInput.credentials.token, signal })
                            : { connectedServicesV2: [] }
                    ),
                    readAccountRevision: () => resolveActiveAccountSettingsSnapshotRevision(getActiveAccountSettingsSnapshot()),
                    subscribeAccountRevision: (listener) => subscribeActiveAccountSettingsSnapshot(
                        (_previous, next) => listener(resolveActiveAccountSettingsSnapshotRevision(next)),
                    ),
                    isCurrent: identity.isCurrent,
                    resolveProviderOps: async (agentId) => agentId === params.agent.id ? providerOps : null,
                    attach: async (ref, source, options) => {
                        const linked = await ensureExternalSessionLink({
                            credentials: params.sessionInput.credentials,
                            machineId: hostRuntimeParams.machineId,
                            agentId: ExternalSessionsAgentIdSchema.parse(ref.agentId),
                            remoteSessionId: ref.remoteSessionId,
                            source,
                        }, {
                            resolveExternalSessionProviderOps: async (agentId) => (
                                agentId === params.agent.id
                                    ? params.executionSurfaces?.externalSession ?? null
                                    : null
                            ),
                            resolveCurrentAgent: async (agentId) => agentId === params.agent.id && params.agent.identity
                                ? {
                                    identity: params.agent.identity,
                                    sourceKinds: params.agent.richDefinition?.definition.surfaces?.externalSession?.sources.map(
                                        (source) => source.sourceKind,
                                    ) ?? [],
                                }
                                : null,
                            resolveSourceKeyOwner: async (agentId, source) => (
                                createExternalSessionSourceKeyOwnerFromAgentProjection(
                                    { agents: [params.agent] },
                                    agentId,
                                    source,
                                )
                            ),
                        });
                        options?.signal?.throwIfAborted();
                        return { sessionId: linked.sessionId };
                    },
                    ...(externalSessionHostOperations
                        ? {
                            takeover: async (ref, source, options) => {
                                return await externalSessionHostOperations.executeTakeover({
                                    ref,
                                    source,
                                    signal: options?.signal,
                                });
                            },
                        }
                        : {}),
                    ...(externalSessionHostOperations
                        ? {
                            followTranscript: async ({ ref, source, options, listener }) =>
                                await externalSessionHostOperations.executeFollow({
                                    ref,
                                    source,
                                    options,
                                    listener,
                                }),
                        }
                        : {}),
                }).catch(() => undefined);
                if (lifecycle) {
                    const configuredExternalSessions = lifecycle.service;
                    externalSessions = configuredExternalSessions;
                    initialTerminalFollowProviderSession ??= async (
                        request,
                        listener,
                    ) => {
                        const target =
                            await configuredExternalSessions
                                .resolveFollowTarget({
                                    agentId: request.agentId,
                                    remoteSessionId:
                                        request.providerSessionId,
                                    signal: request.signal,
                                });
                        if (target.status === 'unavailable') return target;
                        return await configuredExternalSessions
                            .followTranscript(
                                target,
                                {
                                    ...(request.cursor
                                        ? { cursor: request.cursor }
                                        : {}),
                                    signal: request.signal,
                                },
                                listener,
                            );
                    };
                    initialTerminalTranscriptFollowSignal ??= signal;
                    let disposePromise: Promise<void> | null = null;
                    disposeExternalSessions = () => {
                        disposePromise ??= Promise.resolve(lifecycle.dispose());
                        return disposePromise;
                    };
                    const disposeOnAbort = () => { void disposeExternalSessions?.(); };
                    if (signal.aborted) disposeOnAbort();
                    else signal.addEventListener('abort', disposeOnAbort, { once: true });
                }
            }
            if (
                !initialTerminalFollowProviderSession
                && externalSessionHostOperations
            ) {
                initialTerminalFollowProviderSession = async (
                    request,
                    listener,
                ) => await externalSessionHostOperations
                    .executeProviderSessionFollow({
                        agentId: request.agentId,
                        providerSessionId: request.providerSessionId,
                        options: {
                            ...(request.cursor
                                ? { cursor: request.cursor }
                                : {}),
                            signal: request.signal,
                        },
                        listener,
                    });
                initialTerminalTranscriptFollowSignal ??= signal;
            }
            const transcriptMediaPublisher = hostRuntimeParams.transcriptSession.sendAgentSessionMediaCommitted?.bind(
                hostRuntimeParams.transcriptSession,
            );
            const mediaAdapter = transcriptMediaPublisher
                ? createPluginSessionMediaHostAdapter({
                    agentId: identity.agentId,
                    readActiveScope: () => {
                        if (signal.aborted) return null;
                        try {
                            if (!identity.isCurrent()) return null;
                        } catch {
                            return null;
                        }
                        return Object.freeze({
                            sessionId,
                            rootPath: cwd,
                            sendAgentSessionMediaCommitted: transcriptMediaPublisher,
                        });
                    },
                })
                : null;
            let mediaDisposed = false;
            const disposeMedia = () => {
                if (mediaDisposed) return;
                mediaDisposed = true;
                signal.removeEventListener('abort', disposeMedia);
                mediaAdapter?.dispose();
            };
            if (mediaAdapter) {
                if (signal.aborted) disposeMedia();
                else signal.addEventListener('abort', disposeMedia, { once: true });
            }
            if (hostRuntimeParams.session.sessionId !== sessionId) {
                throw new Error('Native Agent current-session presentation target does not match the live session');
            }
            const presentation = createCurrentSessionPresentationService({
                session: hostRuntimeParams.session,
                signal,
                isCurrent: identity.isCurrent,
                ...(hostRuntimeParams.recordRuntimeLimitMeasurement
                    ? { recordRuntimeLimitMeasurement: hostRuntimeParams.recordRuntimeLimitMeasurement }
                    : {}),
            });
            const sessionServices = createNativeAgentSessionServices({
                permissionHandler: hostRuntimeParams.permissionHandler,
                credentials: params.sessionInput.credentials,
                pluginId: identity.pluginId,
                contributionId,
                runtimeId: identity.agentId,
                sessionId,
                generationId: identity.generation,
                ...(identity.immutableGenerationId
                    ? { immutableGenerationId: identity.immutableGenerationId }
                    : {}),
                isCurrent: identity.isCurrent,
                signal,
                ...(externalSessions ? { externalSessions } : {}),
                ...(mediaAdapter ? { media: mediaAdapter.forNativeSession(sessionId) } : {}),
                presentation,
            });
            registerCurrentSessionUiBinding({
                sessionId,
                service: sessionServices.sessions.current,
                signal,
                isCurrent: identity.isCurrent,
            });
            const operationServices = params.createInvocationServices?.({
                correlationId: sessionId,
                cwd,
                environment: openInputs.launchEnvironment.values,
                providerBindingActive: openInputs.providerBinding !== undefined,
                signal,
                session: Object.freeze({
                    id: sessionId,
                    current: sessionServices.sessions.current,
                }),
            });
            const services = operationServices
                ? Object.freeze({
                    ...operationServices,
                    availability: (serviceId: Parameters<PluginServices['availability']>[0]) => (
                        serviceId === 'sessions'
                            ? sessionServices.availability('sessions')
                            : operationServices.availability(serviceId)
                    ),
                    sessions: sessionServices.sessions,
                })
                : sessionServices;
            const terminalHostScope = sessionHostServices.terminalHost
                ? createNativeAgentTerminalHostScope({
                    owner: sessionHostServices.terminalHost,
                    signal,
                    isCurrent: identity.isCurrent,
                    session: hostRuntimeParams.session,
                    reportSessionMetadataToDaemon:
                        params.reportSessionMetadataToDaemon ?? reportSessionToDaemonIfRunning,
                })
                : null;
            const publications = createNativeAgentSessionPublications({
                agentId: identity.agentId,
                session: hostRuntimeParams.session,
                signal,
                isCurrent: identity.isCurrent,
                supportsInFlightSteer: sessionCapabilities.delivery.includes('steer'),
            });
            let lateDiagnosticRedaction:
                ReturnType<typeof beginProviderBindingRuntimeDiagnosticRedaction>
                | null = null;
            let lateProfileDiagnosticRedaction:
                ReturnType<typeof registerSensitiveDiagnosticValues>
                | null = null;
            let cleanupRuntimeScopePromise: Promise<void> | null = null;
            const sanitizeBoundaryError = (error: unknown) =>
                sanitizeNativeAgentSessionBoundaryError(
                    error,
                    lateProfileDiagnosticRedaction !== null
                    || lateDiagnosticRedaction !== null,
                );
            const cleanupRuntimeScope = () => {
                cleanupRuntimeScopePromise ??= (async () => {
                    try {
                        try {
                            disposeMedia();
                            try {
                                await terminalHostScope?.dispose();
                            } finally {
                                publications.dispose();
                            try {
                                await disposeExternalSessions?.();
                            } finally {
                                try {
                                    await externalSessionHostOperations?.retire();
                                } finally {
                                    await sessionHostServices.dispose();
                                }
                            }
                            }
                        } catch (error) {
                            throw sanitizeBoundaryError(error);
                        }
                    } finally {
                        lateProfileDiagnosticRedaction?.close();
                        lateProfileDiagnosticRedaction = null;
                        lateDiagnosticRedaction?.close();
                        lateDiagnosticRedaction = null;
                    }
                })();
                return cleanupRuntimeScopePromise;
            };
            const context: AgentSessionRuntimeContext = Object.freeze({
                plugin: Object.freeze({
                    id: identity.pluginId,
                    version: identity.pluginVersion,
                }),
                contribution: Object.freeze({
                    id: contributionId,
                    qualifiedId: `${identity.pluginId}/agents/${contributionId}`,
                }),
                surface: 'agent',
                session: Object.freeze({
                    id: sessionId,
                    services: createNativeAgentSessionHostServices({
                        owners: sessionHostServices,
                        agentId: identity.agentId,
                        sessionId,
                        directory: cwd,
                        signal,
                        isCurrent: identity.isCurrent,
                        session: hostRuntimeParams.session,
                        systemRecords: createSessionSystemRecordPayloadService(hostRuntimeParams.session),
                        ...(terminalHostScope ? { terminalHost: terminalHostScope.service } : {}),
                        publications: publications.services,
                    }),
                }),
                signal,
                services,
                ui: createPluginInvocationUi({
                    currentSession: services.sessions.current,
                    signal,
                    isGenerationCurrent: identity.isCurrent,
                }),
                agent: Object.freeze({ id: identity.agentId }),
                protocols: Object.freeze({
                    acp: Object.freeze({
                        async open(request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) {
                            return await createPublicAcpSession(request, options, {
                                pluginId: identity.pluginId,
                                agentId: identity.agentId,
                                signal,
                                isCurrent: identity.isCurrent,
                                systemTools: createPublicAcpSystemToolsAdapter(
                                    services.exec,
                                    identity.pluginId,
                                ),
                                managedDependencies: Object.freeze({
                                    async resolve(request) {
                                        if (request.pluginId !== identity.pluginId) {
                                            throw new Error('ACP managed-dependency resolution cannot cross plugin identity');
                                        }
                                        return await resolvePluginExecManagedDependencyForHost(
                                            services.exec,
                                            request.dependencyId,
                                            { signal: request.signal },
                                        );
                                    },
                                }),
                                interactions: services.sessions.current.interactions,
                                media: services.sessions.current.media,
                                models: publications.services.models,
                                ...(openIntent.kind === 'resume' && openIntent.importHistory
                                    ? { resumeHistorySession: hostRuntimeParams.session }
                                    : {}),
                                ...(hostRuntimeParams.mcpServers
                                    ? { mcpServers: hostRuntimeParams.mcpServers }
                                    : {}),
                            });
                        },
                    }),
                }),
                workState: createNativeAgentSessionWorkStateService({
                    session: hostRuntimeParams.session,
                    pluginId: identity.pluginId,
                    contributionId,
                    agentId: params.agent.id,
                    generationId: identity.generation,
                    declarations: readAgentSessionCapabilities(
                        params.agent.richDefinition?.definition,
                    )?.workStateSources ?? [],
                    isCurrent: identity.isCurrent,
                    ...(hostRuntimeParams.recordRuntimeLimitMeasurement
                        ? { recordRuntimeLimitMeasurement: hostRuntimeParams.recordRuntimeLimitMeasurement }
                        : {}),
                }),
            });
            const persistedRollbackTurns = resumeId && sessionCapabilities.conversationRollback === true
                ? await hostRuntimeParams.session.readSessionTurnsProjection()
                    .then((projection) => projection?.turns.flatMap((turn) => (
                        turn.rollback?.state === 'eligible'
                        && turn.rollback.providerCheckpoint !== undefined
                        && typeof turn.transcriptAnchors?.startUserMessageSeq === 'number'
                          ? [Object.freeze({
                              turnId: turn.turnId,
                              userMessageSeq: turn.transcriptAnchors.startUserMessageSeq,
                              providerCheckpoint: turn.rollback.providerCheckpoint,
                            })]
                          : []
                    )) ?? [])
                    .catch(() => [])
                : [];
            const mcpServers = cloneNativeAgentSessionMcpServers(hostRuntimeParams.mcpServers);
            const buildOpenRequest = (): AgentSessionOpenRequest =>
                nativeForkSource
                    ? Object.freeze({
                        kind: 'fork',
                        sessionId,
                        cwd,
                        source: nativeForkSource,
                        ...openInputs,
                        ...(mcpServers ? { mcpServers } : {}),
                    })
                    : resumeId
                    ? Object.freeze({
                        kind: 'resume',
                        sessionId,
                        cwd,
                        providerSessionId: resumeId,
                        ...openInputs,
                        ...(mcpServers ? { mcpServers } : {}),
                    })
                    : Object.freeze({
                        kind: 'create',
                        sessionId,
                        cwd,
                        ...openInputs,
                        ...(mcpServers ? { mcpServers } : {}),
                    });
            let lateProviderBindingMetadata:
                SessionProviderBindingMetadataV1 | null = null;
            let session: AgentSessionRuntime;
            let openStarted = false;
            let continuationRefusalMustRemainPrimary = false;
            let openRequest: AgentSessionOpenRequest;
            try {
                const resolveLateEnvironment =
                    params.sessionInput.bootstrap.resolveLateEnvironment;
                if (resolveLateEnvironment) {
                    const late = await resolveLateEnvironment();
                    const lateEnvironment = {
                        ...late.environmentVariables,
                    };
                    const providerBindingHandoff =
                        consumeProviderBindingLaunchHandoffFromEnvironments([
                            lateEnvironment,
                        ]);
                    const providerConnectionId =
                        params.sessionInput.runtimePreferences.modelSelection
                            ?.ref.providerConnectionId ?? null;
                    if (
                        providerConnectionId !== null
                        && (
                            !providerBindingHandoff
                            || providerBindingHandoff.sessionBindingMetadata
                                .connectionId !== providerConnectionId
                        )
                    ) {
                        throw new Error(
                            'Provider-bound model selection requires a validated late provider binding handoff',
                        );
                    }
                    if (
                        providerConnectionId === null
                        && providerBindingHandoff
                    ) {
                        throw new Error(
                            'Native model selection cannot include a late provider binding handoff',
                        );
                    }
                    const lateInput: PluginSessionBindingInput = Object.freeze({
                        ...params.sessionInput,
                        bootstrap: Object.freeze({
                            ...params.sessionInput.bootstrap,
                            environmentVariables: Object.freeze({
                                ...(params.sessionInput.bootstrap
                                    .environmentVariables ?? {}),
                                ...lateEnvironment,
                            }),
                            unsetEnvironmentVariables: Object.freeze(
                                normalizeUnsetEnvKeys([
                                    ...(params.sessionInput.bootstrap
                                        .unsetEnvironmentVariables ?? []),
                                    ...late.unsetEnvironmentVariables,
                                ]),
                            ),
                        }),
                    });
                    const metadataForOpen = providerBindingHandoff
                        ? applySessionProviderBindingMetadataV1(
                            hostRuntimeParams.metadata,
                            providerBindingHandoff.sessionBindingMetadata,
                        )
                        : hostRuntimeParams.metadata;
                    openInputs = buildNativeAgentSessionOpenInputs(
                        lateInput,
                        metadataForOpen,
                        providerBindingHandoff?.materialization,
                        hostRuntimeParams.getPermissionMode(),
                    );
                    lateProviderBindingMetadata =
                        providerBindingHandoff?.sessionBindingMetadata ?? null;
                    const sensitiveEnvironmentVariableNames =
                        late.sensitiveEnvironmentVariableNames;
                    if (
                        new Set(sensitiveEnvironmentVariableNames).size
                        !== sensitiveEnvironmentVariableNames.length
                    ) {
                        throw new Error(
                            'Late Profile environment contains duplicate sensitive requirement names',
                        );
                    }
                    const sensitiveProfileValues =
                        sensitiveEnvironmentVariableNames.map((name) => {
                            const value = lateEnvironment[name];
                            if (
                                typeof value !== 'string'
                                || value.length === 0
                            ) {
                                throw new Error(
                                    'Late Profile environment is missing a declared sensitive requirement',
                                );
                            }
                            return value;
                        });
                    lateProfileDiagnosticRedaction =
                        registerSensitiveDiagnosticValues(
                            sensitiveProfileValues,
                        );
                    lateDiagnosticRedaction =
                        beginProviderBindingRuntimeDiagnosticRedaction({
                            agentId: identity.agentId,
                            providerBindingActive:
                                providerBindingHandoff !== undefined,
                            environment: lateEnvironment,
                        });
                }
                openRequest = buildOpenRequest();
                const continuationDeclaration =
                    sessionCapabilities.continuationVerification;
                if (
                    openRequest.kind === 'resume'
                    && continuationDeclaration?.intents.includes('resume')
                ) {
                    const continuationContext =
                        createNativeAgentSessionControlContext({
                            context,
                            cwd,
                            activity: 'inactive',
                            connectedAccounts:
                                openRequest.connectedAccounts ?? [],
                            providerSessionId:
                                openRequest.providerSessionId,
                        });
                    const result = sessions.continuation
                        ? await sessions.continuation.verify(
                            openRequest,
                            continuationContext,
                            { signal },
                        )
                        : {
                            status: 'unavailable' as const,
                            diagnostic: {
                                code: 'agent_session_continuation_control_unavailable',
                                severity: 'error' as const,
                            },
                        };
                    if (result.status !== 'reachable') {
                        if (
                            continuationDeclaration.requirement
                            === 'required'
                        ) {
                            continuationRefusalMustRemainPrimary = true;
                            throw createAgentSessionContinuationUnreachableError();
                        }
                        logger.warn(
                            '[NativeAgentSession] advisory continuation verification did not confirm reachability',
                            {
                                code: result.diagnostic.code,
                                sessionId,
                                intent: openRequest.kind,
                            },
                        );
                    }
                }
                assertGenerationCurrent();
                const cancelStalePluginRequests =
                    hostRuntimeParams.permissionHandler.cancelByPlugin;
                if (typeof cancelStalePluginRequests === 'function') {
                    await cancelStalePluginRequests.call(
                        hostRuntimeParams.permissionHandler,
                        identity.pluginId,
                        'agent_runtime_replaced',
                    );
                }
                assertGenerationCurrent();
                openStarted = true;
                session = await openNativeAgentSessionUntilAbort(
                    () => sessions.open(openRequest, context),
                    signal,
                );
            } catch (error) {
                let boundaryError = sanitizeBoundaryError(error);
                if (!openStarted) {
                    try {
                        await abandonDaemonAgentRuntimePreparedSession(
                            params.runtime,
                            sessionId,
                        );
                    } catch (abandonError) {
                        if (continuationRefusalMustRemainPrimary) {
                            logger.warn(
                                '[NativeAgentSession] continuation refusal cleanup failed',
                                {
                                    code: 'agent_session_continuation_abandon_failed',
                                    sessionId,
                                },
                            );
                        } else {
                            boundaryError =
                                sanitizeBoundaryError(abandonError);
                        }
                    }
                }
                ownedAbortController.abort(boundaryError);
                try {
                    await cleanupRuntimeScope();
                } catch (cleanupError) {
                    if (continuationRefusalMustRemainPrimary) {
                        logger.warn(
                            '[NativeAgentSession] continuation refusal cleanup failed',
                            {
                                code: 'agent_session_continuation_scope_cleanup_failed',
                                sessionId,
                            },
                        );
                    } else {
                        throw cleanupError;
                    }
                }
                throw boundaryError;
            }
            if (lateProviderBindingMetadata) {
                try {
                    await hostRuntimeParams.session.updateMetadata((metadata) =>
                        applySessionProviderBindingMetadataV1(
                            metadata,
                            lateProviderBindingMetadata!,
                        ) as typeof metadata
                    );
                } catch (error) {
                    let boundaryError = sanitizeBoundaryError(error);
                    try {
                        await session.dispose('runtime_recovery');
                    } catch (disposeError) {
                        boundaryError =
                            sanitizeBoundaryError(disposeError);
                    }
                    ownedAbortController.abort(boundaryError);
                    try {
                        await cleanupRuntimeScope();
                    } catch (cleanupError) {
                        throw cleanupError;
                    }
                    throw boundaryError;
                }
            }
            try {
                assertGenerationCurrent();
            } catch (error) {
                let boundaryError = sanitizeBoundaryError(error);
                try {
                    await session.dispose('runtime_recovery');
                } catch (disposeError) {
                    boundaryError = sanitizeBoundaryError(disposeError);
                }
                try {
                    await cleanupRuntimeScope();
                } catch (cleanupError) {
                    throw cleanupError;
                }
                throw boundaryError;
            }
            let disposeOnScopeAbort: (() => void) | null = null;
            const operations = createNativeAgentSessionOperations(
                session,
                sessionId,
                async () => {
                    if (disposeOnScopeAbort) {
                        signal.removeEventListener('abort', disposeOnScopeAbort);
                    }
                    await cleanupRuntimeScope();
                },
                resumeId ?? undefined,
                {
                    provider: identity.agentId,
                    publish: (input) => hostRuntimeParams.session.publishUsageObservation(input),
                },
                openInputs.configuration,
                () => ownedAbortController.abort(),
                {
                    ...(sessions.goals ? { goals: sessions.goals } : {}),
                    ...(sessions.catalog ? { catalog: sessions.catalog } : {}),
                    ...(sessions.usageLimitRecovery
                        ? { usageLimitRecovery: sessions.usageLimitRecovery }
                        : {}),
                    context,
                    cwd,
                    connectedAccounts: openRequest.connectedAccounts ?? [],
                    capabilities: sessionCapabilities,
                },
                publications,
                persistedRollbackTurns,
                {
                    onTurnTerminal: async (event) => {
                        await hostRuntimeParams.permissionHandler.cancelByPlugin(
                            identity.pluginId,
                            `agent_${event.kind}`,
                        );
                    },
                    ...(hostRuntimeParams.session.subscribeCommittedUserMessageSeq
                        ? {
                            subscribeCommittedUserMessageSeq: (listener) => (
                                hostRuntimeParams.session.subscribeCommittedUserMessageSeq!(listener)
                            ),
                        }
                        : {}),
                    ...(hostRuntimeParams.session.getCommittedUserMessageSeq
                        ? {
                            getCommittedUserMessageSeq: (localId) => (
                                hostRuntimeParams.session.getCommittedUserMessageSeq!(localId)
                            ),
                        }
                        : {}),
                    getLastObservedMessageSeq: () => hostRuntimeParams.session.getLastObservedMessageSeq(),
                    updateMetadata: (updater) => hostRuntimeParams.session.updateMetadata(updater),
                },
                sanitizeBoundaryError,
            );
            disposeOnScopeAbort = () => {
                void operations.resetOrDisposeRuntime('runtime_recovery').catch(() => {
                    // Retirement is already authoritative; disposal failure cannot revive this runtime.
                });
            };
            if (signal.aborted) {
                const boundaryError = sanitizeBoundaryError(signal.reason);
                await operations.resetOrDisposeRuntime('runtime_recovery');
                throw boundaryError;
            }
            signal.addEventListener('abort', disposeOnScopeAbort, { once: true });
            return operations;
        },
    });
    const createSessionRuntime = plan.config.createSessionRuntime;
    if (!createSessionRuntime || !params.executionSurfaces?.terminalRuntime?.launch) {
        return plan;
    }
    return {
        ...plan,
        config: {
            ...plan.config,
            createSessionRuntime: async (runtimeParams) => {
                const created = await createSessionRuntime(runtimeParams);
                const runtime = created.nativeRuntime ?? created.operations;
                const executableGrants = createPluginExecSystemToolGrantStore();
                const terminalTranscriptFollowService =
                    initialTerminalFollowProviderSession
                    && initialTerminalTranscriptFollowSignal
                        ? createHostTerminalTranscriptFollowService({
                            followProviderSession:
                                initialTerminalFollowProviderSession,
                            signal: initialTerminalTranscriptFollowSignal,
                            publish:
                                createExternalSessionTerminalFollowProjector({
                                    sessionId: runtimeParams.session.sessionId,
                                    agentId: identity.agentId,
                                    projectRuntimeEvent: async (event) =>
                                        await projectRuntimeTranscriptEvent({
                                            session: runtimeParams.session,
                                            provider: identity.agentId,
                                            event,
                                        }),
                                }),
                        })
                        : null;
                const host = createTerminalRuntimeHostOrchestration({
                    messageQueue: runtimeParams.messageQueue,
                    session: runtimeParams.session,
                    projection: createTerminalRuntimeProjectionHostService({
                        session: runtimeParams.session,
                    }),
                    verifyExecutableGrant: executableGrants.verifyGrant,
                    registerExecutableGrant: executableGrants.register,
                    ...(terminalTranscriptFollowService
                        ? {
                            transcriptFollow: terminalTranscriptFollowService,
                        }
                        : {}),
                });
                const terminalModeBinding = createNativeAgentTerminalModeBinding({
                    runtime,
                    terminal: params.executionSurfaces!.terminalRuntime!,
                    agentId: identity.agentId,
                    sessionId: runtimeParams.session.sessionId,
                    directory: runtimeParams.directory,
                    readMetadata: () => (
                        runtimeParams.session.getMetadataSnapshot()
                        ?? runtimeParams.metadata
                    ),
                    ...(params.sessionInput.bootstrap.environmentVariables
                        ? { environment: params.sessionInput.bootstrap.environmentVariables }
                        : {}),
                    ...(params.sessionInput.bootstrap.unsetEnvironmentVariables
                        ? { unsetEnvironmentVariables: params.sessionInput.bootstrap.unsetEnvironmentVariables }
                        : {}),
                    ...(params.generationSignal ? { generationSignal: params.generationSignal } : {}),
                    host,
                });
                return {
                    ...created,
                    operations: terminalModeBinding.runtime,
                    nativeRuntime: terminalModeBinding.runtime,
                    terminalRemoteModeLoop: terminalModeBinding.terminalRemoteModeLoop,
                };
            },
        },
    };
}
