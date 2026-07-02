import { getProviderDefinition, hasBuiltInAcpConfig, isAgentId } from '@happier-dev/agents';
import type { AccountSettings } from '@happier-dev/protocol';

import { createCatalogAcpBackend } from '@/agent/acp';
import { loadBuiltInRuntimeOwners } from '@/agent/acp/catalog/builtIn/runtimeOwners';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createAcpRuntime, type AcpRuntimeBackend } from '@/agent/acp/runtime/createAcpRuntime';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { McpServerConfig } from '@/agent';
import type { AgentFactoryOptions } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import {
  sendPermissionRequestPushNotificationForActiveAccount,
  type PermissionRequestPushSender,
} from '@/settings/notifications/permissionRequestPush';
import { getConnectedServiceRuntimeAuthAdapter } from '@/backends/catalog';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { createSessionProviderPendingDrainAdapter } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { resolveSessionPendingQueueMaxPopPerWake } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';

type RuntimeAuthRecoveryProjectionDeduperState = Readonly<{
  key: string;
  surfacedAtMs: number;
}>;
type PendingRuntimeAuthRecoveryProjectionState = Readonly<{
  key: string;
  promise: Promise<unknown>;
}>;

const RUNTIME_AUTH_RECOVERY_PROJECTION_DEDUPE_WINDOW_MS = 15_000;
const recentRuntimeAuthRecoveryProjectionBySession = new WeakMap<
  ApiSessionClient,
  RuntimeAuthRecoveryProjectionDeduperState
>();
const pendingRuntimeAuthRecoveryProjectionBySession = new WeakMap<
  ApiSessionClient,
  PendingRuntimeAuthRecoveryProjectionState
>();

function readClassificationProjectionFields(classification: unknown): Readonly<{
  kind: string | null;
  serviceId: string | null;
  profileId: string | null;
  groupId: string | null;
  resetsAtMs: number | null;
  retryAfterMs: number | null;
}> {
  if (!classification || typeof classification !== 'object' || Array.isArray(classification)) {
    return {
      kind: null,
      serviceId: null,
      profileId: null,
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
    };
  }
  const record = classification as Record<string, unknown>;
  return {
    kind: typeof record.kind === 'string' ? record.kind : null,
    serviceId: typeof record.serviceId === 'string' ? record.serviceId : null,
    profileId: typeof record.profileId === 'string' ? record.profileId : null,
    groupId: typeof record.groupId === 'string' ? record.groupId : null,
    resetsAtMs: typeof record.resetsAtMs === 'number' ? record.resetsAtMs : null,
    retryAfterMs: typeof record.retryAfterMs === 'number' ? record.retryAfterMs : null,
  };
}

function buildRuntimeAuthRecoveryProjectionDeduperKey(input: Readonly<{
  classification: unknown;
  recoveryReport: Awaited<ReturnType<typeof reportConnectedServiceRuntimeAuthFailureToDaemon>>;
}>): string {
  const transcriptEvent = input.recoveryReport.projection?.transcriptEvent as
    | Readonly<Record<string, unknown>>
    | undefined;
  const classification = readClassificationProjectionFields(input.classification);
  return JSON.stringify({
    statusCode: input.recoveryReport.statusCode ?? null,
    statusMessage: input.recoveryReport.statusMessage ?? null,
    kind: classification.kind,
    serviceId: classification.serviceId,
    profileId: classification.profileId,
    groupId: classification.groupId,
    resetsAtMs: classification.resetsAtMs,
    retryAfterMs: classification.retryAfterMs,
    transcriptStatus: typeof transcriptEvent?.status === 'string' ? transcriptEvent.status : null,
    nextRetryAtMs: typeof transcriptEvent?.nextRetryAtMs === 'number' ? transcriptEvent.nextRetryAtMs : null,
  });
}

function buildPendingRuntimeAuthRecoveryProjectionKey(classification: unknown): string {
  const fields = readClassificationProjectionFields(classification);
  return JSON.stringify(fields);
}

function shouldSuppressDuplicateRuntimeAuthRecoveryProjection(input: Readonly<{
  session: ApiSessionClient;
  key: string;
  nowMs: number;
}>): boolean {
  const current = recentRuntimeAuthRecoveryProjectionBySession.get(input.session);
  if (!current) return false;
  if (current.key !== input.key) return false;
  return input.nowMs - current.surfacedAtMs <= RUNTIME_AUTH_RECOVERY_PROJECTION_DEDUPE_WINDOW_MS;
}

