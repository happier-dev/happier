import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1,
  EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
  ExternalSessionOperationActionResponseV1Schema,
  type ActionExecuteResult,
  type ActionId,
  type ExternalSessionTranscriptInvalidationV1,
  PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID,
} from '@happier-dev/protocol';

import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { writeExternalSessionFollowStatus } from '@/api/session/external/backgroundFollow/externalSessionBackgroundFollowMetadata';
import { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { applyExternalSessionStatusDemandBatch } from '@/api/session/external/leases/applyExternalSessionStatusDemandBatch';
import {
  startExternalSessionPassiveObservation,
} from '@/api/session/external/leases/startExternalSessionPassiveObservation';
import {
  bindExternalSessionStatusDemand,
  type ExternalSessionStatusDemandChannel,
} from '@/daemon/machine/externalSessionStatusDemandBinding';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import {
  externalSessionsError,
  executeExternalSessionAttachAction,
  executeExternalSessionCandidatesListAction,
  executeExternalSessionDetachAction,
  executeExternalSessionFollowPolicySetAction,
  executeExternalSessionLinkEnsureAction,
  executeExternalSessionStatusGetAction,
  executeExternalSessionTakeoverAction,
  executeExternalSessionTranscriptPageAction,
  executeExternalSessionTranscriptReadAfterAction,
  internalErrorResponse,
  mapActionFailureToExternalSessionsError,
  type ExternalSessionActionContext,
} from '@/session/actions/externalSessions';

import {
  registerLegacyDirectSessionLinkEnsureWireAlias,
  registerLegacyDirectSessionTakeoverWireAliases,
} from './legacyDirectSessionWireAliases';
import { mapCanonicalExternalSessionResponseToLegacyDirectSession } from './legacyDirectSessionResponseCompatibility';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import {
  resolveExternalTakeoverSpawnOptions,
  spawnResolvedExternalTakeoverSession,
} from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';
import { configuration } from '@/configuration';
import {
  createExternalSessionOperationExclusion,
  type ExternalSessionOperationExclusionOwner,
} from '@/session/external/operationExclusion';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  executeExternalSessionImportActivation,
  isExternalSessionHostedAdmissionAvailable,
} from '@/session/actions/externalSessions/importActivationFence';
import {
  createDefaultExternalSessionMaterializeActionExecutor,
} from '@/session/actions/externalSessions/materializeDefault';
import {
  createDefaultExternalSessionMaterializeStartActionExecutor,
  type ExternalSessionMaterializeStartActionExecutor,
} from '@/session/actions/externalSessions/materializeStartAction';
import type {
  ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import {
  publishExternalSessionOperationProgress,
  repairExternalSessionOperationProgressProjections,
  resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs,
} from '@/session/actions/externalSessions/operationProgressPublisher';
import {
  createDefaultExternalSessionTakeoverStartActionExecutor,
  type ExternalSessionTakeoverStartActionExecutor,
} from '@/session/actions/externalSessions/takeoverStartAction';
import {
  createExternalSessionTakeoverAdmissionActionExecutor,
  isExternalSessionPersistedTakeoverAdmissionReady,
  type ExternalSessionTakeoverAdmissionActionExecutor,
} from '@/session/actions/externalSessions/takeoverAdmissionAction';
import {
  createExternalSessionPersistedTakeoverAdmissionOwner,
  type ExternalSessionPersistedTakeoverAdmissionOwner,
} from '@/session/actions/externalSessions/persistedTakeoverAdmission';
import type { PersistedTakeoverAdmissionWaiter } from '@/daemon/spawn/persistedTakeoverAdmission';
import {
  abandonExternalSessionOperationsForDeletedSession,
  readExternalSessionOperationRecord,
  type ExternalSessionOperationAccountScope,
} from '@/session/actions/externalSessions/operationRecordStore';
import type { ExternalSessionMaterializeActionExecutor } from '@/session/actions/externalSessions/materializeAction';
import {
  createExternalSessionExternalLinkedTakeoverPhaseRunner,
  createExternalSessionPersistedTakeoverPhaseRunner,
  createExternalSessionPersistedTakeoverPreparation,
  loadCurrentExternalSessionExternalLinkedTakeoverSource,
  type ExternalSessionExternalLinkedTakeoverPhaseRunner,
  type ExternalSessionPersistedTakeoverPhaseRunner,
} from '@/session/actions/externalSessions/takeoverPhaseRunner';
import { randomUUID } from 'node:crypto';
import {
  createExternalSessionFollowHostOperation,
} from '@/session/external/followHostOperation';
import {
  createExternalSessionFollowTargetHostOperation,
} from '@/session/external/followTargetHostOperation';
import type {
  ExternalSessionHostOperationInstallation,
  ExternalSessionHostOperationSet,
} from '@/session/external/hostOperationOwner';
import {
  createPluginSessionHookManagementActionExecutor,
  type PluginSessionHookManagementActionExecutor,
  type PluginSessionHookManagementActionId,
  type PluginSessionHookManagementHost,
} from '@/session/actions/externalSessions/pluginSessionHookManagementActionExecutor';
import {
  createPluginSessionHookManagementHost,
  type PluginSessionHookManagementDaemonHost,
} from '@/session/actions/externalSessions/pluginSessionHookManagementHost';
import {
  createQualifiedExternalSessionHookDaemonIngress,
} from '@/plugins/runtime/hooks/session/qualifiedExternalSessionHookDaemonIngress';
import {
  startQualifiedExternalSessionHookListener,
  type QualifiedExternalSessionHookListener,
} from '@/plugins/runtime/hooks/session/qualifiedExternalSessionHookTransport';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { logExternalSessionsInternalError } from '@/session/actions/externalSessions/responseErrors';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';

export type ExternalSessionArchivedStateChange = Readonly<{
  sessionId: string;
  archived: boolean;
}>;

export type ExternalSessionDeletedChange = Readonly<{
  sessionId: string;
  cursor: number;
  /**
   * Pinned scope of the authenticated Account whose authoritative changes
   * feed delivered the deletion fact. Cleanup must target exactly this
   * Account's operation partition even if the ambient credentials rotate
   * before the listener runs.
   */
  accountScope: ExternalSessionOperationAccountScope;
}>;

function unsupportedExternalSessionAction(actionId: ActionId): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'unsupported_action',
    error: `unsupported_action:${actionId}`,
  };
}

