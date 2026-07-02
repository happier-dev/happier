import {
    ApprovalRequestV1Schema,
    ExternalSessionsProviderIdSchema,
    accountSettingsParse,
    isFeatureId,
    ProviderAccountUsageAdoptionV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    type AccountSettings,
    type ApprovalRequestV1,
    type ConnectedServiceId,
    type SessionMetadata,
} from '@happier-dev/protocol';
import {
    ACTION_ID_FAMILIES_V1,
    ActionIdSchema,
    getActionSpec,
    type ActionId,
} from '@happier-dev/protocol/actions';

import { resolveMergedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import type {
    ResolvedBackendContribution,
    ResolvedCatalogEntry,
    ResolvedContributionRegistry,
    ResolvedProviderContribution,
} from '../../../plugins/projection/registry/types';
import { pluginReloadController } from '../../../plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import {
    createEmptyBackendExecutionSurfaces,
    type BackendRuntimeOwnerCandidate,
    type BackendRuntimeOwnerResolution,
    type BackendRuntimeOwnerTakeoverMarker,
    type BackendExecutionSurfaces,
    type CreateCliExecutionRunBackendParams,
    type CliExecutionRunRuntime,
    type CliRuntimeCoreGetter,
    type CliEngineAdapter,
    type CliRuntimeCore,
    type EngineAdapterResolution,
    type EngineResolutionDiagnostic,
    type EngineResolutionSelectedSource,
    type ResolvedCliEngineRegistry,
} from './engineRegistryTypes';
import { createMissingCliEngineAdapter } from './createCliRuntimeCore';
import {
    readPluginDaemonConnectionStateSource,
    type PluginDaemonConnectionStateSource,
} from './pluginConnectionStateSource';
import { resolvePluginBackendSurfaceHandlers } from './resolvePluginBackendSurfaceHandlers';
import {
    collectEngineImplementedBackendSurfaceOperations,
    mergeBackendExecutionSurfaces,
    resolveBackendExecutionSurfacesFromEngine,
} from './backendEngineSurfaceBindings';
import {
    AGENT_IDS,
    getAgentResumeConfig,
    type TerminalRuntimeHostOrchestrationV1,
} from '@happier-dev/agents';
import { publishSessionStateFieldToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
    defineAcpBackend,
    readAcpBackendSpec,
    type ConnectionRuntimeServiceV1,
    type ConnectionStateV1,
    type FetchRuntimeServiceV1,
    type PluginAuthMaterializedServiceV1,
    type PluginAuthMaterializeRequestV1,
    type PluginContextV1,
    type PluginDisposable,
    type PluginSettingsFieldDescriptorV1,
    type PluginSessionGetParamsV1,
    type PluginSessionRefV1,
    type PluginSessionWatchEventV1,
    type PluginSessionWatchParamsV1,
    type BackendEngineV1,
    type BackendSurfaceDiagnosticV1,
    type ExternalSessionRuntimeContextV1,
    type RegisterBackendEngineV1,
    type SessionPermissionDecisionResultV1,
    type SessionPermissionDecisionV1,
    type SessionScopedServicesV1,
    type SubscriptionV1,
} from '@happier-dev/plugin-sdk';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import {
    notifyDaemonProviderAccountUsageAdoption,
    notifyDaemonProviderAccountUsageSnapshot,
} from '@/daemon/controlClient';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readBuiltInHostCatalogEntry } from '@/backends/builtInHostCatalogEntries';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { PermissionRequestNotFoundError } from '@/agent/permissions/permissionRequestNotFoundError';
import {
    createExecutionRunPermissionHandler,
    resolveExecutionRunPermissionDecision,
} from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
    createAcpRuntimeCoreFromDefinition,
    normalizePluginAcpDefinition,
    normalizePluginBackendContributionAcpDefinition,
} from '@/agent/acp/runtime/definition';
import { createAcpSessionOperations } from '@/agent/acp/createCatalogAcpBackend';
import { createBuiltInNotificationRegistry, createNotificationsService } from '@/notifications/service';
import { createNotificationRegistryFromPluginRuntime } from '@/notifications/pluginRuntimeRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginAuthService } from '@/plugins/runtime/context/auth';
import { createPluginAbortService } from '@/plugins/runtime/context/abort';
import { createPluginAcpRuntimeService } from '@/plugins/runtime/acp/runtime';
import { createPluginAgentsService } from '@/plugins/runtime/context/agents';
import { createPluginEnvService } from '@/plugins/runtime/context/env';
import { createPluginErrorsService } from '@/plugins/runtime/context/errors';
import { createPluginExecService } from '@/plugins/runtime/context/exec';
import { createPluginExecSystemToolGrantStore } from '@/plugins/runtime/context/exec/system/tools/grants';
import { createPluginFsService } from '@/plugins/runtime/context/fs';
import { createPluginManagedServerService } from '@/plugins/runtime/context/managed/server';
import { createPluginLocalServicesService } from '@/plugins/runtime/context/localServices';
import { createPluginMcpService } from '@/plugins/runtime/context/mcp';
import { createSessionScopedAuthServices } from '@/plugins/runtime/context/session/services/auth';
import { createSessionScopedMcpServices } from '@/plugins/runtime/context/session/services/mcp';
import { createDefaultPluginTerminalHostService } from '@/plugins/runtime/context/terminalHost';
import { createPluginHostedMcpServerHandle, createPluginHostedMcpServerRegistry } from '@/mcp/createPluginHostedMcpServerHandle';
import { startPluginHostedMcpLoopbackServer } from '@/mcp/hosted/startPluginHostedMcpLoopbackServer';
import { resolvePluginMcpServersForSession } from '@/mcp/servers/resolvePluginMcpServersForSession';
import { createPluginProgressService } from '@/plugins/runtime/context/progress';
import { createPluginRetryService } from '@/plugins/runtime/context/retry';
import { createPluginTimeoutService } from '@/plugins/runtime/context/timeout';
import { createPluginTranscriptsService } from '@/plugins/runtime/context/transcripts';
import { createTranscriptFileFollowPathGrantRegistry } from '@/plugins/runtime/context/transcripts/fileFollowGrants';
import { createExternalSessionCandidateHostService } from '@/session/external/candidates/host';
import { createExternalSessionTranscriptStoreService } from '@/session/external/transcripts/store';
import { resolveExternalSessionRuntimeHostAdapters } from '@/session/external/hostAdapters';
import {
    resolveConnectedServiceRuntimeAuthContextFromEnv,
    resolveConnectedServiceRuntimeAuthContextFromSessionMetadata,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { canPluginSubscribeToEvent, createPluginEventsService } from '@/plugins/runtime/context/events';
import {
    createSessionHooksService,
    type SessionHookTranscriptFileFollowGrantRequest,
} from '@/plugins/runtime/hooks/session/service';
import { createPluginSecretsService } from '@/plugins/runtime/context/secrets';
import { createPluginSettingsService } from '@/plugins/runtime/context/settings';
import {
    createAccountSettingsBackedPluginStorageScope,
    createPluginStorageService,
} from '@/plugins/runtime/context/storage';
import { enqueueDurableRegisteredSessionStateFieldWrite } from '@/agent/runtime/state/registeredFieldDurability';
import { createTerminalRuntimeHostOrchestration } from '@/agent/runtime/session/terminal/orchestration';
import { createTerminalRuntimeProjectionHostService } from '@/agent/runtime/session/terminal/projection';
import { createTerminalRuntimeTranscriptBindingHostService } from '@/agent/runtime/session/terminal/transcriptBinding';
import { createPluginFetchService } from '@/plugins/runtime/fetch/service';
import {
    createPluginReviewCommentsService,
    type ReviewCommentActionExecutor,
} from '@/agent/reviews/comments/pluginApi';
import {
    createCliReviewCommentActionExecutorFromCredentials,
} from '@/agent/reviews/comments/executor';
import { resolveReviewCommentSnapshot } from '@/agent/reviews/comments/snapshots';
import { splitDurableRegisteredSessionStateMetadata } from './pluginMetadataDurability';
import {
    deliverExecutionRunSessionMetadata,
    deliverExecutionRunSessionStateField,
    readExecutionRunSessionStateTarget,
    throwIfExecutionRunSessionStateUnsupported,
    type ExecutionRunSessionStateTarget,
} from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import {
    getActiveAccountSettingsSnapshot,
    setActiveAccountSettingsSnapshot,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import {
    createAccountSettingsService,
    createProjectsService,
    type WorkspaceRefScopeV1,
} from '@/settings/accountSettings/workspaceRefsV1';

const PLUGIN_CONTEXT_V1_BINDER = Symbol('happier.pluginContextV1.binder');

const STATIC_VENDOR_SESSION_METADATA_KEYS = [
    'claudeSessionId',
    'codexSessionId',
    'geminiSessionId',
    'opencodeSessionId',
    'auggieSessionId',
    'qwenSessionId',
    'kimiSessionId',
    'kiloSessionId',
    'piSessionId',
    'copilotSessionId',
] as const;

const BASE_SESSION_STATE_METADATA_KEYS = [
    'runtimeDescriptorV1',
    'agentRuntimeDescriptorV1',
    'permissionMode',
    'permissionModeUpdatedAt',
    'modelOverrideV1',
    'sessionModeOverrideV1',
    'acpSessionModeOverrideV1',
    'sessionConfigOptionOverridesV1',
    'acpConfigOptionOverridesV1',
    'summary',
    'readStateV1',
    'externalSessionAttentionV1',
] as const;

function getSessionStateMetadataKeys(): ReadonlySet<string> {
    const manifestVendorKeys: readonly string[] = Array.isArray(AGENT_IDS)
        ? AGENT_IDS.flatMap((agentId) => {
            const field = getAgentResumeConfig(agentId).vendorResumeIdField;
            return typeof field === 'string' && field.length > 0 ? [field] : [];
        })
        : STATIC_VENDOR_SESSION_METADATA_KEYS;
    return new Set<string>([
        ...BASE_SESSION_STATE_METADATA_KEYS,
        ...manifestVendorKeys,
    ]);
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function preserveSessionStateMetadataKeys(
    current: unknown,
    candidate: unknown,
): Record<string, unknown> {
    const currentRecord = isMetadataRecord(current) ? current : {};
    const candidateRecord = isMetadataRecord(candidate) ? candidate : {};
    const next: Record<string, unknown> = { ...candidateRecord };

    for (const key of getSessionStateMetadataKeys()) {
        if (Object.prototype.hasOwnProperty.call(currentRecord, key)) {
            next[key] = currentRecord[key];
        } else {
            delete next[key];
        }
    }

    return next;
}

type PluginMetadataDurableSession = Pick<
    ApiSessionClient,
    'sessionId' | 'enqueueRegisteredSessionStateFieldMutation'
>;
type RegisteredSessionStateFieldMutationForPluginWrite = Parameters<
    PluginMetadataDurableSession['enqueueRegisteredSessionStateFieldMutation']
>[0];

function splitPluginMetadataDurableRegisteredFields(params: Readonly<{
    session: Partial<PluginMetadataDurableSession> & Pick<ApiSessionClient, 'sessionId'>;
    current: unknown;
    candidate: unknown;
    source: RegisteredSessionStateFieldMutationForPluginWrite['source'];
}>): Readonly<{
    metadata: Record<string, unknown>;
    mutations: readonly RegisteredSessionStateFieldMutationForPluginWrite[];
}> {
    if (typeof params.session.enqueueRegisteredSessionStateFieldMutation !== 'function') {
        return {
            metadata: isMetadataRecord(params.candidate) ? params.candidate : {},
            mutations: [],
        };
    }
    return splitDurableRegisteredSessionStateMetadata({
        sessionId: params.session.sessionId,
        current: params.current,
        candidate: params.candidate,
        source: params.source,
    });
}

async function publishPluginMetadataDurableRegisteredFieldMutations(
    session: Partial<PluginMetadataDurableSession>,
    mutations: readonly RegisteredSessionStateFieldMutationForPluginWrite[],
): Promise<void> {
    if (typeof session.enqueueRegisteredSessionStateFieldMutation !== 'function') return;
    for (const mutation of mutations) {
        await session.enqueueRegisteredSessionStateFieldMutation(mutation);
    }
}

const IDLE_DAEMON_CONNECTION_STATE: ConnectionStateV1 = Object.freeze({
    phase: 'idle',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
});

type PluginContextV1Binder = Readonly<{
    bindHostSessionRuntime: (params: HostSessionRuntimeFactoryParams) => void;
    resolveTerminalRuntimeHostOrchestration: (sessionId: string) => TerminalRuntimeHostOrchestrationV1 | null;
    bindExecutionRun: (params: Readonly<{
        runId?: string | null;
        permissionMode?: string | null;
        rootPath?: string | null;
        parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
    }>) => ExecutionRunContextScope;
    grantExternalSessionTranscriptPath: (request: Readonly<{
        path: string;
        sourceId: string;
        sessionId?: string | null;
    }>) => Promise<void>;
    revokeTranscriptFileFollowScope: (scope: Readonly<{ sessionId?: string | null }>) => Promise<void>;
    runWithTranscriptFileFollowSession: <T>(sessionId: string | null, fn: () => Promise<T>) => Promise<T>;
    runWithScope: <T>(scope: BoundContextScope, fn: () => T) => T;
}>;

type RuntimeRegistryBackendEngineEntry = Readonly<{
    pluginId?: string;
    registration?: unknown;
}>;

function readPluginContextV1Binder(ctx: PluginContextV1): PluginContextV1Binder | null {
    const record = ctx as unknown as Record<PropertyKey, unknown>;
    const binder = record[PLUGIN_CONTEXT_V1_BINDER];
    return binder && typeof binder === 'object' ? (binder as PluginContextV1Binder) : null;
}

function readRuntimeRegistryBackendEngineEntry(
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry,
    backendId: string,
): RuntimeRegistryBackendEngineEntry | undefined {
    const registry = runtimeRegistry.backendEnginesByBackendId;
    return registry && typeof registry.get === 'function' ? registry.get(backendId) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSessionPermissionDecisionResult(value: unknown): SessionPermissionDecisionResultV1 {
    const decision = isRecord(value) && typeof value.decision === 'string'
        ? value.decision
        : 'denied';
    if (
        decision === 'approved'
        || decision === 'approved_for_session'
        || decision === 'approved_execpolicy_amendment'
        || decision === 'denied'
        || decision === 'abort'
    ) {
        const result: {
            decision: SessionPermissionDecisionV1;
            rationale?: string;
            answers?: Readonly<Record<string, string>>;
            updatedInput?: Readonly<Record<string, unknown>>;
            updatedPermissions?: readonly Readonly<Record<string, unknown>>[];
        } = { decision };
        if (typeof value === 'object' && value && 'rationale' in value) {
            const rationale = (value as Readonly<Record<string, unknown>>).rationale;
            if (typeof rationale === 'string') {
                result.rationale = rationale;
            }
        }
        if (isRecord(value)) {
            const answers = value.answers;
            if (isRecord(answers)) {
                const normalizedAnswers: Record<string, string> = {};
                for (const [question, answer] of Object.entries(answers)) {
                    if (question && typeof answer === 'string') {
                        normalizedAnswers[question] = answer;
                    }
                }
                if (Object.keys(normalizedAnswers).length > 0) {
                    result.answers = normalizedAnswers;
                }
            }
            const updatedInput = value.updatedInput;
            if (isRecord(updatedInput)) {
                result.updatedInput = updatedInput;
            }
            const updatedPermissions = value.updatedPermissions;
            if (Array.isArray(updatedPermissions)) {
                const normalizedUpdates = updatedPermissions.filter(isRecord);
                if (normalizedUpdates.length > 0) {
                    result.updatedPermissions = normalizedUpdates;
                }
            }
        }
        return result;
    }
    return { decision: 'denied' };
}

function readNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readConnectionPhase(value: unknown): ConnectionStateV1['phase'] {
    switch (value) {
        case 'idle':
        case 'connecting':
        case 'online':
        case 'offline':
        case 'auth_failed':
        case 'shutting_down':
            return value;
        default:
            return 'idle';
    }
}

function projectConnectionStateV1(state: unknown): ConnectionStateV1 {
    if (!isRecord(state)) {
        return IDLE_DAEMON_CONNECTION_STATE;
    }
    const projected = {
        phase: readConnectionPhase(state.phase),
        reason: typeof state.reason === 'string' ? state.reason : null,
        attempt: typeof state.attempt === 'number' && Number.isFinite(state.attempt) ? state.attempt : 0,
        nextRetryAt: readNumberOrNull(state.nextRetryAt),
        lastConnectedAt: readNumberOrNull(state.lastConnectedAt),
        lastDisconnectedAt: readNumberOrNull(state.lastDisconnectedAt),
        lastErrorMessage: typeof state.lastErrorMessage === 'string' ? state.lastErrorMessage : null,
    } satisfies ConnectionStateV1;
    return Object.freeze(projected);
}

function hasRuntimeDisposableRegistrar(
    value: unknown,
): value is Readonly<{ addRuntimeDisposable: (pluginId: string, disposable: PluginDisposable) => PluginDisposable }> {
    return isRecord(value) && typeof value.addRuntimeDisposable === 'function';
}

function createIdleConnectionStateSource(): PluginDaemonConnectionStateSource {
    return Object.freeze({
        onConnectionStateChange(listener: (state: unknown) => void) {
            listener(IDLE_DAEMON_CONNECTION_STATE);
            return () => undefined;
        },
    });
}

function createConnectionRuntimeService(params?: Readonly<{
    source?: PluginDaemonConnectionStateSource | null;
}>): ConnectionRuntimeServiceV1 {
    const resolveSource = (): PluginDaemonConnectionStateSource => (
        params?.source
        ?? readPluginDaemonConnectionStateSource()
        ?? createIdleConnectionStateSource()
    );
    const readCurrentState = (): ConnectionStateV1 => {
        let current = IDLE_DAEMON_CONNECTION_STATE;
        const source = resolveSource();
        const unsubscribe = source.onConnectionStateChange((state) => {
            current = projectConnectionStateV1(state);
        });
        unsubscribe();
        return current;
    };

    const service: ConnectionRuntimeServiceV1 = Object.freeze({
        getDaemonLinkState: readCurrentState,
        watchDaemonLink(listener: Parameters<ConnectionRuntimeServiceV1['watchDaemonLink']>[0]) {
            let unsubscribed = false;
            const source = resolveSource();
            const unsubscribeSource = source.onConnectionStateChange((state) => {
                if (unsubscribed) {
                    return;
                }
                const projected = projectConnectionStateV1(state);
                try {
                    listener(projected);
                } catch (error) {
                    logger.warn('[PluginContextV1] ctx.connection watcher failed (ignored)', {
                        error,
                    });
                }
            });
            return Object.freeze({
                unsubscribe: () => {
                    if (unsubscribed) {
                        return;
                    }
                    unsubscribed = true;
                    unsubscribeSource();
                },
            });
        },
        isDaemonOnline: () => readCurrentState().phase === 'online',
    });
    return service;
}

function sanitizePathSegment(value: string): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '') || 'unknown';
}

function sanitizeEnvKeySegment(value: string): string {
    return String(value ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '') || 'UNKNOWN';
}

function parseEnvBoundedInt(name: string, opts: Readonly<{ min: number; max: number; fallback: number }>): number {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim().length === 0) return opts.fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return opts.fallback;
    return Math.min(opts.max, Math.max(opts.min, parsed));
}

function parseEnvBoolean(name: string, opts?: Readonly<{ defaultValue?: boolean }>): boolean {
    const raw = process.env[name];
    if (typeof raw !== 'string') return opts?.defaultValue ?? false;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) return opts?.defaultValue ?? false;
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return opts?.defaultValue ?? false;
}

