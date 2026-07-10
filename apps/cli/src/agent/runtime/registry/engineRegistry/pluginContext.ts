import {
    accountSettingsParse,
    ConnectedServiceUsageSourceV1Schema,
    isFeatureId,
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageRecordKeyV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    type AccountSettings,
    type ConnectedServiceId,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageSnapshotV1,
    type SessionMetadata,
} from '@happier-dev/protocol';
import {
    defineAcpBackend,
    type LocalServiceRuntimeSnapshotV1,
    type PluginContextV1,
    type PluginDisposable,
    type PluginSessionGetParamsV1,
    type PluginSessionRefV1,
    type PluginSessionWatchEventV1,
    type PluginSessionWatchParamsV1,
    type SessionScopedServicesV1,
    type TranscriptAppendTurnV1,
} from '@happier-dev/plugin-sdk';
import { publishSessionStateFieldToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import {
    decryptSessionPayload,
    encryptSessionPayload,
    type SessionEncryptionContext,
    type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { SessionSystemRecordContent } from '@happier-dev/protocol';
import {
    notifyDaemonProviderAccountUsageAdoption,
    notifyDaemonProviderAccountUsageSnapshot,
} from '@/daemon/controlClient';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { PermissionRequestNotFoundError } from '@/agent/permissions/permissionRequestNotFoundError';
import {
    createExecutionRunPermissionHandler,
    resolveExecutionRunPermissionDecision,
} from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
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
import {
    createPluginLocalServicesService,
    type PluginLocalServicesDaemonBridge,
} from '@/plugins/runtime/context/localServices';
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
import {
    enqueueDurableRegisteredSessionStateFieldWrite,
    throwIfDurableRegisteredSessionStateFieldDeliveryUnavailable,
} from '@/agent/runtime/state/registeredFieldDurability';
import { createTerminalRuntimeHostOrchestration } from '@/agent/runtime/session/terminal/orchestration';
import { createTerminalRuntimeProjectionHostService } from '@/agent/runtime/session/terminal/projection';
import { createTerminalRuntimeTranscriptBindingHostService } from '@/agent/runtime/session/terminal/transcriptBinding';
import { createPluginFetchService } from '@/plugins/runtime/fetch/service';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import { resolveReviewCommentSnapshot } from '@/agent/reviews/comments/snapshots';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import type { LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import {
    deliverExecutionRunSessionMetadata,
    deliverExecutionRunSessionStateField,
    throwIfExecutionRunSessionStateUnsupported,
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
import { createPluginExecInstallablesRegistry } from './contributions';
import { resolveFirstPartyCatalogEntryForBackend } from './resolution';
import type { ResolveEngineRegistryParams } from './types';
import { createConnectionRuntimeService } from './pluginContext/connection';
import {
    isMetadataRecord,
    preserveSessionStateMetadataKeys,
    publishPluginMetadataDurableRegisteredFieldMutations,
    splitPluginMetadataDurableRegisteredFields,
    type RegisteredSessionStateFieldMutationForPluginWrite,
} from './pluginContext/metadata';
import { normalizeSessionPermissionDecisionResult } from './pluginContext/permissions';
import {
    BoundContextScope,
    ExecutionRunContextScope,
    HostSessionContextScope,
    PLUGIN_CONTEXT_V1_BINDER,
    PluginContextV1Binder,
    hasRuntimeDisposableRegistrar,
} from './pluginContext/binder';
import {
    isRecord,
    parseEnvBoolean,
    parseEnvBoundedInt,
    readTrimmedString,
    throwIfSignalAborted,
    withCallerAbortSignal,
} from './pluginContext/values';
import {
    createPluginContextActionsService,
    createPluginReviewsService,
    createProductionReviewCommentActionExecutor,
    createUnavailablePluginExternalSessionsService,
    createUnavailablePluginSubagentsService,
    readPluginSettingsDescriptors,
} from './pluginContext/actions';

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

function readRequestedPluginSessionId(params: PluginSessionGetParamsV1): string | null {
    if (typeof params === 'string' && params.trim().length > 0) {
        return params.trim();
    }
    if (isRecord(params) && typeof params.sessionId === 'string' && params.sessionId.trim().length > 0) {
        return params.sessionId.trim();
    }
    return null;
}

function readPluginUserTextSendOptions(
    opts: unknown,
): Readonly<{ localId: string; meta?: Record<string, unknown> }> | null {
    if (!isRecord(opts)) {
        return null;
    }
    const localId = readTrimmedString(opts.localId);
    if (!localId) {
        return null;
    }
    return Object.freeze({
        localId,
        ...(isRecord(opts.meta) ? { meta: opts.meta } : {}),
    });
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

type PluginLocalServicesRuntimeBridgeFactory = Pick<LocalServicesDaemonRuntime, 'createPluginLocalServicesBridge'>;

const PLUGIN_LOCAL_SERVICE_SESSION_CONTEXT_UNAVAILABLE_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_SESSION_CONTEXT_UNAVAILABLE',
    severity: 'warning' as const,
    message: 'Plugin local-service launch requires a bound host session context.',
});
const MAX_PENDING_PROVIDER_ACCOUNT_USAGE_SNAPSHOTS = 64;

type ProviderAccountUsageRecordSnapshotResult = Awaited<ReturnType<PluginContextV1['agentRuntime']['accountUsage']['recordSnapshot']>>;
type ProviderAccountUsageRecordedSnapshotResult = Extract<
    ProviderAccountUsageRecordSnapshotResult,
    Readonly<{ status: 'recorded' }>
>;
type PendingProviderAccountUsageSnapshot = Readonly<{
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: ConnectedServiceUsageSourceV1 | null;
}>;
type ProviderAccountUsageSnapshotDeliveryResult =
    | Readonly<{ status: 'recorded'; result: ProviderAccountUsageRecordedSnapshotResult }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'rejected' }>;

const ProviderAccountUsageAdoptionProofV1Schema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('opaque_local_credential_ref_match'),
        localCredentialRef: z.string().trim().min(1),
    }).strict(),
    z.object({
        kind: z.literal('session_subject_match'),
        sessionId: z.string().trim().min(1).nullable().optional(),
    }).strict(),
    z.object({
        kind: z.literal('id_token_account_id'),
        issuer: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
        kind: z.literal('provider_account_id_match'),
    }).strict(),
    z.object({
        kind: z.literal('provider_owned_subject_proof'),
        detail: z.string().trim().min(1).optional(),
    }).strict(),
]);

