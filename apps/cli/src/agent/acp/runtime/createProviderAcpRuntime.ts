import { getAgentCliRuntimeSpec, isAgentId } from '@happier-dev/agents';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createAcpRuntime, type AcpRuntimeBackend } from '@/agent/acp/runtime/createAcpRuntime';
import type { RuntimeTurnSessionOpenIntent } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { McpServerConfig } from '@/agent';
import type { AgentFactoryOptions } from '@/agent/catalog/factoryOptions';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import {
  sendPermissionRequestPushNotificationForActiveAccount,
  type PermissionRequestPushSender,
} from '@/settings/notifications/permissionRequestPush';
import { getConnectedServiceRuntimeAuthAdapter } from '@/daemon/connectedServices/catalogHooks';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import { hasConnectedServiceRuntimeAuthRecoveryContext } from '@/agent/runtime/session/errors/connectedServiceRuntimeAuthRecoveryContext';

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

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRecoveryActionKind(value: unknown): string | null {
  const action = readRecord(value);
  const kind = readString(action?.kind);
  return kind === 'provider_state_sharing_required' || kind === 'quota_recovery_required'
    ? kind
    : null;
}

function readClassificationStableProjectionIdentity(classification: unknown): Readonly<{
  kind: string | null;
  serviceId: string | null;
  profileId: string | null;
  groupId: string | null;
  limitCategory: string | null;
  providerLimitId: string | null;
  recoveryActionKind: string | null;
  resetsAtMsBucket: number | null;
}> {
  const record = readRecord(classification);
  if (!record) {
    return {
      kind: null,
      serviceId: null,
      profileId: null,
      groupId: null,
      limitCategory: null,
      providerLimitId: null,
      recoveryActionKind: null,
      resetsAtMsBucket: null,
    };
  }
  const resetsAtMs = typeof record.resetsAtMs === 'number' && Number.isFinite(record.resetsAtMs)
    ? Math.floor(record.resetsAtMs / 60_000)
    : null;
  return {
    kind: readString(record.kind),
    serviceId: readString(record.serviceId),
    profileId: readString(record.profileId),
    groupId: readString(record.groupId),
    limitCategory: readString(record.limitCategory),
    providerLimitId: readString(record.providerLimitId),
    recoveryActionKind: readRecoveryActionKind(record.recoveryAction),
    resetsAtMsBucket: resetsAtMs,
  };
}

function buildRuntimeAuthRecoveryProjectionDeduperKey(input: Readonly<{
  classification: unknown;
  recoveryReport: Awaited<ReturnType<typeof reportConnectedServiceRuntimeAuthFailureToDaemon>>;
}>): string {
  const transcriptEvent = input.recoveryReport.projection?.transcriptEvent as
    | Readonly<Record<string, unknown>>
    | undefined;
  const classification = readClassificationStableProjectionIdentity(input.classification);
  return JSON.stringify({
    statusCode: input.recoveryReport.statusCode ?? null,
    ...classification,
    transcriptStatus: typeof transcriptEvent?.status === 'string' ? transcriptEvent.status : null,
  });
}

function buildPendingRuntimeAuthRecoveryProjectionKey(classification: unknown): string {
  return JSON.stringify(readClassificationStableProjectionIdentity(classification));
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
  transcriptProvider?: string;
  directory: string;
  session: ApiSessionClient;
  transcriptSession?: TranscriptSessionPort;
  pushSender?: PermissionRequestPushSender;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  sessionOpenIntent?: RuntimeTurnSessionOpenIntent;
  onSessionIdChange?: (nextSessionId: string | null) => void;
  inFlightSteer?: Parameters<typeof createAcpRuntime>[0]['inFlightSteer'];
  hooks?: Parameters<typeof createAcpRuntime>[0]['hooks'];
  memoryRecallGuidance?: Parameters<typeof createAcpRuntime>[0]['memoryRecallGuidance'];
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

export function createCatalogProviderAcpRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params: CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
): ReturnType<typeof createAcpRuntime>;
export function createCatalogProviderAcpRuntime<TBackendOptions extends AgentFactoryOptions = AgentFactoryOptions>(
  params: CustomBackedAcpProviderRuntimeParams<TBackendOptions>,
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
          ? getAgentCliRuntimeSpec(params.provider).title
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
    if (!hasConnectedServiceRuntimeAuthRecoveryContext(evt.classification)) {
      return delegated;
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
  return createAcpRuntime({
    provider: params.provider,
    ...(params.transcriptProvider ? { transcriptProvider: params.transcriptProvider } : {}),
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
    ensureBackend: async () => {
      const permissionModeRaw = params.resolvePermissionMode
        ? params.resolvePermissionMode({
            getPermissionMode: params.getPermissionMode,
            session: params.session,
          })
        : params.getPermissionMode?.();
      const permissionMode = typeof permissionModeRaw === 'string' ? permissionModeRaw : undefined;

      const created = await params.createBackend(permissionMode ? { permissionMode } : {});
      logger.debug(`[${params.loggerLabel}] Backend created`);
      return created;
    },
    ...(params.sessionOpenIntent ? { sessionOpenIntent: params.sessionOpenIntent } : {}),
    createReplayBackend: async () => (
      params.createReplayBackend
        ? await params.createReplayBackend()
        : await params.createBackend({})
    ),
    onSessionIdChange: params.onSessionIdChange,
  });
}