export async function executeExternalSessionOperationContinuation(input: Readonly<{
  actionId:
    | 'sessions.external.operation.resume'
    | 'sessions.external.operation.retry'
    | 'sessions.external.operation.cancel';
  raw: unknown;
  record: Awaited<ReturnType<typeof readExternalSessionOperationRecord>>;
  materialize: ExternalSessionMaterializeActionExecutor | null;
  takeoverPhaseRunner: ExternalSessionPersistedTakeoverPhaseRunner | null;
  externalLinkedTakeoverPhaseRunner:
    ExternalSessionExternalLinkedTakeoverPhaseRunner | null;
  takeoverAdmission: ExternalSessionTakeoverAdmissionActionExecutor | null;
}>): Promise<ActionExecuteResult> {
  if (input.record?.request.plan === 'takeover') {
    if (input.record.request.targetStorageMode === 'external-linked') {
      if (!input.externalLinkedTakeoverPhaseRunner) {
        return unsupportedExternalSessionAction(input.actionId);
      }
      return {
        ok: true,
        result: input.actionId === 'sessions.external.operation.retry'
          ? await input.externalLinkedTakeoverPhaseRunner.retry(input.raw)
          : input.actionId === 'sessions.external.operation.cancel'
            ? await input.externalLinkedTakeoverPhaseRunner.cancel(input.raw)
            : await input.externalLinkedTakeoverPhaseRunner.resume(input.raw),
      };
    }
    if (input.actionId === 'sessions.external.operation.cancel') {
      return input.materialize
        ? { ok: true, result: await input.materialize.cancel(input.raw) }
        : unsupportedExternalSessionAction(input.actionId);
    }
    if (
      input.takeoverAdmission
      && isExternalSessionPersistedTakeoverAdmissionReady(input.record)
    ) {
      return {
        ok: true,
        result: input.actionId === 'sessions.external.operation.retry'
          ? await input.takeoverAdmission.retry(input.raw)
          : await input.takeoverAdmission.resume(input.raw),
      };
    }
    if (input.actionId === 'sessions.external.operation.resume') {
      return input.takeoverPhaseRunner
        ? {
          ok: true,
          result: await input.takeoverPhaseRunner.resume(input.raw),
        }
        : unsupportedExternalSessionAction(input.actionId);
    }
    return {
      ok: true,
      result: {
        ok: false,
        error: {
          code: 'not_allowed',
          message: 'Persisted takeover phase recovery requires explicit Resume.',
        },
      },
    };
  }
  if (!input.materialize) {
    return unsupportedExternalSessionAction(input.actionId);
  }
  return {
    ok: true,
    result: input.actionId === 'sessions.external.operation.resume'
      ? await input.materialize.resume(input.raw)
      : input.actionId === 'sessions.external.operation.retry'
        ? await input.materialize.retry(input.raw)
        : await input.materialize.cancel(input.raw),
  };
}

export function resolveExternalSessionOperationRequiredPublicationFenceVersion(
  actionId: ActionId,
  record: Awaited<ReturnType<typeof readExternalSessionOperationRecord>>,
): number | undefined {
  if (
    actionId !== 'sessions.external.operation.resume'
    && actionId !== 'sessions.external.operation.retry'
  ) {
    return undefined;
  }
  if (!record) return undefined;
  if (record.request.plan !== 'takeover') {
    return EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1;
  }
  return record.request.targetStorageMode === 'persisted'
    ? EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3
    : undefined;
}