const ProviderAccountUsageAdoptionV1Schema = z.object({
    providerId: z.string().trim().min(1),
    fromRecordId: ProviderAccountUsageRecordIdSchema,
    toRecordId: ProviderAccountUsageRecordIdSchema,
    stableRecordKey: ProviderAccountUsageRecordKeyV1Schema,
    proof: ProviderAccountUsageAdoptionProofV1Schema,
    observedAtMs: z.number().int().nonnegative(),
}).strict().superRefine((adoption, ctx) => {
    if (adoption.providerId !== adoption.stableRecordKey.providerId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Adoption providerId must match stable record key providerId',
            path: ['providerId'],
        });
    }
});

function failedPluginLocalServiceSessionContextSnapshot(id: string): LocalServiceRuntimeSnapshotV1 {
    return Object.freeze({
        id,
        phase: 'failed' as const,
        diagnostics: Object.freeze([PLUGIN_LOCAL_SERVICE_SESSION_CONTEXT_UNAVAILABLE_DIAGNOSTIC]),
    });
}

function resolveHostSessionTitle(scope: HostSessionContextScope, fallback: string): string {
    return getSessionNotificationTitle(() => scope.getSession().getMetadataSnapshot()) ?? fallback;
}

function createScopedPluginLocalServicesDaemonBridge(params: Readonly<{
    localServicesRuntime?: PluginLocalServicesRuntimeBridgeFactory | null;
    pluginId: string | null;
    contributionId: string;
    readActiveScope: () => BoundContextScope | null;
}>): PluginLocalServicesDaemonBridge | null {
    const localServicesRuntime = params.localServicesRuntime;
    const pluginId = params.pluginId;
    if (!localServicesRuntime || !pluginId) {
        return null;
    }
    const bridgesBySessionId = new Map<string, PluginLocalServicesDaemonBridge>();
    const resolveBridge = (): PluginLocalServicesDaemonBridge | null => {
        const scope = params.readActiveScope();
        if (!scope || scope.kind !== 'hostSession') {
            return null;
        }
        const sessionId = readTrimmedString(scope.getSession().sessionId);
        if (!sessionId) {
            return null;
        }
        const existing = bridgesBySessionId.get(sessionId);
        if (existing) {
            return existing;
        }
        const bridge = localServicesRuntime.createPluginLocalServicesBridge({
            pluginId,
            contributionId: params.contributionId,
            sessionId,
            title: resolveHostSessionTitle(scope, params.contributionId),
        });
        bridgesBySessionId.set(sessionId, bridge);
        return bridge;
    };

    return Object.freeze({
        async declare(declaration) {
            await resolveBridge()?.declare?.(declaration);
        },
        async start(declaration) {
            const bridge = resolveBridge();
            if (!bridge) {
                return failedPluginLocalServiceSessionContextSnapshot(declaration.id);
            }
            return await bridge.start(declaration);
        },
        async get(id) {
            return await resolveBridge()?.get?.(id) ?? null;
        },
        async stop(id) {
            await resolveBridge()?.stop?.(id);
        },
    });
}