function rememberRuntimeAuthRecoveryProjection(input: Readonly<{
  session: ApiSessionClient;
  key: string;
  surfacedAtMs: number;
}>): void {
  recentRuntimeAuthRecoveryProjectionBySession.set(input.session, {
    key: input.key,
    surfacedAtMs: input.surfacedAtMs,
  });
}

type CatalogAcpProviderRuntimeParams<TBackendOptions extends AgentFactoryOptions> = {
  loggerLabel: string;
  directory: string;
  session: ApiSessionClient;
  transcriptSession?: TranscriptSessionPort;
  pushSender?: PermissionRequestPushSender;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  onSessionIdChange?: (nextSessionId: string | null) => void;
  accountSettings?: AccountSettings | null;
  pendingQueueDrainMaxPopPerWake?: number;
  inFlightSteer?: Parameters<typeof createAcpRuntime>[0]['inFlightSteer'];
  hooks?: Parameters<typeof createAcpRuntime>[0]['hooks'];
  memoryRecallGuidance?: Parameters<typeof createAcpRuntime>[0]['memoryRecallGuidance'];
};

export type CatalogBackedAcpProviderRuntimeParams<TBackendOptions extends AgentFactoryOptions> =
  CatalogAcpProviderRuntimeParams<TBackendOptions> & {
    provider: Parameters<typeof createCatalogAcpBackend>[0];
    backendOptions?: Omit<TBackendOptions, 'cwd' | 'mcpServers' | 'permissionHandler' | 'permissionMode' | 'happierSessionId'>;
    getPermissionMode?: () => PermissionMode | null | undefined;
    resolvePermissionMode?: (args: {
      getPermissionMode?: () => PermissionMode | null | undefined;
      session: ApiSessionClient;
    }) => PermissionMode | null | undefined;
    createBackend?: never;
    createReplayBackend?: never;
  };

export type CustomBackedAcpProviderRuntimeParams<TBackendOptions extends AgentFactoryOptions> =
  CatalogAcpProviderRuntimeParams<TBackendOptions> & {
    provider: string;
    backendOptions?: never;
    getPermissionMode?: () => PermissionMode | null | undefined;
    resolvePermissionMode?: (args: {
      getPermissionMode?: () => PermissionMode | null | undefined;
      session: ApiSessionClient;
    }) => PermissionMode | null | undefined;
    createBackend: (args: { permissionMode?: PermissionMode }) => AcpRuntimeBackend | Promise<AcpRuntimeBackend>;
    createReplayBackend?: () => AcpRuntimeBackend | Promise<AcpRuntimeBackend>;
  };

function isCustomBackedAcpProviderRuntimeParams<TBackendOptions extends AgentFactoryOptions>(
  params:
    | CatalogBackedAcpProviderRuntimeParams<TBackendOptions>
    | CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
): params is CustomBackedAcpProviderRuntimeParams<TBackendOptions> {
  return 'createBackend' in params;
}

type CatalogAcpRuntimeBackendCreateResult = Readonly<{ backend: AcpRuntimeBackend }>;

async function createCatalogRuntimeBackend<TBackendOptions extends AgentFactoryOptions>(
  params: CatalogBackedAcpProviderRuntimeParams<TBackendOptions>,
  permissionMode: PermissionMode | undefined,
): Promise<AcpRuntimeBackend> {
  const backendOptions = {
    ...(params.backendOptions ?? {}),
    cwd: params.directory,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    permissionMode,
    happierSessionId: params.session.sessionId,
  } as unknown as TBackendOptions;

  if (isAgentId(params.provider) && hasBuiltInAcpConfig(params.provider)) {
    const runtimeOwners = await loadBuiltInRuntimeOwners(params.provider);
    return runtimeOwners.createRuntime(backendOptions) as AcpRuntimeBackend;
  }

  const created = await createCatalogAcpBackend<TBackendOptions, CatalogAcpRuntimeBackendCreateResult>(
    params.provider,
    backendOptions,
  );
  return created.backend;
}