export function createExternalSessionRpcActionExecutor(
  context: ExternalSessionActionContext,
  materialize: ExternalSessionMaterializeActionExecutor | null,
  materializeStart: ExternalSessionMaterializeStartActionExecutor | null,
  takeoverStart: ExternalSessionTakeoverStartActionExecutor,
  takeoverPhaseRunner: ExternalSessionPersistedTakeoverPhaseRunner | null,
  externalLinkedTakeoverPhaseRunner:
    ExternalSessionExternalLinkedTakeoverPhaseRunner | null,
  takeoverAdmission: ExternalSessionTakeoverAdmissionActionExecutor | null,
  sessionHooks: PluginSessionHookManagementActionExecutor | null,
): RpcActionExecutor {
  const readTakeoverOperation = async (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const operationId = (input as Readonly<Record<string, unknown>>).operationId;
    if (typeof operationId !== 'string' || !operationId.trim()) return false;
    const record = await readExternalSessionOperationRecord(
      configuration.activeServerDir,
      operationId,
    );
    return record?.request.plan === 'takeover' ? record : null;
  };
  return {
    execute: async (actionId, input, executionContext) => {
      switch (actionId) {
        case 'sessions.external.follow':
          return { ok: true, result: await executeExternalSessionAttachAction(input, context) };
        case 'sessions.external.unfollow':
          return { ok: true, result: await executeExternalSessionDetachAction(input, context) };
        case 'sessions.external.backgroundFollow.set':
          return { ok: true, result: await executeExternalSessionFollowPolicySetAction(input, context) };
        case 'sessions.external.candidates.list':
          return {
            ok: true,
            result: await executeExternalSessionCandidatesListAction(
              input,
              executionContext?.signal
                ? { signal: executionContext.signal }
                : undefined,
            ),
          };
        case 'sessions.external.link.ensure':
          return {
            ok: true,
            result: await executeExternalSessionLinkEnsureAction(
              input,
              executionContext?.signal
                ? { signal: executionContext.signal }
                : undefined,
            ),
          };
        case 'sessions.external.status.get':
          return { ok: true, result: await executeExternalSessionStatusGetAction(input, context) };
        case 'sessions.external.transcript.page':
          return { ok: true, result: await executeExternalSessionTranscriptPageAction(input, context) };
        case 'sessions.external.transcript.readAfter':
          return { ok: true, result: await executeExternalSessionTranscriptReadAfterAction(input, context) };
        case 'sessions.external.takeover':
          return { ok: true, result: await executeExternalSessionTakeoverAction(input, context) };
        case 'sessions.external.takeover.start':
          return {
            ok: true,
            result: await takeoverStart.start(
              input,
              executionContext?.signal
                ? { signal: executionContext.signal }
                : undefined,
            ),
          };
        case 'sessions.external.materialize.start':
          return materializeStart
            ? {
              ok: true,
              result: await materializeStart.start(
                input,
                executionContext?.signal
                  ? { signal: executionContext.signal }
                  : undefined,
              ),
            }
            : unsupportedExternalSessionAction(actionId);
        case 'sessions.external.operation.status.get':
          return materialize
            ? { ok: true, result: await materialize.status(input) }
            : unsupportedExternalSessionAction(actionId);
        case 'sessions.external.operation.cancel':
          return await executeExternalSessionOperationContinuation({
            actionId,
            raw: input,
            record: await readTakeoverOperation(input) || null,
            materialize,
            takeoverPhaseRunner,
            externalLinkedTakeoverPhaseRunner,
            takeoverAdmission,
          });
        case 'sessions.external.operation.resume':
          return await executeExternalSessionOperationContinuation({
            actionId,
            raw: input,
            record: await readTakeoverOperation(input) || null,
            materialize,
            takeoverPhaseRunner,
            externalLinkedTakeoverPhaseRunner,
            takeoverAdmission,
          });
        case 'sessions.external.operation.retry':
          return await executeExternalSessionOperationContinuation({
            actionId,
            raw: input,
            record: await readTakeoverOperation(input) || null,
            materialize,
            takeoverPhaseRunner,
            externalLinkedTakeoverPhaseRunner,
            takeoverAdmission,
          });
        case 'sessions.external.operation.discard':
          return materialize
            ? { ok: true, result: await materialize.discard(input) }
            : unsupportedExternalSessionAction(actionId);
        case 'plugins.sessionHooks.status.get':
        case 'plugins.sessionHooks.install':
        case 'plugins.sessionHooks.disable':
        case 'plugins.sessionHooks.enable':
        case 'plugins.sessionHooks.uninstall':
          return sessionHooks
            ? await sessionHooks.execute(
              actionId as PluginSessionHookManagementActionId,
              input,
            )
            : unsupportedExternalSessionAction(actionId);
        default:
          return unsupportedExternalSessionAction(actionId);
      }
    },
  };
}

function readExternalSessionGenericFailure(actionId: ActionId): string {
  switch (actionId) {
    case 'sessions.external.candidates.list':
      return 'external_sessions_candidates_list_failed';
    case 'sessions.external.link.ensure':
      return 'external_session_link_ensure_failed';
    case 'sessions.external.follow':
      return 'external_session_attach_failed';
    case 'sessions.external.unfollow':
      return 'external_session_detach_failed';
    case 'sessions.external.backgroundFollow.set':
      return 'follow_policy_set_failed';
    case 'sessions.external.status.get':
      return 'external_session_status_get_failed';
    case 'sessions.external.transcript.page':
      return 'external_session_transcript_page_failed';
    case 'sessions.external.transcript.readAfter':
      return 'external_session_transcript_read_after_failed';
    default:
      return 'external_session_action_failed';
  }
}

const EXTERNAL_SESSION_DURABLE_OPERATION_ACTION_IDS = new Set<ActionId>([
  'sessions.external.materialize.start',
  'sessions.external.takeover.start',
  'sessions.external.operation.status.get',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
]);

function isExternalSessionDurableOperationAction(
  actionId: ActionId,
): boolean {
  return EXTERNAL_SESSION_DURABLE_OPERATION_ACTION_IDS.has(actionId);
}

function internalExternalSessionOperationActionFailure(): ActionExecuteResult {
  return {
    ok: true,
    result: {
      ok: false,
      error: {
        code: 'internal_error',
        message: 'External session operation failed.',
      },
    },
  };
}