function resolveExtensionArtifactsDir(params: Readonly<{ backendId: string }>): string | null {
    const backendId = sanitizePathSegment(params.backendId);
    const upper = sanitizeEnvKeySegment(params.backendId);

    const perBackendKey = `HAPPIER_${upper}_DEBUG_ARTIFACTS_DIR`;
    const perBackend = process.env[perBackendKey];
    if (typeof perBackend === 'string' && perBackend.trim().length > 0) {
        return perBackend.trim();
    }

    const globalRoot = process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
    if (typeof globalRoot === 'string' && globalRoot.trim().length > 0) {
        return `${globalRoot.trim()}/plugins/${backendId}`;
    }

    // Default location is safe, but only used when explicitly enabled by env gating above.
    return join(configuration.happyHomeDir, 'cli', 'logs', 'plugins', backendId);
}

function createUnavailablePluginActionMethod(actionId: string): (input: unknown) => Promise<never> {
    return async (_input: unknown): Promise<never> => {
        throw new Error(`Plugin action '${actionId}' is not available in this runtime context`);
    };
}

type PluginApprovalRuntimeScope = Readonly<{
    sessionId?: string | null;
    serverId?: string | null;
}>;

function readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseApprovalRequestInput(input: unknown): Readonly<{
    actionId: ActionId;
    args: unknown;
    summary: string;
    surface: string | null;
    preview: unknown;
}> {
    if (!isRecord(input)) {
        throw new Error('ctx.actions.approvals.request requires an object input');
    }
    const actionId = readTrimmedString(input.actionId);
    const parsedActionId = actionId ? ActionIdSchema.safeParse(actionId) : null;
    if (!parsedActionId?.success) {
        throw new Error('ctx.actions.approvals.request requires a valid actionId');
    }
    if ((ACTION_ID_FAMILIES_V1.approvals as readonly string[]).includes(parsedActionId.data)) {
        throw new Error('ctx.actions.approvals.request cannot create approval-control approvals');
    }
    const summary = readTrimmedString(input.summary);
    if (!summary) {
        throw new Error('ctx.actions.approvals.request requires a non-empty summary');
    }
    return {
        actionId: parsedActionId.data,
        args: Object.prototype.hasOwnProperty.call(input, 'args') ? input.args : {},
        summary,
        surface: readTrimmedString(input.surface),
        preview: input.preview,
    };
}

function parseApprovalArtifactId(input: unknown): string {
    const artifactId = readTrimmedString(input);
    if (!artifactId) {
        throw new Error('ctx.actions.approvals.get requires a non-empty artifact id');
    }
    return artifactId;
}

function parseApprovalListInput(input: unknown): Readonly<{
    status: ApprovalRequestV1['status'] | null;
    limit: number | null;
}> {
    if (input == null) {
        return { status: null, limit: null };
    }
    if (!isRecord(input)) {
        throw new Error('ctx.actions.approvals.list requires an object input when provided');
    }
    const rawStatus = readTrimmedString(input.status);
    const status = rawStatus === 'open'
        || rawStatus === 'approved'
        || rawStatus === 'rejected'
        || rawStatus === 'executed'
        || rawStatus === 'failed'
        || rawStatus === 'canceled'
        ? rawStatus
        : null;
    const limit = readOptionalFiniteNumber(input.limit);
    return { status, limit };
}

function createAbortReasonError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error) {
        return reason;
    }
    if (typeof reason === 'string' && reason.trim().length > 0) {
        return new Error(reason.trim());
    }
    return new Error('Plugin permission request canceled');
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createAbortReasonError(signal);
    }
}

async function withCallerAbortSignal<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (!signal) {
        return await operation;
    }
    throwIfSignalAborted(signal);
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(createAbortReasonError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}

function createPluginContextActionsService(params: Readonly<{
    pluginId: string;
    readScope: () => PluginApprovalRuntimeScope;
}>): PluginContextV1['actions'] {
    const loadApprovalsStore = async () => {
        const credentials = await readCredentials();
        if (!credentials) {
            throw new Error('ctx.actions.approvals requires authenticated approval credentials');
        }
        return createCliApprovalsArtifactStore({ credentials });
    };
    return Object.freeze({
        approvals: Object.freeze({
            request: async (input: unknown) => {
                const requestInput = parseApprovalRequestInput(input);
                const spec = getActionSpec(requestInput.actionId);
                const args = spec.inputSchema.safeParse(requestInput.args);
                if (!args.success) {
                    throw new Error('ctx.actions.approvals.request action args are invalid for actionId');
                }
                const now = Date.now();
                const scope = params.readScope();
                const request = ApprovalRequestV1Schema.parse({
                    v: 1,
                    status: 'open',
                    createdAtMs: now,
                    updatedAtMs: now,
                    createdBy: {
                        surface: 'system',
                        agentId: params.pluginId,
                        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
                    },
                    ...(requestInput.surface ? { requestedSurface: requestInput.surface } : {}),
                    ...(spec.approval ? { approval: spec.approval } : {}),
                    actionId: requestInput.actionId,
                    actionArgs: args.data,
                    summary: requestInput.summary,
                    ...(requestInput.preview !== undefined ? { preview: requestInput.preview } : {}),
                });
                const store = await loadApprovalsStore();
                const result = await store.approvalsCreate({
                    request,
                    serverId: scope.serverId ?? null,
                });
                return { approvalRequestId: result.artifactId };
            },
            get: async (input: string) => {
                const artifactId = parseApprovalArtifactId(input);
                const scope = params.readScope();
                const store = await loadApprovalsStore();
                return await store.approvalsGet({
                    artifactId,
                    serverId: scope.serverId ?? null,
                });
            },
            list: async (input: Readonly<{ status?: ApprovalRequestV1['status'] | null; limit?: number | null }> | undefined) => {
                const listInput = parseApprovalListInput(input);
                const scope = params.readScope();
                const store = await loadApprovalsStore();
                return await store.approvalsList({
                    status: listInput.status,
                    limit: listInput.limit,
                    serverId: scope.serverId ?? null,
                });
            },
        }),
        scm: Object.freeze({
            pullRequest: Object.freeze({
                list: createUnavailablePluginActionMethod('scm.pullRequest.list'),
                get: createUnavailablePluginActionMethod('scm.pullRequest.get'),
                openOrReuse: createUnavailablePluginActionMethod('scm.pullRequest.openOrReuse'),
                openCompose: createUnavailablePluginActionMethod('scm.pullRequest.openCompose'),
                checkout: createUnavailablePluginActionMethod('scm.pullRequest.checkout'),
                prepareWorktree: createUnavailablePluginActionMethod('scm.pullRequest.prepareWorktree'),
                runStacked: createUnavailablePluginActionMethod('scm.pullRequest.runStacked'),
            }),
            repository: Object.freeze({
                clone: createUnavailablePluginActionMethod('scm.repository.clone'),
                init: createUnavailablePluginActionMethod('scm.repository.init'),
                removeIndexLock: createUnavailablePluginActionMethod('scm.repository.removeIndexLock'),
            }),
            hostingRepository: Object.freeze({
                describePublishTargets: createUnavailablePluginActionMethod('scm.hostingRepository.describePublishTargets'),
                publish: createUnavailablePluginActionMethod('scm.hostingRepository.publish'),
            }),
            diffSummary: Object.freeze({
                generate: createUnavailablePluginActionMethod('scm.diffSummary.generate'),
            }),
        }),
    });
}

function createNoopPluginSubscription(): SubscriptionV1 {
    return Object.freeze({
        unsubscribe: () => undefined,
    });
}

function createUnavailablePluginSubagentsService(): PluginContextV1['sessions']['subagents'] {
    const rejectWrite = async (): Promise<never> => {
        throw new Error('ctx.sessions.subagents is unavailable until the owning subagent packet binds a host adapter');
    };
    return Object.freeze({
        list: async () => Object.freeze([]),
        get: async () => null,
        watch: () => createNoopPluginSubscription(),
        upsert: rejectWrite,
        updateStatus: rejectWrite,
        complete: rejectWrite,
    });
}

function createUnavailablePluginExternalSessionsService(): PluginContextV1['sessions']['external'] {
    const unavailable = 'ctx.sessions.external is unavailable until the owning external-session packet binds a host adapter';
    return Object.freeze({
        listCandidates: async () => Object.freeze({
            candidates: Object.freeze([]),
            nextCursor: null,
        }),
        attach: async () => Object.freeze({
            ok: false,
            error: unavailable,
        }),
        takeover: async () => Object.freeze({
            ok: false,
            errorCode: 'capability_unsupported',
            error: unavailable,
        }),
        pageTranscript: async () => Object.freeze({
            ok: false,
            errorCode: 'provider_unavailable',
            error: unavailable,
        }),
        readAfterTranscript: async () => Object.freeze({
            ok: false,
            errorCode: 'provider_unavailable',
            error: unavailable,
        }),
        followTranscript: () => createNoopPluginSubscription(),
    });
}

function createPluginReviewsService(params: Readonly<{
    pluginId: string;
    executeReviewCommentAction: ReviewCommentActionExecutor;
    resolveSnapshot: Parameters<typeof createPluginReviewCommentsService>[0]['resolveSnapshot'];
}>): PluginContextV1['reviews'] {
    return Object.freeze({
        comments: createPluginReviewCommentsService({
            execute: params.executeReviewCommentAction,
            principalActor: { kind: 'plugin', pluginId: params.pluginId },
            resolveSnapshot: params.resolveSnapshot,
        }),
    });
}

