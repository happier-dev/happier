import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
    AgentLaunchEnvironmentV1Schema,
    AgentRuntimeJsonValueV1Schema,
    AgentSessionConfigurationSnapshotV1Schema,
} from '@happier-dev/protocol/runtime';
import {
    applySessionProviderBindingMetadataV1,
    ExternalSessionsAgentIdSchema,
    materializeSessionInputCausalPermissionAuthorityV1,
    readSessionProviderBindingMetadataV1,
    registerSensitiveDiagnosticValues,
    SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
    SessionActivityHeadlineBundleV1Schema,
    SessionRuntimeIssueSourceV1Schema,
    type SessionEnvOverlayV1,
    type SessionRuntimeIssueV1,
    type HostSemanticEventV1,
    type SessionInputCausalPermissionAuthorityV1,
    type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';
import {
    parsePermissionIntentAlias,
    resolvePermissionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import type {
    HostTerminalOrchestration,
    HostTerminalRunResult,
    HostTerminalTranscriptFollowBindResult,
    HostTerminalTranscriptFollowBinding,
    HostTerminalTranscriptFollowService,
} from '@/agent/runtime/session/terminal/contract';
import {
    HostTerminalModelSelectionBlockedError,
    HostTerminalTranscriptFollowAdmissionError,
} from '@/agent/runtime/session/terminal/contract';
import type {
    AgentRuntime,
    AgentAccountUsageAdoptProvisionalRecordInput,
    AgentAccountUsageRecordSnapshotInput,
    AgentAccountUsageSourceContextInput,
    AgentSessionCatalogControl,
    AgentSessionControlContext,
    AgentSessionGoalControl,
    AgentSessionGoalMutation,
    AgentSessionHookPluginDirCreateRequest,
    AgentSessionHookServerStartRequest,
    AgentSessionMcpLaunchConfig,
    AgentSessionMcpServer,
    AgentSessionHostServices,
    AgentSessionProviderTranscriptPublishRequest,
    AgentSessionRuntimeContext,
    AgentAcpRuntimeOptions,
    AgentSessionConfigurationSnapshot,
    AgentSessionConfigurationUpdate,
    AgentSessionOpenRequest,
    AgentSessionRuntime,
    AgentSessionRuntimeEvent,
    AgentSessionUsageLimitRecoveryControl,
    AgentTerminalHostDisposeIntent,
    AgentTranscriptFileFollowInput,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    PluginError,
    type PluginServices,
} from '@happier-dev/plugin-sdk';
import {
    installAgentChildLaunchEnvironmentTransformerForTerminalHost,
} from '@/plugins/runtime/context/terminalHost';
import { configuration as happierConfiguration } from '@/configuration';
import {
    createProviderBindingLaunchMaterializationCleanup,
} from '@/providers/spawn/compose';
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
import { resolveBackendExecutionSurfacesFromNativeAgentRuntime } from '@/agent/runtime/registry/backendEngineSurfaceBindings';
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
import {
    registerRunnerManagedServiceEndpointReadRpcHandlers,
    type RunnerManagedServiceEndpointReadPort,
} from '@/agent/runtime/session/process/managedServiceEndpointReadProtocol';
import {
    registerRunnerManagedServicesCustodyRpcHandler,
    type RunnerManagedServicesCustodyPortV1,
} from '@/agent/runtime/session/process/runnerManagedServicesCustody';
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
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { fetchAccountProfile } from '@/api/accountProfile';
import { ensureExternalSessionLink } from '@/api/session/external/linking/ensureExternalSessionLink';
import {
    agentDeclaresExplicitTerminalFollow,
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
import {
    createNativeAgentCurrentSessionUiServices,
    createNativeAgentSessionServices,
} from './nativeAgentSessionInteractions';
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
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
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
import { readStoredCredentials } from '@/persistence';
import {
    createNativeAgentSessionPublications,
    type NativeAgentSessionPublications,
} from './nativeAgentSessionPublications';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import {
    consumeProviderBindingLaunchHandoffFromEnvironments,
    HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
} from '@/plugins/runtime/providerBindings/handoff';
import type {
    ProviderBindingLaunchHandoffV1,
} from '@/plugins/runtime/providerBindings/handoff';
import { beginProviderBindingRuntimeDiagnosticRedaction } from '@/plugins/runtime/providerBindings/runtimeDiagnosticRedaction';
import {
    type NativeAgentSessionHostServiceOwners,
} from './nativeAgentSessionHostServiceOwners';
import { createPluginExecSystemToolGrantStore } from '@/plugins/runtime/exec/system/tools/grants';
import { createTerminalRuntimeHostOrchestration } from '@/agent/runtime/session/terminal/orchestration';
import { createTerminalRuntimeProjectionHostService } from '@/agent/runtime/session/terminal/projection';
import { createHostTerminalTranscriptFollowService } from '@/agent/runtime/session/terminal/transcriptFollow';
import {
    commitRequiredRuntimeTranscriptMessage,
    projectRuntimeTranscriptEvent,
} from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { publishRuntimeSessionEvent } from '@/agent/runtime/session/transcripts/publishRuntimeSessionEvent';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';
import { buildTerminalMetadataFromHostHandle } from '@/terminal/runtime/terminalMetadata';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import {
    AGENT_SESSION_CONTINUATION_UNREACHABLE_ERROR_NAME,
} from '@/session/shared/spawnSessionContract';
import {
    classifyNativeAgentSessionEffectBoundaryError,
    projectNativeAgentSessionHostServiceError,
    sanitizeNativeAgentSessionBoundaryError,
} from './nativeAgentSessionBoundaryError';

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

/**
 * For an Agent that does not declare explicit terminal follow, transcript follow
 * is an additive capability around the terminal: its failures are reported as
 * diagnostics and never fail the terminal run.
 *
 * For a declaring Agent the same code is load-bearing — `ES-PEP-03`/`ES-PEP-05`
 * make follow admission a launch precondition — so it is also carried on the
 * typed `HostTerminalTranscriptFollowAdmissionError`.
 */
function readTranscriptFollowFailureCode(error: unknown): string {
    if (error instanceof Error) {
        const code = Reflect.get(error, 'code');
        if (typeof code === 'string' && code.trim().length > 0) return code;
        if (error.message.trim().length > 0) return error.message.trim();
    }
    return 'native_agent_terminal_transcript_follow_failed';
}

function createNativeAgentTerminalModeBinding<TRuntime extends RuntimeTurnOperations>(params: Readonly<{
    runtime: TRuntime;
    terminal: NativeAgentTerminalExecutionSurface;
    agentId: string;
    sessionId: string;
    directory: string;
    readMetadata: () => Readonly<Record<string, unknown>>;
    runWithTerminalModelSelection:
        HostSessionRuntimeFactoryParams['runWithTerminalModelSelection'];
    environment?: Readonly<Record<string, string>>;
    unsetEnvironmentVariables?: readonly string[];
    generationSignal?: AbortSignal;
    /**
     * Declaration-derived terminal-follow eligibility (`ES-PEP-03`/`ES-PEP-05`).
     * When true, follow admission is a launch barrier: it completes before
     * `launch()`, a typed admission failure creates no child, and a ready
     * binding's failure races terminal completion. Never inferred — it comes
     * from the Agent's own `terminalFollow` opt-in.
     */
    requiresTranscriptFollow?: boolean;
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
    const requiresTranscriptFollow = params.requiresTranscriptFollow === true;

    const lifecycleAbortController = new AbortController();
    const signal = AbortSignal.any([
        lifecycleAbortController.signal,
        ...(params.generationSignal ? [params.generationSignal] : []),
    ]);
    const reportDegradedTranscriptFollow = (
        code: string,
        phase: 'bind' | 'active' | 'release',
    ): void => {
        logger.warn(
            '[NativeAgentSession] terminal transcript follow unavailable; running the terminal without it',
            {
                code,
                phase,
                agentId: params.agentId,
                sessionId: params.sessionId,
            },
        );
    };
    const disposeTranscriptFollowBinding = async (
        binding: HostTerminalTranscriptFollowBinding,
    ): Promise<void> => {
        try {
            await binding.dispose();
        } catch (error) {
            reportDegradedTranscriptFollow(
                readTranscriptFollowFailureCode(error),
                'release',
            );
        }
    };
    const releaseTranscriptFollowBindings = async (
        transcriptFollow: HostTerminalTranscriptFollowService | undefined,
    ): Promise<void> => {
        if (!transcriptFollow) return;
        try {
            await transcriptFollow.releaseActiveBindings();
        } catch (error) {
            reportDegradedTranscriptFollow(
                readTranscriptFollowFailureCode(error),
                'release',
            );
        }
    };
    const modeLoop: HostSessionTerminalRemoteModeLoop = Object.freeze({
        startingMode: 'remote',
        remoteExitCode: 0,
        async runTerminal() {
            const transcriptFollow = params.host?.transcriptFollow;
            await releaseTranscriptFollowBindings(transcriptFollow);
            try {
                const run = await params.runWithTerminalModelSelection(
                    async (
                        modelSelection,
                        runWithCurrentPublisherPermit,
                    ) => {
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
                        // `ES-PEP-05` admission-before-launch. For an Agent that
                        // declares explicit terminal follow, admission is a barrier:
                        // it completes before `launch()`, and a typed failure creates
                        // no child. For every other Agent — the shape of every shipped
                        // plugin today — follow stays an additive capability layered on
                        // top of the terminal, so an unavailable or failing bind
                        // degrades to a terminal run without follow and only the
                        // terminal launch itself can fail the run.
                        let transcriptFollowBinding:
                            HostTerminalTranscriptFollowBinding
                            | null = null;
                        if (requiresTranscriptFollow) {
                            if (!transcriptFollow) {
                                throw new HostTerminalTranscriptFollowAdmissionError(
                                    'plugin_external_follow_unavailable',
                                    'bind',
                                );
                            }
                            if (!providerSessionId) {
                                throw new HostTerminalTranscriptFollowAdmissionError(
                                    'native_agent_terminal_provider_session_unavailable',
                                    'bind',
                                );
                            }
                            let follow: HostTerminalTranscriptFollowBindResult;
                            try {
                                follow = await transcriptFollow.bindProviderSession({
                                    agentId: params.agentId,
                                    providerSessionId,
                                    signal,
                                });
                            } catch (error) {
                                throw new HostTerminalTranscriptFollowAdmissionError(
                                    readTranscriptFollowFailureCode(error),
                                    'bind',
                                );
                            }
                            if (follow.status === 'unavailable') {
                                throw new HostTerminalTranscriptFollowAdmissionError(
                                    follow.code,
                                    'bind',
                                );
                            }
                            transcriptFollowBinding = follow.binding;
                        } else if (transcriptFollow) {
                            if (!providerSessionId) {
                                reportDegradedTranscriptFollow(
                                    'native_agent_terminal_provider_session_unavailable',
                                    'bind',
                                );
                            } else {
                                try {
                                    const follow =
                                        await transcriptFollow.bindProviderSession({
                                            agentId: params.agentId,
                                            providerSessionId,
                                            signal,
                                        });
                                    if (follow.status === 'unavailable') {
                                        reportDegradedTranscriptFollow(
                                            follow.code,
                                            'bind',
                                        );
                                    } else {
                                        transcriptFollowBinding = follow.binding;
                                    }
                                } catch (error) {
                                    reportDegradedTranscriptFollow(
                                        readTranscriptFollowFailureCode(error),
                                        'bind',
                                    );
                                }
                            }
                        }
                        // A declaring Agent's terminal must stop when following
                        // stops, so its child is spawned against a run-scoped
                        // signal the race can abort. Every other Agent keeps the
                        // lifecycle signal exactly as before.
                        const runAbort = requiresTranscriptFollow
                            ? new AbortController()
                            : null;
                        const launchSignal = runAbort
                            ? AbortSignal.any([signal, runAbort.signal])
                            : signal;
                        const launchPromise = Promise.resolve(launch({
                            sessionId: params.sessionId,
                            directory: params.directory,
                            metadata: providerSessionId
                                ? {
                                    ...metadata,
                                    providerSessionId,
                                }
                                : metadata,
                            modelSelection,
                            runWithCurrentPublisherPermit,
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
                            signal: launchSignal,
                            ...(params.host ? { host: params.host } : {}),
                        })).then(readNativeAgentTerminalRunResult);
                        let result: HostTerminalRunResult;
                        if (transcriptFollowBinding && runAbort) {
                            // `ES-PEP-05`: race terminal completion against binding
                            // failure. A declaring Agent must never keep producing
                            // terminal work that no transcript owner is recording, so
                            // a durable follow failure stops the child and wins with a
                            // typed failure. Already committed rows are untouched.
                            const activeBinding = transcriptFollowBinding;
                            const bindingFailure = activeBinding.failure.then(
                                (error): never => {
                                    throw new HostTerminalTranscriptFollowAdmissionError(
                                        readTranscriptFollowFailureCode(error),
                                        'active',
                                    );
                                },
                            );
                            // The race settles on whichever arrives first; the loser
                            // must not surface as an unhandled rejection.
                            bindingFailure.catch(() => undefined);
                            try {
                                result = await Promise.race([
                                    launchPromise,
                                    bindingFailure,
                                ]);
                            } catch (error) {
                                runAbort.abort(error);
                                launchPromise.catch(() => undefined);
                                throw error;
                            }
                        } else {
                            if (transcriptFollowBinding) {
                                const activeBinding = transcriptFollowBinding;
                                void activeBinding.failure.then(
                                    async (error) => {
                                        reportDegradedTranscriptFollow(
                                            readTranscriptFollowFailureCode(error),
                                            'active',
                                        );
                                        await disposeTranscriptFollowBinding(
                                            activeBinding,
                                        );
                                    },
                                    () => undefined,
                                );
                            }
                            result = await launchPromise;
                        }
                        return result.type === 'process_exited'
                            ? { type: 'exit' as const, code: result.exitCode }
                            : { type: 'switch' as const };
                    },
                );
                if (run.status === 'blocked') {
                    throw new HostTerminalModelSelectionBlockedError();
                }
                return run.value;
            } finally {
                await releaseTranscriptFollowBindings(transcriptFollow);
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
        intent: AgentTerminalHostDisposeIntent,
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

async function invokeNativeAgentSessionPublicService<T>(
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        throw projectNativeAgentSessionHostServiceError(error);
    }
}

function createPublicNativeAgentSessionTerminalHostService(
    owner: AgentTerminalHostService,
): AgentTerminalHostService {
    return Object.freeze({
        async resolve(request) {
            return await invokeNativeAgentSessionPublicService(
                async () => await owner.resolve(request),
            );
        },
        async createOrAttachHost(request) {
            return await invokeNativeAgentSessionPublicService(
                async () => await owner.createOrAttachHost(request),
            );
        },
        async injectUserPrompt(handle, input) {
            return await invokeNativeAgentSessionPublicService(
                async () => await owner.injectUserPrompt(handle, input),
            );
        },
        async interruptTurn(handle) {
            return await invokeNativeAgentSessionPublicService(
                async () => await owner.interruptTurn(handle),
            );
        },
        async evaluateLiveness(handle) {
            return await invokeNativeAgentSessionPublicService(
                async () => await owner.evaluateLiveness(handle),
            );
        },
        async captureInputState(handle) {
            return await invokeNativeAgentSessionPublicService(
                async () => await owner.captureInputState(handle),
            );
        },
        async controlPort(handle) {
            return await invokeNativeAgentSessionPublicService(
                async () => await owner.controlPort(handle),
            );
        },
        async dispose(handle, intent) {
            return await invokeNativeAgentSessionPublicService(
                async () => await owner.dispose(handle, intent),
            );
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
            const localId = executable.kind === 'systemTool'
                ? typeof executable.id === 'string'
                    ? executable.id
                    : executable.id.pluginId === pluginId
                        ? executable.id.localId
                        : null
                : null;
            if (executable.kind !== 'systemTool' || localId !== request.toolId) {
                throw new PluginError({
                    code: 'plugin_exec_system_tool_resolution_invalid',
                    message: `ACP system tool '${request.toolId}' did not resolve to its exact declared executable`,
                });
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
    session: Pick<ApiSessionClient, 'updateMetadata' | 'enqueueAgentMessageCommitted'> & Readonly<{
        sessionId: string;
    }>;
    publications: NativeAgentSessionPublications['services'];
    readToolExecutionCapability: () => NonNullable<AgentRuntime['toolExecution']>['capability'] | null;
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
            throw new PluginError({
                code: 'plugin_generation_stale',
                message: `The native Agent ${service} session scope is retired or unavailable`,
            });
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
            request: AgentSessionHookServerStartRequest,
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
            request: AgentSessionHookPluginDirCreateRequest,
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
            request: AgentSessionProviderTranscriptPublishRequest,
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
            input: AgentTranscriptFileFollowInput,
        ) {
            return await params.owners.transcripts.fileFollow.follow({
                ...input,
                signal: combineSessionOperationSignal(params.signal, input.signal),
            });
        },
    });
    const publishSessionEvent: AgentSessionHostServices['transcripts']['publishSessionEvent'] = async (event) => {
        assertSessionScopeAvailable('transcript-publication');
        return await invokeNativeAgentSessionPublicService(async () =>
            await publishRuntimeSessionEvent({
                session: params.session,
                agentId: params.agentId,
                event,
            }));
    };
    const markSourceFactConsumed: AgentSessionHostServices['transcripts']['markSourceFactConsumed'] = async (request) => {
        assertSessionScopeAvailable('transcript-publication');
        return await invokeNativeAgentSessionPublicService(async () => {
            if (params.sessionId !== params.session.sessionId) {
                throw new PluginError({
                    code: 'native_agent_transcript_session_scope_mismatch',
                    message: 'Transcript source-fact session scope does not match the durable session',
                });
            }
            const localId = request.localId.trim();
            if (localId.length === 0 || localId !== request.localId) {
                throw new PluginError({
                    code: 'native_agent_transcript_source_fact_local_id_invalid',
                    message: 'Invalid transcript source-fact localId',
                });
            }
            await commitRequiredRuntimeTranscriptMessage({
                session: params.session,
                provider: params.agentId,
                localId,
                body: {
                    type: 'output',
                    data: {
                        type: 'progress',
                        marker: 'source_fact_consumed',
                        reason: request.reason,
                    },
                },
                meta: {
                    happier: { kind: 'source_fact_consumed.v1' },
                },
                provenance: { kind: 'non_dependent', source: 'external' },
                eventKind: 'source-fact-consumed',
            });
            return Object.freeze({ status: 'custodied' as const });
        });
    };
    const accountUsage: AgentSessionHostServices['accountUsage'] = Object.freeze({
        async resolveSourceContext(
            input: AgentAccountUsageSourceContextInput,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            return await params.owners.accountUsage.resolveSourceContext(input, {
                signal: combineSessionOperationSignal(params.signal, options?.signal),
            });
        },
        async recordSnapshot(
            input: AgentAccountUsageRecordSnapshotInput,
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
            input: AgentAccountUsageAdoptProvisionalRecordInput,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) {
            return await params.owners.accountUsage.adoptProvisionalRecord({
                ...input,
                sessionId: params.sessionId,
                adoption: {
                    ...input.adoption,
                    providerId: input.adoption.stableRecordKey.providerId,
                },
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
        if (transport.kind === 'hosted' || transport.kind === 'stdio') {
            return Object.freeze({
                id: server.id,
                name: server.name,
                transport: Object.freeze({ kind: transport.kind }),
            });
        }
        throw new PluginError({
            code: 'native_agent_mcp_transport_unsupported',
            message: 'Unsupported native Agent MCP transport',
        });
    };
    const mcp: AgentSessionHostServices['mcp'] = Object.freeze({
        async resolveServers(options?: Readonly<{ signal?: AbortSignal }>) {
            assertSessionScopeAvailable('mcp');
            const signal = combineSessionOperationSignal(params.signal, options?.signal);
            const resolved = await params.owners.mcp.resolveForSession({
                sessionId: params.sessionId,
                directory: params.directory,
            });
            assertSessionScopeAvailable('mcp');
            signal.throwIfAborted();
            return Object.freeze(resolved.map(projectMcpServer));
        },
    });
    const workflowActivity: AgentSessionHostServices['workflowActivity'] = Object.freeze({
        async publishHeadlines(bundle) {
            assertSessionScopeAvailable('workflow-activity');
            // Fail closed on the whole bundle: publishing one key of a pair that is meant to
            // describe the same snapshots would leave the two disagreeing about what exists.
            const parsed = SessionActivityHeadlineBundleV1Schema.parse(bundle);
            let retiredDuringMerge = false;
            await params.session.updateMetadata((current) => {
                if (!isSessionScopeCurrent()) {
                    retiredDuringMerge = true;
                    return current;
                }
                // ONE merge, both keys. The workflow key keeps its exact released name and shape.
                return {
                    ...current,
                    sessionWorkflowActivityHeadlineV1: parsed.workflow,
                    [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: parsed.agentActivity,
                };
            });
            if (retiredDuringMerge) {
                assertSessionScopeAvailable('workflow-activity');
            }
        },
    });
    const toolExecution: AgentSessionHostServices['toolExecution'] = Object.freeze({
        async before(request, options) {
            assertSessionScopeAvailable('tool-execution');
            if (params.readToolExecutionCapability() !== 'interceptable') {
                return {
                    status: 'failed',
                    code: 'agent_tool_interception_unavailable',
                };
            }
            return await params.owners.toolExecution.before(request, {
                signal: combineSessionOperationSignal(params.signal, options?.signal),
            });
        },
    });
    const terminalHost = params.terminalHost
        ? createPublicNativeAgentSessionTerminalHostService(params.terminalHost)
        : undefined;
    return Object.freeze({
        features,
        ...(terminalHost ? { terminalHost } : {}),
        models: params.publications.models,
        activeInput: params.publications.activeInput,
        sessionHooks,
        transcripts: Object.freeze({
            fileFollow,
            publishSessionEvent,
            markSourceFactConsumed,
        }),
        accountUsage,
        mcp,
        workflowActivity,
        toolExecution,
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

function isHostOwnedToolTraceEnvironmentKey(key: string): boolean {
    return key === 'HAPPIER_STACK_TOOL_TRACE'
        || key === 'HAPPIER_STACK_TOOL_TRACE_DIR'
        || key === 'HAPPIER_STACK_TOOL_TRACE_FILE';
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
    for (const key of Object.keys(environmentValues)) {
        if (isHostOwnedToolTraceEnvironmentKey(key)) {
            delete environmentValues[key];
        }
    }
    const launchEnvironment = AgentLaunchEnvironmentV1Schema.parse({
        values: environmentValues,
        unset: (input.bootstrap.unsetEnvironmentVariables ?? []).filter(
            (key) => key !== HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY
                && !isHostOwnedToolTraceEnvironmentKey(key),
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
        admissionWitness:
            NativeAgentNewTurnAdmissionWitness | null,
    ): void | Promise<void>;
    subscribeCommittedUserMessageSeq?(
        listener: (observation: Readonly<{ localId: string; seq: number }>) => void,
    ): () => void;
    getCommittedUserMessageSeq?(localId: string): number | null;
    getLastObservedMessageSeq?(): number;
    updateMetadata?(updater: (metadata: Metadata) => Metadata): Promise<void> | void;
    onRollbackBoundary?(input: Readonly<{
        event: Extract<AgentSessionRuntimeEvent, { kind: 'turn-rollback-boundary' }>;
        startUserMessageSeq: number;
    }>): void | Promise<void>;
    onRollbackApplied?(input: Readonly<{
        turnId: string;
        restoredToTurnId: string;
        observedAtMs: number;
        agentTurnId?: string;
        agentRollbackOrdinal?: number;
    }>): void | Promise<void>;
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
    event: Readonly<{
        diagnostic: Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>['diagnostic'];
        emittedAtMs: number;
    }>,
): SessionRuntimeIssueV1 {
    return classifyPrimarySessionRuntimeIssue({
        cause: 'session_error',
        error: event.diagnostic,
        occurredAt: event.emittedAtMs,
    });
}

type NativeAgentRuntimeDiagnostic = Extract<
    AgentSessionRuntimeEvent,
    { kind: 'turn-failed' }
>['diagnostic'];

function projectPublicNativeAgentRuntimeDiagnostic(
    diagnostic: NativeAgentRuntimeDiagnostic,
): NativeAgentRuntimeDiagnostic {
    const source = readPublicNativeAgentRuntimeDiagnosticSource(diagnostic.details);
    return {
        code: diagnostic.code,
        severity: diagnostic.severity,
        ...(diagnostic.message !== undefined ? { message: diagnostic.message } : {}),
        ...(diagnostic.remediation !== undefined ? { remediation: diagnostic.remediation } : {}),
        ...(source ? { details: { v: 1, source } } : {}),
    };
}

function readPublicNativeAgentRuntimeDiagnosticSource(
    details: NativeAgentRuntimeDiagnostic['details'],
) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    const candidate = details as Readonly<Record<string, unknown>>;
    if (candidate.v !== 1) return null;
    const source = SessionRuntimeIssueSourceV1Schema.safeParse(candidate.source);
    return source.success ? source.data : null;
}

function projectPublicNativeAgentRuntimeEvent(
    event: AgentSessionRuntimeEvent,
): AgentSessionRuntimeEvent {
    switch (event.kind) {
        case 'input-rejected':
            return {
                ...event,
                diagnostic: projectPublicNativeAgentRuntimeDiagnostic(event.diagnostic),
            };
        case 'input-custody-unknown':
        case 'input-delivery-failed':
            return {
                ...event,
                issue: projectPublicNativeAgentRuntimeDiagnostic(event.issue),
            };
        case 'turn-failed':
            return {
                ...event,
                diagnostic: projectPublicNativeAgentRuntimeDiagnostic(event.diagnostic),
            };
        case 'turn-cancelled':
        case 'runtime-ended':
            return event.diagnostic
                ? {
                    ...event,
                    diagnostic: projectPublicNativeAgentRuntimeDiagnostic(event.diagnostic),
                }
                : event;
        case 'context-compaction':
            if (event.phase === 'failed' || event.phase === 'outcomeUnknown') {
                return {
                    ...event,
                    diagnostic: projectPublicNativeAgentRuntimeDiagnostic(event.diagnostic),
                };
            }
            if (event.phase === 'cancelled' && event.diagnostic) {
                return {
                    ...event,
                    diagnostic: projectPublicNativeAgentRuntimeDiagnostic(event.diagnostic),
                };
            }
            return event;
        default:
            return event;
    }
}

function createNativeAgentRuntimeEndedError(issue: SessionRuntimeIssueV1 | null): Error {
    if (!issue) {
        return new Error('Native Agent runtime is ended, disposing, or disposed');
    }
    const preview = issue.sanitizedPreview?.trim();
    return new Error(
        `Native Agent runtime ended (${issue.code})${preview ? `: ${preview}` : ''}`,
    );
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
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    admissionAbortController?: AbortController;
}>;

export type NativeAgentNewTurnAdmissionWitness = Readonly<{
    inputId: string;
    turnId: string;
    userMessageSeq: number | null;
    userMessageSeqs: readonly number[];
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
}>;

export type NativeAgentNewTurnAdmissionOptions = Readonly<{
    signal: AbortSignal;
}>;

function copyCausalPermissionAuthorityForNativeRuntime(
    authority: SessionInputCausalPermissionAuthorityV1,
): SessionInputCausalPermissionAuthorityV1 {
    return {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: authority.admittedPermissionCeiling,
        ...(authority.sourceAuthority
            ? { sourceAuthority: { ...authority.sourceAuthority } }
            : {}),
    };
}

function createNativeAgentTurnAdmissionWitness(
    correlation: NativeInputCorrelation,
): NativeAgentNewTurnAdmissionWitness {
    const causalPermissionAuthority = correlation.causalPermissionAuthority
        ? materializeSessionInputCausalPermissionAuthorityV1(
            correlation.causalPermissionAuthority,
        )
        : null;
    if (correlation.causalPermissionAuthority && !causalPermissionAuthority) {
        throw new Error(
            'Native Agent runtime delivery requires a valid causal permission authority',
        );
    }
    return Object.freeze({
        inputId: correlation.inputId,
        turnId: correlation.turnId,
        userMessageSeq: correlation.userMessageSeq,
        userMessageSeqs: Object.freeze([
            ...(correlation.userMessageSeqs ?? []),
        ]),
        ...(causalPermissionAuthority
            ? { causalPermissionAuthority }
            : {}),
    });
}

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
    const hasCausalPermissionAuthority = meta !== undefined
        && Object.hasOwn(meta, 'causalPermissionAuthority');
    const causalPermissionAuthority = hasCausalPermissionAuthority
        ? materializeSessionInputCausalPermissionAuthorityV1(
            meta?.causalPermissionAuthority,
        )
        : null;
    if (hasCausalPermissionAuthority && causalPermissionAuthority === null) {
        throw new Error(
            'Native Agent runtime delivery requires a valid causal permission authority',
        );
    }
    return Object.freeze({
        inputId,
        turnId: meta?.turnId || fallbackTurnId,
        deliveryKind,
        userMessageSeq: meta?.userMessageSeq ?? null,
        ...(meta?.userMessageSeqs ? { userMessageSeqs: [...meta.userMessageSeqs] } : {}),
        ...(causalPermissionAuthority
            ? { causalPermissionAuthority }
            : {}),
    });
}

function parseNativeStructuredInput(
    meta: RuntimeTurnPromptMeta | undefined,
) {
    const structuredInput = meta?.structuredInput;
    return structuredInput === undefined
        ? undefined
        : AgentRuntimeJsonValueV1Schema.parse(structuredInput);
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

function createAgentSessionContinuationUnreachableError(): Error {
    const error = new Error('Agent session continuation is unreachable.');
    error.name = AGENT_SESSION_CONTINUATION_UNREACHABLE_ERROR_NAME;
    return error;
}

type NativeAgentToolExecutionLifecycleObserver = Readonly<{
    capability: NonNullable<AgentRuntime['toolExecution']>['capability'];
    observeAfter(request: Readonly<{
        turnId: string;
        callId: string;
        name: string;
        input: Extract<AgentSessionRuntimeEvent, { kind: 'tool-call' }>['input'];
        outcome: Readonly<
            | { status: 'succeeded'; result: Extract<AgentSessionRuntimeEvent, { kind: 'tool-result' }>['output'] }
            | { status: 'failed'; code: string }
        >;
        timestampMs: number;
    }>): void | Promise<void>;
}>;

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
    authorizeNewTurn?: (
        witness: NativeAgentNewTurnAdmissionWitness,
        options: NativeAgentNewTurnAdmissionOptions,
    ) => Promise<Readonly<{ status: 'admitted' }>>,
    bindActiveTurnAdmissionWitnessReader?: (
        reader: () => NativeAgentNewTurnAdmissionWitness | null,
    ) => void,
    publishHostEvent?: (event: HostSemanticEventV1) => void,
    toolExecutionLifecycle?: NativeAgentToolExecutionLifecycleObserver,
    runtimeIncarnationId = randomUUID(),
): PluginRuntimeHookOperations {
    let disposeStarted = false;
    let disposePromise: Promise<void> | null = null;
    let disposeRuntimeScopePromise: Promise<void> | null = null;
    const invariant = createAgentSessionTurnInvariant({
        sessionId: expectedSessionId,
        ...(expectedProviderSessionId ? { expectedProviderSessionId } : {}),
    });
    let deliveryOutcomeHandler: ((outcome: PluginRuntimePromptDeliveryOutcome) => void) | null = null;
    const inputCorrelations = new Map<string, NativeInputCorrelation>();
    const acceptedInputIds = new Set<string>();
    const rejectedInputIds = new Set<string>();
    const uncertainInputIds = new Set<string>();
    const pendingToolExecutions = new Map<string, Readonly<{
        turnId: string;
        callId: string;
        name: string;
        input: Extract<AgentSessionRuntimeEvent, { kind: 'tool-call' }>['input'];
    }>>();
    const toolExecutionKey = (turnId: string, callId: string): string =>
        `${turnId.length}:${turnId}${callId}`;
    let activeTurnAdmissionWitness:
        NativeAgentNewTurnAdmissionWitness | null = null;
    let nativeTurnOrdinal = 0;
    let runtimeEndedIssue: SessionRuntimeIssueV1 | null = null;
    let configuration = initialConfiguration;
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
    const readActiveTurnAdmissionWitness = (): NativeAgentNewTurnAdmissionWitness | null => {
        const activeTurnId =
            invariant.read().activeTurnId ?? readPendingNewTurnId();
        if (!activeTurnId) return null;
        if (
            activeTurnAdmissionWitness?.turnId
            === activeTurnId
            && !rejectedInputIds.has(
                activeTurnAdmissionWitness.inputId,
            )
            && !uncertainInputIds.has(
                activeTurnAdmissionWitness.inputId,
            )
        ) {
            return activeTurnAdmissionWitness;
        }
        return null;
    };
    bindActiveTurnAdmissionWitnessReader?.(readActiveTurnAdmissionWitness);
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    type NativeTurnTerminalEvent = Extract<
        AgentSessionRuntimeEvent,
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
                            event.diagnostic.message?.trim()
                            ? `: ${event.diagnostic.message.trim()}`
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
    const observeTurnCompletion = (event: AgentSessionRuntimeEvent): void => {
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
    const publishCachedRollbackBoundary = (index: number, userMessageSeq: number): void => {
        const current = rollbackTurns[index];
        if (!current?.rollbackBoundaryEvent || current.didPublishRollbackBoundary === true) return;
        rollbackTurns[index] = Object.freeze({
            ...current,
            userMessageSeq,
            didPublishRollbackBoundary: true,
        });
        try {
            void Promise.resolve(interactionLifecycle?.onRollbackBoundary?.({
                event: current.rollbackBoundaryEvent,
                startUserMessageSeq: userMessageSeq,
            })).catch(() => {
                logger.debug('[NativeAgentSession] failed to publish rollback boundary lifecycle (non-fatal)');
            });
        } catch {
            logger.debug('[NativeAgentSession] failed to publish rollback boundary lifecycle (non-fatal)');
        }
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
            if (
                activeTurnAdmissionWitness?.inputId
                === correlation.inputId
            ) {
                activeTurnAdmissionWitness = null;
            }
        }
        if (event.kind === 'input-rejected') {
            rejectedInputIds.add(correlation.inputId);
            uncertainInputIds.delete(correlation.inputId);
            pendingRollbackJoinByLocalId.delete(correlation.inputId);
            if (
                activeTurnAdmissionWitness?.inputId
                === correlation.inputId
            ) {
                activeTurnAdmissionWitness = null;
            }
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
        const terminalAdmissionWitness =
            (
                input.kind === 'turn-complete'
                || input.kind === 'turn-failed'
                || input.kind === 'turn-cancelled'
            )
            && activeTurnAdmissionWitness?.turnId
                === input.turnId
                ? activeTurnAdmissionWitness
                : null;
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
        if (event.kind === 'runtime-ended' && event.diagnostic) {
            runtimeEndedIssue = buildNativeAgentSessionRuntimeIssue({
                diagnostic: event.diagnostic,
                emittedAtMs: event.emittedAtMs,
            });
        }
        if (toolExecutionLifecycle && event.kind === 'tool-call') {
            pendingToolExecutions.set(
                toolExecutionKey(event.turnId, event.toolCallId),
                Object.freeze({
                    turnId: event.turnId,
                    callId: event.toolCallId,
                    name: event.toolName,
                    input: event.input,
                }),
            );
        }
        if (toolExecutionLifecycle && event.kind === 'tool-result') {
            const key = toolExecutionKey(event.turnId, event.toolCallId);
            const pending = pendingToolExecutions.get(key);
            if (pending) {
                pendingToolExecutions.delete(key);
                try {
                    void Promise.resolve(toolExecutionLifecycle.observeAfter({
                        ...pending,
                        outcome: event.isError === true
                            ? { status: 'failed', code: 'agent_tool_execution_failed' }
                            : { status: 'succeeded', result: event.output },
                        timestampMs: event.emittedAtMs,
                    })).catch(() => {
                        logger.debug('[NativeAgentSession] failed to observe Agent tool execution (non-fatal)');
                    });
                } catch {
                    logger.debug('[NativeAgentSession] failed to observe Agent tool execution (non-fatal)');
                }
            }
        }
        if (
            event.kind === 'turn-complete'
            || event.kind === 'turn-failed'
            || event.kind === 'turn-cancelled'
        ) {
            for (const [key, pending] of pendingToolExecutions) {
                if (pending.turnId === event.turnId) pendingToolExecutions.delete(key);
            }
        }
        let terminalLifecycleSettlement:
            Promise<void> | null = null;
        if (
            interactionLifecycle
            && (
                event.kind === 'turn-complete'
                || event.kind === 'turn-failed'
                || event.kind === 'turn-cancelled'
            )
        ) {
            try {
                terminalLifecycleSettlement =
                    Promise.resolve(
                        interactionLifecycle
                            .onTurnTerminal(
                                event,
                                terminalAdmissionWitness,
                            ),
                    ).catch(() => {
                        logger.debug('[NativeAgentSession] failed to settle turn-scoped interactions (non-fatal)');
                    });
            } catch {
                logger.debug('[NativeAgentSession] failed to cancel turn-scoped interactions (non-fatal)');
            }
        }
        if (
            (
                event.kind === 'turn-complete'
                || event.kind === 'turn-failed'
                || event.kind === 'turn-cancelled'
            )
            && activeTurnAdmissionWitness?.turnId
                === event.turnId
        ) {
            activeTurnAdmissionWitness = null;
        }
        const publishCanonicalEvent = () => {
            const publicEvent = projectPublicNativeAgentRuntimeEvent(event);
            try {
                publishHostEvent?.(publicEvent);
            } catch {
                logger.debug('[NativeAgentSession] failed to publish Host Event (non-fatal)');
            }
            observeTurnCompletion(event);
            for (const listener of listeners) {
                listener(publicEvent);
            }
        };
        if (terminalLifecycleSettlement) {
            void terminalLifecycleSettlement.then(
                publishCanonicalEvent,
            );
        } else {
            publishCanonicalEvent();
        }
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
            try {
                void Promise.resolve(interactionLifecycle?.onRollbackBoundary?.({
                    event,
                    startUserMessageSeq: rollbackStartUserMessageSeq,
                })).catch(() => {
                    logger.debug('[NativeAgentSession] failed to publish rollback boundary lifecycle (non-fatal)');
                });
            } catch {
                logger.debug('[NativeAgentSession] failed to publish rollback boundary lifecycle (non-fatal)');
            }
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
                        const observedAtMs = Date.now();
                        for (const removedTurn of removedTurns) {
                            const boundary = removedTurn.rollbackBoundaryEvent;
                            try {
                                await interactionLifecycle?.onRollbackApplied?.({
                                    turnId: removedTurn.turnId,
                                    restoredToTurnId,
                                    observedAtMs,
                                    ...(boundary?.agentTurnId
                                        ? { agentTurnId: boundary.agentTurnId }
                                        : {}),
                                    ...(typeof boundary?.agentRollbackOrdinal === 'number'
                                        ? { agentRollbackOrdinal: boundary.agentRollbackOrdinal }
                                        : {}),
                                });
                            } catch {
                                logger.debug('[NativeAgentSession] failed to publish applied rollback lifecycle (non-fatal)');
                            }
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
                canInterruptForPendingInput: () => {
                    try {
                        return publications.readActiveInputBinding()?.canInterruptForPendingInput?.() !== false;
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
        readActiveTurnCausalPermissionAuthority() {
            return readActiveTurnAdmissionWitness()?.causalPermissionAuthority ?? null;
        },
        subscribeRuntimeEvents(handler) {
            listeners.add(handler);
            if (!disposeStarted) ensureSubscription();
            return () => listeners.delete(handler);
        },
        async sendTurnPrompt(prompt: string, meta?: RuntimeTurnPromptMeta): Promise<void> {
            const fallbackTurnId = meta?.turnId
                || `native-turn-${runtimeIncarnationId}-${++nativeTurnOrdinal}`;
            const correlation = resolveNativeInputCorrelation(meta, 'newTurn', fallbackTurnId);
            if (!correlation) {
                throw new Error('Native Agent runtime delivery requires exactly one Queue localId');
            }
            if (disposeStarted) {
                throw new Error('Native Agent runtime is ended, disposing, or disposed');
            }
            if (invariant.read().runtimeEnded) {
                const error = createNativeAgentRuntimeEndedError(runtimeEndedIssue);
                ensureTurnCompletion();
                settleTurnCompletion(undefined, error);
                throw error;
            }
            const structuredInput = parseNativeStructuredInput(meta);
            ensureTurnCompletion();
            ensureSubscription();
            if (inputCorrelations.has(correlation.inputId)) {
                throw new Error('Native Agent runtime delivery cannot reuse an in-flight Queue localId');
            }
            const admissionAbortController = authorizeNewTurn
                ? new AbortController()
                : null;
            const pendingCorrelation = admissionAbortController
                ? Object.freeze({
                    ...correlation,
                    admissionAbortController,
                })
                : correlation;
            inputCorrelations.set(
                correlation.inputId,
                pendingCorrelation,
            );
            if (authorizeNewTurn && admissionAbortController) {
                try {
                    const admission =
                        await authorizeNewTurn(
                            createNativeAgentTurnAdmissionWitness(correlation),
                            Object.freeze({
                                signal: admissionAbortController.signal,
                            }),
                        );
                    admissionAbortController.signal.throwIfAborted();
                } catch (error) {
                    if (
                        classifyNativeAgentSessionEffectBoundaryError(error)
                        === 'authority_unavailable_before_effect'
                    ) {
                        emitDeliveryOutcome({
                            type: 'input-rejected-before-provider',
                            localInputId: correlation.inputId,
                            userMessageSeq: correlation.userMessageSeq,
                            ...(correlation.userMessageSeqs
                                ? { userMessageSeqs: correlation.userMessageSeqs }
                                : {}),
                            reason: 'provider_unavailable_before_acceptance',
                            diagnostic: {
                                code: 'daemon_turn_admission_unavailable',
                                severity: 'error',
                            },
                            retryable: true,
                            retireLocalCustodyAfterDurableBlock: true,
                        });
                    }
                    if (
                        inputCorrelations.get(correlation.inputId)
                            === pendingCorrelation
                    ) {
                        inputCorrelations.delete(correlation.inputId);
                    }
                    throw error;
                }
            }
            if (
                inputCorrelations.get(correlation.inputId)
                    !== pendingCorrelation
            ) {
                throw admissionAbortController?.signal.reason
                    ?? new Error(
                        'Native Agent runtime delivery was cancelled before admission',
                    );
            }
            inputCorrelations.set(correlation.inputId, correlation);
            activeTurnAdmissionWitness = createNativeAgentTurnAdmissionWitness(
                correlation,
            );
            let result: Awaited<ReturnType<AgentSessionRuntime['send']>>;
            try {
                result = await session.send({
                    inputIds: [correlation.inputId],
                    input: {
                        text: prompt,
                        ...(structuredInput === undefined ? {} : { structuredInput }),
                    },
                    delivery: correlation.deliveryKind === 'steer'
                        ? { kind: 'steer', turnId: correlation.turnId }
                        : { kind: 'newTurn', turnId: correlation.turnId },
                    ...(correlation.causalPermissionAuthority
                        ? {
                            causalPermissionAuthority:
                                copyCausalPermissionAuthorityForNativeRuntime(
                                    correlation.causalPermissionAuthority,
                                ),
                        }
                        : {}),
                });
            } catch (error) {
                if (!acceptedInputIds.has(correlation.inputId) && !uncertainInputIds.has(correlation.inputId)) {
                    uncertainInputIds.add(correlation.inputId);
                    if (
                        activeTurnAdmissionWitness?.inputId
                        === correlation.inputId
                    ) {
                        activeTurnAdmissionWitness = null;
                    }
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
                if (
                    activeTurnAdmissionWitness?.inputId
                    === correlation.inputId
                ) {
                    activeTurnAdmissionWitness = null;
                }
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
            const structuredInput = parseNativeStructuredInput(meta);
            ensureTurnCompletion();
            ensureSubscription();
            if (inputCorrelations.has(correlation.inputId)) {
                throw new Error('Native Agent runtime delivery cannot reuse an in-flight Queue localId');
            }
            inputCorrelations.set(correlation.inputId, correlation);
            const precedingAdmissionWitness = activeTurnAdmissionWitness;
            const steerAdmissionWitness = createNativeAgentTurnAdmissionWitness(
                correlation,
            );
            activeTurnAdmissionWitness = steerAdmissionWitness;
            const restorePrecedingAdmissionWitness = () => {
                const currentActiveTurnId =
                    invariant.read().activeTurnId ?? readPendingNewTurnId();
                if (
                    currentActiveTurnId !== activeTurnId
                    || (
                        activeTurnAdmissionWitness !== steerAdmissionWitness
                        && activeTurnAdmissionWitness !== null
                    )
                ) {
                    return;
                }
                activeTurnAdmissionWitness =
                    precedingAdmissionWitness?.turnId === activeTurnId
                        ? precedingAdmissionWitness
                        : null;
            };
            let result: Awaited<ReturnType<AgentSessionRuntime['send']>>;
            try {
                result = await session.send({
                    inputIds: [correlation.inputId],
                    input: {
                        text: message,
                        ...(structuredInput === undefined ? {} : { structuredInput }),
                    },
                    delivery: { kind: 'steer', turnId: activeTurnId },
                    ...(correlation.causalPermissionAuthority
                        ? {
                            causalPermissionAuthority:
                                copyCausalPermissionAuthorityForNativeRuntime(
                                    correlation.causalPermissionAuthority,
                                ),
                        }
                        : {}),
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
                restorePrecedingAdmissionWitness();
                throw error;
            }
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
                restorePrecedingAdmissionWitness();
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
            if (!turnId) return;
            const pendingAdmission = [...inputCorrelations.values()]
                .find((correlation) =>
                    correlation.deliveryKind === 'newTurn'
                    && correlation.turnId === turnId
                    && correlation.admissionAbortController
                );
            if (pendingAdmission?.admissionAbortController) {
                inputCorrelations.delete(pendingAdmission.inputId);
                pendingAdmission.admissionAbortController.abort(
                    new Error(
                        'Native Agent runtime delivery was cancelled before admission',
                    ),
                );
                return;
            }
            if (!session.cancel) return;
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
            disposeStarted = true;
            disposePromise ??= Promise.resolve().then(async () => {
                try {
                    abortSessionScope?.();
                    try {
                        await session.dispose(reason);
                    } catch (error) {
                        throw sanitizeDisposeError
                            ? sanitizeDisposeError(error)
                            : error;
                    }
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
                    pendingToolExecutions.clear();
                    unsubscribeCommittedUserMessageSeq?.();
                    unsubscribeCommittedUserMessageSeq = null;
                    invariant.fence();
                    deliveryOutcomeHandler = null;
                    subscription?.dispose();
                    subscription = null;
                    listeners.clear();
                }
            });
            const failures: unknown[] = [];
            try {
                await disposePromise;
            } catch (error) {
                failures.push(error);
            }
            if (!disposeRuntimeScopePromise) {
                const attempt = Promise.resolve().then(async () => {
                    await disposeRuntimeScope?.();
                });
                let trackedAttempt!: Promise<void>;
                trackedAttempt = attempt.catch((error: unknown) => {
                    if (disposeRuntimeScopePromise === trackedAttempt) {
                        disposeRuntimeScopePromise = null;
                    }
                    throw error;
                });
                disposeRuntimeScopePromise = trackedAttempt;
            }
            try {
                await disposeRuntimeScopePromise;
            } catch (error) {
                failures.push(error);
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(
                    failures,
                    'Failed to dispose native Agent session',
                );
            }
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
    runtime?: AgentRuntime;
    createRuntime?: (params: Readonly<{
        signal: AbortSignal;
    }>) => Promise<AgentRuntime>;
    prepareRuntimeSource?: (params: Readonly<{
        sessionId: string;
        signal: AbortSignal;
    }>) => Promise<void>;
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
    /** Runtime-owned materialization lookup for SessionHandle action dispatch. */
    resolveCallerMaterialization?(): PluginMachineMaterializationRefV1 | null;
    /** Direct in-process callers may provide the real registration lease. */
    lease?: AgentRuntimeRegistrationLease;
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    sessionInput: PluginSessionBindingInput;
    executionSurfaces?: Partial<Pick<BackendExecutionSurfaces, 'externalSession' | 'terminalRuntime'>>;
    externalSessionHostOperations?: Readonly<{
        bindSession(sessionId: string): ExternalSessionHostOperationPort;
    }> | null;
    managedServiceEndpointReadPort?:
        RunnerManagedServiceEndpointReadPort | null;
    managedServicesCustodyPort?:
        RunnerManagedServicesCustodyPortV1 | null;
    prepareManagedProviderBinding?(params: Readonly<{
        sessionId: string;
        cwd: string;
        environment: Readonly<Record<string, string>>;
        signal: AbortSignal;
        session: Readonly<{
            id: string;
            current: HostCurrentSessionUiServices;
        }>;
        readActiveTurnAdmissionWitness():
            NativeAgentNewTurnAdmissionWitness | null;
    }>): Promise<Readonly<{
        handoff: ProviderBindingLaunchHandoffV1;
        environmentOverlay: SessionEnvOverlayV1;
        additionalRedactionValues: readonly string[];
        transformAgentChildLaunchEnvironment(
            environment: Readonly<Record<string, string>>,
        ): Readonly<Record<string, string>>;
        cleanup: (() => void) | null;
    }> | null>;
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
        readActiveTurnAdmissionWitness():
            NativeAgentNewTurnAdmissionWitness | null;
    }>) => Promise<PluginServices>;
    reportSessionMetadataToDaemon?: (input: Readonly<{
        sessionId: string;
        metadata: Metadata;
    }>) => Promise<void>;
    authorizeNewTurn?: (
        witness: NativeAgentNewTurnAdmissionWitness,
        options: NativeAgentNewTurnAdmissionOptions,
    ) => Promise<Readonly<{ status: 'admitted' }>>;
    retireRuntimeSource?: () => Promise<void>;
    attestSessionOpen?: (params: Readonly<{
        phase: 'prepare' | 'commit';
        request: AgentSessionOpenRequest;
        providerSessionId: string | null;
        signal: AbortSignal;
    }>) => Promise<void>;
    transformAgentRequest?: (params: Readonly<{
        sessionId: string;
        payload: Readonly<Record<string, unknown>>;
        signal?: AbortSignal;
    }>) => Promise<Readonly<Record<string, unknown>>>;
    generationSignal?: AbortSignal;
    publishHostEvent?: (event: HostSemanticEventV1) => void;
    isMediatorPluginCurrent?: (pluginId: string) => boolean;
    isMediatorContributionCurrent?: HostSessionRuntimeConfig['isMediatorContributionCurrent'];
    agentSessionRealtimeVoiceAuthority?:
        HostSessionRuntimeConfig['agentSessionRealtimeVoiceAuthority'];
}>): Promise<HostSessionRuntimePlan> {
    const identity = params.identity ?? params.lease;
    if (!identity) {
        throw new Error('Native Agent runtime identity is required');
    }
    if ((params.runtime === undefined) === (params.createRuntime === undefined)) {
        throw new Error(
            'Native Agent session runtime requires exactly one runtime source',
        );
    }
    if (params.createRuntime && !params.authorizeNewTurn) {
        throw new Error(
            'Runner-owned Agent session runtime requires current daemon new-turn admission',
        );
    }
    const contributionId = params.agent.identity?.localId ?? identity.agentId;
    let initialTerminalFollowProviderSession:
        Parameters<
            typeof createHostTerminalTranscriptFollowService
        >[0]['followProviderSession'] | null = null;
    let initialTerminalTranscriptFollowSignal: AbortSignal | null = null;
    let runtimeExecutionSurfaces = params.executionSurfaces;
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
        ...(params.isMediatorPluginCurrent
            ? { isMediatorPluginCurrent: params.isMediatorPluginCurrent }
            : {}),
        ...(params.isMediatorContributionCurrent
            ? { isMediatorContributionCurrent: params.isMediatorContributionCurrent }
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
            const runtimeIncarnationId = randomUUID();
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
            const resolveLateEnvironment =
                params.sessionInput.bootstrap.resolveLateEnvironment;
            let resolvedLateEnvironmentValues:
                Readonly<Record<string, string>> | null = null;
            let resolvedLateSensitiveEnvironmentVariableNames:
                readonly string[] = Object.freeze([]);
            let resolvedLateProviderBindingHandoff:
                ReturnType<
                    typeof consumeProviderBindingLaunchHandoffFromEnvironments
                > | null = null;
            let lateProviderBindingMaterializationCleanup:
                (() => void) | null = null;
            let transformAgentChildLaunchEnvironment:
                ((environment: Readonly<Record<string, string>>) =>
                    Readonly<Record<string, string>>) | null = null;
            const selectedProviderConnectionId =
                params.sessionInput.runtimePreferences.modelSelection
                    ?.ref.providerConnectionId ?? null;
            const authoritativeProviderBindingMetadata =
                readSessionProviderBindingMetadataV1(
                    hostRuntimeParams.metadata,
                );
            if (
                selectedProviderConnectionId !== null
                && (
                    !authoritativeProviderBindingMetadata
                    || authoritativeProviderBindingMetadata.connectionId
                        !== selectedProviderConnectionId
                )
            ) {
                throw new Error(
                    'Provider-bound model selection requires exact authoritative Provider binding metadata',
                );
            }
            const useRunnerManagedProviderBinding =
                selectedProviderConnectionId !== null
                && authoritativeProviderBindingMetadata
                    ?.runtimeBindingBasis?.deployment.kind
                    === 'managedLocal';
            if (
                useRunnerManagedProviderBinding
                && !params.prepareManagedProviderBinding
            ) {
                throw new Error(
                    'Managed Provider binding requires runner custody preparation',
                );
            }
            const cleanupLateProviderBindingMaterialization = () => {
                const cleanup = lateProviderBindingMaterializationCleanup;
                lateProviderBindingMaterializationCleanup = null;
                cleanup?.();
            };
            try {
                const resolvedLateEnvironment = resolveLateEnvironment
                    ? await resolveLateEnvironment({ sessionId })
                    : null;
                if (resolvedLateEnvironment) {
                    const lateEnvironment = {
                        ...resolvedLateEnvironment.environmentVariables,
                    };
                    const privateProviderBindingHandoff =
                        consumeProviderBindingLaunchHandoffFromEnvironments([
                            lateEnvironment,
                        ]);
                    const providerBindingHandoff =
                        useRunnerManagedProviderBinding
                            ? null
                            : privateProviderBindingHandoff;
                    if (
                        useRunnerManagedProviderBinding
                        && privateProviderBindingHandoff
                    ) {
                        delete lateEnvironment[
                            HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY
                        ];
                        const runtimeBindingBasis =
                            privateProviderBindingHandoff
                                .sessionBindingMetadata
                                .runtimeBindingBasis;
                        for (
                            const key of runtimeBindingBasis
                                ?.agentSupport.authIsolation
                                .ownedEnvKeys ?? []
                        ) {
                            delete lateEnvironment[key];
                        }
                    }
                    if (
                        providerBindingHandoff?.materialization.kind
                        === 'configFile'
                    ) {
                        lateProviderBindingMaterializationCleanup =
                            createProviderBindingLaunchMaterializationCleanup({
                                materialization:
                                    providerBindingHandoff.materialization,
                                materializationBaseDir: join(
                                    happierConfiguration.happyHomeDir,
                                    'providers',
                                    'materialized',
                                ),
                            });
                        if (!lateProviderBindingMaterializationCleanup) {
                            throw new Error(
                                'Late Provider binding materialization is outside its retained Session custody root',
                            );
                        }
                    }
                    if (
                        selectedProviderConnectionId !== null
                        && !useRunnerManagedProviderBinding
                        && (
                            !providerBindingHandoff
                            || providerBindingHandoff.sessionBindingMetadata
                                .connectionId !== selectedProviderConnectionId
                        )
                    ) {
                        throw new Error(
                            'Provider-bound model selection requires a validated late provider binding handoff',
                        );
                    }
                    if (
                        selectedProviderConnectionId === null
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
                                    ...resolvedLateEnvironment
                                        .unsetEnvironmentVariables,
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
                        {
                            allowPendingProviderBinding:
                                useRunnerManagedProviderBinding,
                        },
                    );
                    resolvedLateEnvironmentValues =
                        Object.freeze(lateEnvironment);
                    resolvedLateSensitiveEnvironmentVariableNames =
                        resolvedLateEnvironment
                            .sensitiveEnvironmentVariableNames;
                    resolvedLateProviderBindingHandoff =
                        providerBindingHandoff;
                }
                await params.prepareRuntimeSource?.({
                    sessionId,
                    signal,
                });
            } catch (error) {
                ownedAbortController.abort(error);
                cleanupLateProviderBindingMaterialization();
                throw error;
            }
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
            try {
            assertGenerationCurrent();
            if (params.managedServiceEndpointReadPort) {
                registerRunnerManagedServiceEndpointReadRpcHandlers(
                    hostRuntimeParams.session.rpcHandlerManager,
                    params.managedServiceEndpointReadPort,
                );
            }
            if (params.managedServicesCustodyPort) {
                registerRunnerManagedServicesCustodyRpcHandler(
                    hostRuntimeParams.session.rpcHandlerManager,
                    params.managedServicesCustodyPort,
                );
            }
            const sessionHostServices = params.createSessionHostServiceOwners({
                hostRuntimeParams,
                sessionId,
                directory: cwd,
                signal,
            });
            const externalSessionHostOperations =
                params.externalSessionHostOperations?.bindSession(sessionId) ?? null;
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
                    attach: async (ref, source) => {
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
                        return { sessionId: linked.sessionId };
                    },
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
                    const configuredExternalSessions = lifecycle.compositionPort;
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
                                    ...(request.admissionDeadlineAtMs !== undefined
                                        ? {
                                            admissionDeadlineAtMs:
                                                request.admissionDeadlineAtMs,
                                        }
                                        : {}),
                                    signal: request.signal,
                                });
                        if (target.status === 'unavailable') return target;
                        return await configuredExternalSessions
                            .followTranscript(
                                target,
                                {
                                    ...(request.initialReplay
                                        ? { initialReplay: true }
                                        : {}),
                                    ...(request.admissionDeadlineAtMs !== undefined
                                        ? { admissionDeadlineAtMs: request.admissionDeadlineAtMs }
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
                            ...(request.initialReplay
                                ? { initialReplay: true }
                                : {}),
                            ...(request.admissionDeadlineAtMs !== undefined
                                ? { admissionDeadlineAtMs: request.admissionDeadlineAtMs }
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
            const livePermissionHandler = hostRuntimeParams.permissionHandler
                && typeof hostRuntimeParams.permissionHandler.handleToolCall === 'function'
                ? hostRuntimeParams.permissionHandler
                : null;
            const authorizeNativeMediaRoot = async (canonicalRoot: string): Promise<boolean> => {
                const canonicalCwd = await realpath(cwd).catch(() => null);
                if (!canonicalCwd) return false;
                const candidateRelative = relative(canonicalCwd, canonicalRoot);
                return candidateRelative === '' || (
                    candidateRelative !== '..'
                    && !candidateRelative.startsWith(`..${sep}`)
                    && !isAbsolute(candidateRelative)
                );
            };
            let readActiveTurnAdmissionWitness = ():
                NativeAgentNewTurnAdmissionWitness | null => null;
            const nativeSessionServiceParams = {
                permissionHandler: livePermissionHandler,
                credentials: params.sessionInput.credentials,
                readCredentials: readStoredCredentials,
                readPermissionMode: hostRuntimeParams.getPermissionMode,
                pluginId: identity.pluginId,
                contributionId,
                runtimeId: identity.agentId,
                sessionId,
                generationId: identity.generation,
                ...(identity.immutableGenerationId
                    ? { immutableGenerationId: identity.immutableGenerationId }
                    : {}),
                isCurrent: identity.isCurrent,
                ...(params.resolveCallerMaterialization
                    ? { resolveCallerMaterialization: params.resolveCallerMaterialization }
                    : {}),
                signal,
                readActiveTurnAdmissionWitness: () =>
                    readActiveTurnAdmissionWitness(),
                ...(mediaAdapter ? {
                    media: mediaAdapter.forAuthorizedSession(sessionId, authorizeNativeMediaRoot),
                } : {}),
                presentation,
            } as const;
            const currentSessionUi = createNativeAgentCurrentSessionUiServices(nativeSessionServiceParams);
            const sessionServices = createNativeAgentSessionServices({
                ...nativeSessionServiceParams,
                currentSessionUi,
            });
            const currentSessionHandle = sessionServices.sessions.current;
            if (!currentSessionHandle) {
                throw new Error('native_agent_current_session_unavailable');
            }
            registerCurrentSessionUiBinding({
                sessionId,
                service: currentSessionUi,
                signal,
                isCurrent: identity.isCurrent,
                capabilities: {
                    ...(livePermissionHandler ? { permissionHandler: livePermissionHandler } : {}),
                    readPermissionMode: hostRuntimeParams.getPermissionMode,
                    ...(mediaAdapter ? {
                        createMediaService: (authorizeSourceRoot) => (
                            mediaAdapter.forAuthorizedSession(sessionId, authorizeSourceRoot)
                        ),
                    } : {}),
                },
            });
            if (
                params.prepareManagedProviderBinding
                && useRunnerManagedProviderBinding
            ) {
                const publicBinding =
                    await params.prepareManagedProviderBinding({
                        sessionId,
                        cwd,
                        environment:
                            openInputs.launchEnvironment.values,
                        signal,
                        session: Object.freeze({
                            id: sessionId,
                            current: currentSessionUi,
                        }),
                        readActiveTurnAdmissionWitness: () =>
                            readActiveTurnAdmissionWitness(),
                    });
                const providerConnectionId =
                    selectedProviderConnectionId;
                if (
                    providerConnectionId !== null
                    && (
                        !publicBinding
                        || publicBinding.handoff
                            .sessionBindingMetadata.connectionId
                            !== providerConnectionId
                    )
                ) {
                    throw new Error(
                        'Provider-bound model selection requires the exact public managed Provider binding',
                    );
                }
                if (providerConnectionId === null && publicBinding) {
                    publicBinding.cleanup?.();
                    throw new Error(
                        'Native model selection cannot include a public managed Provider binding',
                    );
                }
                if (publicBinding) {
                    transformAgentChildLaunchEnvironment =
                        publicBinding
                            .transformAgentChildLaunchEnvironment;
                    const lateEnvironment = {
                        ...(resolvedLateEnvironmentValues ?? {}),
                    };
                    for (const entry of publicBinding.environmentOverlay) {
                        if (entry.value === null) {
                            delete lateEnvironment[entry.name];
                        } else {
                            lateEnvironment[entry.name] = entry.value;
                        }
                    }
                    const lateInput: PluginSessionBindingInput =
                        Object.freeze({
                            ...params.sessionInput,
                            bootstrap: Object.freeze({
                                ...params.sessionInput.bootstrap,
                                environmentVariables: Object.freeze({
                                    ...(params.sessionInput.bootstrap
                                        .environmentVariables ?? {}),
                                    ...lateEnvironment,
                                }),
                            }),
                        });
                    openInputs = buildNativeAgentSessionOpenInputs(
                        lateInput,
                        applySessionProviderBindingMetadataV1(
                            hostRuntimeParams.metadata,
                            publicBinding.handoff
                                .sessionBindingMetadata,
                        ),
                        publicBinding.handoff.materialization,
                        hostRuntimeParams.getPermissionMode(),
                    );
                    cleanupLateProviderBindingMaterialization();
                    lateProviderBindingMaterializationCleanup =
                        publicBinding.cleanup;
                    resolvedLateEnvironmentValues =
                        Object.freeze(lateEnvironment);
                    resolvedLateSensitiveEnvironmentVariableNames =
                        Object.freeze([
                            ...new Set([
                                ...resolvedLateSensitiveEnvironmentVariableNames,
                                ...publicBinding.environmentOverlay
                                    .filter((entry) =>
                                        entry.value !== null)
                                    .map((entry) => entry.name),
                            ]),
                        ]);
                    resolvedLateProviderBindingHandoff =
                        publicBinding.handoff;
                }
            }
            const operationServices = await params.createInvocationServices?.({
                correlationId: sessionId,
                cwd,
                environment: openInputs.launchEnvironment.values,
                providerBindingActive: openInputs.providerBinding !== undefined,
                signal,
                session: Object.freeze({
                    id: sessionId,
                    current: currentSessionUi,
                }),
                readActiveTurnAdmissionWitness: () =>
                    readActiveTurnAdmissionWitness(),
            });
            const services = operationServices
                ? Object.freeze({
                    ...operationServices,
                    availability: (serviceId: Parameters<PluginServices['availability']>[0]) => (
                        serviceId === 'sessions'
                            ? sessionServices.availability('sessions')
                            : operationServices.availability(serviceId)
                    ),
                    sessions: Object.freeze({
                        ...sessionServices.sessions,
                        external: operationServices.sessions.external,
                    }),
                })
                : sessionServices;
            const terminalHostLaunchTransformerBinding =
                sessionHostServices.terminalHost
                && transformAgentChildLaunchEnvironment
                    ? installAgentChildLaunchEnvironmentTransformerForTerminalHost(
                        sessionHostServices.terminalHost,
                        transformAgentChildLaunchEnvironment,
                    )
                    : null;
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
                                    terminalHostLaunchTransformerBinding
                                        ?.dispose();
                                    await sessionHostServices.dispose();
                                }
                            }
                            }
                        } catch (error) {
                            throw sanitizeBoundaryError(error);
                        }
                    } finally {
                        try {
                            lateProfileDiagnosticRedaction?.close();
                            lateProfileDiagnosticRedaction = null;
                            lateDiagnosticRedaction?.close();
                            lateDiagnosticRedaction = null;
                        } finally {
                            cleanupLateProviderBindingMaterialization();
                        }
                    }
                })();
                return cleanupRuntimeScopePromise;
            };
            let runtime: AgentRuntime | undefined = params.runtime;
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
                        ...(terminalHostScope ? { terminalHost: terminalHostScope.service } : {}),
                        publications: publications.services,
                        readToolExecutionCapability: () => runtime?.toolExecution?.capability ?? null,
                    }),
                }),
                signal,
                services,
                ui: createPluginInvocationPresentation({
                    currentSession: currentSessionUi,
                    signal,
                    isGenerationCurrent: identity.isCurrent,
                    ...(identity.immutableGenerationId
                        ? {
                            presentationOwner: Object.freeze({
                                pluginId: identity.pluginId,
                                contributionId,
                                generationId: identity.immutableGenerationId,
                                invocationId: runtimeIncarnationId,
                            }),
                        }
                        : {}),
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
                                            throw new PluginError({
                                                code: 'plugin_exec_managed_dependency_denied',
                                                message: 'ACP managed-dependency resolution cannot cross plugin identity',
                                            });
                                        }
                                        return await resolvePluginExecManagedDependencyForHost(
                                            services.exec,
                                            request.dependencyId,
                                            { signal: request.signal },
                                        );
                                    },
                                }),
                                ...(transformAgentChildLaunchEnvironment
                                    ? {
                                        transformAgentChildLaunchEnvironment,
                                    }
                                    : {}),
                                ...(params.transformAgentRequest
                                    ? {
                                        transformAgentRequest: async (payload, options) =>
                                            await params.transformAgentRequest!({
                                                sessionId,
                                                payload,
                                                signal: options.signal,
                                            }),
                                    }
                                    : {}),
                                interactions: currentSessionUi.interactions,
                                media: currentSessionHandle.media,
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
            const startupInstructions =
                params.sessionInput.agentSessionStartupInstructionsV1;
            const clonedStartupInstructions = startupInstructions
                ? Object.freeze({
                    v: startupInstructions.v,
                    id: startupInstructions.id,
                    revision: startupInstructions.revision,
                    instructions: startupInstructions.instructions,
                })
                : undefined;
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
                        ...(clonedStartupInstructions
                            ? { startupInstructions: clonedStartupInstructions }
                            : {}),
                    })
                    : Object.freeze({
                        kind: 'create',
                        sessionId,
                        cwd,
                        ...openInputs,
                        ...(mcpServers ? { mcpServers } : {}),
                        ...(clonedStartupInstructions
                            ? { startupInstructions: clonedStartupInstructions }
                            : {}),
                    });
            let session: AgentSessionRuntime;
            let sessions: NonNullable<AgentRuntime['sessions']> | undefined;
            let continuationRefusalMustRemainPrimary = false;
            let openRequest: AgentSessionOpenRequest;
            try {
                if (resolvedLateEnvironmentValues) {
                    const lateEnvironment =
                        resolvedLateEnvironmentValues;
                    const providerBindingHandoff =
                        resolvedLateProviderBindingHandoff;
                    const sensitiveEnvironmentVariableNames =
                        resolvedLateSensitiveEnvironmentVariableNames;
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
                            providerRequirements:
                                params.agent.richDefinition?.definition
                                    .providerRequirements,
                            environment: lateEnvironment,
                        });
                }
                assertGenerationCurrent();
                runtime ??= await params.createRuntime!({ signal });
                assertGenerationCurrent();
                sessions = runtime.sessions;
                if (!sessions) {
                    throw new Error(
                        `Agent runtime '${identity.agentId}' does not support host sessions`,
                    );
                }
                const sessionFactory = sessions;
                if (params.createRuntime) {
                    const diagnostics: Parameters<
                        typeof resolveBackendExecutionSurfacesFromNativeAgentRuntime
                    >[0]['diagnostics'] = [];
                    const declaredSurfaceFamilies = new Set<
                        'terminalRuntime'
                    >();
                    if (
                        params.agent.richDefinition?.definition
                            .capabilities.surfaces?.includes('terminal')
                    ) {
                        declaredSurfaceFamilies.add('terminalRuntime');
                    }
                    const localRuntimeSurfaces =
                        resolveBackendExecutionSurfacesFromNativeAgentRuntime({
                            backend: params.backend,
                            runtime,
                            agentId: identity.agentId,
                            isCurrent: identity.isCurrent,
                            declaredAgentSurfaceFamilies:
                                declaredSurfaceFamilies,
                            diagnostics,
                        });
                    runtimeExecutionSurfaces = {
                        ...params.executionSurfaces,
                        terminalRuntime:
                            localRuntimeSurfaces.terminalRuntime,
                    };
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
                const providerSessionId =
                    openRequest.kind === 'resume'
                        ? openRequest.providerSessionId
                        : null;
                await params.attestSessionOpen?.({
                    phase: 'prepare',
                    request: openRequest,
                    providerSessionId,
                    signal,
                });
                assertGenerationCurrent();
                session = await openNativeAgentSessionUntilAbort(
                    () => sessionFactory.open(openRequest, context),
                    signal,
                );
                await params.attestSessionOpen?.({
                    phase: 'commit',
                    request: openRequest,
                    providerSessionId,
                    signal,
                });
            } catch (error) {
                let boundaryError = sanitizeBoundaryError(error);
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
            const toolExecutionCapability = runtime.toolExecution?.capability;
            const operations = createNativeAgentSessionOperations(
                session,
                sessionId,
                async () => {
                    if (disposeOnScopeAbort) {
                        signal.removeEventListener('abort', disposeOnScopeAbort);
                    }
                    const failures: unknown[] = [];
                    try {
                        await cleanupRuntimeScope();
                    } catch (error) {
                        failures.push(error);
                    }
                    try {
                        await params.retireRuntimeSource?.();
                    } catch (error) {
                        failures.push(error);
                    }
                    if (failures.length === 1) throw failures[0];
                    if (failures.length > 1) {
                        throw new AggregateError(
                            failures,
                            'Failed to dispose native Agent session runtime scope',
                        );
                    }
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
                    onTurnTerminal: async (
                        event,
                        admissionWitness,
                    ) => {
                        try {
                            await hostRuntimeParams.permissionHandler.cancelByPlugin(
                                identity.pluginId,
                                `agent_${event.kind}`,
                            );
                            if (admissionWitness) {
                                const userMessageSeqs = [...new Set([
                                    ...admissionWitness.userMessageSeqs,
                                    ...(admissionWitness.userMessageSeq === null
                                        ? []
                                        : [admissionWitness.userMessageSeq]),
                                ])].filter((seq) => Number.isSafeInteger(seq) && seq >= 0).sort((left, right) => left - right);
                                const startSeqInclusive = userMessageSeqs[0];
                                const endSeqInclusive = hostRuntimeParams.session.getLastObservedMessageSeq?.();
                                if (
                                    startSeqInclusive !== undefined
                                    && Number.isSafeInteger(endSeqInclusive)
                                    && endSeqInclusive >= startSeqInclusive
                                ) {
                                    await hostRuntimeParams.session.enqueueSessionTurnMutation?.({
                                        v: 1,
                                        sessionId,
                                        mutationId: `native-turn-input-anchors-${randomUUID()}`,
                                        observedAt: event.emittedAtMs,
                                        agentId: identity.agentId,
                                        action: 'append_transcript_anchors',
                                        turnId: event.turnId,
                                        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
                                        transcriptAnchors: {
                                            startUserMessageSeq: startSeqInclusive,
                                            userMessageSeqs,
                                            startSeqInclusive,
                                            endSeqInclusive,
                                        },
                                    });
                                }
                            }
                        } catch (error) {
                            ownedAbortController.abort(error);
                            throw error;
                        }
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
                    onRollbackBoundary: ({ event, startUserMessageSeq }) => (
                        hostRuntimeParams.session.enqueueSessionTurnMutation?.({
                            v: 1,
                            sessionId,
                            mutationId: `native-rollback-boundary-${randomUUID()}`,
                            observedAt: event.emittedAtMs,
                            agentId: identity.agentId,
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
                        })
                    ),
                    onRollbackApplied: (input) => (
                        hostRuntimeParams.session.enqueueSessionTurnMutation?.({
                            v: 1,
                            sessionId,
                            mutationId: `native-rollback-applied-${randomUUID()}`,
                            observedAt: input.observedAtMs,
                            agentId: identity.agentId,
                            action: 'mark_rolled_back',
                            turnId: input.turnId,
                            restoredToTurnId: input.restoredToTurnId,
                            ...(input.agentTurnId ? { agentTurnId: input.agentTurnId } : {}),
                            ...(typeof input.agentRollbackOrdinal === 'number'
                                ? { agentRollbackOrdinal: input.agentRollbackOrdinal }
                                : {}),
                        })
                    ),
                },
                sanitizeBoundaryError,
                params.authorizeNewTurn,
                (reader) => {
                    readActiveTurnAdmissionWitness = reader;
                },
                params.publishHostEvent,
                toolExecutionCapability
                    ? {
                        capability: toolExecutionCapability,
                        observeAfter: async (request) => {
                            await sessionHostServices.toolExecution.observeAfter({
                                capability: toolExecutionCapability,
                                ...request,
                            });
                        },
                    }
                    : undefined,
                runtimeIncarnationId,
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
            return {
                operations,
                ...(resolvedLateProviderBindingHandoff
                    ? {
                        admittedProviderBindingHandoff:
                            resolvedLateProviderBindingHandoff,
                    }
                    : {}),
            };
            } catch (error) {
                ownedAbortController.abort(error);
                await params.retireRuntimeSource?.()
                    .catch(() => undefined);
                cleanupLateProviderBindingMaterialization();
                throw error;
            }
        },
    });
    const createSessionRuntime = plan.config.createSessionRuntime;
    if (
        !createSessionRuntime
        || (
            !params.createRuntime
            && !params.executionSurfaces?.terminalRuntime?.launch
        )
    ) {
        return plan;
    }
    return {
        ...plan,
        config: {
            ...plan.config,
            createSessionRuntime: async (runtimeParams) => {
                const created = await createSessionRuntime(runtimeParams);
                const runtime = created.nativeRuntime ?? created.operations;
                const terminalRuntime =
                    runtimeExecutionSurfaces?.terminalRuntime;
                if (!terminalRuntime?.launch) {
                    return created;
                }
                const executableGrants = createPluginExecSystemToolGrantStore();
                const fetchCommittedTranscriptLocalIdBaseline =
                    runtimeParams.session.fetchCommittedTranscriptLocalIdBaseline;
                const terminalTranscriptFollowService =
                    initialTerminalFollowProviderSession
                    && initialTerminalTranscriptFollowSignal
                        ? createHostTerminalTranscriptFollowService({
                            followProviderSession:
                                initialTerminalFollowProviderSession,
                            ...(fetchCommittedTranscriptLocalIdBaseline
                                ? {
                                    loadCommittedLocalIdBaseline: (input) =>
                                        fetchCommittedTranscriptLocalIdBaseline.call(
                                            runtimeParams.session,
                                            input,
                                        ),
                                }
                                : {}),
                            signal: initialTerminalTranscriptFollowSignal,
                            publish:
                                createExternalSessionTerminalFollowProjector({
                                    sessionId: runtimeParams.session.sessionId,
                                    agentId: identity.agentId,
                                    projectRuntimeEvent: async (event, admission) =>
                                        await projectRuntimeTranscriptEvent({
                                            session: runtimeParams.session,
                                            provider: identity.agentId,
                                            event,
                                            ...(admission === undefined
                                                ? {}
                                                : { admission }),
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
                    terminal: terminalRuntime,
                    agentId: identity.agentId,
                    sessionId: runtimeParams.session.sessionId,
                    directory: runtimeParams.directory,
                    readMetadata: () => (
                        runtimeParams.session.getMetadataSnapshot()
                        ?? runtimeParams.metadata
                    ),
                    runWithTerminalModelSelection:
                        runtimeParams.runWithTerminalModelSelection,
                    // Declaration-derived, never inferred: the Agent's own cold
                    // `terminalFollow` opt-in is what makes follow admission a
                    // launch barrier (`ES-PEP-03`/`ES-PEP-05`).
                    requiresTranscriptFollow:
                        agentDeclaresExplicitTerminalFollow(params.agent),
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
