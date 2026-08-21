/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { createDaemonControlAuthGuard } from './controlAuth';
import { Metadata } from '@/api/types';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
import {
  CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES,
  CONNECTED_SERVICE_RUN_MATERIALIZE_PATH,
  CONNECTED_SERVICE_RUN_GENERATION_CURRENT_PATH,
  CONNECTED_SERVICE_RUN_RELEASE_PATH,
  ConnectedServiceRunMaterializeRequestSchema,
  ConnectedServiceRunReleaseRequestSchema,
  ConnectedServiceRunGenerationCurrentRequestSchema,
  ExecutionRunConnectedServicesRegistrationV1Schema,
  type ConnectedServiceRunMaterializationHandler,
  type ConnectedServiceRunReleaseHandler,
  type ConnectedServiceRunGenerationCurrentHandler,
} from './connectedServices/runs/materializeContract';
import { TrackedSession } from './types';
import {
  StopSessionResultSchema,
  type StopSessionResult,
} from './sessions/stopSessionContract';
import { SPAWN_SESSION_ERROR_CODES, SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { mergeSpawnSessionOptions, SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';
import { parseSessionContinueWithReplayRpcParamsCompatIngress } from '@/session/replay/continueWithReplayCompatIngress';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import {
  ConnectedServiceBindingsV1Schema,
  createProviderErrorV1,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceUsageSourceV1Schema,
  CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
  ConnectedAccountAuthFailureRequestV1Schema,
  ConnectedAccountQuotaFailureRequestV1Schema,
  ConnectedAccountRequestAuthLookupRequestV1Schema,
  DaemonLocalServicePublicPreviewStatusRequestV1Schema,
  DaemonSimulatorPreviewActionRequestV1Schema,
  LocalServiceLauncherSnapshotV1Schema,
  LocalServiceActionRequestV1Schema,
  LocalServiceActionResultV1Schema,
  LocalServicePreviewSnapshotV1Schema,
  LocalServicePublicPreviewSnapshotV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  OAuthBearerLeaseV1Schema,
  RequestAuthFailureOutcomeV1Schema,
  RestartAllSessionRunnersRequestV1Schema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerResultV1Schema,
  SessionRunnerStatusGetRequestV1Schema,
  SessionRunnerRuntimeStateV1Schema,
  SpawnSessionErrorCodeSchema,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  SimulatorPreviewActionResultV1Schema,
  SimulatorPreviewSnapshotV1Schema,
  SshTunnelEnsureRequestSchema,
  SshTunnelProbeRequestSchema,
  SshTunnelReleaseRequestSchema,
  SshTunnelStopRequestSchema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
  type ConnectedServiceQuotaRecoveryCreditConsumeRequestV1,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
  type RestartAllSessionRunnersRequestV1,
  type RestartAllSessionRunnersResultV1,
  type RestartSessionRunnerRequestV1,
  type RestartSessionRunnerResultV1,
  type SessionRunnerStatusGetRequestV1,
  type SessionRunnerRuntimeStateV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';
import {
  ConnectedAccountRequestAuthError,
  type ConnectedAccountRequestAuthService,
  type ConnectedAccountRequestAuthSubject,
} from './connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import {
  ProviderAccountUsageAdoptionV1Schema,
  type ProviderAccountUsageAdoptionV1,
} from './connectedServices/accountUsage/adoption';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { toSshTunnelErrorResponse, type SshTunnelSupervisor } from '@/daemon/ssh/tunnels';
import type { LocalServiceInventoryRoutes } from './local/services/inventory/routes';
import type { LocalServiceLauncherRoutes } from './local/services/launch/routes';
import type { LocalServiceManagedRoutes } from './local/services/managed/routes';
import type { LocalServiceActionRoutes } from './local/services/actions/routes';
import type { LocalServicePreviewRoutes } from './local/services/preview/routes';
import type { LocalServicePublicPreviewRoutes } from './local/services/public/routes';
import type { PluginLocalServicesBridgeControlRoutes } from './local/services/pluginBridgeRoutes';
import {
  PluginLocalServicesBridgeControlRequestV1Schema,
  PluginLocalServicesBridgeControlResponseV1Schema,
  type PluginLocalServicesBridgeControlRequestV1,
} from './local/services/pluginBridgeProtocol';
import { verifyPluginLocalServicesBridgeToken } from './local/services/pluginBridgeAuthorization';
import {
  AGENT_RUNTIME_DAEMON_BRIDGE_PATH,
  AgentRuntimeDaemonBridgeRequestV1Schema,
  AgentRuntimeDaemonBridgeResponseV1Schema,
  type AgentRuntimeDaemonBridgeRequestV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import type { AgentRuntimeSessionBridgeRoutes } from './agentRuntime/sessionBridgeRoutes';
import { verifyAgentRuntimeSessionBridgeToken } from './agentRuntime/sessionBridgeAuthorization';
import type { ForegroundAgentRuntimeAdmissionOwner } from './agentRuntime/foregroundAdmission';
import {
  FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH,
  FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
  ForegroundAgentRuntimeAdmissionRequestV1Schema,
  ForegroundAgentRuntimeAdmissionResponseV1Schema,
  ForegroundAgentRuntimeReleaseRequestV1Schema,
  ForegroundAgentRuntimeReleaseResponseV1Schema,
} from './agentRuntime/foregroundAdmissionContract';
import type { SimulatorPreviewRoutes } from './devices/simulator/previewRoutes.types';
import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeFailureClassification,
} from './connectedServices/runtimeAuth/types';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';

type AgentRuntimeSessionBridgeControlRoutes = Pick<
  AgentRuntimeSessionBridgeRoutes,
  'dispatch' | 'disposeSession' | 'dispose'
>;
import type {
  RuntimeAuthRecoveryScheduleResult,
  RuntimeAuthRecoverySchedulerLike,
} from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import {
  ConnectedServiceDaemonAuthBridgeRefreshResultSchema,
  type SessionConnectedServiceRuntimeAuthRefreshHandler,
} from './connectedServices/sessionRuntimeAuthRefresh';
import { sanitizeConnectedServiceDiagnosticString } from './connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import {
  isLocallyCompleteWithoutProof,
} from './connectedServices/runtimeAuth/resolveRuntimeAuthRecoveryOutcome';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from './connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import {
  applyAuthorizedRuntimeAuthFailureSourceBinding,
  type RuntimeAuthFailureSourceAuthorization,
} from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { buildRuntimeAuthRecoveryScheduledResult } from './connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
import { isRecord } from './connectedServices/quotas/quotaNormalization';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { registerDaemonPluginChangeRoutes } from '@/plugins/daemon/controlRoutes';
import { readCurrentDaemonPluginCatalogSnapshot } from '@/plugins/daemon/currentCatalog';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';

const DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY = 'HAPPIER_DAEMON_CONTROL_BODY_LIMIT_BYTES';
const E2E_DAEMON_CONTROL_PORT_ENV_KEY = 'HAPPIER_E2E_DAEMON_CONTROL_PORT';
const DAEMON_DIST_CLOSURE_FINGERPRINT_PATTERN = /^[a-f0-9]{16}$/;
const DaemonDistClosureFingerprintSchema = z.string().regex(DAEMON_DIST_CLOSURE_FINGERPRINT_PATTERN);
type DaemonSelfRestartRequest = Readonly<{
  successorDistClosureFingerprint?: string;
}>;
const DEFAULT_SPAWN_NONCE_PENDING_TTL_MS = 5 * 60_000;

function resolveDaemonControlListenPort(env: NodeJS.ProcessEnv): number {
  const raw = env[E2E_DAEMON_CONTROL_PORT_ENV_KEY]?.trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${E2E_DAEMON_CONTROL_PORT_ENV_KEY} must be an integer port`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${E2E_DAEMON_CONTROL_PORT_ENV_KEY} must be between 1 and 65535`);
  }
  return port;
}

const ConnectedServiceRuntimeAuthRefreshSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('profile'),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
  }),
  z.object({
    kind: z.literal('group'),
    serviceId: ConnectedServiceIdSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    activeProfileId: ConnectedServiceProfileIdSchema,
    fallbackProfileId: ConnectedServiceProfileIdSchema,
    generation: z.number().int().nonnegative(),
  }),
]);


function resolveThrownSpawnSessionErrorCode(error: unknown): string {
  const record = error as any;
  const candidates = [record?.code, record?.errorCode]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  return candidates.find((value) => SpawnSessionErrorCodeSchema.safeParse(value).success)
    ?? SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED;
}
const DEFAULT_SPAWN_NONCE_SUCCESS_TTL_MS = 60 * 60_000;
const SPAWN_NONCE_PENDING_TTL_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_NONCE_PENDING_TTL_MS';
const SPAWN_NONCE_SUCCESS_TTL_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_NONCE_SUCCESS_TTL_MS';
const DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH = 500;

function readSafeDaemonControlErrorDiagnostic(error: unknown): Readonly<{
  name: string;
  message: string;
}> {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: sanitizeConnectedServiceDiagnosticString(error.message).slice(0, DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH),
    };
  }
  return {
    name: typeof error,
    message: sanitizeConnectedServiceDiagnosticString(String(error)).slice(0, DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH),
  };
}

function isProviderAccountUsageSnapshotIntakeAccepted(result: unknown): boolean {
  if (
    !isRecord(result)
    || typeof result.recordId !== 'string'
    || result.recordId.length === 0
  ) {
    return false;
  }
  if (result.status === 'credential_fingerprint_mismatch') {
    // Exact stale evidence is terminally rejected before store/persistence mutation.
    // Retrying cannot make that claimed source current and would only burn the bounded
    // producer retry budget.
    return result.persisted === false;
  }
  return result.status !== 'session_not_found' && result.persisted === true;
}

function isProviderAccountUsageAdoptionIntakeAccepted(result: unknown): boolean {
  return (
    isRecord(result)
    && (result.status === 'adopted' || result.status === 'already_adopted')
    && typeof result.fromRecordId === 'string'
    && result.fromRecordId.length > 0
    && typeof result.toRecordId === 'string'
    && result.toRecordId.length > 0
    && result.persisted === true
  );
}

function isCanonicalSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return !/^PID-\d+$/.test(normalized);
}

function isAgentRuntimeSessionBridgeRequestAuthorized(
  request: AgentRuntimeDaemonBridgeRequestV1,
  sessions: Iterable<TrackedSession>,
): boolean {
  const bindingOperation = request.operation.kind === 'factory.prepare'
    || request.operation.kind === 'session.open'
    ? request.operation
    : null;
  for (const tracked of sessions) {
    if (
      tracked.reattachedFromDiskMarker === true
      || tracked.happySessionId !== request.context.sessionId
      || tracked.agentRuntimeBridgePluginId !== request.context.pluginId
      || tracked.agentRuntimeBridgeAgentId !== request.context.agentId
      || tracked.agentRuntimeBridgeGeneration !== request.context.generation
      || tracked.agentRuntimeBridgeBackendId
        !== (bindingOperation
          ? bindingOperation.descriptor.backendId
          : tracked.agentRuntimeBridgeBackendId)
      || !tracked.agentRuntimeBridgeTokenHash
    ) {
      continue;
    }
    if (bindingOperation) {
      if (
        bindingOperation.request.sessionId !== request.context.sessionId
        || bindingOperation.descriptor.pluginId !== request.context.pluginId
        || bindingOperation.descriptor.agentId !== request.context.agentId
        || bindingOperation.descriptor.generation !== request.context.generation
      ) {
        return false;
      }
    }
    return verifyAgentRuntimeSessionBridgeToken({
      providedToken: request.context.token,
      expectedTokenHash: tracked.agentRuntimeBridgeTokenHash,
    });
  }
  return false;
}