function createProductionReviewCommentActionExecutor(): ReviewCommentActionExecutor {
    return async (actionId, input, options) => {
        const credentials = await readCredentials().catch(() => null);
        if (!credentials) {
            throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        }
        const executor = createCliReviewCommentActionExecutorFromCredentials({ credentials });
        return await executor(actionId, input, options);
    };
}

function readPluginSettingsDescriptors(params: Readonly<{
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry | null;
    pluginId: string;
}>): readonly PluginSettingsFieldDescriptorV1[] {
    const settings = params.runtimeRegistry?.contributes.settings ?? [];
    return Object.freeze(settings
        .filter((contribution) => contribution.pluginId === params.pluginId)
        .flatMap((contribution) => contribution.definition.fields));
}

type BoundContextScope =
    | Readonly<{
        kind: 'hostSession';
        serverId: string;
        machineId: string;
        rootPath: string;
        getSession: () => ApiSessionClient;
        getTranscriptSession: () => TranscriptSessionPort;
        messageQueue?: HostSessionRuntimeFactoryParams['messageQueue'];
        getPermissionHandler: () => ProviderEnforcedPermissionHandler;
        getPermissionMode: () => unknown;
    }>
    | Readonly<{
        kind: 'executionRun';
        runId: string | null;
        permissionMode: string;
        rootPath: string | null;
        parentSessionStateTarget: ExecutionRunSessionStateTarget | null;
        permissionHandler: ReturnType<typeof createExecutionRunPermissionHandler>;
    }>;

type HostSessionContextScope = Extract<BoundContextScope, Readonly<{ kind: 'hostSession' }>>;
type ExecutionRunContextScope = Extract<BoundContextScope, Readonly<{ kind: 'executionRun' }>>;

function readRequestedPluginSessionId(params: PluginSessionGetParamsV1): string | null {
    if (typeof params === 'string' && params.trim().length > 0) {
        return params.trim();
    }
    if (isRecord(params) && typeof params.sessionId === 'string' && params.sessionId.trim().length > 0) {
        return params.sessionId.trim();
    }
    return null;
}

function createPluginSessionRef(scope: HostSessionContextScope): PluginSessionRefV1 {
    const session = scope.getSession();
    const metadata = session.getMetadataSnapshot();
    const agentState = session.getAgentStateSnapshot();
    const metadataRecord: Record<string, unknown> | null = isRecord(metadata) ? metadata : null;
    const titleValue = metadataRecord ? metadataRecord['title'] : null;
    const title = typeof titleValue === 'string' ? titleValue : null;

    return Object.freeze({
        sessionId: session.sessionId,
        ...(title ? { title } : {}),
        ...(metadataRecord ? { metadata: metadataRecord } : {}),
        ...(isRecord(agentState) ? { agentState } : {}),
    });
}