export function createHostPluginContextV1(params?: ResolveEngineRegistryParams): PluginContextV1 {
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
    const pendingProviderAccountUsageSnapshots = new Map<string, PendingProviderAccountUsageSnapshot>();

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

    function providerAccountUsageSnapshotPendingKey(request: PendingProviderAccountUsageSnapshot): string {
        const source = request.source;
        const sourceKey = source
            ? `${source.serviceId}\u0001${source.profileId}\u0001${source.bindingKind}\u0001${source.groupId ?? ''}\u0001${source.groupGeneration ?? ''}`
            : '';
        return `${request.sessionId}\u0000${request.snapshot.recordId}\u0000${sourceKey}`;
    }

    function enqueuePendingProviderAccountUsageSnapshot(request: PendingProviderAccountUsageSnapshot): void {
        const key = providerAccountUsageSnapshotPendingKey(request);
        pendingProviderAccountUsageSnapshots.delete(key);
        pendingProviderAccountUsageSnapshots.set(key, request);
        while (pendingProviderAccountUsageSnapshots.size > MAX_PENDING_PROVIDER_ACCOUNT_USAGE_SNAPSHOTS) {
            const oldestKey = pendingProviderAccountUsageSnapshots.keys().next().value;
            if (typeof oldestKey !== 'string') break;
            pendingProviderAccountUsageSnapshots.delete(oldestKey);
        }
    }

    async function deliverProviderAccountUsageSnapshotToDaemon(
        request: PendingProviderAccountUsageSnapshot,
    ): Promise<ProviderAccountUsageSnapshotDeliveryResult> {
        try {
            const response = await notifyDaemonProviderAccountUsageSnapshot(request);
            const responseRecord = isRecord(response) ? response : null;
            if (responseRecord?.ok === true) {
                const result = responseRecord.result;
                const resultRecord = isRecord(result) ? result : null;
                if (!resultRecord) {
                    return { status: 'rejected' };
                }
                const resultStatus = typeof resultRecord.status === 'string' ? resultRecord.status : null;
                if (resultStatus === 'session_not_found') {
                    return { status: 'unavailable' };
                }
                if (resultRecord && resultStatus === 'recorded') {
                    const recordId = typeof resultRecord.recordId === 'string'
                        ? resultRecord.recordId
                        : request.snapshot.recordId;
                    const persisted = typeof resultRecord.persisted === 'boolean'
                        ? resultRecord.persisted
                        : undefined;
                    return {
                        status: 'recorded',
                        result: {
                            status: 'recorded',
                            recordId,
                            ...(persisted === undefined ? {} : { persisted }),
                        },
                    };
                }
                return { status: 'rejected' };
            }
            if (responseRecord?.error) {
                return { status: 'unavailable' };
            }
            return { status: 'rejected' };
        } catch {
            return { status: 'unavailable' };
        }
    }

    async function flushPendingProviderAccountUsageSnapshots(
        observedKey?: string,
    ): Promise<ProviderAccountUsageSnapshotDeliveryResult | null> {
        if (pendingProviderAccountUsageSnapshots.size === 0) {
            return null;
        }
        let observedDelivery: ProviderAccountUsageSnapshotDeliveryResult | null = null;
        for (const [key, request] of [...pendingProviderAccountUsageSnapshots.entries()]) {
            if (pendingProviderAccountUsageSnapshots.get(key) !== request) {
                continue;
            }
            const delivery = await deliverProviderAccountUsageSnapshotToDaemon(request);
            if (key === observedKey) {
                observedDelivery = delivery;
            }
            if (delivery.status === 'unavailable') {
                return observedDelivery;
            }
            pendingProviderAccountUsageSnapshots.delete(key);
        }
        return observedDelivery;
    }

    const resolveProviderAccountUsageSourceContextFromPlugin: PluginContextV1['agentRuntime']['accountUsage']['resolveSourceContext'] = async (input, options) => {
        if (options?.signal?.aborted) {
            throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('Provider account usage source-context resolution aborted');
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
        if (!context?.profileId) return null;
        return ConnectedServiceUsageSourceV1Schema.parse({
            serviceId: context.serviceId,
            profileId: context.profileId,
            bindingKind: context.groupId ? 'group_member' : 'profile',
            ...(context.groupId ? { groupId: context.groupId } : {}),
            ...(context.groupId && context.groupGeneration !== null && context.groupGeneration !== undefined
                ? { groupGeneration: context.groupGeneration }
                : {}),
        });
    };
    const recordProviderAccountUsageSnapshotFromPlugin: PluginContextV1['agentRuntime']['accountUsage']['recordSnapshot'] = async (input, options) => {
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
        const parsedSource = request.source == null
            ? { success: true as const, data: undefined }
            : ConnectedServiceUsageSourceV1Schema.safeParse(request.source);
        if (!parsedSource.success) {
            return { status: 'rejected', reason: 'invalid_snapshot' };
        }
        const pendingSnapshot = {
            sessionId: targetSessionId,
            snapshot: parsed.data,
            ...(parsedSource.data ? { source: parsedSource.data } : {}),
        };
        const pendingKey = providerAccountUsageSnapshotPendingKey(pendingSnapshot);
        if (pendingProviderAccountUsageSnapshots.has(pendingKey)) {
            enqueuePendingProviderAccountUsageSnapshot(pendingSnapshot);
            const flushedCurrent = await flushPendingProviderAccountUsageSnapshots(pendingKey);
            if (flushedCurrent?.status === 'recorded') {
                await flushPendingProviderAccountUsageSnapshots();
                return flushedCurrent.result;
            }
            if (flushedCurrent?.status === 'rejected') {
                return { status: 'rejected', reason: 'daemon_rejected' };
            }
            return { status: 'unavailable', reason: 'daemon_unavailable' };
        }
        await flushPendingProviderAccountUsageSnapshots();
        const delivery = await deliverProviderAccountUsageSnapshotToDaemon(pendingSnapshot);
        if (delivery.status === 'recorded') {
            await flushPendingProviderAccountUsageSnapshots();
            return delivery.result;
        }
        if (delivery.status === 'unavailable') {
            enqueuePendingProviderAccountUsageSnapshot(pendingSnapshot);
            return { status: 'unavailable', reason: 'daemon_unavailable' };
        }
        return { status: 'rejected', reason: 'daemon_rejected' };
    };
    const adoptProviderAccountUsageProvisionalRecordFromPlugin: PluginContextV1['agentRuntime']['accountUsage']['adoptProvisionalRecord'] = async (input, options) => {
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
    const accountUsage: PluginContextV1['agentRuntime']['accountUsage'] = Object.freeze({
        resolveSourceContext: resolveProviderAccountUsageSourceContextFromPlugin,
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
            return scope;
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

    const agentRuntimesByAgentId = params?.runtimeRegistry?.agentRuntimesByAgentId;
    const contextPluginId = agentRuntimesByAgentId && typeof agentRuntimesByAgentId.get === 'function'
        ? agentRuntimesByAgentId.get(backendId)?.pluginId ?? null
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
    addRuntimeDisposable({
        dispose: () => {
            const scope = readActiveScope();
            if (!scope || scope.kind !== 'hostSession') {
                return;
            }
            scope.getPermissionHandler().cancelByPlugin(pluginId, 'plugin_deactivated');
        },
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
            const opts = readPluginUserTextSendOptions(request.opts);
            if (!opts) {
                logger.debug('[PluginContextV1] sessions.send userText missing localId (ignored)', { request });
                return { ok: false, error: 'invalid_request' };
            }
            session.sendUserTextMessage(request.text, opts);
            return { ok: true };
        }
        if (request.kind === 'sessionEvent' && request.event) {
            session.sendSessionEvent(request.event as any, typeof request.id === 'string' ? request.id : undefined);
            return { ok: true };
        }
        if (request.kind === 'providerDispatch' && Object.prototype.hasOwnProperty.call(request, 'body')) {
            session.sendProviderMessage({
                body: request.body,
                ...(isRecord(request.meta) ? { meta: request.meta } : {}),
            });
            return { ok: true };
        }
        if (request.kind === 'agentMessageEphemeral' && typeof request.agentId === 'string' && request.body && isRecord(request.opts)) {
            const localId = typeof request.opts.localId === 'string' ? request.opts.localId : '';
            const createdAt = typeof request.opts.createdAt === 'number' ? request.opts.createdAt : Date.now();
            session.sendAgentMessageEphemeral(request.agentId as any, request.body as any, {
                localId,
                createdAt,
                updatedAt: typeof request.opts.updatedAt === 'number' ? request.opts.updatedAt : createdAt,
                ...(request.opts.meta ? { meta: request.opts.meta as any } : {}),
            });
            return { ok: true };
        }
        if (request.kind === 'agentMessageCommitted' && typeof request.agentId === 'string' && request.body && isRecord(request.opts)) {
            const localId = typeof request.opts.localId === 'string' ? request.opts.localId : '';
            const opts = {
                localId,
                ...(request.opts.meta ? { meta: request.opts.meta as any } : {}),
            };
            if (typeof session.enqueueAgentMessageCommitted === 'function') {
                await session.enqueueAgentMessageCommitted(request.agentId as any, request.body as any, opts);
            } else {
                await session.sendAgentMessageCommitted(request.agentId as any, request.body as any, opts);
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
            enqueue: typeof session.enqueueRegisteredSessionStateFieldMutation === 'function'
                ? (mutation) => session.enqueueRegisteredSessionStateFieldMutation(mutation)
                : undefined,
        });
        if (durableResult) {
            throwIfDurableRegisteredSessionStateFieldDeliveryUnavailable(durableResult);
            return;
        }
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

    // Durable session-system-record write (the host-owned counterpart of `writeMetadata`). The active
    // session client owns the socket transport and storage encryption context; a runtime contributes a
    // typed payload through `ctx.sessions.current.writeSystemRecord` and never sees tokens or the DEK.
    type ResolvedSessionRecordWriteContext = Readonly<{
        mode: SessionStoredContentEncryptionMode;
        ctx?: SessionEncryptionContext;
    }>;

    const sealSessionSystemRecordContent = (
        context: ResolvedSessionRecordWriteContext,
        payload: unknown,
    ): SessionSystemRecordContent => {
        // Canonical envelope shape, identical to the memory/activity seal helpers, reusing the same
        // `encryptSessionPayload` primitive so encryption parity with memory records is mandatory.
        if (context.mode === 'plain') {
            return { t: 'plain', v: payload };
        }
        if (!context.ctx) {
            throw new Error('Missing session encryption context for encrypted system record');
        }
        return { t: 'encrypted', c: encryptSessionPayload({ ctx: context.ctx, payload }) };
    };

    const openSessionSystemRecordContent = (
        context: ResolvedSessionRecordWriteContext,
        content: SessionSystemRecordContent,
    ): unknown => {
        if (content.t === 'plain') {
            return content.v;
        }
        if (!context.ctx) {
            throw new Error('Missing session encryption context for encrypted system record');
        }
        return decryptSessionPayload({ ctx: context.ctx, ciphertextBase64: content.c });
    };

    const writeSessionSystemRecord: NonNullable<SessionScopedServicesV1['writeSystemRecord']> = async (request) => {
        const scope = await ensureScope();
        if (scope.kind === 'executionRun') {
            // Durable system records are session-scoped; an execution run has no own session record
            // surface. No-op (consistent with writeAgentState) instead of fabricating a write.
            logger.debug('[PluginContextV1] sessions.writeSystemRecord (execution-run no-op)', {
                namespace: request.namespace,
                kind: request.kind,
            });
            return;
        }
        const session = scope.getSession();
        const sessionId = readTrimmedString(session.sessionId);
        if (!sessionId) {
            throw new Error('writeSystemRecord requires a bound session id');
        }
        if (typeof session.upsertSessionSystemRecord !== 'function') {
            throw new Error('writeSystemRecord requires a session-owned system-record writer');
        }
        const context = session.getStoredContentEncryptionContext?.();
        if (!context) {
            throw new Error('writeSystemRecord requires a session storage encryption context');
        }
        const content = sealSessionSystemRecordContent(context, request.payload);
        await session.upsertSessionSystemRecord({
            namespace: request.namespace,
            kind: request.kind,
            localId: request.localId,
            content,
        });
    };

    const readSessionSystemRecord: NonNullable<SessionScopedServicesV1['readSystemRecord']> = async (request) => {
        const scope = await ensureScope();
        if (scope.kind === 'executionRun') {
            logger.debug('[PluginContextV1] sessions.readSystemRecord (execution-run no-op)', {
                namespace: request.namespace,
                localId: request.localId,
            });
            return null;
        }
        const session = scope.getSession();
        const sessionId = readTrimmedString(session.sessionId);
        if (!sessionId) {
            throw new Error('readSystemRecord requires a bound session id');
        }
        if (typeof session.fetchSessionSystemRecord !== 'function') {
            throw new Error('readSystemRecord requires a session-owned system-record reader');
        }
        const context = session.getStoredContentEncryptionContext?.();
        if (!context) {
            throw new Error('readSystemRecord requires a session storage encryption context');
        }
        const record = await session.fetchSessionSystemRecord({
            namespace: request.namespace,
            localId: request.localId,
        });
        if (!record) {
            return null;
        }
        return {
            namespace: record.namespace,
            kind: record.kind,
            localId: record.localId,
            payload: openSessionSystemRecordContent(context, record.content),
        };
    };

    const sessionPermissions: PluginContextV1['sessions']['current']['permissions'] = Object.freeze({
        requestDecision: async (
            request: Parameters<PluginContextV1['sessions']['current']['permissions']['requestDecision']>[0],
            options?: Parameters<PluginContextV1['sessions']['current']['permissions']['requestDecision']>[1],
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
            const requestRecord = isRecord(request) ? request : null;
            const responseApproved = requestRecord && typeof requestRecord.approved === 'boolean'
                ? requestRecord.approved
                : undefined;
            const toolName = requestRecord && typeof requestRecord.toolName === 'string'
                ? requestRecord.toolName
                : null;
            const toolRequestId = requestRecord && typeof requestRecord.toolCallId === 'string'
                ? requestRecord.toolCallId.trim()
                : '';
            const providerRequestId = requestRecord && typeof requestRecord.requestId === 'string'
                ? requestRecord.requestId.trim()
                : '';
            const permissionAskId = toolRequestId || (typeof responseApproved === 'boolean' ? '' : providerRequestId);
            if (permissionAskId && toolName) {
                const result = await withCallerAbortSignal(
                    handler.handleToolCall(permissionAskId, toolName, requestRecord?.input, {
                        owner: { kind: 'plugin', pluginId, runtimeId },
                    }),
                    options?.signal,
                );
                return normalizeSessionPermissionDecisionResult(result);
            }
            throwIfSignalAborted(options?.signal);
            // Response-routing shape: a runtime forwarded a user/hook response by request id (e.g.
            // `respondToPermission(requestId, approved)`). Resolve the real pending coordinator
            // request instead of fabricating an `approved_for_session` for any/unknown id (gap 28/29).
            const responseRequestId = providerRequestId;
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
        owner: { kind: 'plugin', pluginId, runtimeId },
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

    type ProviderAcceptedUserMessageDeliveryQuery = Parameters<
        NonNullable<SessionScopedServicesV1['hasProviderAcceptedUserMessageDelivery']>
    >[0];

    const hasProviderAcceptedUserMessageDelivery = (
        scope: HostSessionContextScope,
        query: ProviderAcceptedUserMessageDeliveryQuery,
    ): boolean => scope.getSession().hasUserMessageProviderAcceptance?.({
        localIds: query.localIds ?? null,
        userMessageSeq: query.userMessageSeq ?? null,
        userMessageSeqs: query.userMessageSeqs ?? null,
    }) === true;

    const readActiveProviderAcceptedUserMessageDelivery = (
        query: ProviderAcceptedUserMessageDeliveryQuery,
    ): boolean => {
        const scope = readActiveScope();
        return scope?.kind === 'hostSession'
            ? hasProviderAcceptedUserMessageDelivery(scope, query)
            : false;
    };

    const createScopedSessionServices = (scope: HostSessionContextScope): SessionScopedServicesV1 => Object.freeze({
        sessionId: scope.getSession().sessionId,
        hasProviderAcceptedUserMessageDelivery: (query: ProviderAcceptedUserMessageDeliveryQuery) =>
            hasProviderAcceptedUserMessageDelivery(scope, query),
        send: sendSession,
        subscribe: subscribeSession,
        writeMetadata: writeSessionMetadata,
        writeAgentState: writeSessionAgentState,
        writeStateField: writeSessionStateField,
        writeSystemRecord: writeSessionSystemRecord,
        readSystemRecord: readSessionSystemRecord,
        mcp: sessionMcpService,
        auth: sessionAuthService,
        permissions: sessionPermissions,
        subagents: subagentsService,
        external: externalSessionsService,
    });

    const currentSessionServices: SessionScopedServicesV1 = Object.freeze({
        hasProviderAcceptedUserMessageDelivery: readActiveProviderAcceptedUserMessageDelivery,
        send: sendSession,
        subscribe: subscribeSession,
        writeMetadata: writeSessionMetadata,
        writeAgentState: writeSessionAgentState,
        writeStateField: writeSessionStateField,
        writeSystemRecord: writeSessionSystemRecord,
        readSystemRecord: readSessionSystemRecord,
        mcp: sessionMcpService,
        auth: sessionAuthService,
        permissions: sessionPermissions,
        subagents: subagentsService,
        external: externalSessionsService,
    });

    const sessions: PluginContextV1['sessions'] = Object.freeze({
        ...currentSessionServices,
        current: currentSessionServices,
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
        permissions: sessionsPermissions,
    });
    const fetchService = createPluginFetchService({
        networkAllowed: contextPluginId
            ? params?.runtimeRegistry?.networkAllowedPluginIds?.has(contextPluginId) === true
            : false,
        pluginId: contextPluginId ?? backendId,
        adapter: params?.fetchAdapter ?? createGlobalFetchRuntime(),
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
    const runtimeCapabilityInventory: readonly string[] = Object.freeze(
        Array.from(new Set([
            ...(declaredPluginPermissions ?? []),
            ...(declaredRuntimeCapabilities ?? []),
        ])).sort(),
    );
    const permissionInventory: readonly string[] = Object.freeze(
        Array.from(new Set(declaredPluginPermissions ?? [])).sort(),
    );
    const hasRuntimeCapability = (capability: string): boolean => runtimeCapabilityInventory.includes(capability);
    const permissions: PluginContextV1['permissions'] = Object.freeze({
        isGranted: (permission: string) => permissionInventory.includes(permission),
        list: () => permissionInventory,
    });
    const contributionRegistry = params?.runtimeRegistry?.contributes ?? params?.contributes ?? null;
    const currentBackend = params?.backendId
        ? contributionRegistry?.agentRuntimeDefinitionsById.get(params.backendId) ?? null
        : null;
    const agentCatalogEntry = contributionRegistry && currentBackend
        ? resolveFirstPartyCatalogEntryForBackend({
            backend: currentBackend,
            contributions: contributionRegistry,
        })
        : null;
    const terminalHostService = createDefaultPluginTerminalHostService({
        happyHomeDir: pluginStorePaths.happyHomeDir,
        hasCapability: hasRuntimeCapability,
        readSessionId: () => {
            const scope = readActiveScope();
            return scope?.kind === 'hostSession' ? scope.getSession().sessionId : null;
        },
        ...(agentCatalogEntry?.getTerminalPromptSubmitVerificationPolicy
            ? { resolvePromptSubmitVerification: agentCatalogEntry.getTerminalPromptSubmitVerificationPolicy }
            : {}),
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

    const appendTranscriptTurn = async (turn: TranscriptAppendTurnV1): Promise<void> => {
        const scope = await ensureScope();
        if (scope.kind === 'executionRun') {
            logger.debug('[PluginContextV1] transcripts.append (execution-run no-op)', { turn });
            return;
        }
        const session = scope.getSession();
        const transcript = scope.getTranscriptSession();
        if (turn.kind === 'userText') {
            const opts = readPluginUserTextSendOptions(turn.opts);
            if (!opts) {
                logger.debug('[PluginContextV1] transcripts.append userText missing localId (ignored)', { turn });
                return;
            }
            session.sendUserTextMessage(turn.text, opts);
            return;
        }
        if (turn.kind === 'agentMessageCommitted') {
            const opts = {
                localId: turn.localId,
                ...(isRecord(turn.meta) ? { meta: turn.meta as any } : {}),
            };
            if (typeof transcript.enqueueAgentMessageCommitted === 'function') {
                await transcript.enqueueAgentMessageCommitted(turn.agentId as any, turn.body as any, opts);
            } else {
                await transcript.sendAgentMessageCommitted(turn.agentId as any, turn.body as any, opts);
            }
            return;
        }
        if (turn.kind === 'agentMessageEphemeral') {
            const createdAt = typeof turn.createdAt === 'number' ? turn.createdAt : Date.now();
            const updatedAt = typeof turn.updatedAt === 'number' ? turn.updatedAt : createdAt;
            await transcript.sendAgentMessageEphemeral?.(turn.agentId as any, turn.body as any, {
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
        installablesRegistry: createPluginExecInstallablesRegistry(params?.runtimeRegistry?.contributes),
        getAccountSettings: getCurrentAccountSettings,
        getMachineId: () => {
            const scope = readActiveScope();
            return scope?.kind === 'hostSession' ? scope.machineId : null;
        },
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
    const localServicesService = createPluginLocalServicesService({
        daemonBridge: createScopedPluginLocalServicesDaemonBridge({
            localServicesRuntime: params?.localServicesRuntime ?? null,
            pluginId: contextPluginId,
            contributionId: backendId,
            readActiveScope,
        }),
    });
    const acpService: PluginContextV1['agentRuntime']['acp'] = Object.freeze({
        defineAcpBackend,
        createRuntime: acpRuntimeService.createRuntime,
    });
    const sessionHooksService = createSessionHooksService({
        happyHomeDir: pluginStorePaths.happyHomeDir,
        addDisposable: addRuntimeDisposable,
        grantTranscriptFileFollowPath,
        hasCapability: hasRuntimeCapability,
    });
    const transcriptsService = createPluginTranscriptsService({
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
    });
    const agentRuntime: PluginContextV1['agentRuntime'] = Object.freeze({
        exec: execService,
        acp: acpService,
        terminalHost: terminalHostService,
        sessionHooks: sessionHooksService,
        transcripts: transcriptsService,
        agents: agentsService,
        accountUsage,
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
        permissions,
        agentRuntime,
        managedServer: managedServerService,
        localServices: localServicesService,
        mcp: mcpService,
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
        sessions,
        experimental: Object.freeze({
            telemetry: Object.freeze({
                emit: (observation: unknown) => {
                    if (!telemetryEnabled) {
                        logger.debug('[PluginContextV1] experimental.telemetry.emit (disabled)', { observation });
                        return;
                    }
                    appendJsonLine({ kind: 'telemetry', value: observation });
                },
            }),
            artifacts: Object.freeze({
                write: async (record: unknown) => {
                    if (!artifactsEnabled) {
                        logger.debug('[PluginContextV1] experimental.artifacts.write (disabled)', { record });
                        return;
                    }
                    appendJsonLine({ kind: 'artifacts', value: record });
                },
            }),
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