function isPluginLocalServicesBridgeRequestAuthorized(
  request: PluginLocalServicesBridgeControlRequestV1,
  sessions: Iterable<TrackedSession>,
): boolean {
  const requestedSessionId = request.context.sessionId.trim();
  const requestedPluginId = request.context.pluginId.trim();
  const requestedContributionId = request.context.contributionId.trim();
  const providedToken = request.bridgeToken?.trim() ?? '';
  if (!requestedSessionId || !requestedPluginId || !requestedContributionId || !providedToken) {
    return false;
  }

  for (const session of sessions) {
    if (session.startedBy !== 'daemon') continue;
    const sessionId = typeof session.happySessionId === 'string' ? session.happySessionId.trim() : '';
    if (sessionId !== requestedSessionId) continue;
    const expectedTokenHash = typeof session.localServicesBridgeTokenHash === 'string'
      ? session.localServicesBridgeTokenHash.trim()
      : '';
    if (!expectedTokenHash || !verifyPluginLocalServicesBridgeToken({
      providedToken,
      expectedTokenHash,
    })) continue;
    const expectedPluginId = typeof session.localServicesBridgePluginId === 'string'
      ? session.localServicesBridgePluginId.trim()
      : '';
    if (expectedPluginId !== requestedPluginId) continue;
    const expectedContributionId = typeof session.localServicesBridgeContributionId === 'string'
      ? session.localServicesBridgeContributionId.trim()
      : '';
    if (expectedContributionId !== requestedContributionId) continue;
    return true;
  }

  return false;
}

function resolveDaemonControlBodyLimitBytes(): number {
  const raw = String(process.env[DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY] ?? '').trim();
  if (!raw) return DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES;
  }

  return Math.max(1024 * 1024, Math.min(parsed, 64 * 1024 * 1024));
}

function sendBadRequest(reply: FastifyReply, body: Readonly<{
  success: false;
  error: string;
  errorCode?: string;
}>): void {
  void reply.code(400).send(body);
}

function resolvePositiveIntFromEnv(key: string, fallback: number): number {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isRuntimeAuthRecoveryScheduled(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { status?: unknown }).status === 'scheduled'
    && (value as { retryable?: unknown }).retryable === true;
}

function isConnectedServiceRuntimeAuthApplyFailure(result: unknown): boolean {
  const outer = result && typeof result === 'object' && !Array.isArray(result)
    ? result as { status?: unknown; result?: unknown }
    : null;
  const inner = outer?.result && typeof outer.result === 'object' && !Array.isArray(outer.result)
    ? outer.result as { status?: unknown; applyResult?: unknown }
    : null;
  return outer?.status === 'switch_attempted'
    && inner?.status === 'apply_failed'
    && Boolean(inner.applyResult);
}

async function beginRuntimeAuthRecoveryIntake(input: Readonly<{
  reportId?: string;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerLike | null;
  sessionId: string;
  switchesThisTurn: number;
  classification: ConnectedServiceRuntimeFailureClassification;
  resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1;
}>): Promise<Readonly<{
  ok: true;
  created: boolean;
  recovery?: RuntimeAuthRecoveryScheduleResult;
}> | Readonly<{ ok: false; error: unknown }>> {
  if (!input.runtimeAuthRecoveryScheduler?.beginClassifiedFailure) return { ok: true, created: false };
  try {
    const recovery = await input.runtimeAuthRecoveryScheduler.beginClassifiedFailure({
      ...(input.reportId ? { reportId: input.reportId } : {}),
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      resumePromptMode: input.resumePromptMode,
    });
    return { ok: true, created: true, recovery };
  } catch (error) {
    return { ok: false, error };
  }
}

function readRuntimeAuthRecoveryResumePromptMode(
  recovery: unknown,
): SessionUsageLimitRecoveryResumePromptModeV1 {
  const record = recovery && typeof recovery === 'object' && !Array.isArray(recovery)
    ? recovery as Readonly<Record<string, unknown>>
    : null;
  return record?.resumePromptMode === 'off' || record?.resumePromptMode === 'custom'
    ? record.resumePromptMode
    : 'standard';
}

function readRuntimeAuthRecoveryAttemptId(recovery: unknown): string | null {
  const record = recovery && typeof recovery === 'object' && !Array.isArray(recovery)
    ? recovery as Readonly<Record<string, unknown>>
    : null;
  return typeof record?.attemptId === 'string' && record.attemptId.trim() ? record.attemptId.trim() : null;
}

type SpawnNonceCorrelationRecord = Readonly<{
  status: 'pending' | 'success';
  sessionId?: string;
  updatedAtMs: number;
  expiresAtMs: number;
}>;

type SpawnNonceAdmissionResult =
  | { type: 'none' }
  | { type: 'claimed' }
  | { type: 'pending' }
  | { type: 'success'; sessionId: string };

export type ConnectedAccountRequestAuthControlRoutes = Readonly<{
  authenticate: (capability: unknown) => ConnectedAccountRequestAuthSubject | null;
}> & Pick<
  ConnectedAccountRequestAuthService,
  'lookupRequestAuth' | 'refreshAfterAuthFailure' | 'reportQuotaFailure'
>;