function createHostPluginContextV1(params?: ResolveEngineRegistryParams): PluginContextV1 {
    const configValues = Object.freeze({
        currentCliVersion: configuration.currentCliVersion,
        happyHomeDir: params?.happyHomeDir ?? null,
    });

    // Keep this stable and side-effect-free. Implementations may memoize feature queries.
    const featureEnabledMemo = new Map<string, boolean>();
    const features: PluginContextV1['features'] = Object.freeze({
        isEnabled: (featureIdRaw: string) => {
            const cached = featureEnabledMemo.get(featureIdRaw);
            if (cached !== undefined) {
                return cached;
            }
            if (!isFeatureId(featureIdRaw)) {
                featureEnabledMemo.set(featureIdRaw, false);
                return false;
            }
            const decision = resolveCliFeatureDecision({
                featureId: featureIdRaw,
                env: process.env,
            });
            const enabled = decision.state === 'enabled';
            featureEnabledMemo.set(featureIdRaw, enabled);
            return enabled;
        },
    });

    const abortRuntime = createPluginAbortService();

    let currentScope: BoundContextScope | null = null;
    const boundScopeStorage = new AsyncLocalStorage<BoundContextScope>();
    const transcriptFileFollowSessionStorage = new AsyncLocalStorage<string | null>();
    const readActiveScope = (): BoundContextScope | null => boundScopeStorage.getStore() ?? currentScope;
    let initialScopeBoundResolve: (() => void) | null = null;
    const initialScopeBound = new Promise<void>((resolve) => {
        initialScopeBoundResolve = resolve;
    });

    const backendId = params?.backendId?.trim() || 'unknown';
    const artifactsEnabled = parseEnvBoolean('HAPPIER_EXTENSION_ARTIFACTS_ENABLED', { defaultValue: false });
    const telemetryEnabled = parseEnvBoolean('HAPPIER_EXTENSION_TELEMETRY_ENABLED', { defaultValue: false });
    const artifactsDir = artifactsEnabled || telemetryEnabled ? resolveExtensionArtifactsDir({ backendId }) : null;
    const maxBytes = parseEnvBoundedInt('HAPPIER_EXTENSION_ARTIFACTS_MAX_BYTES', { min: 0, max: 10_000_000, fallback: 1_000_000 });
    let artifactsBytesWritten = 0;
    let artifactsTruncationWritten = false;
    let telemetryBytesWritten = 0;
    let telemetryTruncationWritten = false;
    const systemToolGrantStore = createPluginExecSystemToolGrantStore();

    function appendBoundedLineSync(params2: Readonly<{ filePath: string; line: string; kind: 'artifacts' | 'telemetry' }>): void {
        if (!params2.line) return;
        if (maxBytes === 0) return;

        const state = params2.kind === 'artifacts'
            ? { bytesWritten: artifactsBytesWritten, truncationWritten: artifactsTruncationWritten }
            : { bytesWritten: telemetryBytesWritten, truncationWritten: telemetryTruncationWritten };

        const buf = Buffer.from(params2.line);
        if (maxBytes > 0 && state.bytesWritten >= maxBytes) {
            if (!state.truncationWritten) {
                state.truncationWritten = true;
                appendFileSync(params2.filePath, '\n...[truncated]\n');
            }
            return;
        }

        const remaining = maxBytes > 0 ? Math.max(0, maxBytes - state.bytesWritten) : buf.length;
        const slice = maxBytes > 0 ? buf.subarray(0, remaining) : buf;
        appendFileSync(params2.filePath, slice);
        state.bytesWritten += slice.length;

        if (params2.kind === 'artifacts') {
            artifactsBytesWritten = state.bytesWritten;
            artifactsTruncationWritten = state.truncationWritten;
        } else {
            telemetryBytesWritten = state.bytesWritten;
            telemetryTruncationWritten = state.truncationWritten;
        }
    }

    function appendJsonLine(params2: Readonly<{ kind: 'artifacts' | 'telemetry'; value: unknown }>): void {
        if (!artifactsDir) return;
        const filePath = `${artifactsDir}/extension-${params2.kind}.jsonl`;
        const record = {
            at: Date.now(),
            backendId,
            kind: params2.kind,
            value: params2.value,
        };
        try {
            mkdirSync(dirname(filePath), { recursive: true });
            appendBoundedLineSync({ filePath, line: `${JSON.stringify(record)}\n`, kind: params2.kind });
        } catch (error) {
            logger.debug('[PluginContextV1] Failed to write plugin record (non-fatal)', error);
        }
    }

    const ensureScope = async (): Promise<BoundContextScope> => {
        const activeScope = readActiveScope();
        if (activeScope) {
            return activeScope;
        }
        if (!currentScope) {
            await initialScopeBound;
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return currentScope!;
    };
    const readCurrentScope = async (signal?: AbortSignal): Promise<BoundContextScope> => {
        const activeScope = readActiveScope();
        if (activeScope) {
            return activeScope;
        }
        return await withCallerAbortSignal(ensureScope(), signal);
    };
    const resolveProviderAccountUsageAliasContextFromPlugin: PluginContextV1['accountUsage']['resolveAliasContext'] = async (input, options) => {
        if (options?.signal?.aborted) {
            throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('Provider account usage alias-context resolution aborted');
        }
        const request = isRecord(input as unknown) ? input as unknown as Record<string, unknown> : {};
        const serviceId = readTrimmedString(request.serviceId);
        if (!serviceId) return null;
        const env = isRecord(request.env)
            ? Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string | undefined] => (
                typeof entry[1] === 'string' || entry[1] === undefined
            )))
            : null;
        const context = env
            ? resolveConnectedServiceRuntimeAuthContextFromEnv(env, serviceId as ConnectedServiceId)
            : (() => {
                const scope = readActiveScope();
                if (!scope || scope.kind !== 'hostSession') return null;
                return resolveConnectedServiceRuntimeAuthContextFromSessionMetadata(
                    scope.getSession(),
                    serviceId as ConnectedServiceId,
                );
            })();
        if (!context || (!context.profileId && !context.groupId)) return null;
        return context;
    };
    const recordProviderAccountUsageSnapshotFromPlugin: PluginContextV1['accountUsage']['recordSnapshot'] = async (input, options) => {
        if (options?.signal?.aborted) {
            throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('Provider account usage recording aborted');
        }
        const scope = await readCurrentScope(options?.signal);
        const targetSessionId = scope.kind === 'hostSession'
            ? readTrimmedString(scope.getSession().sessionId)
            : readTrimmedString(scope.parentSessionStateTarget?.sessionId);
        if (!targetSessionId) {
            return { status: 'unavailable', reason: 'session_scope_unavailable' };
        }
        const request = isRecord(input as unknown) ? input as unknown as Record<string, unknown> : {};
        const requestedSessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
        if (requestedSessionId && requestedSessionId !== targetSessionId) {
            return { status: 'rejected', reason: 'session_mismatch' };
        }
        const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(request.snapshot);
        if (!parsed.success) {
            return { status: 'rejected', reason: 'invalid_snapshot' };
        }
        try {
            const response = await notifyDaemonProviderAccountUsageSnapshot({
                sessionId: targetSessionId,
                snapshot: parsed.data,
            });
            if (response?.ok === true) {
                const result = response.result;
                if (result && typeof result === 'object') {
                    const recordId = typeof (result as { recordId?: unknown }).recordId === 'string'
                        ? (result as { recordId: string }).recordId
                        : parsed.data.recordId;
                    const persisted = typeof (result as { persisted?: unknown }).persisted === 'boolean'
                        ? (result as { persisted: boolean }).persisted
                        : undefined;
                    return {
                        status: 'recorded',
                        recordId,
                        ...(persisted === undefined ? {} : { persisted }),
                    };
                }
                return { status: 'recorded', recordId: parsed.data.recordId };
            }
            if (response?.error) {
                return { status: 'unavailable', reason: 'daemon_unavailable' };
            }
            return { status: 'rejected', reason: 'daemon_rejected' };
        } catch {
            return { status: 'unavailable', reason: 'daemon_unavailable' };
        }
    };
    const adoptProviderAccountUsageProvisionalRecordFromPlugin: PluginContextV1['accountUsage']['adoptProvisionalRecord'] = async (input, options) => {
        if (options?.signal?.aborted) {
            throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('Provider account usage adoption aborted');
        }
        const scope = await readCurrentScope(options?.signal);
        const targetSessionId = scope.kind === 'hostSession'
            ? readTrimmedString(scope.getSession().sessionId)
            : readTrimmedString(scope.parentSessionStateTarget?.sessionId);
        if (!targetSessionId) {
            return { status: 'unavailable', reason: 'session_scope_unavailable' };
        }
        const request = isRecord(input as unknown) ? input as unknown as Record<string, unknown> : {};
        const requestedSessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
        if (requestedSessionId && requestedSessionId !== targetSessionId) {
            return { status: 'rejected', reason: 'session_mismatch' };
        }
        const parsed = ProviderAccountUsageAdoptionV1Schema.safeParse(request.adoption);
        if (!parsed.success) {
            return { status: 'rejected', reason: 'invalid_adoption' };
        }
        try {
            const response = await notifyDaemonProviderAccountUsageAdoption({
                sessionId: targetSessionId,
                adoption: parsed.data,
            });
            if (response?.ok === true) {
                const result = response.result;
                if (result && typeof result === 'object') {
                    const fromRecordId = typeof (result as { fromRecordId?: unknown }).fromRecordId === 'string'
                        ? (result as { fromRecordId: string }).fromRecordId
                        : parsed.data.fromRecordId;
                    const toRecordId = typeof (result as { toRecordId?: unknown }).toRecordId === 'string'
                        ? (result as { toRecordId: string }).toRecordId
                        : parsed.data.toRecordId;
                    const status = (result as { status?: unknown }).status === 'already_adopted'
                        ? 'already_adopted'
                        : 'adopted';
                    const persisted = typeof (result as { persisted?: unknown }).persisted === 'boolean'
                        ? (result as { persisted: boolean }).persisted
                        : undefined;
                    return {
                        status,
                        fromRecordId,
                        toRecordId,
                        ...(persisted === undefined ? {} : { persisted }),
                    };
                }
                return {
                    status: 'adopted',
                    fromRecordId: parsed.data.fromRecordId,
                    toRecordId: parsed.data.toRecordId,
                };
            }
            if (response?.error) {
                return { status: 'unavailable', reason: 'daemon_unavailable' };
            }
            return { status: 'rejected', reason: 'daemon_rejected' };
        } catch {
            return { status: 'unavailable', reason: 'daemon_unavailable' };
        }
    };
    const accountUsage: PluginContextV1['accountUsage'] = Object.freeze({
        resolveAliasContext: resolveProviderAccountUsageAliasContextFromPlugin,
        recordSnapshot: recordProviderAccountUsageSnapshotFromPlugin,
        adoptProvisionalRecord: adoptProviderAccountUsageProvisionalRecordFromPlugin,
    });
    let grantExternalSessionTranscriptPathImpl: PluginContextV1Binder['grantExternalSessionTranscriptPath'] = async () => undefined;
    let revokeTranscriptFileFollowScopeImpl: PluginContextV1Binder['revokeTranscriptFileFollowScope'] = async () => undefined;

    const binder: PluginContextV1Binder = Object.freeze({
        bindHostSessionRuntime: (runtimeParams) => {
            const getSession = () => runtimeParams.session as unknown as ApiSessionClient;
            const getTranscriptSession = () => runtimeParams.transcriptSession as unknown as TranscriptSessionPort;
            const getPermissionHandler = () => runtimeParams.permissionHandler as unknown as ProviderEnforcedPermissionHandler;
            const getPermissionMode = () => runtimeParams.getPermissionMode?.() ?? 'default';
            const scope: HostSessionContextScope = Object.freeze({
                kind: 'hostSession',
                serverId: configuration.activeServerId,
                machineId: runtimeParams.machineId,
                rootPath: runtimeParams.directory,
                getSession,
                getTranscriptSession,
                messageQueue: runtimeParams.messageQueue,
                getPermissionHandler,
                getPermissionMode,
            });
            currentScope = scope;
            initialScopeBoundResolve?.();
            initialScopeBoundResolve = null;
        },
        resolveTerminalRuntimeHostOrchestration: (sessionId) => {
            const scope = readActiveScope();
            if (!scope || scope.kind !== 'hostSession') {
                return null;
            }
            const activeSession = scope.getSession();
            if (activeSession.sessionId !== sessionId) {
                return null;
            }
            const transcripts = createTerminalRuntimeTranscriptBindingHostService();
            return createTerminalRuntimeHostOrchestration({
                messageQueue: scope.messageQueue,
                session: activeSession,
                transcripts,
                projection: createTerminalRuntimeProjectionHostService({
                    session: activeSession,
                    transcripts,
                }),
                verifyExecutableGrant: systemToolGrantStore.verifyGrant,
                registerExecutableGrant: systemToolGrantStore.register,
            });
        },
        bindExecutionRun: (executionRunParams) => {
            const permissionMode = typeof executionRunParams.permissionMode === 'string'
                && executionRunParams.permissionMode.trim().length > 0
                ? executionRunParams.permissionMode.trim()
                : 'default';
            const runId = readTrimmedString(executionRunParams.runId);
            const rootPath = readTrimmedString(executionRunParams.rootPath);
            const permissionHandler = createExecutionRunPermissionHandler({
                backendId,
                permissionMode,
            });
            const scope: ExecutionRunContextScope = Object.freeze({
                kind: 'executionRun',
                runId,
                permissionMode,
                rootPath,
                parentSessionStateTarget: executionRunParams.parentSessionStateTarget ?? null,
                permissionHandler,
            });
            currentScope = scope;
            initialScopeBoundResolve?.();
            initialScopeBoundResolve = null;
            return scope;
        },
        grantExternalSessionTranscriptPath: (request) => grantExternalSessionTranscriptPathImpl(request),
        revokeTranscriptFileFollowScope: (scope) => revokeTranscriptFileFollowScopeImpl(scope),
        runWithTranscriptFileFollowSession: (sessionId, fn) => transcriptFileFollowSessionStorage.run(sessionId, fn),
        runWithScope: (scope, fn) => boundScopeStorage.run(scope, fn),
    });

    const getCurrentAccountSettings = (): AccountSettings | null => getActiveAccountSettingsSnapshot()?.settings ?? null;
    const subscribeCurrentAccountSettings = (listener: (settings: AccountSettings | null) => void): (() => void) => (
        subscribeActiveAccountSettingsSnapshot((snapshot) => listener(snapshot?.settings ?? null))
    );
    const getActiveProjectScope = (): WorkspaceRefScopeV1 | null => {
        const scope = readActiveScope();
        if (!scope || scope.kind !== 'hostSession') return null;
        return Object.freeze({
            serverId: scope.serverId,
            machineId: scope.machineId,
            rootPath: scope.rootPath,
        });
    };
    const updateCurrentAccountSettings = async (
        mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>,
    ): Promise<AccountSettings> => {
        const credentials = await readCredentials();
        if (!credentials) {
            throw new Error('ctx.account.settings.set requires authenticated account settings credentials');
        }
        const result = await updateAccountSettingsV2WithRetry({ credentials, mutate });
        const previous = getActiveAccountSettingsSnapshot();
        const settings = result.settings ?? previous?.settings ?? accountSettingsParse({});
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings,
            settingsVersion: result.version,
            loadedAtMs: Date.now(),
            settingsSecretsReadKeys: previous?.settingsSecretsReadKeys ?? [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        });
        return settings;
    };

    const backendEnginesByBackendId = params?.runtimeRegistry?.backendEnginesByBackendId;
    const contextPluginId = backendEnginesByBackendId && typeof backendEnginesByBackendId.get === 'function'
        ? backendEnginesByBackendId.get(backendId)?.pluginId ?? null
        : null;
    const pluginId = contextPluginId ?? backendId;
    const runtimeId = `plugin-runtime:${pluginId}:${randomUUID()}`;
    const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
    revokeTranscriptFileFollowScopeImpl = async (scope): Promise<void> => {
        await fileFollowPathGrants.revokeScope({
            pluginId,
            runtimeId,
            sessionId: scope.sessionId ?? null,
        });
    };
    grantExternalSessionTranscriptPathImpl = async (request): Promise<void> => {
        const sourceId = readTrimmedString(request.sourceId);
        if (!sourceId) {
            return;
        }
        await fileFollowPathGrants.grant({
            pluginId,
            runtimeId,
            sessionId: readTrimmedString(request.sessionId),
            path: request.path,
            reason: 'externalSessionTranscript',
            evidence: {
                kind: 'hostMaterializedTranscriptPath',
                sourceId,
            },
        });
    };
    const grantTranscriptFileFollowPath = async (
        request: SessionHookTranscriptFileFollowGrantRequest,
    ): Promise<void> => {
        const sessionId = readTrimmedString(request.sessionId);
        if (!sessionId) {
            return;
        }
        await fileFollowPathGrants.grant({
            pluginId,
            runtimeId,
            sessionId,
            path: request.transcriptPath,
            reason: 'providerTranscriptSource',
            evidence: {
                kind: 'sessionStartTranscriptPath',
                providerSessionId: request.providerSessionId,
            },
        });
    };
    const addRuntimeDisposable = (disposable: PluginDisposable): PluginDisposable => {
        if (!contextPluginId || !hasRuntimeDisposableRegistrar(params?.runtimeRegistry)) {
            return disposable;
        }
        return params.runtimeRegistry.addRuntimeDisposable(contextPluginId, disposable);
    };
    addRuntimeDisposable({
        dispose: () => {
            if (!abortRuntime.controller.signal.aborted) {
                abortRuntime.controller.abort(new Error('Plugin runtime disposed'));
            }
        },
    });
    addRuntimeDisposable({
        dispose: () => fileFollowPathGrants.revokeScope({ pluginId, runtimeId }),
    });
    const subagentsService = createUnavailablePluginSubagentsService();
    const externalSessionsService = createUnavailablePluginExternalSessionsService();

    const sendSession: PluginContextV1['sessions']['send'] = async (request) => {
        const scope = await ensureScope();
        if (scope.kind === 'executionRun') {
            logger.debug('[PluginContextV1] sessions.send (execution-run no-op)', { request });
            return { ok: true };
        }
        const session = scope.getSession();
        if (!isRecord(request) || typeof request.kind !== 'string') {
            logger.debug('[PluginContextV1] sessions.send invalid request (ignored)', { request });
            return { ok: false, error: 'invalid_request' };
        }
        if (request.kind === 'userText' && typeof request.text === 'string') {
            session.sendUserTextMessage(request.text, isRecord(request.opts) ? request.opts as any : undefined);
            return { ok: true };
        }
        if (request.kind === 'sessionEvent' && request.event) {
            session.sendSessionEvent(request.event as any, typeof request.id === 'string' ? request.id : undefined);
            return { ok: true };
        }
        if (request.kind === 'providerDispatch' && Object.prototype.hasOwnProperty.call(request, 'body')) {
            const sendProviderMessage = (session as unknown as {
                sendProviderMessage?: (request: { body: unknown; meta?: Record<string, unknown> }) => void;
            }).sendProviderMessage;
            if (typeof sendProviderMessage !== 'function') {
                logger.debug('[PluginContextV1] sessions.send provider dispatch unavailable (ignored)', { request });
                return { ok: false, error: 'unsupported_kind' };
            }
            sendProviderMessage.call(session, {
                body: request.body,
                ...(isRecord(request.meta) ? { meta: request.meta } : {}),
            });
            return { ok: true };
        }
        if (request.kind === 'agentMessageEphemeral' && typeof request.provider === 'string' && request.body && isRecord(request.opts)) {
            const localId = typeof request.opts.localId === 'string' ? request.opts.localId : '';
            const createdAt = typeof request.opts.createdAt === 'number' ? request.opts.createdAt : Date.now();
            session.sendAgentMessageEphemeral(request.provider as any, request.body as any, {
                localId,
                createdAt,
                updatedAt: typeof request.opts.updatedAt === 'number' ? request.opts.updatedAt : createdAt,
                ...(request.opts.meta ? { meta: request.opts.meta as any } : {}),
            });
            return { ok: true };
        }
        if (request.kind === 'agentMessageCommitted' && typeof request.provider === 'string' && request.body && isRecord(request.opts)) {
            const localId = typeof request.opts.localId === 'string' ? request.opts.localId : '';
            const opts = {
                localId,
                ...(request.opts.meta ? { meta: request.opts.meta as any } : {}),
            };
            if (typeof session.enqueueAgentMessageCommitted === 'function') {
                await session.enqueueAgentMessageCommitted(request.provider as any, request.body as any, opts);
            } else {
                await session.sendAgentMessageCommitted(request.provider as any, request.body as any, opts);
            }
            return { ok: true };
        }
        logger.debug('[PluginContextV1] sessions.send unknown kind (ignored)', { kind: request.kind });
        return { ok: false, error: 'unsupported_kind' };
    };

    const subscribeSession: PluginContextV1['sessions']['subscribe'] = (request, onEvent) => {
        let unsubscribed = false;
        let unsubscribeImpl: (() => void) | null = null;

        void ensureScope().then((scope) => {
            if (unsubscribed) return;
            if (scope.kind === 'executionRun') {
                return;
            }
            const sessionAny = scope.getSession() as any;
            const eventName =
                isRecord(request) && typeof request.eventName === 'string' ? request.eventName : 'metadata-updated';
            if (typeof sessionAny.on !== 'function' || typeof sessionAny.off !== 'function') {
                return;
            }
            const handler = (payload: unknown) => onEvent(Object.freeze({
                kind: eventName,
                payload,
            }));
            sessionAny.on(eventName, handler);
            unsubscribeImpl = () => {
                try {
                    sessionAny.off(eventName, handler);
                } catch {
                    // Best effort
                }
            };
        }).catch(() => {
            // Best effort
        });

        return Object.freeze({
            unsubscribe: () => {
                unsubscribed = true;
                unsubscribeImpl?.();
            },
        });
    };

    const writeSessionMetadata: PluginContextV1['sessions']['writeMetadata'] = async (request) => {
        const scope = await ensureScope();
        if (scope.kind === 'executionRun') {
            const result = await deliverExecutionRunSessionMetadata({
                target: scope.parentSessionStateTarget,
                request,
            });
            throwIfExecutionRunSessionStateUnsupported(result);
            return;
        }
        const session = scope.getSession();
        if (!isRecord(request) || typeof request.kind !== 'string') return;
        if (request.kind === 'set') {
            const requestedMetadata = isRecord(request.metadata) ? request.metadata : {};
            const durableRegisteredMutations: RegisteredSessionStateFieldMutationForPluginWrite[] = [];
            await session.updateMetadata((current) => {
                durableRegisteredMutations.length = 0;
                const split = splitPluginMetadataDurableRegisteredFields({
                    session,
                    current,
                    candidate: requestedMetadata,
                    source: 'runtime',
                });
                durableRegisteredMutations.push(...split.mutations);
                const next = split.metadata;
                return preserveSessionStateMetadataKeys(current, next) as any;
            });
            await publishPluginMetadataDurableRegisteredFieldMutations(session, durableRegisteredMutations);
        } else if (request.kind === 'update') {
            const handler = request.handler;
            if (typeof handler !== 'function') return;
            const durableRegisteredMutations: RegisteredSessionStateFieldMutationForPluginWrite[] = [];
            await session.updateMetadata((current) => {
                durableRegisteredMutations.length = 0;
                const requestedMetadata = handler(current);
                const split = splitPluginMetadataDurableRegisteredFields({
                    session,
                    current,
                    candidate: requestedMetadata,
                    source: 'runtime',
                });
                durableRegisteredMutations.push(...split.mutations);
                const candidate = split.metadata;
                return preserveSessionStateMetadataKeys(current, candidate) as any;
            });
            await publishPluginMetadataDurableRegisteredFieldMutations(session, durableRegisteredMutations);
        }
    };

    const writeSessionStateField: PluginContextV1['sessions']['writeStateField'] = async (request) => {
        const scope = await ensureScope();
        if (scope.kind === 'executionRun') {
            const result = await deliverExecutionRunSessionStateField({
                target: scope.parentSessionStateTarget,
                fieldId: request.fieldId,
                value: request.value,
            });
            throwIfExecutionRunSessionStateUnsupported(result);
            return;
        }
        const session = scope.getSession();
        const durableResult = await enqueueDurableRegisteredSessionStateFieldWrite({
            sessionId: session.sessionId,
            fieldId: request.fieldId,
            value: request.value,
            source: 'runtime',
            enqueue: session.enqueueRegisteredSessionStateFieldMutation,
        });
        if (durableResult) return;
        await publishSessionStateFieldToMetadata({
            sessionId: session.sessionId,
            fieldId: request.fieldId,
            value: request.value,
            updateSessionMetadataWithRetry: async (_sessionId: string, updater: (metadata: SessionMetadata) => SessionMetadata) => {
                await session.updateMetadata((current) => updater(isMetadataRecord(current) ? current : {}) as any);
            },
        });
    };

    const writeSessionAgentState: PluginContextV1['sessions']['writeAgentState'] = async (request) => {
        const scope = await ensureScope();
        if (scope.kind === 'executionRun') {
            logger.debug('[PluginContextV1] sessions.writeAgentState (execution-run no-op)', { request });
            return;
        }
        const session = scope.getSession();
        if (!isRecord(request) || typeof request.kind !== 'string') return;
        if (request.kind === 'set') {
            const next = isRecord(request.agentState) ? request.agentState : {};
            await session.updateAgentState(() => next as any);
        } else if (request.kind === 'update' && typeof request.handler === 'function') {
            await session.updateAgentState(request.handler as any);
        }
    };

    const sessionPermissions: PluginContextV1['session']['permissions'] = Object.freeze({
        requestDecision: async (
            request: Parameters<PluginContextV1['session']['permissions']['requestDecision']>[0],
            options?: Parameters<PluginContextV1['session']['permissions']['requestDecision']>[1],
        ) => {
            throwIfSignalAborted(options?.signal);
            const scope = await readCurrentScope(options?.signal);
            if (scope.kind === 'executionRun') {
                // Execution runs may run without an interactive prompt surface. If an extracted backend
                // asks the host for a decision, apply deterministic execution-run semantics.
                throwIfSignalAborted(options?.signal);
                const toolName = isRecord(request) && typeof request.toolName === 'string'
                    ? request.toolName
                    : null;
                if (!toolName) {
                    return normalizeSessionPermissionDecisionResult({ decision: 'denied' });
                }
                return normalizeSessionPermissionDecisionResult({
                    decision: resolveExecutionRunPermissionDecision({
                        permissionMode: scope.permissionMode,
                        backendId,
                        toolName,
                    }),
                });
            }
            const handler = scope.getPermissionHandler();
            if (isRecord(request) && typeof request.toolCallId === 'string' && typeof request.toolName === 'string') {
                const result = await withCallerAbortSignal(
                    handler.handleToolCall(request.toolCallId, request.toolName, request.input),
                    options?.signal,
                );
                return normalizeSessionPermissionDecisionResult(result);
            }
            throwIfSignalAborted(options?.signal);
            // Response-routing shape: a runtime forwarded a user/hook response by request id (e.g.
            // `respondToPermission(requestId, approved)`). Resolve the real pending coordinator
            // request instead of fabricating an `approved_for_session` for any/unknown id (gap 28/29).
            const responseRequestId = isRecord(request) && typeof request.requestId === 'string'
                ? request.requestId.trim()
                : '';
            const responseApproved = isRecord(request) && typeof request.approved === 'boolean'
                ? request.approved
                : undefined;
            if (responseRequestId && typeof responseApproved === 'boolean') {
                const routing = handler.respondToPendingPermission(
                    responseApproved
                        ? { id: responseRequestId, approved: true }
                        // Deny this specific request rather than aborting the whole turn.
                        : { id: responseRequestId, approved: false, decision: 'denied' },
                );
                if (routing.status === 'not_found') {
                    throw new PermissionRequestNotFoundError(responseRequestId);
                }
                return normalizeSessionPermissionDecisionResult({
                    decision: responseApproved ? 'approved' : 'denied',
                });
            }
            // No usable request identity (no tool-call decision, no response id): typed not-found
            // rather than a manufactured approval.
            throw new PermissionRequestNotFoundError(responseRequestId);
        },
        getMode: () => {
            const scope = readActiveScope();
            if (!scope) return 'default';
            if (scope.kind === 'executionRun') return scope.permissionMode;
            const mode = scope.getPermissionMode();
            return typeof mode === 'string' ? mode : 'default';
        },
    });

    const sessionsPermissions: PluginContextV1['sessions']['permissions'] = Object.freeze({
        forSession: async (sessionId: string) => {
            const requestedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
            if (!requestedSessionId) {
                return null;
            }
            const scope = await ensureScope();
            if (scope.kind !== 'hostSession') {
                return null;
            }
            return scope.getSession().sessionId === requestedSessionId
                ? sessionPermissions
                : null;
        },
    });

    const sessionMcpService = createSessionScopedMcpServices({
        readScope: async (signal) => {
            const scope = await readCurrentScope(signal);
            if (scope.kind !== 'hostSession') {
                return null;
            }
            return Object.freeze({
                permissionHandler: scope.getPermissionHandler(),
            });
        },
    });
    const sessionAuthService = createSessionScopedAuthServices({
        readSessionId: async (signal) => {
            const scope = await readCurrentScope(signal);
            return scope.kind === 'hostSession'
                ? scope.getSession().sessionId
                : null;
        },
    });

    const createScopedSessionServices = (scope: HostSessionContextScope): SessionScopedServicesV1 => Object.freeze({
        sessionId: scope.getSession().sessionId,
        send: sendSession,
        subscribe: subscribeSession,
        writeMetadata: writeSessionMetadata,
        writeAgentState: writeSessionAgentState,
        writeStateField: writeSessionStateField,
        mcp: sessionMcpService,
        auth: sessionAuthService,
        permissions: sessionPermissions,
        subagents: subagentsService,
        external: externalSessionsService,
    });

    const sessions: PluginContextV1['sessions'] = Object.freeze({
        list: async () => {
            const scope = await ensureScope();
            if (scope.kind === 'executionRun') {
                return Object.freeze([]);
            }
            return Object.freeze([createPluginSessionRef(scope)]);
        },
        get: async (request: PluginSessionGetParamsV1) => {
            const requestedSessionId = readRequestedPluginSessionId(request);
            if (!requestedSessionId) {
                return null;
            }
            const scope = await ensureScope();
            if (scope.kind === 'executionRun') {
                return null;
            }
            return scope.getSession().sessionId === requestedSessionId
                ? createScopedSessionServices(scope)
                : null;
        },
        watch: (
            _request: PluginSessionWatchParamsV1,
            onEvent: (event: PluginSessionWatchEventV1) => void,
        ) => {
            let unsubscribed = false;
            void ensureScope().then((scope) => {
                if (unsubscribed) {
                    return;
                }
                const sessionRefs = scope.kind === 'hostSession'
                    ? Object.freeze([createPluginSessionRef(scope)])
                    : Object.freeze([]);
                onEvent(Object.freeze({
                    kind: 'snapshot',
                    sessions: sessionRefs,
                }));
            }).catch((error) => {
                logger.debug('[PluginContextV1] sessions.watch initial snapshot failed (ignored)', { error });
            });
            return Object.freeze({
                unsubscribe: () => {
                    unsubscribed = true;
                },
            });
        },
        send: sendSession,
        subscribe: subscribeSession,
        writeMetadata: writeSessionMetadata,
        writeAgentState: writeSessionAgentState,
        writeStateField: writeSessionStateField,
        mcp: sessionMcpService,
        auth: sessionAuthService,
        permissions: sessionsPermissions,
        subagents: subagentsService,
        external: externalSessionsService,
    });
    const fetchService = createPluginFetchService({
        networkAllowed: contextPluginId
            ? params?.runtimeRegistry?.networkAllowedPluginIds?.has(contextPluginId) === true
            : false,
        pluginId: contextPluginId ?? backendId,
        adapter: params?.fetchAdapter ?? null,
        interceptors: params?.runtimeRegistry?.requestInterceptors ?? [],
        interception: {
            scope: 'plugin-fetch',
        },
        allowedUrlOrigins: contextPluginId
            ? Object.freeze([...(params?.runtimeRegistry?.networkAllowedUrlOriginsByPluginId?.get(contextPluginId) ?? [])])
            : Object.freeze([]),
    });
    const pluginStorePaths = resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir });
    const storage = createPluginStorageService({
        pluginId,
        paths: pluginStorePaths,
        sessionId: () => {
            const scope = readActiveScope();
            return scope?.kind === 'hostSession' ? scope.getSession().sessionId : null;
        },
        synced: createAccountSettingsBackedPluginStorageScope({
            pluginId,
            getSettings: getCurrentAccountSettings,
            updateSettings: updateCurrentAccountSettings,
        }),
    });
    const settings = createPluginSettingsService({
        pluginId,
        storage: storage.local,
        descriptors: readPluginSettingsDescriptors({
            runtimeRegistry: params?.runtimeRegistry,
            pluginId,
        }),
    });
    const secrets = createPluginSecretsService({
        pluginId,
        paths: pluginStorePaths,
    });
    const eventSubscriptionPermissions = contextPluginId
        ? params?.runtimeRegistry?.eventSubscriptionPermissionsByPluginId?.get(contextPluginId)
        : undefined;
    const eventDeclarations = contextPluginId
        ? params?.runtimeRegistry?.eventDeclarationsByPluginId?.get(contextPluginId)
        : undefined;
    const declaredEventIds = eventDeclarations?.map((declaration) => declaration.id);
    const availableEventPluginIds = params?.runtimeRegistry?.eventDeclarationsByPluginId
        ? new Set(params.runtimeRegistry.eventDeclarationsByPluginId.keys())
        : undefined;
    const eventPermissionDeclarations = contextPluginId
        ? params?.runtimeRegistry?.permissionDeclarationsByPluginId?.get(contextPluginId)
        : undefined;
    const requiredPluginPermissions = contextPluginId
        ? params?.runtimeRegistry?.requiredPermissionsByPluginId?.get(contextPluginId)
        : undefined;
    const trustedOptionalPluginPermissions = contextPluginId
        ? params?.runtimeRegistry?.trustedOptionalPermissionsByPluginId?.get(contextPluginId)
        : undefined;
    const fallbackPluginPermissions = requiredPluginPermissions || trustedOptionalPluginPermissions
        ? new Set([
            ...(requiredPluginPermissions ?? []),
            ...(trustedOptionalPluginPermissions ?? []),
        ])
        : undefined;
    const declaredPluginPermissions = contextPluginId
        ? params?.runtimeRegistry?.permissionsByPluginId?.get(contextPluginId) ?? fallbackPluginPermissions ?? eventSubscriptionPermissions
        : undefined;
    const declaredRuntimeCapabilities = contextPluginId
        ? params?.runtimeRegistry?.runtimeCapabilitiesByPluginId?.get(contextPluginId)
        : undefined;
    const capabilityInventory = Object.freeze(
        Array.from(new Set([
            ...(declaredPluginPermissions ?? []),
            ...(declaredRuntimeCapabilities ?? []),
        ])).sort(),
    );
    const capabilities: PluginContextV1['capabilities'] = Object.freeze({
        has: (capability: string) => capabilityInventory.includes(capability),
        list: () => capabilityInventory,
    });
    const terminalHostService = createDefaultPluginTerminalHostService({
        happyHomeDir: pluginStorePaths.happyHomeDir,
        hasCapability: capabilities.has,
    });
    const events = createPluginEventsService({
        pluginId,
        declaredEventIds,
        eventDeclarations,
        availablePluginIds: availableEventPluginIds,
        canSubscribe: (eventName) => canPluginSubscribeToEvent({
            pluginId,
            eventName,
            permissions: eventSubscriptionPermissions,
            permissionDeclarations: eventPermissionDeclarations,
        }),
        addDisposable: addRuntimeDisposable,
    });
    const auth = createPluginAuthService({
        getIdentity: async () => {
            const credentials = await readCredentials();
            return credentials
                ? Object.freeze({ accountId: null })
                : null;
        },
        materialize: params?.authMaterializeAdapter,
    });

    const appendTranscriptTurn = async (turn: unknown): Promise<void> => {
        const scope = await ensureScope();
        if (scope.kind === 'executionRun') {
            logger.debug('[PluginContextV1] transcripts.append (execution-run no-op)', { turn });
            return;
        }
        if (!isRecord(turn) || typeof turn.kind !== 'string') return;
        const session = scope.getSession();
        const transcript = scope.getTranscriptSession();
        if (turn.kind === 'userText' && typeof turn.text === 'string') {
            session.sendUserTextMessage(turn.text, isRecord(turn.opts) ? turn.opts as any : undefined);
            return;
        }
        if (turn.kind === 'agentMessageCommitted' && typeof turn.provider === 'string' && turn.body && typeof turn.localId === 'string') {
            const opts = {
                localId: turn.localId,
                ...(isRecord(turn.meta) ? { meta: turn.meta as any } : {}),
            };
            if (typeof transcript.enqueueAgentMessageCommitted === 'function') {
                await transcript.enqueueAgentMessageCommitted(turn.provider as any, turn.body as any, opts);
            } else {
                await transcript.sendAgentMessageCommitted(turn.provider as any, turn.body as any, opts);
            }
            return;
        }
        if (turn.kind === 'agentMessageEphemeral' && typeof turn.provider === 'string' && turn.body && typeof turn.localId === 'string') {
            const createdAt = typeof turn.createdAt === 'number' ? turn.createdAt : Date.now();
            const updatedAt = typeof turn.updatedAt === 'number' ? turn.updatedAt : createdAt;
            await transcript.sendAgentMessageEphemeral?.(turn.provider as any, turn.body as any, {
                localId: turn.localId,
                createdAt,
                updatedAt,
                ...(isRecord(turn.meta) ? { meta: turn.meta as any } : {}),
            } as any);
        }
    };
    const execService = createPluginExecService({
        allowedExecutablePaths: contextPluginId
            ? Object.freeze([...(params?.runtimeRegistry?.processSpawnAllowedPathsByPluginId?.get(contextPluginId) ?? [])])
            : Object.freeze([]),
        systemTools: contextPluginId
            ? Object.freeze([...(params?.runtimeRegistry?.systemToolDefinitionsByPluginId?.get(contextPluginId) ?? [])])
            : Object.freeze([]),
        baseEnv: Object.freeze({}),
        signal: abortRuntime.service.signal,
        addDisposable: addRuntimeDisposable,
        systemToolGrantStore,
        rpcLogAllowedDirectories: contextPluginId
            ? Object.freeze([join(configuration.logsDir, 'plugins', contextPluginId)])
            : Object.freeze([]),
    });
    let pluginContext: PluginContextV1 | null = null;
    const acpRuntimeService = createPluginAcpRuntimeService({
        exec: execService,
        signal: abortRuntime.service.signal,
        addDisposable: addRuntimeDisposable,
        readPluginContext: () => {
            if (!pluginContext) {
                throw new Error('Plugin ACP runtime context is not initialized');
            }
            return pluginContext;
        },
    });
    const managedServerService = createPluginManagedServerService({
        exec: execService,
        signal: abortRuntime.service.signal,
        addDisposable: addRuntimeDisposable,
    });
    const agentsService = createPluginAgentsService();
    const errorsService = createPluginErrorsService({
        report: (classification, fields) => logger.warn('[PluginContextV1] runtime error reported', {
            classification,
            fields,
        }),
    });
    // RN-MCP-001: per-runtime hosted server registry (no module global).
    const pluginHostedMcpRegistry = createPluginHostedMcpServerRegistry();
    const mcpService = createPluginMcpService({
        pluginId,
        exec: execService,
        managedServer: managedServerService,
        errors: errorsService,
        signal: abortRuntime.service.signal,
        addDisposable: addRuntimeDisposable,
        startHostedServer: (spec) => createPluginHostedMcpServerHandle({
            pluginId,
            spec,
            registry: pluginHostedMcpRegistry,
            startRuntimeEndpoint: startPluginHostedMcpLoopbackServer,
        }),
        // RN-MCP-003: scope listSpecs to the calling plugin's own registrations.
        // Cross-plugin enumeration is not part of ctx.mcp.list contract; host-level
        // discovery uses dedicated registry queries.
        listSpecs: () => Object.freeze(
            (params?.runtimeRegistry?.mcpServers ?? [])
                .filter((entry) => entry.pluginId === pluginId)
                .map((entry) => entry.registration),
        ),
        resolveForSession: async (input) => {
            const scope = await readCurrentScope();
            if (scope.kind !== 'hostSession') return Object.freeze([]);
            const session = scope.getSession();
            const requestedSessionId = readTrimmedString(input.sessionId);
            if (!requestedSessionId || requestedSessionId !== session.sessionId) {
                return Object.freeze([]);
            }
            const sessionMetadata = typeof session.getMetadataSnapshot === 'function'
                ? session.getMetadataSnapshot()
                : null;
            return resolvePluginMcpServersForSession({
                input,
                accountSettings: getCurrentAccountSettings(),
                machineId: scope.machineId,
                directory: scope.rootPath,
                sessionMetadata,
                pluginServers: Object.freeze(
                    (params?.runtimeRegistry?.mcpServers ?? [])
                        .filter((entry) => entry.pluginId === pluginId)
                        .map((entry) => entry.registration),
                ),
            });
        },
    });

    const nextPluginContext = Object.freeze({
        logger: Object.freeze({
            debug: (message: string, fields?: Readonly<Record<string, unknown>>) => logger.debug(message, fields),
            info: (message: string, fields?: Readonly<Record<string, unknown>>) => logger.info(message, fields),
            warn: (message: string, fields?: Readonly<Record<string, unknown>>) => logger.warn(message, fields),
            error: (message: string, fields?: Readonly<Record<string, unknown>>) => logger.warn(`[ERROR] ${message}`, fields),
        }),
        config: Object.freeze({
            values: configValues,
        }),
        features,
        capabilities,
        exec: execService,
        agents: agentsService,
        managedServer: managedServerService,
        localServices: createPluginLocalServicesService(),
        mcp: mcpService,
        terminalHost: terminalHostService,
        sessionHooks: createSessionHooksService({
            happyHomeDir: pluginStorePaths.happyHomeDir,
            addDisposable: addRuntimeDisposable,
            grantTranscriptFileFollowPath,
            hasCapability: capabilities.has,
        }),
        errors: errorsService,
        retry: createPluginRetryService(),
        env: createPluginEnvService({
            env: process.env,
            allowedNames: contextPluginId
                ? Object.freeze([...(params?.runtimeRegistry?.envAllowedNamesByPluginId?.get(contextPluginId) ?? [])])
                : Object.freeze([]),
        }),
        fs: createPluginFsService({
            rootDir: join(pluginStorePaths.storageDir, pluginId, 'fs'),
            readAllowedPaths: contextPluginId
                ? Object.freeze([...(params?.runtimeRegistry?.filesystemReadAllowedPathsByPluginId?.get(contextPluginId) ?? [])])
                : Object.freeze([]),
            writeAllowedPaths: contextPluginId
                ? Object.freeze([...(params?.runtimeRegistry?.filesystemWriteAllowedPathsByPluginId?.get(contextPluginId) ?? [])])
                : Object.freeze([]),
            readScopedRootDir: () => readActiveScope()?.rootPath ?? null,
        }),
        actions: createPluginContextActionsService({
            pluginId,
            readScope: () => {
                const scope = readActiveScope();
                if (!scope || scope.kind !== 'hostSession') {
                    return {};
                }
                return {
                    serverId: scope.serverId,
                    sessionId: scope.getSession().sessionId,
                };
            },
        }),
        acp: Object.freeze({
            defineAcpBackend,
            createRuntime: acpRuntimeService.createRuntime,
        }),
        connection: createConnectionRuntimeService({
            source: params?.connectionStateSource ?? null,
        }),
        fetch: fetchService,
        storage,
        settings,
        secrets,
        events,
        auth,
        projects: createProjectsService({
            getSettings: getCurrentAccountSettings,
            getActiveScope: getActiveProjectScope,
            subscribeSettings: subscribeCurrentAccountSettings,
        }),
        account: Object.freeze({
            settings: createAccountSettingsService({
                getSettings: getCurrentAccountSettings,
                updateSettings: updateCurrentAccountSettings,
                subscribeSettings: subscribeCurrentAccountSettings,
            }),
        }),
        accountUsage,
        reviews: createPluginReviewsService({
            pluginId,
            executeReviewCommentAction: params?.reviewCommentActionExecutor
                ?? createProductionReviewCommentActionExecutor(),
            resolveSnapshot: async (request, options) => {
                throwIfSignalAborted(options?.signal);
                const scope = readActiveScope();
                const cwd = scope?.kind === 'hostSession'
                    ? scope.rootPath
                    : scope?.rootPath ?? null;
                return cwd
                    ? await resolveReviewCommentSnapshot({ cwd, anchor: request.anchor })
                    : null;
            },
        }),
        session: Object.freeze({
            send: sendSession,
            subscribe: subscribeSession,
            writeMetadata: writeSessionMetadata,
            writeAgentState: writeSessionAgentState,
            writeStateField: writeSessionStateField,
            mcp: sessionMcpService,
            auth: sessionAuthService,
            permissions: sessionPermissions,
            subagents: subagentsService,
            external: externalSessionsService,
        }),
        sessions,
        transcripts: createPluginTranscriptsService({
            append: appendTranscriptTurn,
            addDisposable: addRuntimeDisposable,
            pluginId,
            runtimeId,
            readSessionId: () => {
                const fileFollowSessionId = transcriptFileFollowSessionStorage.getStore();
                if (fileFollowSessionId) {
                    return fileFollowSessionId;
                }
                const scope = readActiveScope();
                return scope?.kind === 'hostSession' ? scope.getSession().sessionId : null;
            },
            fileFollowPathGrants,
        }),
        telemetry: Object.freeze({
            emit: (observation: unknown) => {
                if (!telemetryEnabled) {
                    logger.debug('[PluginContextV1] telemetry.emit (disabled)', { observation });
                    return;
                }
                appendJsonLine({ kind: 'telemetry', value: observation });
            },
        }),
        artifacts: Object.freeze({
            write: async (record: unknown) => {
                if (!artifactsEnabled) {
                    logger.debug('[PluginContextV1] artifacts.write (disabled)', { record });
                    return;
                }
                appendJsonLine({ kind: 'artifacts', value: record });
            },
        }),
        notifications: createNotificationsService({
            registry: params?.runtimeRegistry
                ? createNotificationRegistryFromPluginRuntime(params.runtimeRegistry)
                : createBuiltInNotificationRegistry(),
            pluginId: contextPluginId,
            getSettings: () => getActiveAccountSettingsSnapshot()?.settings ?? null,
            getSettingsSecretsReadKeys: () => getActiveAccountSettingsSnapshot()?.settingsSecretsReadKeys ?? [],
        }),
        abort: Object.freeze({
            ...abortRuntime.service,
        }),
        timeout: createPluginTimeoutService(),
        progress: createPluginProgressService(),
        [PLUGIN_CONTEXT_V1_BINDER]: binder,
    });
    pluginContext = nextPluginContext;
    return nextPluginContext;
}