function mapExternalSessionDurableOperationActionResult(
  result: ActionExecuteResult,
): ActionExecuteResult {
  if (!result.ok) return internalExternalSessionOperationActionFailure();
  const parsed = ExternalSessionOperationActionResponseV1Schema.safeParse(
    result.result,
  );
  return parsed.success
    ? { ok: true, result: parsed.data }
    : internalExternalSessionOperationActionFailure();
}

function createExternalSessionGenericRpcActionExecutor(
  executor: RpcActionExecutor,
): RpcActionExecutor {
  return {
    execute: async (actionId, input, context) => {
      try {
        const result = await executor.execute(actionId, input, context);
        if (isExternalSessionDurableOperationAction(actionId)) {
          return mapExternalSessionDurableOperationActionResult(result);
        }
        if (result.ok) {
          return result;
        }
        return {
          ok: true,
          result: mapActionFailureToExternalSessionsError(result),
        };
      } catch (error) {
        if (isExternalSessionDurableOperationAction(actionId)) {
          return internalExternalSessionOperationActionFailure();
        }
        return {
          ok: true,
          result: internalErrorResponse(
            `external_session_generic.${actionId}`,
            error,
            readExternalSessionGenericFailure(actionId),
          ),
        };
      }
    },
  };
}

export function registerMachineExternalSessionsRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  operationExclusion?: ExternalSessionOperationExclusionOwner;
  spawnSession?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession?: (sessionId: string) => Promise<boolean>;
  emitExternalSessionTranscriptUpdate?: (payload: ExternalSessionTranscriptInvalidationV1) => void | Promise<void>;
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  transientMediaReadAllowance?: ExternalSessionActionContext['transientMediaReadAllowance'];
  actionExecutor?: RpcActionExecutor;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  machineId?: string;
  executeExternalSessionHistoricalImportCommand?: Parameters<
    typeof createDefaultExternalSessionMaterializeActionExecutor
  >[0]['sendHistoricalCommand'];
  persistedTakeoverAdmissionWaiter?: PersistedTakeoverAdmissionWaiter;
  attachPersistedTakeoverAdmissionOwner?: (
    owner: ExternalSessionPersistedTakeoverAdmissionOwner,
  ) => () => void;
  installExternalSessionHostOperations?: (
    operations: ExternalSessionHostOperationSet,
  ) => Promise<ExternalSessionHostOperationInstallation>;
  statusDemand?: Readonly<{
    channel: ExternalSessionStatusDemandChannel;
    machineId: string;
    subscribeConnectedAccountInvalidations?: (listener: () => void) => () => void;
  }>;
  startPassiveObservation?: typeof startExternalSessionPassiveObservation;
  subscribeSessionArchivedStateChanges?: (
    listener: (
      change: ExternalSessionArchivedStateChange,
    ) => void | Promise<void>,
  ) => () => void;
  subscribeSessionDeletedChanges?: (
    listener: (change: ExternalSessionDeletedChange) => void | Promise<void>,
  ) => () => void;
}>): Readonly<{
  pluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  /**
   * The exact fenced RPC executor also owns host-stamped external Action
   * dispatch. It is exposed as one owner rather than rebuilding an Action
   * switch at the public HTTP boundary.
   */
  hostExternalSessionActionExecutor: RpcActionExecutor;
  connectivityResource?: Readonly<{
    name: string;
    pause(): void | Promise<void>;
    resume(): void | Promise<void>;
  }>;
  dispose(): Promise<void>;
}> {
  const { rpcHandlerManager, emitExternalSessionTranscriptUpdate } = params;
  const followLeaseManager = createExternalSessionFollowLeaseManager({
    writeFollowStatus: writeExternalSessionFollowStatus,
  });
  const observationProjection = createExternalSessionObservationDaemonProjection({
    shouldSendReadyNotification: (sessionId) =>
      followLeaseManager.isBackgroundFollowEnabled(sessionId)
      && followLeaseManager.countActiveLeases(sessionId) === 0,
    requestTranscriptRefresh: async (input) =>
      await followLeaseManager.requestTranscriptRefresh(input),
    isTranscriptRefreshDemanded: (input) =>
      followLeaseManager.hasTranscriptDemand(input),
  });
  const statusDemand = params.statusDemand;
  const statusDemandBinding = statusDemand
    ? bindExternalSessionStatusDemand({
      channel: statusDemand.channel,
      machineId: statusDemand.machineId,
      onDemandChanges: async (changes) => {
        const result = await applyExternalSessionStatusDemandBatch({
          machineId: statusDemand.machineId,
          changes,
          projection: observationProjection,
        });
        if (result.state === 'retryable-failure') {
          throw new Error(
            `External-session status demand reconciliation failed during ${result.phase}`,
          );
        }
      },
    })
    : null;
  const passiveObservation = statusDemand
    ? (params.startPassiveObservation ?? startExternalSessionPassiveObservation)({
      machineId: statusDemand.machineId,
      projection: observationProjection,
      followLeaseManager,
      startPaused: true,
      ...(statusDemand.subscribeConnectedAccountInvalidations
        ? {
            subscribeConnectedAccountInvalidations:
              statusDemand.subscribeConnectedAccountInvalidations,
          }
        : {}),
      reconcileSharedCredentialDemand: async () => {
        await statusDemandBinding?.reconcileCredentialInvalidation();
      },
    })
    : null;
  const operationExclusion = params.operationExclusion
    ?? createExternalSessionOperationExclusion({
      activeServerDir: configuration.activeServerDir,
      ownerId: `cli-daemon:${process.pid}:external-session-operations:${randomUUID()}`,
      claimMutationLockAcquisitionTimeoutMs:
        resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs(),
    });
  const resolveSessionHookFeatureDecision = () => resolveCliFeatureDecision({
    featureId: PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID,
    env: process.env,
    serverSnapshot: params.getServerFeaturesSnapshot?.(),
  });
  let sessionHookHost: PluginSessionHookManagementDaemonHost | null = null;
  let sessionHookListener: Promise<QualifiedExternalSessionHookListener> | null = null;
  let sessionHookTransition: Promise<PluginSessionHookManagementDaemonHost | null>
    = Promise.resolve(null);
  let sessionHookLifecycleDisposed = false;
  const reconcileSessionHookLifecycle =
    (): Promise<PluginSessionHookManagementDaemonHost | null> => {
      sessionHookTransition = sessionHookTransition
        .catch(() => null)
        .then(async () => {
        const enabled = !sessionHookLifecycleDisposed
          && params.machineId !== undefined
          && resolveSessionHookFeatureDecision().state === 'enabled';
        if (!enabled) {
          const priorHost = sessionHookHost;
          const priorListener = sessionHookListener;
          sessionHookHost = null;
          sessionHookListener = null;
          await priorHost?.dispose();
          await priorListener?.then(
            async (listener) => await listener.stop(),
            () => undefined,
          );
          return null;
        }
        if (sessionHookHost) return sessionHookHost;
        let expectedHost:
          PluginSessionHookManagementDaemonHost | null = null;
        let expectedListener:
          Promise<QualifiedExternalSessionHookListener> | null = null;
        const ingress = createQualifiedExternalSessionHookDaemonIngress({
          machineId: params.machineId!,
          projection: observationProjection,
          isFeatureEnabled: () =>
            resolveSessionHookFeatureDecision().state === 'enabled',
          shouldCommit: () => (
            !sessionHookLifecycleDisposed
            && expectedHost !== null
            && expectedListener !== null
            && sessionHookHost === expectedHost
            && sessionHookListener === expectedListener
          ),
        });
        const listener = startQualifiedExternalSessionHookListener({
          activeServerDir: configuration.activeServerDir,
          ingress,
        });
        const host = createPluginSessionHookManagementHost({
          machineId: params.machineId!,
          listener,
          activeServerDir: configuration.activeServerDir,
          isFeatureEnabled: () =>
            resolveSessionHookFeatureDecision().state === 'enabled',
        });
        expectedListener = listener;
        expectedHost = host;
        sessionHookListener = listener;
        sessionHookHost = host;
        try {
          await host.hydrate();
        } catch (error) {
          // Listener startup gates active monitoring hydration, not the host's
          // durable passive-status and exact-custody cleanup operations. Keep
          // this same host available when its listener is conclusively absent;
          // Install and Enable already return listener_unavailable at the host
          // boundary, while Uninstall can revoke durable credentials directly.
          const listenerUnavailable = await listener.then(
            () => false,
            () => true,
          );
          if (listenerUnavailable) return host;
          if (
            sessionHookHost === host
            && sessionHookListener === listener
          ) {
            sessionHookHost = null;
            sessionHookListener = null;
          }
          await host.dispose().catch(() => undefined);
          await listener.then(
            async (started) => await started.stop(),
            () => undefined,
          );
          throw error;
        }
        return host;
      });
      return sessionHookTransition;
    };
  const readSessionHookFeatureDecision = () => {
    const decision = resolveSessionHookFeatureDecision();
    if (decision.state !== 'enabled') {
      void reconcileSessionHookLifecycle().catch(() => undefined);
    }
    return decision;
  };
  const sessionHookHostProxy: PluginSessionHookManagementHost = {
    status: async (target) => {
      const host = await reconcileSessionHookLifecycle();
      return host
        ? await host.status(target)
        : {
            ok: false,
            diagnostic: { code: 'listener_unavailable', retryable: true },
          };
    },
    install: async (target) => {
      const host = await reconcileSessionHookLifecycle();
      return host
        ? await host.install(target)
        : {
            ok: false,
            diagnostic: { code: 'listener_unavailable', retryable: true },
          };
    },
    disable: async (target) => {
      const host = await reconcileSessionHookLifecycle();
      return host
        ? await host.disable(target)
        : {
            ok: false,
            diagnostic: { code: 'listener_unavailable', retryable: true },
          };
    },
    enable: async (target) => {
      const host = await reconcileSessionHookLifecycle();
      return host
        ? await host.enable(target)
        : {
            ok: false,
            diagnostic: { code: 'listener_unavailable', retryable: true },
          };
    },
    uninstall: async (target) => {
      const host = await reconcileSessionHookLifecycle();
      return host
        ? await host.uninstall(target)
        : {
            ok: false,
            diagnostic: { code: 'listener_unavailable', retryable: true },
          };
    },
  };
  const unsubscribeSessionHookHydration = params.machineId
    ? pluginReloadController.subscribe(() => {
      void reconcileSessionHookLifecycle()
        .then(async (host) => {
          await host?.hydrate({ reason: 'plugin_reload' });
        })
        .catch(() => undefined);
    })
    : null;
  if (params.machineId) {
    void reconcileSessionHookLifecycle().catch(() => undefined);
  }
  const pauseArchivedSession = async (sessionId: string): Promise<void> => {
    if (passiveObservation) {
      await passiveObservation.releaseSession(sessionId);
      return;
    }
    const hasManagerDemand =
      followLeaseManager.isBackgroundFollowEnabled(sessionId)
      || followLeaseManager.countActiveLeases(sessionId) > 0
      || followLeaseManager.hasBackgroundFollowLease(sessionId);
    if (!hasManagerDemand) return;
    await followLeaseManager.archiveSession({
      sessionId,
    });
  };
  const resumeArchivedSession = async (sessionId: string): Promise<void> => {
    if (passiveObservation) {
      await passiveObservation.reconcileSession(sessionId);
      return;
    }
    const archived = await followLeaseManager.archiveSession({ sessionId });
    if (!archived.releaseSettled) return;
    await followLeaseManager.resumeSession({
      sessionId,
      reason: 'session_archived',
    });
  };
  const archiveStateTransitions = new Set<Promise<void>>();
  const unregisterSessionArchivedStateChanges =
    params.subscribeSessionArchivedStateChanges?.((change) => {
      let tracked: Promise<void>;
      tracked = (
        change.archived
          ? pauseArchivedSession(change.sessionId)
          : resumeArchivedSession(change.sessionId)
      )
        .then(() => undefined)
        .catch((error) => {
          logExternalSessionsInternalError(
            'external_session.archive_state_reconcile',
            error,
          );
        })
        .finally(() => {
          archiveStateTransitions.delete(tracked);
        });
      archiveStateTransitions.add(tracked);
      return tracked;
    }) ?? (() => {});

  const publishExternalSessionOperationProgressForServer = (
    input: Omit<
      Parameters<typeof publishExternalSessionOperationProgress>[0],
      'activeServerDir'
    >,
  ) => publishExternalSessionOperationProgress({
    ...input,
    activeServerDir: configuration.activeServerDir,
  });
  const externalSessionActionContext: ExternalSessionActionContext = {
    followLeaseManager,
    operationExclusion,
    operationProgress: {
      activeServerDir: configuration.activeServerDir,
      publish: async (input) => {
        await publishExternalSessionOperationProgressForServer(input);
      },
    },
    observationProjection,
    ...(passiveObservation
      ? {
          reconcilePassiveFollowSession: (sessionId: string) =>
            passiveObservation.reconcileSession(sessionId),
        }
      : {}),
    ...(params.getServerFeaturesSnapshot
      ? { getServerFeaturesSnapshot: params.getServerFeaturesSnapshot }
      : {}),
    ...(params.deviceLocalSecretStorage
      ? { deviceLocalSecretStorage: params.deviceLocalSecretStorage }
      : {}),
    emitExternalSessionTranscriptUpdate,
    transientMediaReadAllowance: params.transientMediaReadAllowance,
    spawnSession: params.spawnSession,
    stopSession: params.stopSession,
  };
  const materializeActionExecutor = params.executeExternalSessionHistoricalImportCommand
    ? createDefaultExternalSessionMaterializeActionExecutor({
      activeServerDir: configuration.activeServerDir,
      operationExclusion,
      sendHistoricalCommand: params.executeExternalSessionHistoricalImportCommand,
      preparePersistedTakeover:
        createExternalSessionPersistedTakeoverPreparation({
          followLeaseManager,
        }),
    })
    : null;
  const abandonOperationsForDeletedSession = async (
    change: ExternalSessionDeletedChange,
  ): Promise<void> => {
    const result = await abandonExternalSessionOperationsForDeletedSession({
      activeServerDir: configuration.activeServerDir,
      sessionId: change.sessionId,
      accountScope: change.accountScope,
      withSessionOperationBarrier:
        operationExclusion.withPassiveRepairSessionBarrier,
      cleanupPrivateOperation: async (record) => {
        if (materializeActionExecutor?.cleanupAbandonedOperation) {
          // The deletion fact's pinned Account scope owns this cleanup: the
          // executor must address that partition directly, never the ambient
          // credentials, so an A→B rotation cannot orphan A's private state
          // or consume B's partition.
          await materializeActionExecutor.cleanupAbandonedOperation(
            record,
            change.accountScope,
          );
          return;
        }
        if (
          record.request.plan === 'materialize'
          || record.request.targetStorageMode === 'persisted'
        ) {
          throw new Error(
            'external_session_operation_abandonment_cleanup_owner_unavailable',
          );
        }
      },
    });
    if (result.deferred > 0) {
      throw new Error('external_session_operation_abandonment_claim_active');
    }
  };
  const unregisterSessionDeletedChanges =
    params.subscribeSessionDeletedChanges?.(
      abandonOperationsForDeletedSession,
    ) ?? (() => {});
  const takeoverPhaseRunner = materializeActionExecutor
    ? createExternalSessionPersistedTakeoverPhaseRunner({
      importExecutor: materializeActionExecutor,
    })
    : null;
  const materializeStartActionExecutor = materializeActionExecutor
    ? createDefaultExternalSessionMaterializeStartActionExecutor({
      activeServerDir: configuration.activeServerDir,
      ...(params.machineId ? { machineId: params.machineId } : {}),
      materialize: materializeActionExecutor,
    })
    : null;
  const takeoverStartActionExecutor =
    createDefaultExternalSessionTakeoverStartActionExecutor({
      activeServerDir: configuration.activeServerDir,
      operationExclusion,
      publishProgress: publishExternalSessionOperationProgressForServer,
      sendHistoricalCommand: async (command) => {
        if (!params.executeExternalSessionHistoricalImportCommand) {
          return {
            v: 1,
            kind: 'error',
            errorCode: 'upgrade_required',
            message: 'External-session private storage inspection is unavailable.',
          };
        }
        return await params.executeExternalSessionHistoricalImportCommand(command);
      },
    });
  const persistedTakeoverAdmissionOwner =
    params.executeExternalSessionHistoricalImportCommand
    && params.persistedTakeoverAdmissionWaiter
      ? createExternalSessionPersistedTakeoverAdmissionOwner({
          activeServerDir: configuration.activeServerDir,
          admissionWaiter: params.persistedTakeoverAdmissionWaiter,
          isFollowSuspended: (input) =>
            followLeaseManager.isSessionSuspended(input),
          suspendFollow: async (input) => {
            await followLeaseManager.suspendSession(input);
          },
          ...(passiveObservation
            ? {
              reconcilePassiveFollowSession: (sessionId: string) =>
                passiveObservation.reconcileSession(sessionId),
            }
            : {}),
          sendHistoricalCommand:
            params.executeExternalSessionHistoricalImportCommand,
          ...(materializeActionExecutor?.cleanupTerminalStaging
            ? {
              cleanupTerminalStaging:
                materializeActionExecutor.cleanupTerminalStaging,
            }
            : {}),
        })
      : null;
  const externalLinkedTakeoverPhaseRunner = params.spawnSession
    && params.executeExternalSessionHistoricalImportCommand
    && params.persistedTakeoverAdmissionWaiter
    && persistedTakeoverAdmissionOwner
    ? createExternalSessionExternalLinkedTakeoverPhaseRunner({
      activeServerDir: configuration.activeServerDir,
      operationExclusion,
      loadCurrent:
        loadCurrentExternalSessionExternalLinkedTakeoverSource,
      followLeaseManager,
      resolveSpawn: resolveExternalTakeoverSpawnOptions,
      spawnResolvedTakeoverSession:
        spawnResolvedExternalTakeoverSession,
      spawnSession: params.spawnSession,
      admissionWaiter: params.persistedTakeoverAdmissionWaiter,
      reconcileRuntimeBindingFailure:
        persistedTakeoverAdmissionOwner.reconcileRuntimeBindingFailure,
      publishProgress: publishExternalSessionOperationProgressForServer,
    })
    : null;
  // Recovery is deliberately local-only: it CASes the durable operation row
  // before the ordinary public-safe projection publish and may remove private
  // staging only after the operation row is terminal. It never invokes
  // admission commands, source reads, authority reconciliation, or spawn.
  const repairOperationProgressProjections = async (): Promise<void> => {
    try {
      await repairExternalSessionOperationProgressProjections(
        configuration.activeServerDir,
        {
          inspectOperationClaim:
            operationExclusion.inspectPassiveRepairClaim,
          withOperationClaimBarrier:
            operationExclusion.withPassiveRepairClaimBarrier,
          ...(materializeActionExecutor?.cleanupTerminalStaging
            ? {
              cleanupTerminalStaging:
                materializeActionExecutor.cleanupTerminalStaging,
            }
            : {}),
        },
      );
    } catch (error) {
      logExternalSessionsInternalError(
        'external_session.operation_projection_repair_lifecycle',
        error,
      );
    }
  };
  void repairOperationProgressProjections();
  const detachPersistedTakeoverAdmissionOwner =
    persistedTakeoverAdmissionOwner
    && params.attachPersistedTakeoverAdmissionOwner
      ? params.attachPersistedTakeoverAdmissionOwner(
          persistedTakeoverAdmissionOwner,
        )
      : null;
  const takeoverAdmissionActionExecutor = params.spawnSession
    && persistedTakeoverAdmissionOwner
    && params.persistedTakeoverAdmissionWaiter
    ? createExternalSessionTakeoverAdmissionActionExecutor({
      activeServerDir: configuration.activeServerDir,
      operationExclusion,
      prepareSpawn: persistedTakeoverAdmissionOwner.prepareSpawn,
      reconcileAuthority: persistedTakeoverAdmissionOwner.reconcileAuthority,
      reconcileRuntimeBindingFailure:
        persistedTakeoverAdmissionOwner.reconcileRuntimeBindingFailure,
      spawnSession: params.spawnSession,
      spawnResolvedTakeoverSession:
        spawnResolvedExternalTakeoverSession,
      admissionWaiter: params.persistedTakeoverAdmissionWaiter,
      isHostedAdmissionAvailable: () =>
        isExternalSessionHostedAdmissionAvailable(
          params.getServerFeaturesSnapshot?.(),
        ),
      publishProgress: publishExternalSessionOperationProgressForServer,
    })
    : null;
  const sessionHookActionExecutor = params.machineId
    ? createPluginSessionHookManagementActionExecutor({
      machineId: params.machineId,
      readFeatureDecision: readSessionHookFeatureDecision,
      host: sessionHookHostProxy,
    })
    : null;
  const externalSessionRpcActionExecutor = params.actionExecutor
    ?? createExternalSessionRpcActionExecutor(
      externalSessionActionContext,
      materializeActionExecutor,
      materializeStartActionExecutor,
      takeoverStartActionExecutor,
      takeoverPhaseRunner,
      externalLinkedTakeoverPhaseRunner,
      takeoverAdmissionActionExecutor,
      sessionHookActionExecutor,
    );
  const publicationFenceAwareActionExecutor: RpcActionExecutor = {
    execute: async (actionId, input, context) => {
      let requiredPublicationFenceVersion: number | undefined;
      if (
        actionId === 'sessions.external.operation.resume'
        || actionId === 'sessions.external.operation.retry'
      ) {
        const operationId = input
          && typeof input === 'object'
          && !Array.isArray(input)
          && typeof (input as Readonly<Record<string, unknown>>).operationId === 'string'
          ? (input as Readonly<Record<string, string>>).operationId
          : null;
        const record = operationId
          ? await readExternalSessionOperationRecord(
            configuration.activeServerDir,
            operationId,
          )
          : null;
        requiredPublicationFenceVersion =
          resolveExternalSessionOperationRequiredPublicationFenceVersion(
            actionId,
            record,
          );
      }
      return await executeExternalSessionImportActivation({
        actionId,
        input,
        serverSnapshot: params.getServerFeaturesSnapshot?.(),
        ...(requiredPublicationFenceVersion === undefined
          ? {}
          : { requiredPublicationFenceVersion }),
        execute: async () =>
          await externalSessionRpcActionExecutor.execute(
            actionId,
            input,
            context,
          ),
      });
    },
  };

  const followHostOperation = params.machineId
      ? createExternalSessionFollowHostOperation({
          machineId: params.machineId,
          followLeaseManager,
          observationProjection,
        })
    : null;
  const followTargetHostOperation = params.machineId
    ? createExternalSessionFollowTargetHostOperation({
        machineId: params.machineId,
      })
    : null;
  const hostOperationInstallation = params.installExternalSessionHostOperations
    ? params.installExternalSessionHostOperations({
        followTargetOperation: followTargetHostOperation,
        followOperation: followHostOperation,
      })
    : null;
  // Own the installation failure now instead of first observing it at teardown: an
  // unobserved rejection here is what the daemon turns into an exception shutdown.
  // `dispose()` still awaits this exact promise and records the failure as the
  // `host_operations` cleanup phase, so nothing is swallowed.
  void hostOperationInstallation?.catch(() => undefined);

  registerActionSpecRpcHandlers({
    rpcHandlerManager,
    actionExecutor: createExternalSessionGenericRpcActionExecutor(publicationFenceAwareActionExecutor),
    scopes: EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES,
    mapResponseForMethod: ({ method, response }) => method.startsWith('daemon.directSessions.')
      ? mapCanonicalExternalSessionResponseToLegacyDirectSession(response)
      : response,
  });

  registerLegacyDirectSessionLinkEnsureWireAlias({
    rpcHandlerManager,
  });

  registerLegacyDirectSessionTakeoverWireAliases({
    rpcHandlerManager,
  });
  return {
    hostExternalSessionActionExecutor: publicationFenceAwareActionExecutor,
    pluginAdmissionOwner: {
      ...(materializeStartActionExecutor
        ? {
            materializeStart:
              materializeStartActionExecutor.startPluginMaterialize,
          }
        : {}),
      takeoverStart: takeoverStartActionExecutor.startPluginTakeover,
      ...(sessionHookActionExecutor
        ? { hookManagementAction: sessionHookActionExecutor.execute }
        : {}),
    },
    connectivityResource: {
      name: 'externalSessionPassiveFollow',
      pause: () => passiveObservation?.pause(),
      resume: async () => {
        await repairOperationProgressProjections();
        await passiveObservation?.resume();
      },
    },
    async dispose() {
      const cleanupFailures: Error[] = [];
      const recordCleanupFailure = (phase: string, error: unknown): void => {
        logExternalSessionsInternalError(
          `external_session.daemon_dispose.${phase}`,
          error,
        );
        cleanupFailures.push(
          new Error(`external_session_daemon_cleanup_failed:${phase}`),
        );
      };
      const runCleanup = async (
        phase: string,
        cleanup: () => unknown | Promise<unknown>,
      ): Promise<void> => {
        try {
          await cleanup();
        } catch (error) {
          recordCleanupFailure(phase, error);
        }
      };

      await runCleanup(
        'persisted_takeover_admission_owner',
        () => detachPersistedTakeoverAdmissionOwner?.(),
      );
      await runCleanup(
        'session_hook_hydration',
        () => unsubscribeSessionHookHydration?.(),
      );
      sessionHookLifecycleDisposed = true;
      await runCleanup(
        'session_hook_lifecycle',
        reconcileSessionHookLifecycle,
      );
      await runCleanup('host_operations', async () => {
        const installation = await hostOperationInstallation;
        await installation?.dispose();
      });
      await runCleanup(
        'session_archived_state_changes',
        unregisterSessionArchivedStateChanges,
      );
      await runCleanup(
        'session_deleted_changes',
        unregisterSessionDeletedChanges,
      );
      const archivedTransitionResults = await Promise.allSettled(
        [...archiveStateTransitions],
      );
      for (const result of archivedTransitionResults) {
        if (result.status === 'rejected') {
          recordCleanupFailure('session_archived_transition', result.reason);
        }
      }
      await runCleanup(
        'status_demand_binding',
        async () => await statusDemandBinding?.dispose(),
      );
      await runCleanup(
        'passive_observation',
        async () => await passiveObservation?.dispose(),
      );
      await runCleanup(
        'follow_lease_manager',
        async () => await followLeaseManager.dispose(),
      );
      await runCleanup(
        'observation_projection',
        async () => await observationProjection.dispose(),
      );
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          cleanupFailures,
          'External Session daemon cleanup failed',
        );
      }
    },
  };
}
