import {
    ExternalSessionsProviderIdSchema,
    accountSettingsParse,
    isFeatureId,
    type AccountSettings,
} from '@happier-dev/protocol';

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
    type BackendExecutionSurfaces,
    type CliRuntimeCoreGetter,
    type CliEngineAdapter,
    type CliRuntimeCore,
    type EngineAdapterResolution,
    type EngineResolutionSelectedSource,
    type ResolvedCliEngineRegistry,
} from './engineRegistryTypes';
import { createMissingCliEngineAdapter } from './createCliRuntimeCore';
import {
    readPluginDaemonConnectionStateSource,
    type PluginDaemonConnectionStateSource,
} from './pluginConnectionStateSource';
import { resolvePluginRuntimeAdapterSurfaces } from './resolvePluginRuntimeAdapterSurfaces';
import {
    AGENT_IDS,
    getAgentResumeConfig,
} from '@happier-dev/agents';
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
    type RegisterBackendEngineV1,
    type SessionScopedServicesV1,
    type SubscriptionV1,
} from '@happier-dev/plugin-sdk';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { readBuiltInHostCatalogEntry } from '@/backends/builtInHostCatalogEntries';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import {
    createExecutionRunPermissionHandler,
    resolveExecutionRunPermissionDecision,
} from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
    createAcpRuntimeCoreFromDefinition,
    normalizePluginAcpDefinition,
    normalizePluginBackendContributionAcpDefinition,
} from '@/agent/acp/runtime/definition';
import { createBuiltInNotificationRegistry, createNotificationsService } from '@/notifications/service';
import { createNotificationRegistryFromPluginRuntime } from '@/notifications/pluginRuntimeRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginAuthService } from '@/plugins/runtime/context/auth';
import { createPluginAbortService } from '@/plugins/runtime/context/abort';
import { createPluginEnvService } from '@/plugins/runtime/context/env';
import { createPluginErrorsService } from '@/plugins/runtime/context/errors';
import { createPluginExecService } from '@/plugins/runtime/context/exec';
import { createPluginFsService } from '@/plugins/runtime/context/fs';
import { createPluginManagedServerService } from '@/plugins/runtime/context/managedServer';
import { createPluginMcpService } from '@/plugins/runtime/context/mcp';
import { createPluginHostedMcpServerHandle, createPluginHostedMcpServerRegistry } from '@/mcp/createPluginHostedMcpServerHandle';
import { createPluginProgressService } from '@/plugins/runtime/context/progress';
import { createPluginRetryService } from '@/plugins/runtime/context/retry';
import { createPluginTimeoutService } from '@/plugins/runtime/context/timeout';
import { createPluginTranscriptsService } from '@/plugins/runtime/context/transcripts';
import { canPluginSubscribeToEvent, createPluginEventsService } from '@/plugins/runtime/context/events';
import { createPluginSecretsService } from '@/plugins/runtime/context/secrets';
import { createPluginSettingsService } from '@/plugins/runtime/context/settings';
import {
    createAccountSettingsBackedPluginStorageScope,
    createPluginStorageService,
} from '@/plugins/runtime/context/storage';
import { createPluginFetchService } from '@/plugins/runtime/fetch/service';
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
    bindExecutionRun: (params: Readonly<{ permissionMode?: string | null }>) => void;
}>;

const UNSUPPORTED_PLUGIN_BACKEND_ENGINE_SURFACES = Object.freeze([
    'terminalRuntimeSurface',
    'externalSessionSurface',
    'attachSurface',
    'sessionHandoffSurface',
] as const);