export type {
    BackendRuntimeOwnerCandidate,
    BackendRuntimeOwnerKind,
    BackendRuntimeOwnerResolution,
    BackendRuntimeOwnerTakeoverMarker,
    BackendExecutionSurfaces,
    EngineAdapterResolution,
    EngineResolutionDiagnostic,
    EngineResolutionDiagnosticCode,
    EngineResolutionSelectedSource,
    ResolvedCliEngineRegistry,
} from './engineRegistryTypes';

type ResolveEngineRegistryParams = Readonly<{
    happyHomeDir?: string;
    backendId?: string;
    contributes?: ResolvedContributionRegistry;
    connectionStateSource?: PluginDaemonConnectionStateSource | null;
    fetchAdapter?: FetchRuntimeServiceV1 | null;
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry | null;
    authMaterializeAdapter?: (request: PluginAuthMaterializeRequestV1) => Promise<PluginAuthMaterializedServiceV1 | null>;
    reviewCommentActionExecutor?: ReviewCommentActionExecutor | null;
}>;

type BackendSurfaceKind = NonNullable<ResolvedBackendContribution['surfaceHandlers']>[number]['kind'];
type CatalogSurfaceOmissions = Readonly<Partial<Record<BackendSurfaceKind, true>>>;

function toEngineSelectedSource(
    backendProvenance: EngineAdapterResolution['provenance'],
    providerRuntimePreference?: 'system-first' | 'managed-first' | null,
): EngineResolutionSelectedSource | undefined {
    if (backendProvenance === 'external') {
        return 'plugin';
    }
    if (providerRuntimePreference === 'managed-first') {
        return 'managed';
    }
    if (providerRuntimePreference === 'system-first') {
        return 'system';
    }
    return undefined;
}