export function createDaemonControlApp({
  getChildren,
  machineId,
  runtimeId = '',
  prepareStopSession,
  stopSession,
  spawnSession,
  requestShutdown,
  beforeShutdown,
  isShuttingDown,
  onHappySessionWebhook,
  admitPersistedTakeover,
  controlToken,
  connectedAccountRequestAuth,
  verifyRunMaterializeToken,
  materializeConnectedServicesForExecutionRun,
  checkConnectedServicesGenerationForExecutionRun,
  releaseConnectedServicesForExecutionRun,
  sshTunnels,
  handleConnectedServiceRuntimeAuthFailure,
  authorizeConnectedServiceRuntimeAuthFailure,
  resolveConnectedServiceRuntimeAuthResumePromptMode,
  runtimeAuthRecoveryScheduler,
  handleSessionConnectedServiceAuthSwitch,
  handleSessionConnectedServiceRuntimeAuthRefresh,
  handleSessionRunnerRestart,
  handleSessionRunnerRestartAll,
  handleSessionRunnerStatusGet,
  handleConnectedServiceTurnLifecycle,
  handleConnectedServiceUsageLimitWaitResumeCancel,
  handleConnectedServiceQuotaRecoveryCreditConsume,
  handleProviderAccountUsageSnapshot,
  handleProviderAccountUsageAdoption,
  localServicesInventory,
  localServicesLauncher,
  localServicesPreview,
  localServicesActions,
  localServicesPublicPreview,
  localServicesPluginBridge,
  agentRuntimeSessionBridge,
  foregroundAgentRuntimeAdmission,
  simulatorPreview,
  requestSelfRestart,
  pluginChangeService,
  pluginActionCurrentIntent,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  runtimeId?: string;
  prepareStopSession?: (trackedSession: TrackedSession) => Promise<void> | void;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: (input: Readonly<{
    managedLocalServicesDisposition: 'permanent' | 'transfer';
  }>) => Promise<void>;
  // True once daemon shutdown / control-server stop has begun. Recovery handlers early-return when
  // set so switch/restart work is never run into a tearing-down daemon (a deferral, not an attempt).
  isShuttingDown?: () => boolean;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void | Promise<void>;
  admitPersistedTakeover?: (input: Readonly<{
    sessionId: string;
    operationId: string;
    attemptId: string;
    phase: 'admit' | 'runtime_bound';
    signal: AbortSignal;
  }>) => Promise<void>;
  controlToken: string;
  connectedAccountRequestAuth?: ConnectedAccountRequestAuthControlRoutes;
  /**
   * Validates the scoped execution-run materialization capability token. The
   * `/connected-service-run/*` bridge endpoints accept only this scoped token and reject the
   * master control token. When unset the run bridge endpoints fail closed.
   */
  verifyRunMaterializeToken?: (provided: string) => boolean;
  /**
   * Resolves + materializes connected-service auth for an execution run (RUN-scoped
   * materialization key) and registers the run PID as a runtime-registry target. Implemented by
   * the daemon wiring over the canonical spawn-auth owner (`resolveConnectedServiceAuthForSpawn`).
   * When unset the materialize endpoint fails closed with 501.
   */
  materializeConnectedServicesForExecutionRun?: ConnectedServiceRunMaterializationHandler;
  checkConnectedServicesGenerationForExecutionRun?: ConnectedServiceRunGenerationCurrentHandler;
  /**
   * Unregisters the run from the canonical runtime registry and runs the retained materialization
   * cleanup for a finished execution run. Optional; release is best-effort at run end.
   */
  releaseConnectedServicesForExecutionRun?: ConnectedServiceRunReleaseHandler;
  sshTunnels?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
  handleConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    interruptedOriginId?: string;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
    classification: ConnectedServiceRuntimeFailureClassification;
    sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
  }>) => Promise<unknown>;
  authorizeConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => Promise<RuntimeAuthFailureSourceAuthorization>;
  resolveConnectedServiceRuntimeAuthResumePromptMode?: (input: Readonly<{
    classification: ConnectedServiceRuntimeFailureClassification;
    explicit?: SessionUsageLimitRecoveryResumePromptModeV1;
  }>) => Promise<SessionUsageLimitRecoveryResumePromptModeV1>;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerLike | null;
  handleConnectedServiceTurnLifecycle?: (input: Readonly<{
    sessionId: string;
    turnId?: string;
    event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
    terminalStatus?: 'completed' | 'failed';
    connectedServiceSelectionsEnvRaw?: string;
  }>) => Promise<unknown>;
  handleConnectedServiceUsageLimitWaitResumeCancel?: (input: Readonly<{
    sessionId: string;
    attemptId: string;
  }>) => Promise<unknown>;
  handleSessionConnectedServiceAuthSwitch?: (input: Readonly<{
    sessionId: string;
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
  }>) => Promise<unknown>;
  handleSessionConnectedServiceRuntimeAuthRefresh?: SessionConnectedServiceRuntimeAuthRefreshHandler;
  handleSessionRunnerRestart?: (request: RestartSessionRunnerRequestV1) => Promise<RestartSessionRunnerResultV1>;
  handleSessionRunnerRestartAll?: (request: RestartAllSessionRunnersRequestV1) => Promise<RestartAllSessionRunnersResultV1>;
  handleSessionRunnerStatusGet?: (request: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStateV1>;
  handleConnectedServiceQuotaRecoveryCreditConsume?: (
    input: ConnectedServiceQuotaRecoveryCreditConsumeRequestV1,
  ) => Promise<unknown>;
  handleProviderAccountUsageSnapshot?: (input: Readonly<{
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: ConnectedServiceUsageSourceV1;
    credentialFingerprint?: string | null;
    policyDisposition?: 'evidence_only';
  }>) => Promise<unknown>;
  handleProviderAccountUsageAdoption?: (input: Readonly<{
    sessionId: string;
    adoption: ProviderAccountUsageAdoptionV1;
  }>) => Promise<unknown>;
  localServicesInventory?: LocalServiceInventoryRoutes;
  localServicesLauncher?: LocalServiceLauncherRoutes;
  localServicesManaged?: LocalServiceManagedRoutes;
  localServicesPreview?: Pick<LocalServicePreviewRoutes, 'getSnapshot'>;
  localServicesActions?: LocalServiceActionRoutes;
  localServicesPublicPreview?: LocalServicePublicPreviewRoutes;
  localServicesPluginBridge?: PluginLocalServicesBridgeControlRoutes;
  agentRuntimeSessionBridge?: AgentRuntimeSessionBridgeControlRoutes;
  foregroundAgentRuntimeAdmission?: ForegroundAgentRuntimeAdmissionOwner;
  simulatorPreview?: SimulatorPreviewRoutes;
  requestSelfRestart?: (request?: DaemonSelfRestartRequest) => Promise<unknown>;
  pluginChangeService?: DaemonPluginChangeService;
  pluginActionCurrentIntent?: (
    request: TargetActionCurrentIntentRequest
  ) => Promise<TargetActionCurrentIntentResult>;
}): FastifyInstance {
  const normalizedRuntimeId = runtimeId.trim();
  const normalizedControlToken = controlToken.trim();
  if (!normalizedControlToken) {
    throw new Error('Daemon control token is required');
  }

  const app = fastify({
    logger: false, // We use our own logger
    bodyLimit: resolveDaemonControlBodyLimitBytes(),
  });

  // Set up Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const runtimeAuthReportClaims = new Map<string, Readonly<{
    claimedAtMs: number;
    result: Promise<unknown>;
    settled: boolean;
  }>>();
  const runtimeAuthReportClaimTtlMs = 24 * 60 * 60_000;
  const runtimeAuthReportClaimMaxSettledEntries = 256;
  const claimRuntimeAuthReport = async <T>(input: Readonly<{
    reportId?: string;
    execute: () => Promise<T>;
    retainSettled?: (result: T) => boolean;
    onResult?: (result: T) => void;
  }>): Promise<T> => {
    const reportId = typeof input.reportId === 'string' ? input.reportId.trim() : '';
    if (!reportId) return await input.execute();
    const nowMs = Date.now();
    for (const [key, claim] of runtimeAuthReportClaims) {
      if (claim.settled && nowMs - claim.claimedAtMs > runtimeAuthReportClaimTtlMs) {
        runtimeAuthReportClaims.delete(key);
      }
    }
    const existing = runtimeAuthReportClaims.get(reportId);
    if (existing) {
      const joined = await existing.result as T;
      input.onResult?.(joined);
      return joined;
    }
    let settledEntries = 0;
    for (const claim of runtimeAuthReportClaims.values()) {
      if (claim.settled) settledEntries += 1;
    }
    if (settledEntries >= runtimeAuthReportClaimMaxSettledEntries) {
      for (const [key, claim] of runtimeAuthReportClaims) {
        if (!claim.settled) continue;
        runtimeAuthReportClaims.delete(key);
        break;
      }
    }
    const result = input.execute();
    runtimeAuthReportClaims.set(reportId, { claimedAtMs: nowMs, result, settled: false });
    void result.then((settled) => {
      if (input.retainSettled?.(settled) === false && runtimeAuthReportClaims.get(reportId)?.result === result) {
        runtimeAuthReportClaims.delete(reportId);
      } else if (runtimeAuthReportClaims.get(reportId)?.result === result) {
        runtimeAuthReportClaims.set(reportId, { claimedAtMs: nowMs, result, settled: true });
      }
    }).catch(() => {
      if (runtimeAuthReportClaims.get(reportId)?.result === result) {
        runtimeAuthReportClaims.delete(reportId);
      }
    });
    const settled = await result;
    input.onResult?.(settled);
    return settled;
  };
  const requestAuthPrincipalByRequest = new WeakMap<object, ConnectedAccountRequestAuthSubject>();
  const spawnNoncePendingTtlMs = resolvePositiveIntFromEnv(
    SPAWN_NONCE_PENDING_TTL_ENV_KEY,
    DEFAULT_SPAWN_NONCE_PENDING_TTL_MS,
  );
  const spawnNonceSuccessTtlMs = resolvePositiveIntFromEnv(
    SPAWN_NONCE_SUCCESS_TTL_ENV_KEY,
    DEFAULT_SPAWN_NONCE_SUCCESS_TTL_MS,
  );
  const spawnNonceCorrelationByNonce = new Map<string, SpawnNonceCorrelationRecord>();
  let daemonStopRequested = false;
  let restartState: 'idle' | 'restarting' = 'idle';
  const isDaemonQuiescing = () => daemonStopRequested || isShuttingDown?.() === true;
  const daemonShuttingDownResponse = () => ({
    ok: false as const,
    errorCode: 'daemon_shutting_down' as const,
  });
  const daemonShuttingDownRouteResponseSchema = z.object({
    ok: z.literal(false),
    errorCode: z.literal('daemon_shutting_down'),
  });
  const daemonShuttingDownErrorResponse = () => ({
    ...daemonShuttingDownResponse(),
    error: 'Daemon is shutting down',
  });
  const spawnDaemonShuttingDownResponse = () => ({
    success: false as const,
    error: 'Daemon is shutting down',
    errorCode: 'daemon_shutting_down' as const,
  });

  const pruneSpawnNonceCorrelation = (nowMs: number = Date.now()): void => {
    for (const [spawnNonce, record] of spawnNonceCorrelationByNonce.entries()) {
      if (record.expiresAtMs <= nowMs) {
        spawnNonceCorrelationByNonce.delete(spawnNonce);
      }
    }
  };

  const markSpawnNoncePending = (spawnNonce: string): void => {
    const normalizedNonce = spawnNonce.trim();
    if (!normalizedNonce) return;
    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    const current = spawnNonceCorrelationByNonce.get(normalizedNonce);
    if (current?.status === 'success' && current.expiresAtMs > nowMs) return;
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'pending',
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + spawnNoncePendingTtlMs,
    });
  };

  const markSpawnNonceSuccess = (spawnNonce: string, sessionId: string): void => {
    const normalizedNonce = spawnNonce.trim();
    const normalizedSessionId = sessionId.trim();
    if (!normalizedNonce || !isCanonicalSessionId(normalizedSessionId)) return;
    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'success',
      sessionId: normalizedSessionId,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + spawnNonceSuccessTtlMs,
    });
  };

  const clearSpawnNonceCorrelation = (spawnNonce: string): void => {
    const normalizedNonce = spawnNonce.trim();
    if (!normalizedNonce) return;
    spawnNonceCorrelationByNonce.delete(normalizedNonce);
  };

  const readTrackedSpawnNonceAdmission = (spawnNonce: string): Exclude<SpawnNonceAdmissionResult, { type: 'none' | 'claimed' }> | null => {
    const normalizedNonce = spawnNonce.trim();
    if (!normalizedNonce) return null;

    let foundPending = false;
    for (const child of getChildren()) {
      const childNonce = typeof child.spawnOptions?.spawnNonce === 'string'
        ? child.spawnOptions.spawnNonce.trim()
        : '';
      if (childNonce !== normalizedNonce) continue;

      const childSessionId = typeof child.happySessionId === 'string'
        ? child.happySessionId.trim()
        : '';
      if (isCanonicalSessionId(childSessionId)) {
        return { type: 'success', sessionId: childSessionId };
      }
      foundPending = true;
    }

    return foundPending ? { type: 'pending' } : null;
  };

  const claimSpawnNonceAdmission = (spawnNonce: string): SpawnNonceAdmissionResult => {
    const normalizedNonce = spawnNonce.trim();
    if (!normalizedNonce) return { type: 'none' };
    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    const current = spawnNonceCorrelationByNonce.get(normalizedNonce);
    if (current?.status === 'success' && isCanonicalSessionId(current.sessionId)) {
      return { type: 'success', sessionId: current.sessionId.trim() };
    }
    if (current?.status === 'pending') {
      return { type: 'pending' };
    }
    const tracked = readTrackedSpawnNonceAdmission(normalizedNonce);
    if (tracked?.type === 'success') {
      markSpawnNonceSuccess(normalizedNonce, tracked.sessionId);
      return tracked;
    }
    if (tracked?.type === 'pending') {
      markSpawnNoncePending(normalizedNonce);
      return tracked;
    }
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'pending',
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + spawnNoncePendingTtlMs,
    });
    return { type: 'claimed' };
  };

  const markSpawnNonceFromTrackedSession = (sessionId: string): void => {
    const normalizedSessionId = sessionId.trim();
    if (!isCanonicalSessionId(normalizedSessionId)) return;
    for (const child of getChildren()) {
      const trackedNonce = typeof child.spawnOptions?.spawnNonce === 'string'
        ? child.spawnOptions.spawnNonce.trim()
        : '';
      const trackedSessionId = typeof child.happySessionId === 'string'
        ? child.happySessionId.trim()
        : '';
      if (!trackedNonce || trackedSessionId !== normalizedSessionId) continue;
      markSpawnNonceSuccess(trackedNonce, trackedSessionId);
    }
  };

  const authSchema401 = z.object({
    success: z.literal(false),
    error: z.string(),
  });

  const requireAuth = createDaemonControlAuthGuard(normalizedControlToken);

  const requestAuthErrorResponseSchema = z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().trim().min(1).max(128) }).strict(),
  }).strict();
  const requireConnectedAccountRequestAuth = async (request: {
    headers: Record<string, unknown>;
  }, reply: FastifyReply): Promise<void> => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return reply.send({
        ok: false as const,
        error: { code: 'request_auth_unavailable' },
      });
    }
    const provided = request.headers[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER];
    const principal = typeof provided === 'string'
      ? connectedAccountRequestAuth?.authenticate(provided) ?? null
      : null;
    if (!principal || !principal.isCurrent()) {
      reply.code(401);
      return reply.send({
        ok: false as const,
        error: { code: 'request_auth_unauthorized' },
      });
    }
    requestAuthPrincipalByRequest.set(request, principal);
  };

  const takeConnectedAccountRequestAuthPrincipal = (
    request: object,
  ): ConnectedAccountRequestAuthSubject | null => {
    const principal = requestAuthPrincipalByRequest.get(request) ?? null;
    requestAuthPrincipalByRequest.delete(request);
    return principal?.isCurrent() === true ? principal : null;
  };

  const sendConnectedAccountRequestAuthFailure = (
    reply: FastifyReply,
    error: unknown,
  ) => {
    if (error instanceof ConnectedAccountRequestAuthError) {
      const status = error.code === 'request_auth_purpose_forbidden'
        ? 403
        : error.code === 'request_auth_not_active'
          ? 409
          : 503;
      reply.code(status);
      return {
        ok: false as const,
        error: { code: error.code },
      };
    }
    logger.debug('[CONTROL SERVER] Connected-account request-auth operation failed', {
      errorCode: 'unexpected_error',
    });
    reply.code(503);
    return {
      ok: false as const,
      error: { code: 'request_auth_unavailable' },
    };
  };


  // Least-privilege gate for the execution-run connected-services bridge. Accepts only the scoped
  // run-materialize capability token via the injected verifier; the master control token is
  // rejected. Fails closed when no verifier is wired.
  const requireRunMaterializeAuth = async (request: { headers: Record<string, unknown> }, reply: any): Promise<void> => {
    const rawHeader = (request.headers as any)['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;
    if (!provided || !verifyRunMaterializeToken || !verifyRunMaterializeToken(provided)) {
      reply.code(401);
      return reply.send({ success: false as const, error: 'Unauthorized' });
    }
  };

  if (pluginChangeService) {
    registerDaemonPluginChangeRoutes(app, {
      service: pluginChangeService,
      requireAuth,
      ...(pluginActionCurrentIntent ? { requestCurrentIntent: pluginActionCurrentIntent } : {}),
      readCatalogSnapshot: async () => await readCurrentDaemonPluginCatalogSnapshot({
        reloadController: pluginReloadController,
      }),
    });
  }

  typed.post('/ping', {
    schema: {
      response: {
        200: z.object({
          status: z.literal('ok'),
          runtimeId: z.string().min(1).optional(),
          distClosureFingerprint: DaemonDistClosureFingerprintSchema.optional(),
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    const distClosureFingerprint = String(
      process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT ?? '',
    ).trim();
    return {
      status: 'ok' as const,
      ...(normalizedRuntimeId ? { runtimeId: normalizedRuntimeId } : {}),
      ...(DAEMON_DIST_CLOSURE_FINGERPRINT_PATTERN.test(distClosureFingerprint)
        ? { distClosureFingerprint }
        : {}),
    };
  });

  typed.post(CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH, {
    schema: {
      body: ConnectedAccountRequestAuthLookupRequestV1Schema,
      response: {
        200: z.object({ ok: z.literal(true), value: OAuthBearerLeaseV1Schema }).strict(),
        401: requestAuthErrorResponseSchema,
        403: requestAuthErrorResponseSchema,
        409: requestAuthErrorResponseSchema,
        503: requestAuthErrorResponseSchema,
      },
    },
    preHandler: requireConnectedAccountRequestAuth,
  }, async (request, reply) => {
    const principal = takeConnectedAccountRequestAuthPrincipal(request);
    if (!principal || !connectedAccountRequestAuth) {
      reply.code(401);
      return { ok: false as const, error: { code: 'request_auth_unauthorized' } };
    }
    try {
      const value = await connectedAccountRequestAuth.lookupRequestAuth({
        subject: principal,
        purpose: request.body.purpose,
      });
      if (!principal.isCurrent()) {
        reply.code(409);
        return { ok: false as const, error: { code: 'request_auth_not_active' } };
      }
      return { ok: true as const, value };
    } catch (error) {
      return sendConnectedAccountRequestAuthFailure(reply, error);
    }
  });

  typed.post(CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH, {
    schema: {
      body: ConnectedAccountAuthFailureRequestV1Schema,
      response: {
        200: z.object({ ok: z.literal(true), value: RequestAuthFailureOutcomeV1Schema }).strict(),
        401: requestAuthErrorResponseSchema,
        403: requestAuthErrorResponseSchema,
        409: requestAuthErrorResponseSchema,
        503: requestAuthErrorResponseSchema,
      },
    },
    preHandler: requireConnectedAccountRequestAuth,
  }, async (request, reply) => {
    const principal = takeConnectedAccountRequestAuthPrincipal(request);
    if (!principal || !connectedAccountRequestAuth) {
      reply.code(401);
      return { ok: false as const, error: { code: 'request_auth_unauthorized' } };
    }
    try {
      const value = await connectedAccountRequestAuth.refreshAfterAuthFailure({
        subject: principal,
        request: request.body,
      });
      if (!principal.isCurrent()) {
        reply.code(409);
        return { ok: false as const, error: { code: 'request_auth_not_active' } };
      }
      return { ok: true as const, value };
    } catch (error) {
      return sendConnectedAccountRequestAuthFailure(reply, error);
    }
  });

  typed.post(CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH, {
    schema: {
      body: ConnectedAccountQuotaFailureRequestV1Schema,
      response: {
        200: z.object({ ok: z.literal(true), value: RequestAuthFailureOutcomeV1Schema }).strict(),
        401: requestAuthErrorResponseSchema,
        403: requestAuthErrorResponseSchema,
        409: requestAuthErrorResponseSchema,
        503: requestAuthErrorResponseSchema,
      },
    },
    preHandler: requireConnectedAccountRequestAuth,
  }, async (request, reply) => {
    const principal = takeConnectedAccountRequestAuthPrincipal(request);
    if (!principal || !connectedAccountRequestAuth) {
      reply.code(401);
      return { ok: false as const, error: { code: 'request_auth_unauthorized' } };
    }
    try {
      const value = await connectedAccountRequestAuth.reportQuotaFailure({
        subject: principal,
        request: request.body,
      });
      if (!principal.isCurrent()) {
        reply.code(409);
        return { ok: false as const, error: { code: 'request_auth_not_active' } };
      }
      return { ok: true as const, value };
    } catch (error) {
      return sendConnectedAccountRequestAuthFailure(reply, error);
    }
  });

  typed.post('/connected-service-auth/session/switch', {
    schema: {
      body: z.object({
        sessionId: z.string().trim().min(1),
        agentId: z.string().trim().min(1),
        bindings: ConnectedServiceBindingsV1Schema,
        expectedGroupGenerationByServiceId: z.record(z.string(), z.number().int().nonnegative()).optional(),
        accountSettingsVersionHint: z.number().int().nonnegative().optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_auth_switch_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!handleSessionConnectedServiceAuthSwitch) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_auth_switch_handler_unavailable' as const,
      };
    }
    const result = await handleSessionConnectedServiceAuthSwitch({
      sessionId: request.body.sessionId,
      agentId: request.body.agentId,
      bindings: request.body.bindings,
      ...(request.body.expectedGroupGenerationByServiceId === undefined
        ? {}
        : { expectedGroupGenerationByServiceId: request.body.expectedGroupGenerationByServiceId }),
      ...(request.body.accountSettingsVersionHint === undefined
        ? {}
        : { accountSettingsVersionHint: request.body.accountSettingsVersionHint }),
    });
    return { ok: true as const, result };
  });

  typed.post('/connected-service-auth/session/refresh-runtime-auth', {
    schema: {
      body: z.object({
        sessionId: z.string().trim().min(1),
        serviceId: ConnectedServiceIdSchema,
        refreshAttemptId: z.string().trim().min(1),
        selection: ConnectedServiceRuntimeAuthRefreshSelectionSchema,
        planType: z.string().trim().min(1).nullable().optional(),
        failingAccessTokenFingerprint: z.string().trim().min(1).nullable().optional(),
        expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
        reason: z.string().trim().min(1).nullable().optional(),
      }),
      response: {
        200: z.object({ ok: z.literal(true), result: ConnectedServiceDaemonAuthBridgeRefreshResultSchema }),
        400: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_session_refresh_service_id_mismatch'),
        }),
        401: authSchema401,
        403: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_session_refresh_forbidden'),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_daemon_auth_bridge_unavailable'),
        }),
        503: daemonShuttingDownRouteResponseSchema,
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (request.body.serviceId !== request.body.selection.serviceId) {
      reply.code(400);
      return {
        ok: false as const,
        errorCode: 'connected_service_session_refresh_service_id_mismatch' as const,
      };
    }
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!handleSessionConnectedServiceRuntimeAuthRefresh) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_daemon_auth_bridge_unavailable' as const,
      };
    }
    const result = await handleSessionConnectedServiceRuntimeAuthRefresh({
      sessionId: request.body.sessionId,
      refreshAttemptId: request.body.refreshAttemptId,
      selection: request.body.selection,
      ...(request.body.planType === undefined ? {} : { planType: request.body.planType }),
      ...(request.body.failingAccessTokenFingerprint === undefined
        ? {}
        : { failingAccessTokenFingerprint: request.body.failingAccessTokenFingerprint }),
      expectedCredentialRevision: request.body.expectedCredentialRevision,
      ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
    });
    if (!result.ok) {
      reply.code(result.errorCode === 'connected_service_session_refresh_forbidden' ? 403 : 501);
      return result;
    }
    return result;
  });

  typed.post('/session-runners/restart', {
    schema: {
      body: RestartSessionRunnerRequestV1Schema,
      response: {
        200: RestartSessionRunnerResultV1Schema,
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
        501: z.object({
          ok: z.literal(false),
          status: z.literal('unsupported_daemon'),
          sessionId: z.string(),
          reasonCode: z.literal('unsupported_daemon_version'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!handleSessionRunnerRestart) {
      reply.code(501);
      return {
        ok: false as const,
        status: 'unsupported_daemon' as const,
        sessionId: request.body.sessionId,
        reasonCode: 'unsupported_daemon_version' as const,
      };
    }
    return await handleSessionRunnerRestart(request.body);
  });

  typed.post('/session-runners/restart-all', {
    schema: {
      body: RestartAllSessionRunnersRequestV1Schema,
      response: {
        200: RestartAllSessionRunnersResultV1Schema,
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
        501: RestartAllSessionRunnersResultV1Schema,
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!handleSessionRunnerRestartAll) {
      reply.code(501);
      return {
        ok: false as const,
        mode: request.body.mode,
        requestedCount: 0,
        restartedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        results: [],
      };
    }
    return await handleSessionRunnerRestartAll({
      mode: request.body.mode,
      dryRun: request.body.dryRun === true,
      reason: request.body.reason,
    });
  });

  typed.post('/session-runners/status', {
    schema: {
      body: SessionRunnerStatusGetRequestV1Schema,
      response: {
        200: SessionRunnerRuntimeStateV1Schema,
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('unsupported_daemon_version'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleSessionRunnerStatusGet) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'unsupported_daemon_version' as const,
      };
    }
    return await handleSessionRunnerStatusGet({ sessionId: request.body.sessionId });
  });

  // Session reports itself after creation
  typed.post('/session-started', {
    schema: {
      body: z.object({
        sessionId: z.string(),
        metadata: z.any(), // Metadata type from API
        persistedTakeoverAdmission: z.object({
          operationId: z.string().trim().min(1).max(256),
          attemptId: z.string().trim().min(1).max(256),
          phase: z.enum(['admit', 'runtime_bound']).optional(),
        }).strict().optional(),
      }).strict(),
      response: {
        200: z.object({
          status: z.literal('ok')
        }),
        401: authSchema401,
        503: z.object({
          status: z.literal('error'),
          errorCode: z.enum([
            'session_startup_reconciliation_failed',
            'persisted_takeover_admission_failed',
            'persisted_takeover_admission_upgrade_required',
          ]),
        }),
      }
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { sessionId, metadata, persistedTakeoverAdmission } = request.body;

    if (persistedTakeoverAdmission) {
      // The host sends this strict, attempt-scoped request only after its ordinary startup
      // report has completed. Admission must not replay that report or its spawn-nonce side effect.
      if (!admitPersistedTakeover || !persistedTakeoverAdmission.phase) {
        reply.code(503);
        return {
          status: 'error' as const,
          errorCode: 'persisted_takeover_admission_upgrade_required' as const,
        };
      }
      const requestLifetime = new AbortController();
      const abortRequestLifetime = () => {
        if (!requestLifetime.signal.aborted) {
          requestLifetime.abort(
            new Error('Persisted takeover admission control request ended'),
          );
        }
      };
      const abortIfResponseDidNotFinish = () => {
        if (!reply.raw.writableEnded) {
          abortRequestLifetime();
        }
      };
      request.raw.once('aborted', abortRequestLifetime);
      reply.raw.once('close', abortIfResponseDidNotFinish);
      if (request.raw.aborted) {
        abortRequestLifetime();
      }
      try {
        await admitPersistedTakeover({
          sessionId,
          operationId: persistedTakeoverAdmission.operationId,
          attemptId: persistedTakeoverAdmission.attemptId,
          phase: persistedTakeoverAdmission.phase,
          signal: requestLifetime.signal,
        });
        return { status: 'ok' as const };
      } catch (error) {
        logger.debug('[CONTROL SERVER] Persisted takeover admission failed', error);
        reply.code(503);
        return {
          status: 'error' as const,
          errorCode: 'persisted_takeover_admission_failed' as const,
        };
      } finally {
        request.raw.removeListener('aborted', abortRequestLifetime);
        reply.raw.removeListener('close', abortIfResponseDidNotFinish);
      }
    }

    logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
    let requiredReadiness: Promise<void>;
    try {
      requiredReadiness = Promise.resolve(onHappySessionWebhook(sessionId, metadata));
    } catch (error) {
      requiredReadiness = Promise.reject(error);
    }
    try {
      await requiredReadiness;
    } catch (error) {
      logger.debug('[CONTROL SERVER] Session startup reconciliation failed', error);
      reply.code(503);
      return {
        status: 'error' as const,
        errorCode: 'session_startup_reconciliation_failed' as const,
      };
    }
    markSpawnNonceFromTrackedSession(sessionId);

    return { status: 'ok' as const };
  });

  typed.post('/connected-service-runtime-auth/failure', {
    schema: {
      body: z.object({
        reportId: z.string().min(1).max(256).optional(),
        originDaemonExecutionGenerationV1: z.string().min(1).max(256).optional(),
        sessionId: z.string().min(1),
        switchesThisTurn: z.number().int().nonnegative().optional(),
        resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
        classification: z.object({
          kind: ConnectedServiceRuntimeAuthFailureKindSchema,
          serviceId: z.string().min(1),
          profileId: z.string().nullable(),
          groupId: z.string().nullable(),
          resetsAtMs: z.number().nullable(),
          planType: z.string().nullable(),
          rateLimits: z.unknown().nullable(),
          source: z.enum(['structured_provider_error', 'stable_provider_message', 'provider_runtime_marker']),
        }).passthrough(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
          resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
          recoveryReceipt: z.object({
            reportId: z.string().min(1).max(256),
            attemptId: z.string().min(1).max(256),
          }).optional(),
        }),
        401: authSchema401,
        400: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_runtime_auth_invalid_classification'),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_runtime_auth_handler_unavailable'),
        }),
        503: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_runtime_auth_recovery_intake_failed'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    return await claimRuntimeAuthReport({
      reportId: request.body.reportId,
      retainSettled: (result) => result.ok === true,
      onResult: (result) => {
        if (result.ok === true) return;
        reply.code(
          result.errorCode === 'connected_service_runtime_auth_invalid_classification'
            ? 400
            : result.errorCode === 'connected_service_runtime_auth_handler_unavailable'
              ? 501
              : 503,
        );
      },
      execute: async () => {
    if (!handleConnectedServiceRuntimeAuthFailure) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_runtime_auth_handler_unavailable' as const,
      };
    }
    const startedAtMs = Date.now();
    const sessionId = request.body.sessionId;
    const switchesThisTurn = request.body.switchesThisTurn ?? 0;
    let classification = sanitizeConnectedServiceRuntimeFailureClassification(request.body.classification);
    if (!classification) {
      reply.code(400);
      return {
        ok: false as const,
        errorCode: 'connected_service_runtime_auth_invalid_classification' as const,
      };
    }
    const resolvedResumePromptMode = await (resolveConnectedServiceRuntimeAuthResumePromptMode?.({
      classification,
      ...(request.body.resumePromptMode ? { explicit: request.body.resumePromptMode } : {}),
    }) ?? Promise.resolve(request.body.resumePromptMode ?? 'standard')).catch(() => 'standard' as const);
    let resumePromptMode = resolvedResumePromptMode;
    if (daemonStopRequested || isShuttingDown?.() === true) {
      return {
        ok: true as const,
        result: {
          status: 'daemon_lifecycle_unavailable' as const,
          reason: 'recovery_deferred_shutdown' as const,
        },
      };
    }
    let sourceAuthorization: Awaited<ReturnType<NonNullable<
      typeof authorizeConnectedServiceRuntimeAuthFailure
    >>> | undefined;
    try {
      sourceAuthorization = await authorizeConnectedServiceRuntimeAuthFailure?.({ sessionId, classification });
    } catch (error) {
      logger.warn('[CONTROL SERVER] Connected-service runtime auth source verification unavailable', {
        sessionId,
        serviceId: classification.serviceId,
        error: readSafeDaemonControlErrorDiagnostic(error),
      });
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'connected_service_runtime_auth_recovery_intake_failed' as const,
      };
    }
    if (sourceAuthorization && sourceAuthorization.status !== 'authorized') {
      return { ok: true as const, result: sourceAuthorization };
    }
    classification = applyAuthorizedRuntimeAuthFailureSourceBinding(classification, sourceAuthorization);
    const intake = await beginRuntimeAuthRecoveryIntake({
      ...(request.body.reportId ? { reportId: request.body.reportId } : {}),
      runtimeAuthRecoveryScheduler,
      sessionId,
      switchesThisTurn,
      classification,
      resumePromptMode,
    });
    if (!intake.ok) {
      const diagnostic = readSafeDaemonControlErrorDiagnostic(intake.error);
      logger.warn('[CONTROL SERVER] Connected-service runtime auth recovery intake failed', {
        ...buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
          sessionId,
          classification,
          handlerFailure: {
            errorCode: 'runtime_auth_recovery_intake_failed',
            errorName: diagnostic.name,
            errorMessage: diagnostic.message,
          },
          routedThroughFsm: false,
          startedAtMs,
          finishedAtMs: Date.now(),
        }),
        kind: classification.kind,
        error: diagnostic,
      });
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'connected_service_runtime_auth_recovery_intake_failed' as const,
      };
    }
    if (intake.created) {
      resumePromptMode = readRuntimeAuthRecoveryResumePromptMode(intake.recovery);
    }
    const recoveryAttemptId = readRuntimeAuthRecoveryAttemptId(intake.recovery);
    const recoveryReceipt = request.body.reportId && recoveryAttemptId
      ? {
          reportId: request.body.reportId,
          attemptId: recoveryAttemptId,
        }
      : null;
    const buildAcceptedResponse = (result: unknown) => ({
      ok: true as const,
      result,
      ...(resolveConnectedServiceRuntimeAuthResumePromptMode ? { resumePromptMode } : {}),
      ...(recoveryReceipt ? { recoveryReceipt } : {}),
    });
    try {
      const result = await handleConnectedServiceRuntimeAuthFailure({
        sessionId,
        switchesThisTurn,
        ...(request.body.reportId ? { interruptedOriginId: request.body.reportId } : {}),
        resumePromptMode,
        classification,
        ...(sourceAuthorization ? { sourceAuthorization } : {}),
      });
      if (isConnectedServiceRuntimeAuthApplyFailure(result) && runtimeAuthRecoveryScheduler) {
        try {
          const recovery = await runtimeAuthRecoveryScheduler.enqueueApplyFailure({
            ...(request.body.reportId ? { reportId: request.body.reportId } : {}),
            ...(recoveryAttemptId ? { expectedAttemptId: recoveryAttemptId } : {}),
            sessionId,
            switchesThisTurn,
            classification,
            result,
          });
          if (isRuntimeAuthRecoveryScheduled(recovery)) {
            return buildAcceptedResponse({
                ...buildRuntimeAuthRecoveryScheduledResult({
                  classification,
                  recovery,
                  originalResult: result,
                }),
            });
          }
        } catch (schedulerError) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after apply failure', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(schedulerError),
          });
        }
      }
      await runtimeAuthRecoveryScheduler?.settleResultByKey?.({
        sessionId,
        serviceId: classification.serviceId,
        profileId: classification.profileId ?? null,
        groupId: classification.groupId ?? null,
        ...(recoveryAttemptId ? { expectedAttemptId: recoveryAttemptId } : {}),
        result,
        classificationFailureKind: classification.kind,
        classificationResetsAtMs: classification.resetsAtMs ?? null,
      }).catch((error) => {
        logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery result settlement failed', {
          sessionId,
          error: readSafeDaemonControlErrorDiagnostic(error),
        });
      });
      if (isLocallyCompleteWithoutProof(result)) {
        await runtimeAuthRecoveryScheduler?.markAwaitingProviderOutcomeProofByKey?.({
          sessionId,
          serviceId: classification.serviceId,
          profileId: classification.profileId ?? null,
          groupId: classification.groupId ?? null,
          ...(recoveryAttemptId ? { expectedAttemptId: recoveryAttemptId } : {}),
          result,
        }).catch((error) => {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery proof-wait mark failed after local completion', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        });
      }
      return buildAcceptedResponse(result);
    } catch (error) {
      const diagnostic = readSafeDaemonControlErrorDiagnostic(error);
      logger.warn('[CONTROL SERVER] Connected-service runtime auth failure handler failed', {
        ...buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
          sessionId,
          classification,
          handlerFailure: {
            errorCode: 'unexpected_error',
            errorName: diagnostic.name,
            errorMessage: diagnostic.message,
          },
          routedThroughFsm: false,
          startedAtMs,
          finishedAtMs: Date.now(),
        }),
        kind: classification.kind,
        error: diagnostic,
      });
      if (runtimeAuthRecoveryScheduler) {
        try {
          const recovery = await runtimeAuthRecoveryScheduler.enqueueHandlerFailure({
            ...(request.body.reportId ? { reportId: request.body.reportId } : {}),
            ...(recoveryAttemptId ? { expectedAttemptId: recoveryAttemptId } : {}),
            sessionId,
            switchesThisTurn,
            classification,
            error,
          });
          if (isRuntimeAuthRecoveryScheduled(recovery)) {
            return buildAcceptedResponse({
                ...buildRuntimeAuthRecoveryScheduledResult({
                  classification,
                  recovery,
                }),
            });
          }
        } catch (schedulerError) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after handler failure', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(schedulerError),
          });
        }
      }
      return buildAcceptedResponse({
          status: 'recovery_handler_failed' as const,
          errorCode: 'unexpected_error' as const,
      });
    }
      },
    });
  });

  typed.post('/connected-service-turn-lifecycle', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        turnId: z.string().trim().min(1).max(512).optional(),
        event: z.enum(['prompt_or_steer', 'task_started', 'assistant_message_end', 'turn_cancelled']),
        terminalStatus: z.enum(['completed', 'failed']).optional(),
        connectedServiceSelectionsEnvRaw: z.string().min(1).max(64 * 1024).optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_turn_lifecycle_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!handleConnectedServiceTurnLifecycle) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_turn_lifecycle_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceTurnLifecycle({
      sessionId: request.body.sessionId,
      ...(request.body.turnId ? { turnId: request.body.turnId } : {}),
      event: request.body.event,
      ...(request.body.terminalStatus ? { terminalStatus: request.body.terminalStatus } : {}),
      ...(request.body.connectedServiceSelectionsEnvRaw
        ? { connectedServiceSelectionsEnvRaw: request.body.connectedServiceSelectionsEnvRaw }
        : {}),
    });
    return { ok: true as const, result };
  });

  typed.post('/connected-service-usage-limit/wait-resume-cancel', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        attemptId: z.string().trim().min(1),
      }),
      response: {
        200: z.object({ ok: z.literal(true), result: z.unknown() }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_usage_limit_wait_resume_cancel_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleConnectedServiceUsageLimitWaitResumeCancel) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_usage_limit_wait_resume_cancel_handler_unavailable' as const,
      };
    }
    return {
      ok: true as const,
      result: await handleConnectedServiceUsageLimitWaitResumeCancel(request.body),
    };
  });

  typed.post('/connected-service-quota-recovery-credit/consume', {
    schema: {
      body: z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: z.string().trim().min(1),
        idempotencyKey: z.string().trim().min(1).max(256),
        providerCreditId: z.string().trim().min(1).max(256).optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        503: z.object({
          ok: z.literal(false),
          errorCode: z.literal('daemon_shutting_down'),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_quota_recovery_credit_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!handleConnectedServiceQuotaRecoveryCreditConsume) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_quota_recovery_credit_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceQuotaRecoveryCreditConsume({
      serviceId: request.body.serviceId,
      profileId: request.body.profileId,
      idempotencyKey: request.body.idempotencyKey,
      ...(request.body.providerCreditId ? { providerCreditId: request.body.providerCreditId } : {}),
    });
    return { ok: true as const, result };
  });

	  typed.post('/provider-account-usage-snapshot', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        snapshot: ProviderAccountUsageSnapshotV1Schema,
        source: ConnectedServiceUsageSourceV1Schema.optional(),
        credentialFingerprint: z.string().regex(/^sha256:[a-f0-9]{8}$/u).nullable().optional(),
        policyDisposition: z.literal('evidence_only').optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        503: z.union([
          daemonShuttingDownRouteResponseSchema,
          z.object({
            ok: z.literal(false),
            errorCode: z.literal('provider_account_usage_snapshot_intake_failed'),
          }),
        ]),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('provider_account_usage_snapshot_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!handleProviderAccountUsageSnapshot) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'provider_account_usage_snapshot_handler_unavailable' as const,
      };
    }
    try {
      const result = await handleProviderAccountUsageSnapshot({
        sessionId: request.body.sessionId,
        snapshot: request.body.snapshot,
        ...(request.body.source ? { source: request.body.source } : {}),
        ...(request.body.credentialFingerprint !== undefined ? { credentialFingerprint: request.body.credentialFingerprint } : {}),
        ...(request.body.policyDisposition ? { policyDisposition: request.body.policyDisposition } : {}),
      });
      if (!isProviderAccountUsageSnapshotIntakeAccepted(result)) {
        throw new Error('provider_account_usage_snapshot_canonical_custody_unavailable');
      }
      return { ok: true as const, result };
    } catch (error) {
      logger.warn('[CONTROL SERVER] Provider account usage snapshot canonical intake failed', {
        sessionId: request.body.sessionId,
        error: readSafeDaemonControlErrorDiagnostic(error),
      });
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'provider_account_usage_snapshot_intake_failed' as const,
      };
    }
	  });

	  typed.post('/provider-account-usage-adoption', {
	    schema: {
	      body: z.object({
	        sessionId: z.string().min(1),
	        adoption: ProviderAccountUsageAdoptionV1Schema,
	      }),
	      response: {
	        200: z.object({
	          ok: z.literal(true),
	          result: z.unknown(),
	        }),
        401: authSchema401,
        503: z.object({
          ok: z.literal(false),
          errorCode: z.union([
            z.literal('daemon_shutting_down'),
            z.literal('provider_account_usage_adoption_intake_failed'),
          ]),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('provider_account_usage_adoption_handler_unavailable'),
        }),
	      },
	    },
	    preHandler: requireAuth,
	  }, async (request, reply) => {
        if (isDaemonQuiescing()) {
          reply.code(503);
          return daemonShuttingDownResponse();
        }
	    if (!handleProviderAccountUsageAdoption) {
	      reply.code(501);
	      return {
	        ok: false as const,
	        errorCode: 'provider_account_usage_adoption_handler_unavailable' as const,
	      };
	    }
      try {
        const result = await handleProviderAccountUsageAdoption({
          sessionId: request.body.sessionId,
          adoption: request.body.adoption,
        });
        if (!isProviderAccountUsageAdoptionIntakeAccepted(result)) {
          throw new Error('provider_account_usage_adoption_canonical_custody_unavailable');
        }
        return { ok: true as const, result };
      } catch (error) {
        logger.warn('[CONTROL SERVER] Provider account usage adoption canonical intake failed', {
          sessionId: request.body.sessionId,
          error: readSafeDaemonControlErrorDiagnostic(error),
        });
        reply.code(503);
        return {
          ok: false as const,
          errorCode: 'provider_account_usage_adoption_intake_failed' as const,
        };
      }
	  });

  // Execution-run connected-services bridge: the RUNNER (which spawns run backends in-process)
  // asks the daemon — the sole connected-services owner — to resolve + materialize the selected
  // auth for a RUN-scoped materialization key and register the run PID as a runtime-registry
  // target. Gated by the SCOPED run-materialize capability token (master token rejected).
  typed.post(CONNECTED_SERVICE_RUN_MATERIALIZE_PATH, {
    schema: {
      body: ConnectedServiceRunMaterializeRequestSchema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.object({
            activationId: z.string().uuid(),
            env: z.record(z.string(), z.string()),
            connectedServicesBindings: z.unknown(),
            registration: ExecutionRunConnectedServicesRegistrationV1Schema,
          }),
        }),
        401: authSchema401,
        403: z.object({
          ok: z.literal(false),
          errorCode: z.literal(CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.blocked),
          errorMessage: z.string().optional(),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal(CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.unavailable),
        }),
      },
    },
    preHandler: requireRunMaterializeAuth,
  }, async (request, reply) => {
    if (!materializeConnectedServicesForExecutionRun) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.unavailable,
      };
    }
    const result = await materializeConnectedServicesForExecutionRun(request.body);
    if (!result.ok) {
      reply.code(403);
      return {
        ok: false as const,
        errorCode: result.errorCode,
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      };
    }
    return {
      ok: true as const,
      result: {
        activationId: result.activationId,
        env: { ...result.env },
        connectedServicesBindings: result.connectedServicesBindings,
        registration: result.registration,
      },
    };
  });

  typed.post(CONNECTED_SERVICE_RUN_GENERATION_CURRENT_PATH, {
    schema: {
      body: ConnectedServiceRunGenerationCurrentRequestSchema,
      response: {
        200: z.object({ ok: z.literal(true), current: z.boolean() }),
        401: authSchema401,
      },
    },
    preHandler: requireRunMaterializeAuth,
  }, async (request) => {
    if (!checkConnectedServicesGenerationForExecutionRun) {
      return { ok: true as const, current: false };
    }
    return await checkConnectedServicesGenerationForExecutionRun(request.body);
  });

  // Execution-run release: unregister the run from the canonical runtime registry and run retained
  // materialization cleanup. Best-effort at run end — a missing handler is a bounded no-op so
  // run teardown never blocks on daemon wiring.
  typed.post(CONNECTED_SERVICE_RUN_RELEASE_PATH, {
    schema: {
      body: ConnectedServiceRunReleaseRequestSchema,
      response: {
        200: z.object({ ok: z.literal(true), released: z.boolean() }),
        401: authSchema401,
      },
    },
    preHandler: requireRunMaterializeAuth,
  }, async (request) => {
    if (!releaseConnectedServicesForExecutionRun) {
      return { ok: true as const, released: false };
    }
    return await releaseConnectedServicesForExecutionRun(request.body);
  });

  // List all tracked sessions
  typed.post('/list', {
    schema: {
      response: {
        200: z.object({
          children: z.array(z.object({
            startedBy: z.string(),
            happySessionId: z.string(),
            pid: z.number()
          }))
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    const children = getChildren();
    logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
    return { 
      children: children
        .filter(child => child.happySessionId !== undefined)
        .map(child => ({
          startedBy: child.startedBy,
          happySessionId: child.happySessionId!,
          pid: child.pid
        }))
    }
  });

  typed.post('/local-services/inventory/snapshot', {
    schema: {
      response: {
        200: z.object({ ok: z.literal(true), snapshot: z.unknown() }),
        401: authSchema401,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_inventory_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
    if (!localServicesInventory) {
      reply.code(501);
      return { ok: false as const, errorCode: 'local_services_inventory_unavailable' as const };
    }
    return { ok: true as const, snapshot: await localServicesInventory.getSnapshot() };
  });

  typed.post('/local-services/inventory/refresh', {
    schema: {
      response: {
        200: z.object({ ok: z.literal(true), snapshot: z.unknown() }),
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_inventory_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!localServicesInventory) {
      reply.code(501);
      return { ok: false as const, errorCode: 'local_services_inventory_unavailable' as const };
    }
    return { ok: true as const, snapshot: await localServicesInventory.refreshSnapshot() };
  });

  typed.post('/local-services/inventory/labels/patch', {
    schema: {
      body: z.object({
        inventoryId: z.string().trim().min(1),
        label: z.object({ text: z.string().trim().min(1).max(200) }),
        source: z.enum(['user', 'plugin']).optional().default('user'),
      }),
      response: {
        200: z.object({ ok: z.literal(true) }),
        401: authSchema401,
        404: z.object({ ok: z.literal(false), reason: z.literal('unknown_inventory_entry') }),
        503: daemonShuttingDownRouteResponseSchema,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_inventory_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!localServicesInventory) {
      reply.code(501);
      return { ok: false as const, errorCode: 'local_services_inventory_unavailable' as const };
    }
    const result = await localServicesInventory.patchLabel({
      inventoryId: request.body.inventoryId,
      label: request.body.label,
      source: request.body.source,
      now: Date.now(),
    });
    if (!result.ok) {
      reply.code(404);
    }
    return result;
  });

  typed.post('/local-services/preview/snapshot', {
    schema: {
      response: {
        200: z.object({ ok: z.literal(true), snapshot: LocalServicePreviewSnapshotV1Schema }),
        401: authSchema401,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_preview_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
    if (!localServicesPreview) {
      reply.code(501);
      return { ok: false as const, errorCode: 'local_services_preview_unavailable' as const };
    }
    return { ok: true as const, snapshot: await localServicesPreview.getSnapshot() };
  });

  typed.post('/local-services/public-preview/status', {
    schema: {
      body: DaemonLocalServicePublicPreviewStatusRequestV1Schema,
      response: {
        200: z.object({ ok: z.literal(true), snapshot: LocalServicePublicPreviewSnapshotV1Schema }),
        401: authSchema401,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_public_preview_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!localServicesPublicPreview) {
      reply.code(501);
      return { ok: false as const, errorCode: 'local_services_public_preview_unavailable' as const };
    }
    return { ok: true as const, snapshot: await localServicesPublicPreview.getStatus(request.body) };
  });

  typed.post('/local-services/launcher/snapshot', {
    schema: {
      response: {
        200: z.object({ ok: z.literal(true), snapshot: LocalServiceLauncherSnapshotV1Schema }),
        401: authSchema401,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_launcher_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
    if (!localServicesLauncher) {
      reply.code(501);
      return { ok: false as const, errorCode: 'local_services_launcher_unavailable' as const };
    }
    return { ok: true as const, snapshot: await localServicesLauncher.getSnapshot() };
  });

  typed.post('/devices/simulator/preview/snapshot', {
    schema: {
      response: {
        200: z.object({ ok: z.literal(true), snapshot: SimulatorPreviewSnapshotV1Schema }),
        401: authSchema401,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('simulator_preview_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
    if (!simulatorPreview) {
      reply.code(501);
      return { ok: false as const, errorCode: 'simulator_preview_unavailable' as const };
    }
    return { ok: true as const, snapshot: await simulatorPreview.getSnapshot() };
  });

  typed.post('/devices/simulator/preview/action', {
    schema: {
      body: DaemonSimulatorPreviewActionRequestV1Schema,
      response: {
        200: z.object({ ok: z.literal(true), result: SimulatorPreviewActionResultV1Schema }),
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('simulator_preview_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!simulatorPreview) {
      reply.code(501);
      return { ok: false as const, errorCode: 'simulator_preview_unavailable' as const };
    }
    return { ok: true as const, result: await simulatorPreview.dispatchAction(request.body.event) };
  });

  typed.post('/local-services/actions/execute', {
    schema: {
      body: LocalServiceActionRequestV1Schema,
      response: {
        200: z.object({ ok: z.literal(true), result: LocalServiceActionResultV1Schema }),
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_actions_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!localServicesActions) {
      reply.code(501);
      return { ok: false as const, errorCode: 'local_services_actions_unavailable' as const };
    }
    return { ok: true as const, result: await localServicesActions.execute(request.body) };
  });

  typed.post('/local-services/plugin/bridge', {
    schema: {
      body: PluginLocalServicesBridgeControlRequestV1Schema,
      response: {
        200: PluginLocalServicesBridgeControlResponseV1Schema,
        401: authSchema401,
        403: z.object({
          ok: z.literal(false),
          errorCode: z.literal('local_services_plugin_bridge_forbidden'),
        }),
        503: daemonShuttingDownRouteResponseSchema,
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_plugin_bridge_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!localServicesPluginBridge) {
      reply.code(501);
      return { ok: false as const, errorCode: 'local_services_plugin_bridge_unavailable' as const };
    }
    if (!isPluginLocalServicesBridgeRequestAuthorized(request.body, getChildren())) {
      reply.code(403);
      return { ok: false as const, errorCode: 'local_services_plugin_bridge_forbidden' as const };
    }
    const dispatchRequest: PluginLocalServicesBridgeControlRequestV1 = {
      protocolVersion: request.body.protocolVersion,
      context: request.body.context,
      operation: request.body.operation,
    };
    return await localServicesPluginBridge.dispatch(dispatchRequest);
  });

  typed.post(AGENT_RUNTIME_DAEMON_BRIDGE_PATH, {
    schema: {
      body: AgentRuntimeDaemonBridgeRequestV1Schema,
      response: {
        200: AgentRuntimeDaemonBridgeResponseV1Schema,
        401: authSchema401,
        403: AgentRuntimeDaemonBridgeResponseV1Schema,
        503: daemonShuttingDownRouteResponseSchema,
        501: AgentRuntimeDaemonBridgeResponseV1Schema,
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!agentRuntimeSessionBridge) {
      reply.code(501);
      return {
        ok: false as const,
        error: {
          code: 'agent_runtime_daemon_bridge_unavailable',
          message: 'Agent runtime daemon bridge is unavailable',
        },
      };
    }
    if (
      !isAgentRuntimeSessionBridgeRequestAuthorized(request.body, getChildren())
      && !foregroundAgentRuntimeAdmission?.isBridgeRequestAuthorized(
        request.body,
      )
    ) {
      reply.code(403);
      return {
        ok: false as const,
        error: {
          code: 'agent_runtime_daemon_bridge_forbidden',
          message: 'Agent runtime daemon bridge request is forbidden',
        },
      };
    }
    return await agentRuntimeSessionBridge.dispatch(request.body);
  });

  typed.post(FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH, {
    schema: {
      body: ForegroundAgentRuntimeAdmissionRequestV1Schema,
      response: {
        200: ForegroundAgentRuntimeAdmissionResponseV1Schema,
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!foregroundAgentRuntimeAdmission) {
      return {
        ok: false as const,
        error: createProviderErrorV1(
          'provider_agent_runtime_unsupported',
          { machineId },
        ),
      };
    }
    return await foregroundAgentRuntimeAdmission.admit({
      ...request.body,
      machineId,
    });
  });

  typed.post(FOREGROUND_AGENT_RUNTIME_RELEASE_PATH, {
    schema: {
      body: ForegroundAgentRuntimeReleaseRequestV1Schema,
      response: {
        200: ForegroundAgentRuntimeReleaseResponseV1Schema,
        401: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    await foregroundAgentRuntimeAdmission?.release(
      request.body.attemptId,
      request.body.sessionId,
    );
    return { ok: true as const };
  });

  typed.post('/ssh-tunnels/ensure', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.unknown(),
        400: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownErrorResponse();
    }
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    const parsed = SshTunnelEnsureRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, errorCode: 'ssh_tunnel_invalid_request', error: 'ssh_tunnel_invalid_request' };
    }
    try {
      return { ok: true as const, lease: await sshTunnels.ensureTunnel(parsed.data) };
    } catch (error) {
      const response = toSshTunnelErrorResponse(error);
      if (response) {
        reply.code(503);
        return response;
      }
      throw error;
    }
  });

  typed.post('/ssh-tunnels/list', {
    schema: {
      response: {
        200: z.unknown(),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    return { ok: true as const, tunnels: await sshTunnels.listTunnels() };
  });

  typed.post('/ssh-tunnels/probe', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.unknown(),
        400: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    const parsed = SshTunnelProbeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, errorCode: 'ssh_tunnel_invalid_request', error: 'ssh_tunnel_invalid_request' };
    }
    try {
      return { ok: true as const, health: await sshTunnels.probeTunnel(parsed.data.tunnelKey) };
    } catch (error) {
      const response = toSshTunnelErrorResponse(error);
      if (response) {
        reply.code(503);
        return response;
      }
      throw error;
    }
  });

  typed.post('/ssh-tunnels/release', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.unknown(),
        400: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownErrorResponse();
    }
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    const parsed = SshTunnelReleaseRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, errorCode: 'ssh_tunnel_invalid_request', error: 'ssh_tunnel_invalid_request' };
    }
    try {
      await sshTunnels.releaseTunnel(parsed.data.leaseId);
      return { ok: true as const };
    } catch (error) {
      const response = toSshTunnelErrorResponse(error);
      if (response) {
        reply.code(503);
        return response;
      }
      throw error;
    }
  });

  typed.post('/ssh-tunnels/stop', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.unknown(),
        400: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownErrorResponse();
    }
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    const parsed = SshTunnelStopRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, errorCode: 'ssh_tunnel_invalid_request', error: 'ssh_tunnel_invalid_request' };
    }
    try {
      await sshTunnels.stopTunnel(parsed.data.tunnelKey);
      return { ok: true as const };
    } catch (error) {
      const response = toSshTunnelErrorResponse(error);
      if (response) {
        reply.code(503);
        return response;
      }
      throw error;
    }
  });

  // Stop specific session
  typed.post('/stop-session', {
    schema: {
      body: z.object({
        sessionId: z.string()
      }),
      response: {
        200: StopSessionResultSchema,
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const { sessionId } = request.body;

    logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
    return await stopSession(sessionId);
  });

  // Spawn new session
      typed.post('/spawn-session', {
        schema: {
          body: z.unknown(),
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          approvedNewDirectoryCreation: z.boolean().optional()
        }),
        202: z.object({
          success: z.literal(false),
          status: z.literal('pending'),
          errorCode: z.literal(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT),
        }),
        400: z.object({
          success: z.boolean(),
          error: z.string(),
          errorCode: z.string().optional(),
        }),
        401: authSchema401,
        409: z.object({
          success: z.boolean(),
          requiresUserApproval: z.boolean().optional(),
          actionRequired: z.string().optional(),
          directory: z.string().optional()
        }),
        503: z.object({
          success: z.literal(false),
          error: z.string(),
          errorCode: z.literal('daemon_shutting_down'),
        }),
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
        })
      }
    },
    preHandler: requireAuth,
      }, async (request, reply) => {
        if (isDaemonQuiescing()) {
          reply.code(503);
          return spawnDaemonShuttingDownResponse();
        }
        const parsedRequest = SpawnDaemonSessionRequestSchema.safeParse(request.body);
        if (!parsedRequest.success) {
          sendBadRequest(reply, {
            success: false,
            error: 'Invalid params',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          });
          return;
        }

        const requestBody = parsedRequest.data;
        const { directory, sessionId, existingSessionId } = requestBody;
        const spawnNonce = typeof requestBody.spawnNonce === 'string' ? requestBody.spawnNonce.trim() : '';
        const nonceAdmission = claimSpawnNonceAdmission(spawnNonce);
        if (nonceAdmission.type === 'success') {
          return {
            success: true,
            sessionId: nonceAdmission.sessionId,
            approvedNewDirectoryCreation: true,
          };
        }
        if (nonceAdmission.type === 'pending') {
          reply.code(202);
          return {
            success: false as const,
            status: 'pending' as const,
            errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          };
        }

    logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
        let result: SpawnSessionResult;
        try {
          const normalizedExistingSessionId = typeof existingSessionId === 'string' && existingSessionId.trim().length > 0
            ? existingSessionId.trim()
            : undefined;
          result = await spawnSession(
            mergeSpawnSessionOptions(
              requestBody,
              normalizedExistingSessionId ? { existingSessionId: normalizedExistingSessionId } : {},
              normalizedExistingSessionId ? { omit: ['sessionId'] } : {},
            ) as SpawnSessionOptions,
          );
        } catch (error) {
          if (spawnNonce) {
            clearSpawnNonceCorrelation(spawnNonce);
          }
          const message = error instanceof Error ? error.message : String(error);
          const errorCode = resolveThrownSpawnSessionErrorCode(error);
          reply.code(500);
          return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode,
      };
    }

    switch (result.type) {
      case 'success':
        // Check if sessionId exists, if not return error
        if (!result.sessionId) {
          if (spawnNonce) {
            clearSpawnNonceCorrelation(spawnNonce);
          }
          reply.code(500);
          return {
            success: false,
            error: 'Failed to spawn session: no session ID returned'
          };
        }
        if (spawnNonce) {
          markSpawnNonceSuccess(spawnNonce, result.sessionId);
        }
        return {
          success: true,
          sessionId: result.sessionId,
          approvedNewDirectoryCreation: true
        };
      
      case 'requestToApproveDirectoryCreation':
        if (spawnNonce) {
          clearSpawnNonceCorrelation(spawnNonce);
        }
        reply.code(409); // Conflict - user input needed
        return { 
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory
        };
      
      case 'error':
        if (spawnNonce && result.errorCode !== SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT) {
          clearSpawnNonceCorrelation(spawnNonce);
        }
        if (spawnNonce && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT) {
          reply.code(202);
          return {
            success: false as const,
            status: 'pending' as const,
            errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          };
        }
        reply.code(500);
        return { 
          success: false,
          error: result.errorMessage,
          errorCode: result.errorCode,
        };
    }
  });

  typed.post('/spawn-session/resolve', {
    schema: {
      body: z.object({
        spawnNonce: z.string(),
      }),
      response: {
        200: z.object({
          success: z.literal(true),
          status: z.enum(['success', 'pending', 'not_found']),
          sessionId: z.string().optional(),
        }),
        401: authSchema401,
      },
    },
    preHandler: requireAuth,
  }, async (request) => {
    const normalizedNonce = request.body.spawnNonce.trim();
    if (!normalizedNonce) {
      return {
        success: true as const,
        status: 'not_found' as const,
      };
    }

    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    const record = spawnNonceCorrelationByNonce.get(normalizedNonce);
    if (record) {
      if (record.status === 'success' && isCanonicalSessionId(record.sessionId)) {
        return {
          success: true as const,
          status: 'success' as const,
          sessionId: record.sessionId,
        };
      }
      if (record.status === 'pending') {
        return {
          success: true as const,
          status: 'pending' as const,
        };
      }
    }

    const tracked = readTrackedSpawnNonceAdmission(normalizedNonce);
    if (tracked) {
      if (tracked.type === 'success') {
        markSpawnNonceSuccess(normalizedNonce, tracked.sessionId);
        return {
          success: true as const,
          status: 'success' as const,
          sessionId: tracked.sessionId,
        };
      }
      markSpawnNoncePending(normalizedNonce);
      return {
        success: true as const,
        status: 'pending' as const,
      };
    }

    return {
      success: true as const,
      status: 'not_found' as const,
    };
  });

  typed.post('/continue-with-replay', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          approvedNewDirectoryCreation: z.boolean().optional(),
        }),
        400: z.object({
          success: z.boolean(),
          error: z.string(),
          errorCode: z.string().optional(),
        }),
        401: authSchema401,
        403: authSchema401,
        409: z.object({
          success: z.boolean(),
          requiresUserApproval: z.boolean().optional(),
          actionRequired: z.string().optional(),
          directory: z.string().optional(),
        }),
        503: z.object({
          success: z.literal(false),
          error: z.string(),
          errorCode: z.literal('daemon_shutting_down'),
        }),
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(503);
      return spawnDaemonShuttingDownResponse();
    }
    const parsedRequest = parseSessionContinueWithReplayRpcParamsCompatIngress(request.body);
    if (!parsedRequest.success) {
      sendBadRequest(reply, {
        success: false,
        error: 'Invalid params',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      });
      return;
    }
    const requestBody = parsedRequest.data;

    const resolvedBackend = getSessionHostBridge().resolveContinueWithReplayBackendTarget({
      backendTarget: requestBody.backendTarget,
    });
    if (!resolvedBackend.ok) {
      sendBadRequest(reply, {
        success: false,
        error: resolvedBackend.errorMessage,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      });
      return;
    }

    let result: SpawnSessionResult;
    try {
      result = await continueSessionWithReplay(
        {
          directory: requestBody.directory,
          backendTarget: resolvedBackend.backendTargetV2,
          approvedNewDirectoryCreation: requestBody.approvedNewDirectoryCreation,
          permissionMode: requestBody.permissionMode,
          permissionModeUpdatedAt: requestBody.permissionModeUpdatedAt,
          modelSelection: requestBody.modelSelection,
          replay: requestBody.replay,
        },
        { spawnSession },
      );
    } catch (error) {
      const authStatus = readAuthenticationStatus(error);
      if (authStatus) {
        reply.code(authStatus);
        return {
          success: false,
          error: 'not_authenticated',
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = resolveThrownSpawnSessionErrorCode(error);
      reply.code(500);
      return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode,
      };
    }

    switch (result.type) {
      case 'success':
        if (!result.sessionId) {
          reply.code(500);
          return { success: false, error: 'Failed to spawn session: no session ID returned' };
        }
        return { success: true, sessionId: result.sessionId, approvedNewDirectoryCreation: true };
      case 'requestToApproveDirectoryCreation':
        reply.code(409);
        return {
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory,
        };
      case 'error':
        reply.code(result.errorCode === SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST ? 400 : 500);
        return { success: false, error: result.errorMessage, errorCode: result.errorCode };
    }
  });

  typed.post('/restart', {
    schema: {
      body: z
        .object({
          stopSessions: z.boolean().optional(),
          restartSessionRunners: z.boolean().optional(),
          successorDistClosureFingerprint: DaemonDistClosureFingerprintSchema.optional(),
        })
        .strict()
        .nullish(),
      response: {
        202: z.object({
          status: z.enum(['restarting', 'already_restarting']),
        }),
        400: z.union([
          z.object({
            status: z.literal('unsupported_restart_options'),
          }),
          z.object({
            statusCode: z.literal(400),
            code: z.string(),
            error: z.string(),
            message: z.string(),
          }),
        ]),
        401: authSchema401,
        409: z.object({
          status: z.literal('shutting_down'),
        }),
        501: z.object({
          status: z.literal('restart_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isDaemonQuiescing()) {
      reply.code(409);
      return { status: 'shutting_down' as const };
    }
    if (!requestSelfRestart) {
      reply.code(501);
      return { status: 'restart_unavailable' as const };
    }
    if (
      request.body &&
      (request.body.stopSessions !== undefined || request.body.restartSessionRunners !== undefined)
    ) {
      reply.code(400);
      return { status: 'unsupported_restart_options' as const };
    }
    if (restartState === 'restarting') {
      reply.code(202);
      return { status: 'already_restarting' as const };
    }

    restartState = 'restarting';
    setTimeout(() => {
      void (async () => {
        try {
          const successorDistClosureFingerprint = request.body?.successorDistClosureFingerprint;
          await requestSelfRestart(
            successorDistClosureFingerprint ? { successorDistClosureFingerprint } : undefined,
          );
        } catch (error) {
          logger.debug('[CONTROL SERVER] Daemon self-restart request failed; keeping current daemon alive', error);
        } finally {
          restartState = 'idle';
        }
      })();
    }, 50);

    reply.code(202);
    return { status: 'restarting' as const };
  });

  // Stop daemon
  typed.post('/stop', {
    schema: {
      body: z
        .object({
          stopSessions: z.boolean().optional(),
          transferManagedLocalServices: z.boolean().optional(),
        })
        .strict()
        .nullish(),
      response: {
        200: z.object({
          status: z.string()
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const stopSessions = request.body?.stopSessions === true;
    const managedLocalServicesDisposition = request.body?.transferManagedLocalServices === true
      ? 'transfer' as const
      : 'permanent' as const;
    daemonStopRequested = true;
    logger.debug('[CONTROL SERVER] Stop daemon request received', {
      stopSessions,
      managedLocalServicesDisposition,
    });

    // Give time for response to arrive
    setTimeout(() => {
      logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
      const runBeforeShutdown = async (): Promise<void> => {
        if (!beforeShutdown) return;
        try {
          await beforeShutdown({ managedLocalServicesDisposition });
        } catch (error) {
          logger.debug('[CONTROL SERVER] beforeShutdown hook failed (best-effort)', error);
        }
      };

      void (async () => {
        try {
          if (stopSessions) {
            const children = getChildren();
            logger.debug(`[CONTROL SERVER] stopSessions requested: stopping ${children.length} tracked sessions`);
            for (const child of children) {
              const sessionId = typeof child.happySessionId === 'string' ? child.happySessionId.trim() : '';
              const fallbackSessionId =
                Number.isFinite(child.pid) && child.pid > 1 ? `PID-${Math.trunc(child.pid)}` : '';
              const id = sessionId || fallbackSessionId;
              if (!id) continue;
              if (prepareStopSession) {
                try {
                  // eslint-disable-next-line no-await-in-loop
                  await prepareStopSession(child);
                } catch (error) {
                  logger.debug(`[CONTROL SERVER] Failed to prepare session ${id} for stop`, error);
                }
              }
              try {
                // eslint-disable-next-line no-await-in-loop
                await stopSession(id);
              } catch (error) {
                logger.debug(`[CONTROL SERVER] Failed to stop session ${id}`, error);
              }
            }
          }
          await runBeforeShutdown();
        } catch (error) {
          logger.debug('[CONTROL SERVER] stopSessions failed', error);
        } finally {
          requestShutdown();
        }
      })();
    }, 50);

    return { status: 'stopping' };
  });

  return app;
}

export function startDaemonControlServer({
  getChildren,
  machineId,
  runtimeId = '',
  prepareStopSession,
  stopSession,
  spawnSession,
  requestShutdown,
  beforeShutdown,
  isShuttingDown,
  onHappySessionWebhook,
  admitPersistedTakeover,
  controlToken,
  connectedAccountRequestAuth,
  sshTunnels,
  localServicesInventory,
  localServicesLauncher,
  localServicesPreview,
  localServicesActions,
  localServicesPublicPreview,
  localServicesPluginBridge,
  agentRuntimeSessionBridge,
  foregroundAgentRuntimeAdmission,
  simulatorPreview,
  handleConnectedServiceRuntimeAuthFailure,
  authorizeConnectedServiceRuntimeAuthFailure,
  resolveConnectedServiceRuntimeAuthResumePromptMode,
  runtimeAuthRecoveryScheduler,
  handleSessionConnectedServiceAuthSwitch,
  handleSessionConnectedServiceRuntimeAuthRefresh,
  handleSessionRunnerRestart,
  handleSessionRunnerRestartAll,
  handleSessionRunnerStatusGet,
  handleConnectedServiceTurnLifecycle,
  handleConnectedServiceUsageLimitWaitResumeCancel,
  handleConnectedServiceQuotaRecoveryCreditConsume,
  handleProviderAccountUsageSnapshot,
  handleProviderAccountUsageAdoption,
  verifyRunMaterializeToken,
  materializeConnectedServicesForExecutionRun,
  checkConnectedServicesGenerationForExecutionRun,
  releaseConnectedServicesForExecutionRun,
  requestSelfRestart,
  pluginChangeService,
  pluginActionCurrentIntent,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  runtimeId?: string;
  prepareStopSession?: (trackedSession: TrackedSession) => Promise<void> | void;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: (input: Readonly<{
    managedLocalServicesDisposition: 'permanent' | 'transfer';
  }>) => Promise<void>;
  // True once daemon shutdown / control-server stop has begun. Recovery handlers early-return when
  // set so switch/restart work is never run into a tearing-down daemon (a deferral, not an attempt).
  isShuttingDown?: () => boolean;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void | Promise<void>;
  admitPersistedTakeover?: (input: Readonly<{
    sessionId: string;
    operationId: string;
    attemptId: string;
    phase: 'admit' | 'runtime_bound';
    signal: AbortSignal;
  }>) => Promise<void>;
  controlToken: string;
  connectedAccountRequestAuth?: ConnectedAccountRequestAuthControlRoutes;
  /** Validates the scoped execution-run materialization token (see createDaemonControlApp). */
  verifyRunMaterializeToken?: (provided: string) => boolean;
  /** Execution-run connected-services materialization handler (see createDaemonControlApp). */
  materializeConnectedServicesForExecutionRun?: ConnectedServiceRunMaterializationHandler;
  /** Exact run-key current-generation admission check before provider Send/Steer. */
  checkConnectedServicesGenerationForExecutionRun?: ConnectedServiceRunGenerationCurrentHandler;
  /** Execution-run connected-services release handler (see createDaemonControlApp). */
  releaseConnectedServicesForExecutionRun?: ConnectedServiceRunReleaseHandler;
  sshTunnels?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
  localServicesInventory?: LocalServiceInventoryRoutes;
  localServicesLauncher?: LocalServiceLauncherRoutes;
  localServicesManaged?: LocalServiceManagedRoutes;
  localServicesPreview?: Pick<LocalServicePreviewRoutes, 'getSnapshot'>;
  localServicesActions?: LocalServiceActionRoutes;
  localServicesPublicPreview?: LocalServicePublicPreviewRoutes;
  localServicesPluginBridge?: PluginLocalServicesBridgeControlRoutes;
  agentRuntimeSessionBridge?: AgentRuntimeSessionBridgeControlRoutes;
  foregroundAgentRuntimeAdmission?: ForegroundAgentRuntimeAdmissionOwner;
  simulatorPreview?: SimulatorPreviewRoutes;
  handleConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    interruptedOriginId?: string;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
    classification: ConnectedServiceRuntimeFailureClassification;
    sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
  }>) => Promise<unknown>;
  authorizeConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => Promise<RuntimeAuthFailureSourceAuthorization>;
  resolveConnectedServiceRuntimeAuthResumePromptMode?: (input: Readonly<{
    classification: ConnectedServiceRuntimeFailureClassification;
    explicit?: SessionUsageLimitRecoveryResumePromptModeV1;
  }>) => Promise<SessionUsageLimitRecoveryResumePromptModeV1>;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerLike | null;
  handleConnectedServiceTurnLifecycle?: (input: Readonly<{
    sessionId: string;
    turnId?: string;
    event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
    terminalStatus?: 'completed' | 'failed';
    connectedServiceSelectionsEnvRaw?: string;
  }>) => Promise<unknown>;
  handleConnectedServiceUsageLimitWaitResumeCancel?: (input: Readonly<{
    sessionId: string;
    attemptId: string;
  }>) => Promise<unknown>;
  handleSessionConnectedServiceAuthSwitch?: (input: Readonly<{
    sessionId: string;
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
  }>) => Promise<unknown>;
  handleSessionConnectedServiceRuntimeAuthRefresh?: SessionConnectedServiceRuntimeAuthRefreshHandler;
  handleSessionRunnerRestart?: (request: RestartSessionRunnerRequestV1) => Promise<RestartSessionRunnerResultV1>;
  handleSessionRunnerRestartAll?: (request: RestartAllSessionRunnersRequestV1) => Promise<RestartAllSessionRunnersResultV1>;
  handleSessionRunnerStatusGet?: (request: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStateV1>;
  handleConnectedServiceQuotaRecoveryCreditConsume?: (
    input: ConnectedServiceQuotaRecoveryCreditConsumeRequestV1,
  ) => Promise<unknown>;
	  handleProviderAccountUsageSnapshot?: (input: Readonly<{
	    sessionId: string;
	    snapshot: ProviderAccountUsageSnapshotV1;
      source?: ConnectedServiceUsageSourceV1;
	    credentialFingerprint?: string | null;
      policyDisposition?: 'evidence_only';
	  }>) => Promise<unknown>;
	  handleProviderAccountUsageAdoption?: (input: Readonly<{
	    sessionId: string;
	    adoption: ProviderAccountUsageAdoptionV1;
	  }>) => Promise<unknown>;
  requestSelfRestart?: (request?: DaemonSelfRestartRequest) => Promise<unknown>;
  pluginChangeService?: DaemonPluginChangeService;
  pluginActionCurrentIntent?: (
    request: TargetActionCurrentIntentRequest
  ) => Promise<TargetActionCurrentIntentResult>;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = createDaemonControlApp({
      getChildren,
      machineId,
      runtimeId,
      prepareStopSession,
      stopSession,
      spawnSession,
      requestShutdown,
      beforeShutdown,
      isShuttingDown,
      onHappySessionWebhook,
      admitPersistedTakeover,
      controlToken,
      connectedAccountRequestAuth,
      verifyRunMaterializeToken,
      materializeConnectedServicesForExecutionRun,
      checkConnectedServicesGenerationForExecutionRun,
      releaseConnectedServicesForExecutionRun,
      sshTunnels,
      localServicesInventory,
      localServicesLauncher,
      localServicesPreview,
      localServicesActions,
      localServicesPublicPreview,
      localServicesPluginBridge,
      agentRuntimeSessionBridge,
      foregroundAgentRuntimeAdmission,
      simulatorPreview,
      handleConnectedServiceRuntimeAuthFailure,
      authorizeConnectedServiceRuntimeAuthFailure,
      resolveConnectedServiceRuntimeAuthResumePromptMode,
      runtimeAuthRecoveryScheduler,
      handleSessionConnectedServiceAuthSwitch,
      handleSessionConnectedServiceRuntimeAuthRefresh,
      handleSessionRunnerRestart,
      handleSessionRunnerRestartAll,
      handleSessionRunnerStatusGet,
	      handleConnectedServiceTurnLifecycle,
	      handleConnectedServiceUsageLimitWaitResumeCancel,
	      handleConnectedServiceQuotaRecoveryCreditConsume,
	      handleProviderAccountUsageSnapshot,
	      handleProviderAccountUsageAdoption,
      requestSelfRestart,
      pluginChangeService,
      pluginActionCurrentIntent,
	    });

    app.listen({ port: resolveDaemonControlListenPort(process.env), host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