function readPluginContextV1Binder(ctx: PluginContextV1): PluginContextV1Binder | null {
    const record = ctx as unknown as Record<PropertyKey, unknown>;
    const binder = record[PLUGIN_CONTEXT_V1_BINDER];
    return binder && typeof binder === 'object' ? (binder as PluginContextV1Binder) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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

function assertNoUnsupportedPluginBackendEngineSurfaces(params: Readonly<{
    backendId: string;
    engine: unknown;
}>): void {
    if (!isRecord(params.engine)) {
        return;
    }
    const engine = params.engine;
    const unsupportedSurface = UNSUPPORTED_PLUGIN_BACKEND_ENGINE_SURFACES.find((key) => engine[key] != null);
    if (!unsupportedSurface) {
        return;
    }
    throw new Error(
        `Plugin backend '${params.backendId}' returned unsupported BackendEngineV1 executable surface '${unsupportedSurface}'. A.6 exposes the typed substrate, but this host runtime only executes runtimeCore, facets, and messageMeta until the owning surface packet wires that capability.`,
    );
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

function createPluginContextActionsService(): PluginContextV1['actions'] {
    return Object.freeze({
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
        getPermissionHandler: () => ProviderEnforcedPermissionHandler;
        getPermissionMode: () => unknown;
    }>
    | Readonly<{
        kind: 'executionRun';
        permissionMode: string;
        permissionHandler: ReturnType<typeof createExecutionRunPermissionHandler>;
    }>;

type HostSessionContextScope = Extract<BoundContextScope, Readonly<{ kind: 'hostSession' }>>;

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
        if (!currentScope) {
            await initialScopeBound;
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return currentScope!;
    };

    const binder: PluginContextV1Binder = Object.freeze({
        bindHostSessionRuntime: (runtimeParams) => {
            const getSession = () => runtimeParams.session as unknown as ApiSessionClient;
            const getTranscriptSession = () => runtimeParams.transcriptSession as unknown as TranscriptSessionPort;
            const getPermissionHandler = () => runtimeParams.permissionHandler as unknown as ProviderEnforcedPermissionHandler;
            const getPermissionMode = () => runtimeParams.getPermissionMode?.() ?? 'default';
            currentScope = Object.freeze({
                kind: 'hostSession',
                serverId: configuration.activeServerId,
                machineId: runtimeParams.machineId,
                rootPath: runtimeParams.directory,
                getSession,
                getTranscriptSession,
                getPermissionHandler,
                getPermissionMode,
            });
            initialScopeBoundResolve?.();
            initialScopeBoundResolve = null;
        },
        bindExecutionRun: (executionRunParams) => {
            const permissionMode = typeof executionRunParams.permissionMode === 'string'
                && executionRunParams.permissionMode.trim().length > 0
                ? executionRunParams.permissionMode.trim()
                : 'default';
            const permissionHandler = createExecutionRunPermissionHandler({
                backendId,
                permissionMode,
            });
            currentScope = Object.freeze({
                kind: 'executionRun',
                permissionMode,
                permissionHandler,
            });
            initialScopeBoundResolve?.();
            initialScopeBoundResolve = null;
        },
    });

    const getCurrentAccountSettings = (): AccountSettings | null => getActiveAccountSettingsSnapshot()?.settings ?? null;
    const subscribeCurrentAccountSettings = (listener: (settings: AccountSettings | null) => void): (() => void) => (
        subscribeActiveAccountSettingsSnapshot((snapshot) => listener(snapshot?.settings ?? null))
    );
    const getActiveProjectScope = (): WorkspaceRefScopeV1 | null => {
        const scope = currentScope;
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
            await session.sendAgentMessageCommitted(request.provider as any, request.body as any, {
                localId,
                ...(request.opts.meta ? { meta: request.opts.meta as any } : {}),
            });
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
            const handler = (payload: unknown) => onEvent(payload);
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
            logger.debug('[PluginContextV1] sessions.writeMetadata (execution-run no-op)', { request });
            return;
        }
        const session = scope.getSession();
        if (!isRecord(request) || typeof request.kind !== 'string') return;
        if (request.kind === 'set') {
            const next = isRecord(request.metadata) ? request.metadata : {};
            await session.updateMetadata((current) => preserveSessionStateMetadataKeys(current, next) as any);
        } else if (request.kind === 'update') {
            const handler = request.handler;
            if (typeof handler !== 'function') return;
            await session.updateMetadata((current) => {
                const candidate = handler(current);
                return preserveSessionStateMetadataKeys(current, candidate) as any;
            });
        }
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

    const createScopedSessionServices = (scope: HostSessionContextScope): SessionScopedServicesV1 => Object.freeze({
        sessionId: scope.getSession().sessionId,
        send: sendSession,
        subscribe: subscribeSession,
        writeMetadata: writeSessionMetadata,
        writeAgentState: writeSessionAgentState,
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
        subagents: subagentsService,
        external: externalSessionsService,
    });
    const fetchService = createPluginFetchService({
        networkAllowed: contextPluginId
            ? params?.runtimeRegistry?.networkAllowedPluginIds?.has(contextPluginId) === true
            : false,
        pluginId: contextPluginId ?? backendId,
        adapter: params?.fetchAdapter ?? null,
        interceptors: Object.freeze((params?.runtimeRegistry?.requestInterceptors ?? []).map((entry) => entry.registration)),
        allowedUrlOrigins: contextPluginId
            ? Object.freeze([...(params?.runtimeRegistry?.networkAllowedUrlOriginsByPluginId?.get(contextPluginId) ?? [])])
            : Object.freeze([]),
    });
    const pluginStorePaths = resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir });
    const storage = createPluginStorageService({
        pluginId,
        paths: pluginStorePaths,
        sessionId: () => currentScope?.kind === 'hostSession' ? currentScope.getSession().sessionId : null,
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
    const events = createPluginEventsService({
        pluginId,
        canSubscribe: (eventName) => canPluginSubscribeToEvent({
            pluginId,
            eventName,
            permissions: eventSubscriptionPermissions,
        }),
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
            await transcript.sendAgentMessageCommitted(turn.provider as any, turn.body as any, {
                localId: turn.localId,
                ...(isRecord(turn.meta) ? { meta: turn.meta as any } : {}),
            });
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
        baseEnv: Object.freeze({}),
        signal: abortRuntime.service.signal,
        addDisposable: addRuntimeDisposable,
    });
    const managedServerService = createPluginManagedServerService({
        exec: execService,
        signal: abortRuntime.service.signal,
        addDisposable: addRuntimeDisposable,
    });
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
        startHostedServer: (spec) => createPluginHostedMcpServerHandle({ pluginId, spec, registry: pluginHostedMcpRegistry }),
        // RN-MCP-003: scope listSpecs to the calling plugin's own registrations.
        // Cross-plugin enumeration is not part of ctx.mcp.list contract; host-level
        // discovery uses dedicated registry queries.
        listSpecs: () => Object.freeze(
            (params?.runtimeRegistry?.mcpServers ?? [])
                .filter((entry) => entry.pluginId === pluginId)
                .map((entry) => entry.registration),
        ),
        // RN-MCP-004: host-policy-backed per-session resolution is intentionally
        // deferred; returning no resolved specs avoids fabricating scope policy.
        resolveForSession: () => Object.freeze([]),
    });

    return Object.freeze({
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
        exec: execService,
        managedServer: managedServerService,
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
        }),
        actions: createPluginContextActionsService(),
        acp: Object.freeze({
            defineAcpBackend,
            createRuntime: async () => {
                throw new Error('ctx.acp.createRuntime is reserved for Tier 3 ACP runtime composition and is not implemented in this host packet yet. Use ctx.acp.defineAcpBackend(spec) for A.15.2 backends.');
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
        sessions,
        transcripts: createPluginTranscriptsService({
            append: appendTranscriptTurn,
            addDisposable: addRuntimeDisposable,
        }),
        permissions: Object.freeze({
            requestDecision: async (request: unknown) => {
	                const scope = await ensureScope();
		                if (scope.kind === 'executionRun') {
		                    // Execution runs may run without an interactive prompt surface. If an extracted backend
		                    // asks the host for a decision, apply deterministic execution-run semantics.
		                    const toolName = isRecord(request) && typeof request.toolName === 'string'
		                        ? request.toolName
		                        : null;
		                    if (!toolName) {
		                        return { decision: 'denied' };
		                    }
		                    return {
		                        decision: resolveExecutionRunPermissionDecision({
		                            permissionMode: scope.permissionMode,
		                            backendId,
		                            toolName,
		                        }),
		                    };
		                }
                const handler = scope.getPermissionHandler();
                if (isRecord(request) && typeof request.toolCallId === 'string' && typeof request.toolName === 'string') {
                    return await handler.handleToolCall(request.toolCallId, request.toolName, request.input);
                }
                return { decision: 'approved_for_session' };
            },
            getEffectiveMode: () => {
                const scope = currentScope;
                if (!scope) return 'default';
                if (scope.kind === 'executionRun') return scope.permissionMode;
                return scope.getPermissionMode();
            },
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
}

export type {
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
    connectionStateSource?: PluginDaemonConnectionStateSource | null;
    fetchAdapter?: FetchRuntimeServiceV1 | null;
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry | null;
    authMaterializeAdapter?: (request: PluginAuthMaterializeRequestV1) => Promise<PluginAuthMaterializedServiceV1 | null>;
}>;

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

async function resolveCatalogExecutionSurfacesForEntry(entry: ResolvedCatalogEntry): Promise<BackendExecutionSurfaces> {
    const hostEntry = readBuiltInHostCatalogEntry(entry.id);
    const getExternalSessionProviderOps = entry.getExternalSessionProviderOps ?? hostEntry?.getExternalSessionProviderOps;
    const getTerminalRuntimeOps = entry.getTerminalRuntimeOps ?? hostEntry?.getTerminalRuntimeOps;
    const getProviderAttachOps = entry.getProviderAttachOps ?? hostEntry?.getProviderAttachOps;
    const getSessionHandoffProviderOps = entry.getSessionHandoffProviderOps ?? hostEntry?.getSessionHandoffProviderOps;

    const externalSessions = ExternalSessionsProviderIdSchema.safeParse(entry.id).success
        && getExternalSessionProviderOps
        ? await getExternalSessionProviderOps()
        : null;

    return {
        terminalRuntime: getTerminalRuntimeOps ? await getTerminalRuntimeOps() : null,
        externalSessions,
        attach: getProviderAttachOps ? await getProviderAttachOps() : null,
        sessionHandoff: getSessionHandoffProviderOps ? await getSessionHandoffProviderOps() : null,
    };
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
                    return await createSessionRuntime(runtimeParams);
                },
            });
            return Object.freeze({
                ...planRecord,
                config: wrappedConfig,
            });
        },
        createExecutionRunBackend(opts: any) {
            binder?.bindExecutionRun({ permissionMode: opts?.permissionMode });
            return rawRuntimeCore.createExecutionRunBackend(opts);
        },
    });
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
        const adapter = createAcpRuntimeCoreFromDefinition(acpDefinition);
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
    catalogEntry?: ResolvedCatalogEntry | null;
    provider: ResolvedProviderContribution;
    executionSurfaces: BackendExecutionSurfaces;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    pluginContext: PluginContextV1;
}>): Promise<CliEngineAdapter | null> {
    const getRuntimeCore = resolveContributionRuntimeCoreGetter({
        backend: params.backend,
        catalogEntry: params.catalogEntry,
    });
    if (!getRuntimeCore) {
        const runtimeRegistry = params.runtimeRegistry;
        if (!runtimeRegistry) {
            return null;
        }
        const engineEntry = runtimeRegistry.backendEnginesByBackendId.get(params.backend.id);
        const registration = engineEntry?.registration as RegisterBackendEngineV1 | undefined;
        if (!registration) {
            return resolveManifestOnlyAcpBackendAdapter({
                backend: params.backend,
                pluginContext: params.pluginContext,
            });
        }
        const engine = await registration.create(params.pluginContext);
        assertNoUnsupportedPluginBackendEngineSurfaces({
            backendId: params.backend.id,
            engine,
        });
        const acpSpec = readAcpBackendSpec(engine);
        if (acpSpec) {
            const acpDefinition = normalizePluginAcpDefinition({
                pluginId: engineEntry?.pluginId,
                spec: acpSpec,
            });
            const adapter = createAcpRuntimeCoreFromDefinition(acpDefinition);
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
        return {
            backendId: backend.id,
            providerId: backend.providerId,
            provenance: backend.provenance,
            selectedSource: toEngineSelectedSource(backend.provenance, undefined),
            backend,
            provider: missingProvider,
            engineAdapter: createMissingCliEngineAdapter({ backend }),
            executionSurfaces: createEmptyBackendExecutionSurfaces(),
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
        const executionSurfaces = entry
            ? await resolveCatalogExecutionSurfacesForEntry(entry)
            : createEmptyBackendExecutionSurfaces();
        const hasExplicitRuntimeCore = Boolean(resolveContributionRuntimeCoreGetter({
            backend,
            catalogEntry: entry ?? null,
        }));
        const engineAdapter = await resolveBackendRuntimeCore({
            backend,
            catalogEntry: entry ?? null,
            provider,
            executionSurfaces,
            runtimeRegistry: params.runtimeRegistry,
            pluginContext: params.pluginContext,
        });
        return {
            backendId: backend.id,
            providerId: provider.id,
            provenance: backend.provenance,
            selectedSource: !hasExplicitRuntimeCore && params.runtimeRegistry ? 'plugin' : toEngineSelectedSource(
                backend.provenance,
                provider.runtimeSpec?.sourcePreferenceDefault,
            ),
            backend,
            provider,
            engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
            executionSurfaces,
            diagnostics: Object.freeze([]),
        };
    }

    const runtimeRegistry = params.runtimeRegistry;
    if (!runtimeRegistry) {
        return {
            backendId: backend.id,
            providerId: provider.id,
            provenance: backend.provenance,
            selectedSource: 'plugin',
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

    const pluginResolution = await resolvePluginRuntimeAdapterSurfaces({
        backend,
        provider,
        runtimeRegistry,
    });
    const engineAdapter = await resolveBackendRuntimeCore({
        backend,
        provider,
        executionSurfaces: pluginResolution.surfaces,
        runtimeRegistry,
        pluginContext: params.pluginContext,
    });
    return {
        backendId: backend.id,
        providerId: provider.id,
        provenance: backend.provenance,
        selectedSource: 'plugin',
        backend,
        provider,
        engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
        executionSurfaces: pluginResolution.surfaces,
        diagnostics: pluginResolution.diagnostics,
    };
}

export async function resolveCliEngineRegistry(
    params?: ResolveEngineRegistryParams,
): Promise<ResolvedCliEngineRegistry> {
    const activeRuntimeRegistry = pluginReloadController.getState().activeRegistry;
    const contributions = activeRuntimeRegistry?.contributes
        ?? await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
        });
    let runtimeRegistryPromise: Promise<ResolvedExecutablePluginRuntimeRegistry> | null = activeRuntimeRegistry
        ? Promise.resolve(activeRuntimeRegistry)
        : null;
    const resolutionPromises = new Map<string, Promise<EngineAdapterResolution | null>>();

    async function resolveRuntimeRegistry(): Promise<ResolvedExecutablePluginRuntimeRegistry> {
        if (!runtimeRegistryPromise) {
            runtimeRegistryPromise = resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: params?.happyHomeDir,
                contributes: contributions,
            });
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

                if (requiresExecutablePluginRuntimeRegistry) {
                    runtimeRegistry = await resolveRuntimeRegistry();
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