function resolveCatalogSurfaceOmissions(backend: ResolvedBackendContribution): CatalogSurfaceOmissions {
    const omissions: Partial<Record<BackendSurfaceKind, true>> = {};
    for (const surfaceHandler of backend.surfaceHandlers ?? []) {
        if (surfaceHandler.support === 'unsupported') {
            continue;
        }
        omissions[surfaceHandler.kind] = true;
    }
    return omissions;
}

async function resolveCatalogExecutionSurfacesForEntry(
    entry: ResolvedCatalogEntry,
    omissions: CatalogSurfaceOmissions = {},
): Promise<BackendExecutionSurfaces> {
    const hostEntry = readBuiltInHostCatalogEntry(entry.id);
    const getExternalSessionProviderOps = entry.getExternalSessionProviderOps ?? hostEntry?.getExternalSessionProviderOps;
    const getTerminalRuntimeOps = entry.getTerminalRuntimeOps ?? hostEntry?.getTerminalRuntimeOps;
    const getProviderAttachOps = entry.getProviderAttachOps ?? hostEntry?.getProviderAttachOps;
    const getHandoffSurface = entry.getHandoffSurface ?? hostEntry?.getHandoffSurface;
    const getForkSurface = entry.getForkSurface ?? hostEntry?.getForkSurface;

    const externalSession = !omissions.externalSession
        && ExternalSessionsProviderIdSchema.safeParse(entry.id).success
        && getExternalSessionProviderOps
        ? await getExternalSessionProviderOps()
        : null;

    return {
        terminalRuntime: !omissions.terminalRuntime && getTerminalRuntimeOps ? await getTerminalRuntimeOps() : null,
        externalSession,
        attach: !omissions.attach && getProviderAttachOps ? await getProviderAttachOps() : null,
        handoff: !omissions.handoff && getHandoffSurface ? await getHandoffSurface() : null,
        fork: !omissions.fork && getForkSurface ? await getForkSurface() : null,
        // CHKPT-5 owns product checkpoint/restore orchestration. Catalog-only
        // backend entries must not claim checkpoint readiness from surface shape
        // existence; provider checkpoint leaves are consumed through declared
        // plugin/engine surfaces and operation-specific availability.
        checkpoint: null,
    };
}

async function resolveCatalogExecutionSurfacesForFirstPartyBackend(params: Readonly<{
    backend: ResolvedBackendContribution;
    entry?: ResolvedCatalogEntry | null;
}>): Promise<BackendExecutionSurfaces> {
    const entry = params.entry ?? readBuiltInHostCatalogEntry(params.backend.id);
    return entry
        ? await resolveCatalogExecutionSurfacesForEntry(entry, resolveCatalogSurfaceOmissions(params.backend))
        : createEmptyBackendExecutionSurfaces();
}

function resolveRuntimeCoreGetter(entry: Readonly<{
    getRuntimeCore?: CliRuntimeCoreGetter | undefined;
}>): CliRuntimeCoreGetter | null {
    return typeof entry.getRuntimeCore === 'function' ? entry.getRuntimeCore : null;
}

function resolveContributionRuntimeCoreGetter(params: Readonly<{
    backend: ResolvedBackendContribution;
    catalogEntry?: ResolvedCatalogEntry | null;
}>): CliRuntimeCoreGetter | null {
    if (params.backend.provenance !== 'first_party') {
        return resolveRuntimeCoreGetter(params.backend);
    }
    return resolveRuntimeCoreGetter(params.catalogEntry ?? {})
        ?? resolveRuntimeCoreGetter(readBuiltInHostCatalogEntry(params.backend.id) ?? {})
        ?? resolveRuntimeCoreGetter(params.backend);
}

function createEmptyBackendRuntimeOwnerResolution(backendId: string): BackendRuntimeOwnerResolution {
    return Object.freeze({
        backendId,
        selected: null,
        candidates: Object.freeze([]),
    });
}

function createLegacyHostRuntimeOwnerCandidate(backend: ResolvedBackendContribution): BackendRuntimeOwnerCandidate {
    return Object.freeze({
        kind: 'legacy_host',
        ownerId: backend.id,
        provenance: backend.provenance,
    });
}

function createPluginRuntimeOwnerCandidate(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider?: ResolvedProviderContribution | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
}>): BackendRuntimeOwnerCandidate {
    const pluginId = resolvePluginRuntimeOwnerPluginId(params);
    return Object.freeze({
        kind: 'plugin_engine',
        ownerId: pluginId ?? params.backend.id,
        provenance: params.backend.provenance,
        ...(pluginId ? { pluginId } : {}),
    });
}

function resolvePluginRuntimeOwnerPluginId(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider?: ResolvedProviderContribution | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
}>): string | undefined {
    return params.engineEntry?.pluginId
        ?? params.backend.pluginId
        ?? params.provider?.pluginId;
}

function readBackendRuntimeOwnerTakeoverMarker(
    backend: ResolvedBackendContribution,
): BackendRuntimeOwnerTakeoverMarker | undefined {
    const marker = backend.runtimeOwner;
    if (
        marker?.selectedOwner === 'plugin_engine'
        && typeof marker.acceptedBy === 'string'
        && marker.acceptedBy.trim().length > 0
    ) {
        return Object.freeze({
            selectedOwner: 'plugin_engine',
            acceptedBy: marker.acceptedBy,
        });
    }
    return undefined;
}

function createRuntimeOwnerConflictDiagnostic(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider?: ResolvedProviderContribution | null;
    pluginOwner: BackendRuntimeOwnerCandidate;
}>): EngineResolutionDiagnostic {
    const pluginLabel = params.pluginOwner.pluginId ?? params.pluginOwner.ownerId;
    return Object.freeze({
        code: 'engine_runtime_owner_conflict',
        message: `Backend '${params.backend.id}' has both legacy host getRuntimeCore and plugin backend engine owner '${pluginLabel}' without an accepted runtime owner takeover marker`,
        backendId: params.backend.id,
        providerId: params.provider?.id ?? params.backend.providerId,
        pluginId: params.pluginOwner.pluginId,
    });
}