export function createCatalogProviderAcpRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params: CatalogBackedAcpProviderRuntimeParams<TBackendOptions>,
): ReturnType<typeof createAcpRuntime>;
export function createCatalogProviderAcpRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params: CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
): ReturnType<typeof createAcpRuntime>;
export function createCatalogProviderAcpRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params:
    | CatalogBackedAcpProviderRuntimeParams<TBackendOptions>
    | CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
): ReturnType<typeof createAcpRuntime> {
  const resolveConnectedServiceRuntimeAuthAdapter = async () => {
    if (!isAgentId(params.provider)) return null;
    return await getConnectedServiceRuntimeAuthAdapter(params.provider);
  };
  const sendPermissionPush = (evt: { permissionId: string; toolName: string }): void => {
    if (!params.pushSender) return;
    try {
      sendPermissionRequestPushNotificationForActiveAccount({
        pushSender: params.pushSender,
        sessionId: params.session.sessionId,
        sessionTitle: getSessionNotificationTitle(() => params.session.getMetadataSnapshot?.() ?? null),
        agentDisplayName: isAgentId(params.provider)
          ? getProviderDefinition(params.provider)?.agentCliRuntime.title ?? null
          : null,
        permissionId: evt.permissionId,
        toolName: evt.toolName,
        permissionMode: params.getPermissionMode?.(),
      });
    } catch {
      // best-effort
    }
  };
  const notifyRuntimeAuthFailure = async (evt: {
    provider: string;
    happierSessionId: string | null;
    activeSessionId: string | null;
    classification: unknown;
  }): Promise<unknown> => {
    let delegated: unknown;
    try {
      delegated = await params.hooks?.onRuntimeAuthFailure?.(evt);
    } catch (error) {
      logger.debug(`[${params.loggerLabel}] Runtime auth failure caller hook failed (non-fatal)`, error);
    }
    const sessionId = evt.happierSessionId;
    if (!sessionId) return delegated;
    const pendingKey = buildPendingRuntimeAuthRecoveryProjectionKey(evt.classification);
    const currentPending = pendingRuntimeAuthRecoveryProjectionBySession.get(params.session);
    if (currentPending?.key === pendingKey) {
      return await currentPending.promise;
    }
    const recoveryPromise = (async () => {
      const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId,
        classification: evt.classification,
        logPrefix: `[${params.loggerLabel}]`,
      });
      const projectionKey = buildRuntimeAuthRecoveryProjectionDeduperKey({
        classification: evt.classification,
        recoveryReport,
      });
      const nowMs = Date.now();
      if (shouldSuppressDuplicateRuntimeAuthRecoveryProjection({
        session: params.session,
        key: projectionKey,
        nowMs,
      })) {
        return recoveryReport;
      }
      const projectionResult = projectConnectedServiceRuntimeAuthRecoveryReport({
        report: recoveryReport,
        classification: evt.classification as ConnectedServiceRuntimeFailureClassification,
        addStatusMessage: (message) => {
          params.messageBuffer.addMessage(message, 'status');
        },
        sendGenericStatusMessage: (message) => {
          params.session.sendSessionEvent({ type: 'message', message });
        },
        commitTypedProjection: (projection) => {
          if (!projection.transcriptEvent) return false;
          params.session.sendSessionEvent(projection.transcriptEvent);
          return true;
        },
        commitUsageLimitRecoveryMetadata: (updater) => {
          updateMetadataBestEffort(
            params.session,
            updater,
            `[${params.loggerLabel}]`,
            'runtime_auth_usage_limit_recovery',
          );
          return true;
        },
      });
      if (projectionResult.emitted) {
        rememberRuntimeAuthRecoveryProjection({
          session: params.session,
          key: projectionKey,
          surfacedAtMs: nowMs,
        });
      }
      return recoveryReport;
    })();
    pendingRuntimeAuthRecoveryProjectionBySession.set(params.session, {
      key: pendingKey,
      promise: recoveryPromise,
    });
    try {
      return await recoveryPromise;
    } finally {
      const current = pendingRuntimeAuthRecoveryProjectionBySession.get(params.session);
      if (current?.promise === recoveryPromise) {
        pendingRuntimeAuthRecoveryProjectionBySession.delete(params.session);
      }
    }
  };
  const hooks = params.hooks
    ? {
        ...params.hooks,
        classifyRuntimeAuthFailure: async (evt: { provider: string; happierSessionId: string | null; activeSessionId: string | null; error: unknown }) => {
          const delegated = await params.hooks?.classifyRuntimeAuthFailure?.(evt);
          if (delegated) return delegated;
          const adapter = await resolveConnectedServiceRuntimeAuthAdapter();
          return adapter?.classifyRuntimeAuthFailure({
            target: { agentId: params.provider },
            error: evt.error,
          }) ?? null;
        },
        onRuntimeAuthFailure: async (evt: { provider: string; happierSessionId: string | null; activeSessionId: string | null; classification: unknown }) => {
          return await notifyRuntimeAuthFailure(evt);
        },
        onPermissionRequest: (evt: { permissionId: string; toolName: string; payload: unknown; reason: string }) => {
          try {
            params.hooks?.onPermissionRequest?.(evt);
          } catch {
            // ignore
          }
          sendPermissionPush(evt);
        },
      }
    : {
        classifyRuntimeAuthFailure: async (evt: { provider: string; happierSessionId: string | null; activeSessionId: string | null; error: unknown }) => {
          const adapter = await resolveConnectedServiceRuntimeAuthAdapter();
          return adapter?.classifyRuntimeAuthFailure({
            target: { agentId: params.provider },
            error: evt.error,
          }) ?? null;
        },
        onRuntimeAuthFailure: async (evt: { provider: string; happierSessionId: string | null; activeSessionId: string | null; classification: unknown }) => {
          return await notifyRuntimeAuthFailure(evt);
        },
        onPermissionRequest: (evt: { permissionId: string; toolName: string; payload: unknown; reason: string }) => {
          sendPermissionPush(evt);
        },
      };
  const pendingQueueMaxPopPerWake = params.pendingQueueDrainMaxPopPerWake
    ?? resolveSessionPendingQueueMaxPopPerWake(params.accountSettings ?? null);
  const popPendingMessageThroughSafeOrLegacy = async (): Promise<boolean> => {
    const materializeSafely = params.session.materializeNextPendingMessageSafely;
    if (materializeSafely) {
      return (await materializeSafely({ reconcileWhenEmpty: 'force' })).type === 'materialized';
    }
    return await params.session.popPendingMessage();
  };

  return createAcpRuntime({
    provider: params.provider,
    directory: params.directory,
    happierSessionId: params.session.sessionId,
    session: params.session,
    transcriptSession: params.transcriptSession,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    hooks,
    inFlightSteer: params.inFlightSteer,
    memoryRecallGuidance: params.memoryRecallGuidance,
    pendingQueue: {
      drainAfterStartOrLoad: true,
      maxPopPerWake: pendingQueueMaxPopPerWake,
      waitForMetadataUpdate: (signal) => params.session.waitForMetadataUpdate(signal),
      popPendingMessage: popPendingMessageThroughSafeOrLegacy,
      inputConsumer: createSessionProviderPendingDrainAdapter({
        waitForMetadataUpdate: (signal) => params.session.waitForMetadataUpdate(signal),
        getMetadataSnapshot: () => params.session.getMetadataSnapshot(),
        materializeNextPendingMessageSafely: params.session.materializeNextPendingMessageSafely
          ? (materializeOpts) => params.session.materializeNextPendingMessageSafely?.(materializeOpts) ?? Promise.resolve({ type: 'no_pending' as const })
          : undefined,
        popPendingMessage: popPendingMessageThroughSafeOrLegacy,
        shouldAttemptPendingMaterialization: () => params.session.shouldAttemptPendingMaterialization?.() ?? true,
        reconcilePendingQueueState: params.session.reconcilePendingQueueState
          ? async (opts) => {
              await params.session.reconcilePendingQueueState?.(opts);
            }
          : undefined,
      }, { maxPopPerWake: pendingQueueMaxPopPerWake }),
      shouldAttemptMaterialization: () => params.session.shouldAttemptPendingMaterialization?.() ?? true,
      reconcilePendingQueueState: params.session.reconcilePendingQueueState
        ? async (opts) => {
            await params.session.reconcilePendingQueueState?.(opts);
          }
        : undefined,
    },
    ensureBackend: async () => {
      const permissionModeRaw = params.resolvePermissionMode
        ? params.resolvePermissionMode({
            getPermissionMode: params.getPermissionMode,
            session: params.session,
          })
        : params.getPermissionMode?.();
      const permissionMode = typeof permissionModeRaw === 'string' ? permissionModeRaw : undefined;

      if (isCustomBackedAcpProviderRuntimeParams(params)) {
        const created = await params.createBackend(permissionMode ? { permissionMode } : {});
        logger.debug(`[${params.loggerLabel}] Backend created`);
        return created;
      }

      const created = await createCatalogRuntimeBackend(params, permissionMode);
      logger.debug(`[${params.loggerLabel}] Backend created`);
      return created;
    },
    ...(isCustomBackedAcpProviderRuntimeParams(params)
      ? {
          createReplayBackend: async () => {
            if (params.createReplayBackend) {
              return await params.createReplayBackend();
            }
            return await params.createBackend({});
          },
        }
      : {}),
    onSessionIdChange: params.onSessionIdChange,
  });
}