function createRuntimeOwnerTakeoverMissingDiagnostic(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider?: ResolvedProviderContribution | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
}>): EngineResolutionDiagnostic {
    const pluginId = resolvePluginRuntimeOwnerPluginId({
        backend: params.backend,
        provider: params.provider ?? null,
        engineEntry: params.engineEntry,
    });
    return Object.freeze({
        code: 'engine_runtime_owner_takeover_missing',
        message: `Backend '${params.backend.id}' is marked for plugin engine takeover but no registered plugin backend engine owner is available`,
        backendId: params.backend.id,
        providerId: params.provider?.id ?? params.backend.providerId,
        pluginId,
    });
}

function resolveBackendRuntimeOwner(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider?: ResolvedProviderContribution | null;
    runtimeCoreGetter: CliRuntimeCoreGetter | null;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
    manifestOnlyPluginRuntime: boolean;
}>): BackendRuntimeOwnerResolution {
    const candidates: BackendRuntimeOwnerCandidate[] = [];
    const legacyHostOwner = params.backend.provenance === 'first_party' && params.runtimeCoreGetter
        ? createLegacyHostRuntimeOwnerCandidate(params.backend)
        : null;
    const pluginOwnerExists = Boolean(params.engineEntry?.registration)
        || params.manifestOnlyPluginRuntime
        || (params.backend.provenance === 'external' && Boolean(params.runtimeCoreGetter));
    const pluginOwner = pluginOwnerExists
        ? createPluginRuntimeOwnerCandidate({
            backend: params.backend,
            provider: params.provider ?? null,
            engineEntry: params.engineEntry,
        })
        : null;

    if (legacyHostOwner) {
        candidates.push(legacyHostOwner);
    }
    if (pluginOwner) {
        candidates.push(pluginOwner);
    }

    const takeover = readBackendRuntimeOwnerTakeoverMarker(params.backend);
    if (takeover?.selectedOwner === 'plugin_engine' && !pluginOwner) {
        const conflictDiagnostic = createRuntimeOwnerTakeoverMissingDiagnostic({
            backend: params.backend,
            provider: params.provider ?? null,
            engineEntry: params.engineEntry,
        });
        return Object.freeze({
            backendId: params.backend.id,
            selected: null,
            candidates: Object.freeze(candidates),
            takeover,
            conflictDiagnostic,
        });
    }

    if (legacyHostOwner && pluginOwner) {
        if (takeover?.selectedOwner === 'plugin_engine') {
            return Object.freeze({
                backendId: params.backend.id,
                selected: pluginOwner,
                candidates: Object.freeze(candidates),
                takeover,
            });
        }

        const conflictDiagnostic = createRuntimeOwnerConflictDiagnostic({
            backend: params.backend,
            provider: params.provider ?? null,
            pluginOwner,
        });
        return Object.freeze({
            backendId: params.backend.id,
            selected: null,
            candidates: Object.freeze(candidates),
            conflictDiagnostic,
        });
    }

    return Object.freeze({
        backendId: params.backend.id,
        selected: legacyHostOwner ?? pluginOwner,
        candidates: Object.freeze(candidates),
    });
}

function readExecutionRunScopeRootPath(opts: unknown): string | null {
    if (!isRecord(opts)) return null;
    return readTrimmedString(opts.cwd) ?? readTrimmedString(opts.directory);
}

function bindExecutionRunHostRuntimeToScope(
    runtime: CliExecutionRunRuntime,
    scope: ExecutionRunContextScope,
    runWithScope: PluginContextV1Binder['runWithScope'],
): CliExecutionRunRuntime {
    const sendSteerPrompt = runtime.sendSteerPrompt;
    const respondToPermission = runtime.respondToPermission;
    const waitForTurnCompletion = runtime.waitForTurnCompletion;
    const probeTurnLiveness = runtime.probeTurnLiveness;

    return Object.freeze({
        ...runtime,
        readResumeSupport: (opts) => runWithScope(scope, () => runtime.readResumeSupport(opts)),
        provisionSession: (opts) => runWithScope(scope, () => runtime.provisionSession(opts)),
        sendPrompt: (sessionId, prompt) => runWithScope(scope, () => runtime.sendPrompt(sessionId, prompt)),
        ...(sendSteerPrompt
            ? { sendSteerPrompt: (sessionId: string, prompt: string) => runWithScope(scope, () => sendSteerPrompt(sessionId, prompt)) }
            : {}),
        cancel: (sessionId) => runWithScope(scope, () => runtime.cancel(sessionId)),
        subscribeMessages: (handler) => runWithScope(scope, () => runtime.subscribeMessages(handler)),
        ...(respondToPermission
            ? { respondToPermission: (requestId: string, approved: boolean) => runWithScope(scope, () => respondToPermission(requestId, approved)) }
            : {}),
        ...(waitForTurnCompletion
            ? { waitForTurnCompletion: (timeoutMs?: number | null) => runWithScope(scope, () => waitForTurnCompletion(timeoutMs)) }
            : {}),
        ...(probeTurnLiveness
            ? { probeTurnLiveness: (sessionId: string) => runWithScope(scope, () => probeTurnLiveness(sessionId)) }
            : {}),
        dispose: () => runWithScope(scope, () => runtime.dispose()),
    });
}

function bindHostSessionRuntimeResultToTranscriptGrantScope(params: Readonly<{
    createdRuntime: unknown;
    binder: PluginContextV1Binder;
    sessionId: string | null;
}>): unknown {
    if (!params.sessionId || !isRecord(params.createdRuntime)) {
        return params.createdRuntime;
    }
    const operations = isRecord(params.createdRuntime.operations)
        ? params.createdRuntime.operations
        : null;
    const resetOrDisposeRuntime = operations?.resetOrDisposeRuntime;
    if (typeof resetOrDisposeRuntime !== 'function') {
        return params.createdRuntime;
    }
    const wrappedOperations = Object.freeze({
        ...operations,
        resetOrDisposeRuntime: async (...args: readonly unknown[]) => {
            try {
                return await resetOrDisposeRuntime.apply(operations, args);
            } finally {
                await params.binder.revokeTranscriptFileFollowScope({ sessionId: params.sessionId });
            }
        },
    });
    return Object.freeze({
        ...params.createdRuntime,
        operations: wrappedOperations,
    });
}

function bindPluginContextToRuntimeCore(
    rawRuntimeCore: CliRuntimeCore,
    binder: PluginContextV1Binder | null,
): CliRuntimeCore {
    return Object.freeze({
        async createSessionRuntime(sessionParams: unknown) {
            const plan = await rawRuntimeCore.createSessionRuntime(sessionParams);
            if (!binder) return plan as any;
            if (!plan || typeof plan !== 'object') return plan as any;
            const planRecord = plan as any;
            const config = planRecord.config;
            const createSessionRuntime = config?.createSessionRuntime;
            if (typeof createSessionRuntime !== 'function') return plan as any;
            const wrappedConfig = Object.freeze({
                ...config,
                createSessionRuntime: async (runtimeParams: HostSessionRuntimeFactoryParams) => {
                    binder.bindHostSessionRuntime(runtimeParams);
                    const createdRuntime = await createSessionRuntime(runtimeParams);
                    return bindHostSessionRuntimeResultToTranscriptGrantScope({
                        createdRuntime,
                        binder,
                        sessionId: readTrimmedString(runtimeParams.session.sessionId),
                    });
                },
            });
            return Object.freeze({
                ...planRecord,
                config: wrappedConfig,
            });
        },
        createExecutionRunBackend(opts: CreateCliExecutionRunBackendParams & Readonly<{
            parentSessionStateTarget?: unknown;
        }>) {
            const parentSessionStateTarget = readExecutionRunSessionStateTarget(opts);
            const executionRunScope = binder?.bindExecutionRun({
                runId: readTrimmedString(opts?.runId),
                permissionMode: opts?.permissionMode,
                rootPath: readExecutionRunScopeRootPath(opts),
                parentSessionStateTarget,
            }) ?? null;
            const { parentSessionStateTarget: _parentSessionStateTarget, ...runtimeOpts } = opts;
            void _parentSessionStateTarget;
            const runtime = rawRuntimeCore.createExecutionRunBackend(runtimeOpts);
            if (!executionRunScope || !binder) return runtime;
            return bindExecutionRunHostRuntimeToScope(runtime, executionRunScope, binder.runWithScope);
        },
    });
}

function createEngineSurfaceContextResolvers(
    pluginContext: PluginContextV1,
): Pick<
    Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0],
    | 'resolveTerminalRuntimeLaunchServices'
    | 'resolveTerminalRuntimeLaunchSignal'
    | 'resolveTerminalRuntimeHostOrchestration'
    | 'resolveExternalSessionRuntimeContext'
    | 'grantExternalSessionTranscriptPath'
    | 'runExternalSessionFollowWithLinkedSession'
    | 'resolveAcpSessionOperations'
> {
    const acp = createAcpSessionOperations();
    const externalSessionHostServices = (async () => {
        const adapters = await resolveExternalSessionRuntimeHostAdapters({
            activeServerDir: configuration.activeServerDir,
            env: process.env,
        });
        return Object.freeze({
            transcripts: createExternalSessionTranscriptStoreService({
                adapters: adapters.transcriptStores ?? [],
            }),
            candidates: createExternalSessionCandidateHostService({
                adapters: adapters.candidateHosts ?? [],
            }),
        });
    })();
    const binder = readPluginContextV1Binder(pluginContext);
    const issueRuntimeDiagnostic = (diagnostic: BackendSurfaceDiagnosticV1): void => {
        const error = new Error(diagnostic.safeMessage ?? diagnostic.code);
        pluginContext.errors.report(error, {
            code: diagnostic.code,
            ...(diagnostic.severity ? { severity: diagnostic.severity } : {}),
            ...(typeof diagnostic.retryable === 'boolean' ? { retryable: diagnostic.retryable } : {}),
            ...(diagnostic.details ? { details: diagnostic.details } : {}),
        });
    };
    return {
        resolveTerminalRuntimeLaunchServices: async (request) => {
            const sessionId = readTrimmedString(request.sessionId);
            if (!sessionId) {
                return null;
            }
            return await pluginContext.sessions.get({ sessionId });
        },
        resolveTerminalRuntimeLaunchSignal: () => pluginContext.abort.signal,
        resolveTerminalRuntimeHostOrchestration: (request) => {
            const sessionId = readTrimmedString(request.sessionId);
            if (!sessionId) {
                return null;
            }
            return binder?.resolveTerminalRuntimeHostOrchestration(sessionId) ?? null;
        },
        resolveExternalSessionRuntimeContext: async (request): Promise<ExternalSessionRuntimeContextV1> => {
            const linkedSessionId = readTrimmedString(request.linkedSessionId);
            const directory = readTrimmedString(request.directory);
            const external = await externalSessionHostServices;
            return Object.freeze({
                signal: pluginContext.abort.signal,
                ...(linkedSessionId || directory
                    ? {
                        session: Object.freeze({
                            ...(linkedSessionId ? { sessionId: linkedSessionId } : {}),
                            ...(directory ? { directory } : {}),
                        }),
                    }
                    : {}),
                directories: Object.freeze({
                    activeServerDir: configuration.activeServerDir,
                    logsDir: configuration.logsDir,
                }),
                transcripts: Object.freeze({
                    fileFollow: pluginContext.transcripts.fileFollow,
                }),
                external: Object.freeze({
                    transcripts: external.transcripts,
                    candidates: external.candidates,
                }),
                diagnostics: Object.freeze({
                    issue: issueRuntimeDiagnostic,
                }),
            });
        },
        grantExternalSessionTranscriptPath: async (request) => {
            const sourceId = readTrimmedString(request.sourceId) ?? readTrimmedString(request.providerSessionId);
            if (!sourceId) {
                return;
            }
            await binder?.grantExternalSessionTranscriptPath({
                path: request.path,
                sourceId,
                sessionId: request.sessionId ?? null,
            });
        },
        runExternalSessionFollowWithLinkedSession: async (sessionId, operation) => (
            binder
                ? await binder.runWithTranscriptFileFollowSession(sessionId, operation)
                : await operation()
        ),
        resolveAcpSessionOperations: () => acp,
    };
}

function shouldNormalizeManifestOnlyAcpBackend(backend: ResolvedBackendContribution): boolean {
    if (backend.runtimeKind === 'acp') {
        return true;
    }
    const richDefinition = backend.richDefinition;
    if (richDefinition?.provenance !== 'external' || !isRecord(richDefinition.definition)) {
        return false;
    }
    if (richDefinition.definition.runtimeKind === 'acp' || Object.prototype.hasOwnProperty.call(richDefinition.definition, 'acp')) {
        return true;
    }
    const engine = richDefinition.definition.engine;
    return isRecord(engine) && engine.kind === 'acp';
}

function resolveManifestOnlyAcpBackendAdapter(params: Readonly<{
    backend: ResolvedBackendContribution;
    pluginContext: PluginContextV1;
}>): CliEngineAdapter | null {
    const richDefinition = params.backend.richDefinition;
    if (richDefinition?.provenance !== 'external') {
        return null;
    }
    if (!shouldNormalizeManifestOnlyAcpBackend(params.backend)) {
        return null;
    }

    try {
        const acpDefinition = normalizePluginBackendContributionAcpDefinition({
            pluginId: params.backend.pluginId,
            backend: richDefinition.definition,
        });
        const adapter = createAcpRuntimeCoreFromDefinition(acpDefinition, {
            pluginContext: params.pluginContext,
        });
        const binder = readPluginContextV1Binder(params.pluginContext);
        return {
            ...adapter,
            runtimeCore: bindPluginContextToRuntimeCore(adapter.runtimeCore, binder),
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid manifest-only ACP backend '${params.backend.id}' from plugin '${params.backend.pluginId ?? 'unknown'}': ${reason}`);
    }
}

async function resolveBackendRuntimeCore(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
    executionSurfaces: BackendExecutionSurfaces;
    runtimeCoreGetter: CliRuntimeCoreGetter | null;
    runtimeOwner: BackendRuntimeOwnerResolution;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    pluginContext: PluginContextV1;
    pluginEngine?: BackendEngineV1 | null;
}>): Promise<CliEngineAdapter | null> {
    const selectedOwnerKind = params.runtimeOwner.selected?.kind ?? null;
    if (!selectedOwnerKind) {
        return null;
    }

    if (selectedOwnerKind === 'plugin_engine') {
        const runtimeRegistry = params.runtimeRegistry;
        const engineEntry = params.engineEntry;
        const registration = engineEntry?.registration as RegisterBackendEngineV1 | undefined;
        if (runtimeRegistry && registration) {
            const engine = params.pluginEngine ?? await registration.create(params.pluginContext);
            const acpSpec = readAcpBackendSpec(engine);
            if (acpSpec) {
                const acpDefinition = normalizePluginAcpDefinition({
                    pluginId: engineEntry?.pluginId,
                    spec: acpSpec,
                });
                const adapter = createAcpRuntimeCoreFromDefinition(acpDefinition, {
                    pluginContext: params.pluginContext,
                });
                const binder = readPluginContextV1Binder(params.pluginContext);
                return {
                    ...adapter,
                    runtimeCore: bindPluginContextToRuntimeCore(adapter.runtimeCore, binder),
                };
            }
            if (!engine.runtimeCore) {
                return null;
            }
            const binder = readPluginContextV1Binder(params.pluginContext);
            const rawRuntimeCore = engine.runtimeCore as unknown as CliRuntimeCore;
            const wrappedRuntimeCore = bindPluginContextToRuntimeCore(rawRuntimeCore, binder);
            return {
                runtimeCore: wrappedRuntimeCore,
                facets: engine.facets ?? undefined,
                messageMeta: engine.messageMeta ?? undefined,
            };
        }

        const manifestOnlyAdapter = resolveManifestOnlyAcpBackendAdapter({
            backend: params.backend,
            pluginContext: params.pluginContext,
        });
        if (manifestOnlyAdapter) {
            return manifestOnlyAdapter;
        }

        if (params.backend.provenance === 'external' && params.runtimeCoreGetter) {
            const runtimeCoreFactory = await params.runtimeCoreGetter();
            return await runtimeCoreFactory({
                backend: params.backend,
                provider: params.provider,
                executionSurfaces: params.executionSurfaces,
            });
        }
        return null;
    }

    const getRuntimeCore = params.runtimeCoreGetter;
    if (!getRuntimeCore) {
        return null;
    }
    const runtimeCoreFactory = await getRuntimeCore();
    return await runtimeCoreFactory({
        backend: params.backend,
        provider: params.provider,
        executionSurfaces: params.executionSurfaces,
    });
}

function createMissingProviderContribution(params: Readonly<{
    backend: ResolvedBackendContribution;
}>): ResolvedProviderContribution {
    return {
        id: params.backend.providerId,
        provenance: params.backend.provenance,
        source: params.backend.source,
        definition: {
            kindVersion: 1,
            id: params.backend.providerId,
            ownedBackendIds: Object.freeze([]),
        },
    };
}

async function resolveEngineAdapterResolutionFromRegistry(params: Readonly<{
    backendId: string;
    contributions: ResolvedContributionRegistry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    pluginContext: PluginContextV1;
}>): Promise<EngineAdapterResolution | null> {
    const backend = params.contributions.backendDefinitionsById.get(params.backendId);
    if (!backend) {
        return null;
    }

    const provider = params.contributions.providerDefinitionsById.get(backend.providerId);
    if (!provider) {
        const missingProvider = createMissingProviderContribution({ backend });
        const catalogEntry = backend.provenance === 'first_party'
            ? params.contributions.catalogEntriesById[backend.id] ?? null
            : null;
        const runtimeCoreGetter = resolveContributionRuntimeCoreGetter({
            backend,
            catalogEntry,
        });
        const engineEntry = params.runtimeRegistry
            ? readRuntimeRegistryBackendEngineEntry(params.runtimeRegistry, backend.id)
            : undefined;
        const runtimeOwner = resolveBackendRuntimeOwner({
            backend,
            provider: null,
            runtimeCoreGetter,
            engineEntry,
            manifestOnlyPluginRuntime: shouldNormalizeManifestOnlyAcpBackend(backend),
        });
        const executionSurfaces = createEmptyBackendExecutionSurfaces();
        const engineAdapter = await resolveBackendRuntimeCore({
            backend,
            provider: missingProvider,
            executionSurfaces,
            runtimeCoreGetter,
            runtimeOwner,
            engineEntry,
            runtimeRegistry: params.runtimeRegistry,
            pluginContext: params.pluginContext,
        });
        return {
            backendId: backend.id,
            providerId: backend.providerId,
            provenance: backend.provenance,
            selectedSource: toEngineSelectedSource(backend.provenance, undefined),
            runtimeOwner,
            backend,
            provider: missingProvider,
            engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
            executionSurfaces,
            diagnostics: Object.freeze([{
                code: 'engine_provider_missing',
                message: `Missing provider contribution '${backend.providerId}' for backend '${backend.id}'`,
                backendId: backend.id,
                providerId: backend.providerId,
                pluginId: backend.pluginId,
            }]),
        };
    }

    if (backend.provenance === 'first_party') {
        const entry = params.contributions.catalogEntriesById[backend.id];
        const runtimeCoreGetter = resolveContributionRuntimeCoreGetter({
            backend,
            catalogEntry: entry ?? null,
        });
        const runtimeRegistry = params.runtimeRegistry;
        const engineEntry = runtimeRegistry
            ? readRuntimeRegistryBackendEngineEntry(runtimeRegistry, backend.id)
            : undefined;
        const runtimeOwner = resolveBackendRuntimeOwner({
            backend,
            provider,
            runtimeCoreGetter,
            engineEntry,
            manifestOnlyPluginRuntime: false,
        });
        const catalogExecutionSurfaces = await resolveCatalogExecutionSurfacesForFirstPartyBackend({
            backend,
            entry,
        });
        const canResolvePluginEngineSurfaces = Boolean(
            runtimeOwner.conflictDiagnostic
            && engineEntry?.registration
            && (backend.surfaceHandlers?.length ?? 0) > 0,
        );
        const registration = runtimeOwner.selected?.kind === 'plugin_engine' || canResolvePluginEngineSurfaces
            ? engineEntry?.registration as RegisterBackendEngineV1 | undefined
            : undefined;
        const pluginEngine = registration ? await registration.create(params.pluginContext) : null;
        const diagnostics: EngineResolutionDiagnostic[] = runtimeOwner.conflictDiagnostic
            ? [runtimeOwner.conflictDiagnostic]
            : [];
        const engineSurfaces = pluginEngine
            ? resolveBackendExecutionSurfacesFromEngine({
                backend,
                engine: pluginEngine,
                diagnostics,
                ...createEngineSurfaceContextResolvers(params.pluginContext),
            })
            : createEmptyBackendExecutionSurfaces();
        const executionSurfaces = mergeBackendExecutionSurfaces(catalogExecutionSurfaces, engineSurfaces);
        const engineAdapter = runtimeOwner.conflictDiagnostic
            ? null
            : await resolveBackendRuntimeCore({
                backend,
                provider,
                executionSurfaces,
                runtimeCoreGetter,
                runtimeOwner,
                engineEntry,
                runtimeRegistry: params.runtimeRegistry,
                pluginContext: params.pluginContext,
                pluginEngine,
            });
        return {
            backendId: backend.id,
            providerId: provider.id,
            provenance: backend.provenance,
            selectedSource: runtimeOwner.selected?.kind === 'plugin_engine'
                ? 'plugin'
                : toEngineSelectedSource(
                    backend.provenance,
                    provider.runtimeSpec?.sourcePreferenceDefault,
                ),
            runtimeOwner,
            backend,
            provider,
            engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
            executionSurfaces,
            diagnostics: Object.freeze(diagnostics),
        };
    }

    const runtimeRegistry = params.runtimeRegistry;
    if (!runtimeRegistry) {
        return {
            backendId: backend.id,
            providerId: provider.id,
            provenance: backend.provenance,
            selectedSource: 'plugin',
            runtimeOwner: createEmptyBackendRuntimeOwnerResolution(backend.id),
            backend,
            provider,
            engineAdapter: createMissingCliEngineAdapter({ backend }),
            executionSurfaces: createEmptyBackendExecutionSurfaces(),
            diagnostics: Object.freeze([{
                code: 'engine_backend_missing',
                message: `No executable runtime registry available for plugin backend '${backend.id}'`,
                backendId: backend.id,
                providerId: provider.id,
                pluginId: backend.pluginId,
            }]),
        };
    }

    const engineEntry = readRuntimeRegistryBackendEngineEntry(runtimeRegistry, backend.id);
    const runtimeCoreGetter = resolveContributionRuntimeCoreGetter({
        backend,
        catalogEntry: null,
    });
    const runtimeOwner = resolveBackendRuntimeOwner({
        backend,
        provider,
        runtimeCoreGetter,
        engineEntry,
        manifestOnlyPluginRuntime: shouldNormalizeManifestOnlyAcpBackend(backend),
    });
    const registration = runtimeOwner.selected?.kind === 'plugin_engine'
        ? engineEntry?.registration as RegisterBackendEngineV1 | undefined
        : undefined;
    const pluginEngine = registration ? await registration.create(params.pluginContext) : null;
    const engineImplementedBackendSurfaceOperations = pluginEngine
        ? collectEngineImplementedBackendSurfaceOperations(pluginEngine)
        : undefined;
    const engineSurfaceContextResolvers = createEngineSurfaceContextResolvers(params.pluginContext);
    const pluginResolution = await resolvePluginBackendSurfaceHandlers({
        backend,
        provider,
        runtimeRegistry,
        engineImplementedBackendSurfaceOperations,
        ...engineSurfaceContextResolvers,
    });
    const diagnostics = [...pluginResolution.diagnostics];
    const engineSurfaces = pluginEngine
        ? resolveBackendExecutionSurfacesFromEngine({
            backend,
            engine: pluginEngine,
            diagnostics,
            ...engineSurfaceContextResolvers,
        })
        : createEmptyBackendExecutionSurfaces();
    const executionSurfaces = mergeBackendExecutionSurfaces(pluginResolution.surfaces, engineSurfaces);
    const engineAdapter = await resolveBackendRuntimeCore({
        backend,
        provider,
        executionSurfaces,
        runtimeCoreGetter,
        runtimeOwner,
        engineEntry,
        runtimeRegistry,
        pluginContext: params.pluginContext,
        pluginEngine,
    });
    return {
        backendId: backend.id,
        providerId: provider.id,
        provenance: backend.provenance,
        selectedSource: 'plugin',
        runtimeOwner,
        backend,
        provider,
        engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
        executionSurfaces,
        diagnostics: Object.freeze(diagnostics),
    };
}

export async function resolveCliEngineRegistry(
    params?: ResolveEngineRegistryParams,
): Promise<ResolvedCliEngineRegistry> {
    const activeRuntimeRegistry = pluginReloadController.getState().activeRegistry;
    const contributions = activeRuntimeRegistry?.contributes
        ?? params?.contributes
        ?? await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
        });
    const runtimeRegistryPromises = new Map<string, Promise<ResolvedExecutablePluginRuntimeRegistry>>();
    const resolutionPromises = new Map<string, Promise<EngineAdapterResolution | null>>();

    async function resolveRuntimeRegistry(pluginId?: string | null): Promise<ResolvedExecutablePluginRuntimeRegistry> {
        if (activeRuntimeRegistry) {
            return activeRuntimeRegistry;
        }
        const cacheKey = pluginId ? `plugin:${pluginId}` : 'all';
        let runtimeRegistryPromise = runtimeRegistryPromises.get(cacheKey);
        if (!runtimeRegistryPromise) {
            runtimeRegistryPromise = resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: params?.happyHomeDir,
                contributes: contributions,
                ...(pluginId ? { pluginIds: [pluginId] } : {}),
            });
            runtimeRegistryPromises.set(cacheKey, runtimeRegistryPromise);
        }
        return await runtimeRegistryPromise;
    }

    return Object.freeze({
        contributions,
        async resolveForBackendId(backendId: string): Promise<EngineAdapterResolution | null> {
            const existing = resolutionPromises.get(backendId);
            if (existing) {
                return await existing;
            }
            const resolutionPromise = (async (): Promise<EngineAdapterResolution | null> => {
                let resolutionContributions = contributions;
                let backend = resolutionContributions.backendDefinitionsById.get(backendId) ?? null;
                let runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;

                const catalogEntry = backend ? resolutionContributions.catalogEntriesById[backend.id] : undefined;
                const hasExplicitRuntimeCore = backend
                    ? Boolean(resolveContributionRuntimeCoreGetter({ backend, catalogEntry }))
                    : false;
                const requiresExecutablePluginRuntimeRegistry = Boolean(
                    backend
                    && (
                        backend.provenance === 'external'
                        || backend.pluginId
                        || backend.daemonEntryPath
                        || (backend.provenance === 'first_party' && !hasExplicitRuntimeCore)
                    ),
                );

                if (requiresExecutablePluginRuntimeRegistry && backend) {
                    runtimeRegistry = await resolveRuntimeRegistry(backend.pluginId ?? null);
                    resolutionContributions = runtimeRegistry.contributes;
                    backend = resolutionContributions.backendDefinitionsById.get(backendId) ?? backend;
                }

                const pluginContext = createHostPluginContextV1({ ...(params ?? {}), backendId, runtimeRegistry });

                if (!backend) {
                    return null;
                }

                return await resolveEngineAdapterResolutionFromRegistry({
                    backendId,
                    contributions: resolutionContributions,
                    runtimeRegistry,
                    pluginContext,
                });
            })();
            resolutionPromises.set(backendId, resolutionPromise);
            return await resolutionPromise;
        },
        async resolveExecutionSurfaces(backendId?: string | null): Promise<BackendExecutionSurfaces> {
            if (!backendId) {
                return createEmptyBackendExecutionSurfaces();
            }
            const resolution = await this.resolveForBackendId(backendId);
            return resolution?.executionSurfaces ?? createEmptyBackendExecutionSurfaces();
        },
    });
}

export async function resolveBackendEngineAdapterResolution(
    backendId?: string | null,
    params?: ResolveEngineRegistryParams,
): Promise<EngineAdapterResolution | null> {
    if (!backendId) {
        return null;
    }
    const registry = await resolveCliEngineRegistry(params);
    return await registry.resolveForBackendId(backendId);
}

export async function resolveBackendExecutionSurfaces(
    backendId?: string | null,
    params?: ResolveEngineRegistryParams,
): Promise<BackendExecutionSurfaces> {
    const resolution = await resolveBackendEngineAdapterResolution(backendId, params);
    return resolution?.executionSurfaces ?? createEmptyBackendExecutionSurfaces();
}
