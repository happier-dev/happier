/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createDaemonControlAuthGuard } from './controlAuth';
import { isUnattestedPublicV1RunnerRolloutMutation } from './plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { Metadata, type SessionCreationOutcome } from '@/api/types';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER,
} from '@happier-dev/protocol/connect/connected-account-request-auth';
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
import type {
  RunnerAgentInvocationContext,
  TrackedSession,
} from './types';
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
  SessionConnectedServiceAuthSwitchRpcParamsSchema,
  createProviderErrorV1,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceUsageSourceV1Schema,
  CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1,
  CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
  ConnectedAccountAuthFailureRequestV1Schema,
  ConnectedAccountQuotaFailureRequestV1Schema,
  ConnectedAccountRequestAuthErrorResponseV1Schema,
  ConnectedAccountRequestAuthFailureSuccessResponseV1Schema,
  ConnectedAccountRequestAuthLookupRequestV1Schema,
  ConnectedAccountRequestAuthLookupSuccessResponseV1Schema,
  DaemonLocalServicePublicPreviewStatusRequestV1Schema,
  DaemonSimulatorPreviewActionRequestV1Schema,
  LocalServiceLauncherSnapshotV1Schema,
  LocalServiceActionRequestV1Schema,
  LocalServiceActionResultV1Schema,
  LocalServicePreviewSnapshotV1Schema,
  LocalServicePublicPreviewSnapshotV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  getConnectedAccountRequestAuthErrorHttpStatusV1,
  RestartAllSessionRunnersRequestV1Schema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerRequestV2Schema,
  RestartSessionRunnerResultV1Schema,
  SessionRunnerStatusGetRequestV1Schema,
  SessionRunnerRuntimeStateV1Schema,
  SessionRunnerRuntimeStatusV2Schema,
  SessionOrganizationPlacementV1Schema,
  SessionCreationTerminalSpawnErrorDetailSchema,
  isSessionCreationTerminalSpawnErrorDetail,
  SpawnSessionErrorCodeSchema,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  SimulatorPreviewActionResultV1Schema,
  SimulatorPreviewSnapshotV1Schema,
  SshTunnelEnsureRequestSchema,
  SshTunnelProbeRequestSchema,
  SshTunnelReleaseRequestSchema,
  SshTunnelStopRequestSchema,
  StrictJsonValueSchema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
  type ConnectedServiceQuotaRecoveryCreditConsumeRequestV1,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
  type RestartAllSessionRunnersRequestV1,
  type RestartAllSessionRunnersResultV1,
  type RestartSessionRunnerRequestV1,
  type RestartSessionRunnerRequestV2,
  type RestartSessionRunnerResultV1,
  type SessionRunnerStatusGetRequestV1,
  type SessionRunnerRuntimeStateV1,
  type SessionRunnerRuntimeStatusV2,
  type SessionCreationTerminalSpawnErrorDetail,
  type SpawnSessionErrorCode,
  type SpawnSessionErrorDetail,
  type SessionMetadataPublisherPreconditionV1,
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
import {
  ConnectedServiceTurnLifecycleRequestBodySchema,
  ConnectedServiceTurnLifecycleResultSchema,
  type ConnectedServiceTurnLifecycleRequestBody,
  type ConnectedServiceTurnLifecycleResult,
} from './connectedServices/connectedServiceTurnLifecycleContract';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { toSshTunnelErrorResponse, type SshTunnelSupervisor } from '@/daemon/ssh/tunnels';
import type { LocalServiceInventoryRoutes } from './local/services/inventory/routes';
import type { LocalServiceLauncherRoutes } from './local/services/launch/routes';
import type { LocalServiceActionRoutes } from './local/services/actions/routes';
import type { LocalServicePreviewRoutes } from './local/services/preview/routes';
import type { LocalServicePublicPreviewRoutes } from './local/services/public/routes';
import {
  readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
  isAgentRuntimeDaemonServiceAuthorityHardRevocationCurrent,
  verifyAgentRuntimeSessionBridgeToken,
  type AgentRuntimeDaemonServiceAuthorityDocumentV2,
  type AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from './agentRuntime/sessionBridgeAuthorization';
import {
  areRunnerManagedProviderRetainedAuthoritiesEqual,
  type RunnerManagedProviderRetainedAuthorityV1,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';
import { constantTimeEqualUtf8 } from './privateBearerFile';
import type {
  PersistedTakeoverAdmissionPhase,
  TakeoverAdmissionMode,
} from './spawn/persistedTakeoverAdmission';
import {
  AGENT_RUNTIME_DAEMON_SERVICES_PATH,
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
  type AgentRuntimeDaemonServiceRequestV1,
  type AgentRuntimeDaemonServiceResponseV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import type { ForegroundAgentRuntimeAdmissionOwner } from './agentRuntime/foregroundAdmission';
import {
  FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH,
  FOREGROUND_AGENT_RUNTIME_CLAIM_PATH,
  FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
  FOREGROUND_AGENT_RUNTIME_SESSION_OPTIONS_PATH,
  ForegroundAgentRuntimeAdmissionRequestV1Schema,
  ForegroundAgentRuntimeAdmissionResponseV1Schema,
  ForegroundAgentRuntimeClaimRequestV1Schema,
  ForegroundAgentRuntimeClaimResponseV1Schema,
  ForegroundAgentRuntimeReleaseRequestV1Schema,
  ForegroundAgentRuntimeReleaseResponseV1Schema,
  ForegroundAgentRuntimeSessionOptionsRequestV1Schema,
  ForegroundAgentRuntimeSessionOptionsResponseV1Schema,
} from './agentRuntime/foregroundAdmissionContract';
import type { SimulatorPreviewRoutes } from './devices/simulator/previewRoutes.types';
import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeFailureClassification,
} from './connectedServices/runtimeAuth/types';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';

export type AgentRuntimeDaemonServiceRoutes = Readonly<{
  dispatch(
    request: AgentRuntimeDaemonServiceRequestV1,
    context: Readonly<{
      sessionId: string;
      runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
      retainedAgent: AgentSessionRunnerBindingV1;
      invocationContext: RunnerAgentInvocationContext;
      trackedSession?: TrackedSession;
      signal?: AbortSignal;
    }>,
  ): Promise<AgentRuntimeDaemonServiceResponseV1>;
}>;
type AgentRuntimeDaemonServiceAdmission = Readonly<{
  turnId: string;
  inputId: string;
  userMessageSeq: number | null;
  userMessageSeqs: readonly number[];
}>;
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
import type {
  AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  authorizeTrackedRunnerAgentDaemonServiceOperation,
} from './agentRuntime/authorizeTrackedRunnerAgentDaemonServiceOperation';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from './connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import { registerDaemonControlRequestTiming } from './diagnostics/registerDaemonControlRequestTiming';
import {
  applyAuthorizedRuntimeAuthFailureSourceBinding,
  type RuntimeAuthFailureSourceAuthorization,
} from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { buildRuntimeAuthRecoveryScheduledResult } from './connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
import { isRecord } from './connectedServices/quotas/quotaNormalization';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import {
  executeAppliedDaemonPluginActionWithController,
  registerDaemonPluginChangeRoutes,
} from '@/plugins/daemon/controlRoutes';
import { readCurrentDaemonPluginCatalogSnapshot } from '@/plugins/daemon/currentCatalog';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import type { DaemonPatVerifier } from './auth/daemonPatVerifier';
import {
  registerDaemonExternalActionRoute,
} from './externalActions/registerDaemonExternalActionRoute';
import {
  executeExternalAction,
  type ExternalActionExecutor,
  type ResolveExternalActionTarget,
} from './externalActions/executeExternalAction';
import {
  SIGNED_ROOT_ACTION_EXECUTE_PATH,
  SignedRootActionExecuteRequestSchema,
} from './externalActions/signedRootActionControl';

const DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY = 'HAPPIER_DAEMON_CONTROL_BODY_LIMIT_BYTES';
const E2E_DAEMON_CONTROL_PORT_ENV_KEY = 'HAPPIER_E2E_DAEMON_CONTROL_PORT';
const DAEMON_DIST_CLOSURE_FINGERPRINT_PATTERN = /^[a-f0-9]{16}$/;
const DaemonDistClosureFingerprintSchema = z.string().regex(DAEMON_DIST_CLOSURE_FINGERPRINT_PATTERN);
type DaemonSelfRestartRequest = Readonly<{
  successorDistClosureFingerprint?: string;
}>;
type DaemonExternalActionApi = Readonly<{
  currentServerId: string;
  verifyPat: DaemonPatVerifier;
  executor: ExternalActionExecutor;
  resolveTarget: ResolveExternalActionTarget;
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

type TrackedAgentRuntimeDaemonServiceAuthority = Readonly<{
  tracked: TrackedSession;
  authorityPath: string;
  capabilityHash: string;
  authority: AgentRuntimeDaemonServiceAuthorityDocumentV2;
  runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
  retainedAgent: AgentSessionRunnerBindingV1;
  adoptedManagedProviderAuthority:
    RunnerManagedProviderRetainedAuthorityV1 | null;
  invocationContext: RunnerAgentInvocationContext;
}>;

async function resolveTrackedAgentRuntimeDaemonServiceAuthority(
  tracked: TrackedSession,
  sessionId: string,
  readPluginHardRevocationRevision?: (pluginId: string) => Promise<number>,
): Promise<TrackedAgentRuntimeDaemonServiceAuthority | null> {
  const authorityPath =
    typeof tracked.agentRuntimeDaemonServiceAuthorityFilePath === 'string'
      ? tracked.agentRuntimeDaemonServiceAuthorityFilePath.trim()
      : '';
  const capabilityHash =
    typeof tracked.agentRuntimeDaemonServiceCapabilityHash === 'string'
      ? tracked.agentRuntimeDaemonServiceCapabilityHash
      : '';
  const runnerPid = tracked.sessionRunnerPid ?? tracked.pid;
  const processStartTimeMs = tracked.processStartTimeMs;
  const processCommandHash = tracked.processCommandHash;
  const invocationContext = tracked.runnerAgentInvocationContext;
  if (
    tracked.agentRuntimeRunnerRestartDisposition
      === 'runner_authority_unavailable'
    || tracked.happySessionId !== sessionId
    || !authorityPath
    || !capabilityHash
    || !Number.isSafeInteger(runnerPid)
    || runnerPid < 1
    || typeof processStartTimeMs !== 'number'
    || !Number.isSafeInteger(processStartTimeMs)
    || processStartTimeMs < 0
    || typeof processCommandHash !== 'string'
    || !invocationContext
  ) {
    return null;
  }
  const authority =
    await readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
      happyHomeDir: configuration.happyHomeDir,
      publicReleaseRing: configuration.publicReleaseRing,
      path: authorityPath,
      sessionId,
      runner: {
        pid: runnerPid,
        processStartTimeMs,
        processCommandHash,
      },
    });
  if (
    !authority
    || tracked.runnerAgentImmutableGenerationId
      !== authority.retainedAgent.immutableGenerationId
    || !verifyAgentRuntimeSessionBridgeToken({
      providedToken: authority.capability,
      expectedTokenHash: capabilityHash,
    })
  ) {
    return null;
  }
  const trackedAdoptedManagedProviderAuthority = tracked
    .runnerManagedDependencyRetentionV1
    ?.adoptedManagedProviderAuthority;
  const adoptedManagedProviderAuthority = trackedAdoptedManagedProviderAuthority
    ? Object.freeze({ ...trackedAdoptedManagedProviderAuthority })
    : null;
  if (!await isAgentRuntimeDaemonServiceAuthorityHardRevocationCurrent({
    happyHomeDir: configuration.happyHomeDir,
    authority,
    adoptedManagedProviderAuthority,
    readPluginHardRevocationRevision,
  })) {
    return null;
  }
  return Object.freeze({
    tracked,
    authorityPath,
    capabilityHash,
    authority,
    runner: authority.runner,
    retainedAgent: authority.retainedAgent,
    adoptedManagedProviderAuthority,
    invocationContext,
  });
}

function trackedAgentRuntimeDaemonServiceAuthorityMatches(
  expected: TrackedAgentRuntimeDaemonServiceAuthority,
  current: TrackedAgentRuntimeDaemonServiceAuthority | null,
): boolean {
  return Boolean(
    current
    && current.tracked === expected.tracked
    && current.authorityPath === expected.authorityPath
    && current.capabilityHash === expected.capabilityHash
    && current.invocationContext === expected.invocationContext
    && areRunnerManagedProviderRetainedAuthoritiesEqual(
      current.adoptedManagedProviderAuthority,
      expected.adoptedManagedProviderAuthority,
    )
    && isDeepStrictEqual(current.authority, expected.authority),
  );
}

function findAgentRuntimeDaemonServiceAuthorizedSession(
  request: AgentRuntimeDaemonServiceRequestV1,
  sessions: Iterable<TrackedSession>,
  providedCapability: string,
): TrackedSession | null {
  for (const tracked of sessions) {
    if (
      tracked.agentRuntimeRunnerRestartDisposition
        === 'runner_authority_unavailable'
      || tracked.happySessionId
        !== request.context.sessionId
      || !tracked
        .agentRuntimeDaemonServiceCapabilityHash
    ) {
      continue;
    }
    const authorized = (
      verifyAgentRuntimeSessionBridgeToken({
        providedToken: providedCapability,
        expectedTokenHash:
          tracked.agentRuntimeDaemonServiceCapabilityHash,
      })
      && verifyAgentRuntimeSessionBridgeToken({
        providedToken: request.context.token,
        expectedTokenHash:
          tracked.agentRuntimeDaemonServiceCapabilityHash,
      })
    );
    return authorized ? tracked : null;
  }
  return null;
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
  status: 'pending' | 'success' | 'error';
  sessionId?: string;
  sessionCreationOutcome?: SessionCreationOutcome;
  errorCode?: SpawnSessionErrorCode;
  errorMessage?: string;
  errorDetail?: SpawnSessionErrorDetail;
  updatedAtMs: number;
  expiresAtMs: number;
}>;

type SpawnNonceAdmissionResult =
  | { type: 'none' }
  | { type: 'claimed' }
  | { type: 'pending' }
  | { type: 'error'; errorCode: SpawnSessionErrorCode; errorMessage: string; errorDetail?: SpawnSessionErrorDetail }
  | { type: 'success'; sessionId: string; sessionCreationOutcome?: SessionCreationOutcome };

const SessionCreationOutcomeSchema = z.object({
  disposition: z.enum(['created', 'rejoined']),
  organizationPlacement: SessionOrganizationPlacementV1Schema,
}).strict();

// Success remains shape-compatible with released runners; failure is a strict
// terminal counterpart on the same authenticated callback and carries no
// Session/metadata truth because no Session was created or rejoined.
const SessionStartedSuccessReportSchema = z.object({
  sessionId: z.string(),
  metadata: z.any(), // Metadata type from API
  sessionCreationOutcome: SessionCreationOutcomeSchema.optional(),
  persistedTakeoverAdmission: z.object({
    mode: z.enum(['persisted', 'external_linked']),
    operationId: z.string().trim().min(1).max(256),
    attemptId: z.string().trim().min(1).max(256),
    phase: z.enum(['admit', 'runtime_bound']).optional(),
    publisherPrecondition: z.object({
      machineId: z.string().trim().min(1).max(256),
      committedFenceMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
  }).strict().optional(),
}).strict();

const SessionStartedFailureReportSchema = z.object({
  result: z.literal('failure'),
  spawnNonce: z.string().trim().min(1),
  errorDetail: SessionCreationTerminalSpawnErrorDetailSchema,
}).strict();

const SessionStartedReportSchema = z.union([
  SessionStartedSuccessReportSchema,
  SessionStartedFailureReportSchema,
]);

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
  onSessionStartupFailure,
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
  handleSessionRunnerStatusV2Get,
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
  agentRuntimeDaemonServices,
  recordAgentRuntimeDaemonServiceAdmission,
  clearAgentRuntimeDaemonServiceAdmission,
  foregroundAgentRuntimeAdmission,
  simulatorPreview,
  requestSelfRestart,
  pluginChangeService,
  pluginActionCurrentIntent,
  externalActionApi,
  readPluginHardRevocationRevision,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  runtimeId?: string;
  prepareStopSession?: (trackedSession: TrackedSession) => Promise<void> | void;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  // True once daemon shutdown / control-server stop has begun. Recovery handlers early-return when
  // set so switch/restart work is never run into a tearing-down daemon (a deferral, not an attempt).
  isShuttingDown?: () => boolean;
  onHappySessionWebhook: (
    sessionId: string,
    metadata: Metadata,
    reconcileCanonicalReadiness?: (tracked: TrackedSession) => Promise<void>,
    sessionCreationOutcome?: SessionCreationOutcome,
  ) => void | Promise<void>;
  /**
   * Settles the existing PID-correlated spawn waiter for a strict terminal
   * creation failure. It is intentionally separate from ordinary Session
   * reporting because failure has no Session truth to reconcile.
   */
  onSessionStartupFailure?: (input: Readonly<{
    spawnNonce: string;
    errorDetail: SessionCreationTerminalSpawnErrorDetail;
  }>) => boolean | Promise<boolean>;
  admitPersistedTakeover?: (input: Readonly<{
    sessionId: string;
    mode: TakeoverAdmissionMode;
    operationId: string;
    attemptId: string;
    phase: PersistedTakeoverAdmissionPhase;
    publisherPrecondition: SessionMetadataPublisherPreconditionV1;
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
  handleConnectedServiceTurnLifecycle?: (
    input: ConnectedServiceTurnLifecycleRequestBody,
  ) => Promise<ConnectedServiceTurnLifecycleResult>;
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
  handleSessionRunnerRestart?: (request: RestartSessionRunnerRequestV1 | RestartSessionRunnerRequestV2) => Promise<RestartSessionRunnerResultV1>;
  handleSessionRunnerRestartAll?: (request: RestartAllSessionRunnersRequestV1) => Promise<RestartAllSessionRunnersResultV1>;
  handleSessionRunnerStatusGet?: (request: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStateV1>;
  handleSessionRunnerStatusV2Get?: (request: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStatusV2>;
  handleConnectedServiceQuotaRecoveryCreditConsume?: (
    input: ConnectedServiceQuotaRecoveryCreditConsumeRequestV1,
  ) => Promise<unknown>;
  handleProviderAccountUsageSnapshot?: (input: Readonly<{
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: ConnectedServiceUsageSourceV1;
    deriveCredentialFingerprintFromSource?: true;
    credentialFingerprint?: string | null;
    policyDisposition?: 'evidence_only';
  }>) => Promise<unknown>;
  handleProviderAccountUsageAdoption?: (input: Readonly<{
    sessionId: string;
    adoption: ProviderAccountUsageAdoptionV1;
  }>) => Promise<unknown>;
  localServicesInventory?: LocalServiceInventoryRoutes;
  localServicesLauncher?: LocalServiceLauncherRoutes;
  localServicesPreview?: Pick<LocalServicePreviewRoutes, 'getSnapshot'>;
  localServicesActions?: LocalServiceActionRoutes;
  localServicesPublicPreview?: LocalServicePublicPreviewRoutes;
  agentRuntimeDaemonServices?: AgentRuntimeDaemonServiceRoutes;
  recordAgentRuntimeDaemonServiceAdmission?: (
    tracked: TrackedSession,
    admission: AgentRuntimeDaemonServiceAdmission,
  ) => Promise<boolean>;
  clearAgentRuntimeDaemonServiceAdmission?: (
    tracked: TrackedSession,
    admission: AgentRuntimeDaemonServiceAdmission,
  ) => Promise<boolean>;
  foregroundAgentRuntimeAdmission?: ForegroundAgentRuntimeAdmissionOwner;
  simulatorPreview?: SimulatorPreviewRoutes;
  requestSelfRestart?: (request?: DaemonSelfRestartRequest) => Promise<unknown>;
  pluginChangeService?: DaemonPluginChangeService;
  pluginActionCurrentIntent?: (
    request: TargetActionCurrentIntentRequest
  ) => Promise<TargetActionCurrentIntentResult>;
  /** Public PAT-only ingress; intentionally outside the daemon control-token guard. */
  externalActionApi?: DaemonExternalActionApi;
  readPluginHardRevocationRevision?: (pluginId: string) => Promise<number>;
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
  registerDaemonControlRequestTiming(app, {
    debug: (message, data) => logger.debug(message, data),
  });

  // Set up Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  if (externalActionApi) {
    registerDaemonExternalActionRoute(app, {
      currentMachineId: machineId,
      ...externalActionApi,
    });
  }
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
    if ((current?.status === 'success' || current?.status === 'error') && current.expiresAtMs > nowMs) return;
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'pending',
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + spawnNoncePendingTtlMs,
    });
  };

  const markSpawnNonceSuccess = (
    spawnNonce: string,
    sessionId: string,
    sessionCreationOutcome?: SessionCreationOutcome,
  ): void => {
    const normalizedNonce = spawnNonce.trim();
    const normalizedSessionId = sessionId.trim();
    if (!normalizedNonce || !isCanonicalSessionId(normalizedSessionId)) return;
    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    const current = spawnNonceCorrelationByNonce.get(normalizedNonce);
    if (current?.status === 'error' && current.expiresAtMs > nowMs) return;
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'success',
      sessionId: normalizedSessionId,
      ...(sessionCreationOutcome ? { sessionCreationOutcome } : {}),
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + spawnNonceSuccessTtlMs,
    });
  };

  const markSpawnNonceError = (
    spawnNonce: string,
    error: Readonly<{
      errorCode: SpawnSessionErrorCode;
      errorMessage: string;
      errorDetail?: SpawnSessionErrorDetail;
    }>,
  ): void => {
    const normalizedNonce = spawnNonce.trim();
    const errorMessage = error.errorMessage.trim();
    if (!normalizedNonce || !errorMessage) return;
    const nowMs = Date.now();
    pruneSpawnNonceCorrelation(nowMs);
    const current = spawnNonceCorrelationByNonce.get(normalizedNonce);
    if ((current?.status === 'success' || current?.status === 'error') && current.expiresAtMs > nowMs) return;
    spawnNonceCorrelationByNonce.set(normalizedNonce, {
      status: 'error',
      errorCode: error.errorCode,
      errorMessage,
      ...(error.errorDetail ? { errorDetail: error.errorDetail } : {}),
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
        return {
          type: 'success',
          sessionId: childSessionId,
          ...(child.sessionCreationOutcome
            ? { sessionCreationOutcome: child.sessionCreationOutcome }
            : {}),
        };
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
      return {
        type: 'success',
        sessionId: current.sessionId.trim(),
        ...(current.sessionCreationOutcome
          ? { sessionCreationOutcome: current.sessionCreationOutcome }
          : {}),
      };
    }
    if (current?.status === 'pending') {
      return { type: 'pending' };
    }
    if (current?.status === 'error' && current.errorCode && current.errorMessage) {
      return {
        type: 'error',
        errorCode: current.errorCode,
        errorMessage: current.errorMessage,
        ...(current.errorDetail ? { errorDetail: current.errorDetail } : {}),
      };
    }
    const tracked = readTrackedSpawnNonceAdmission(normalizedNonce);
    if (tracked?.type === 'success') {
      markSpawnNonceSuccess(
        normalizedNonce,
        tracked.sessionId,
        tracked.sessionCreationOutcome,
      );
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
      markSpawnNonceSuccess(
        trackedNonce,
        trackedSessionId,
        child.sessionCreationOutcome,
      );
    }
  };

  const authSchema401 = z.object({
    success: z.literal(false),
    error: z.string(),
  });

  const requireAuth = createDaemonControlAuthGuard(normalizedControlToken);
  if (externalActionApi) {
    app.post(SIGNED_ROOT_ACTION_EXECUTE_PATH, { preHandler: requireAuth }, async (request, reply) => {
      const parsed = SignedRootActionExecuteRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return await reply.code(400).send({
          ok: false,
          errorCode: 'invalid_action_request',
          error: 'invalid_action_request',
        });
      }
      const execution = await executeExternalAction({
        actionId: parsed.data.actionId,
        envelope: {
          v: 1,
          input: parsed.data.input,
          ...(parsed.data.targetMachineId
            ? { target: { kind: 'machine' as const, machineId: parsed.data.targetMachineId } }
            : {}),
          ...(parsed.data.actionRequestId ? { requestId: parsed.data.actionRequestId } : {}),
        },
        principal: { authority: 'present_user' },
        currentMachineId: machineId,
        currentServerId: externalActionApi.currentServerId,
        resolveTarget: externalActionApi.resolveTarget,
        executor: externalActionApi.executor,
      });
      if (execution.kind === 'invalid_request') {
        return await reply.code(400).send({
          ok: false,
          errorCode: execution.errorCode,
          error: execution.errorCode,
        });
      }
      return execution.response.execution;
    });
  }

  const connectedAccountRequestAuthErrorResponses = {
    [CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1.request_auth_unauthorized]:
      ConnectedAccountRequestAuthErrorResponseV1Schema,
    [CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1.request_auth_purpose_forbidden]:
      ConnectedAccountRequestAuthErrorResponseV1Schema,
    [CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1.request_auth_not_active]:
      ConnectedAccountRequestAuthErrorResponseV1Schema,
    [CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1.request_auth_unavailable]:
      ConnectedAccountRequestAuthErrorResponseV1Schema,
  } as const;
  const sendConnectedAccountRequestAuthError = (
    reply: FastifyReply,
    code: Parameters<typeof getConnectedAccountRequestAuthErrorHttpStatusV1>[0],
  ): void => {
    const body = {
      ok: false,
      error: { code },
    } satisfies z.infer<typeof ConnectedAccountRequestAuthErrorResponseV1Schema>;
    reply.code(getConnectedAccountRequestAuthErrorHttpStatusV1(code)).send(body);
  };
  const requireConnectedAccountRequestAuth = async (request: {
    headers: Record<string, unknown>;
  }, reply: FastifyReply): Promise<void> => {
    if (isDaemonQuiescing()) {
      return sendConnectedAccountRequestAuthError(
        reply,
        'request_auth_unavailable',
      );
    }
    const provided = request.headers[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER];
    const principal = typeof provided === 'string'
      ? connectedAccountRequestAuth?.authenticate(provided) ?? null
      : null;
    if (!principal || !principal.isCurrent()) {
      return sendConnectedAccountRequestAuthError(
        reply,
        'request_auth_unauthorized',
      );
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
      const code = error.code === 'request_auth_purpose_forbidden'
        || error.code === 'request_auth_not_active'
        ? error.code
        : 'request_auth_unavailable';
      return sendConnectedAccountRequestAuthError(reply, code);
    }
    logger.debug('[CONTROL SERVER] Connected-account request-auth operation failed', {
      errorCode: 'unexpected_error',
    });
    return sendConnectedAccountRequestAuthError(reply, 'request_auth_unavailable');
  };

  const createConnectedAccountRequestAuthRequestLifetime = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Readonly<{
    signal: AbortSignal;
    dispose: () => void;
  }> => {
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) {
        controller.abort(new Error('Connected-account request-auth request ended'));
      }
    };
    const abortIfResponseDidNotFinish = () => {
      if (!reply.raw.writableEnded) {
        abort();
      }
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abortIfResponseDidNotFinish);
    if (request.raw.aborted) {
      abort();
    }
    return {
      signal: controller.signal,
      dispose: () => {
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', abortIfResponseDidNotFinish);
      },
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
      executeAction: async (request) => {
        if (externalActionApi
          && (request.actionId === 'action.spec.search'
            || request.actionId === 'action.spec.get'
            || request.actionId === 'action.invoke')) {
          const execution = await externalActionApi.executor.execute(
            request.actionId,
            request.input,
            {
              surface: request.surface,
              authority: request.authority,
              actionCaller: { kind: 'host' },
              ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
            },
          );
          if (!execution.ok) {
            return {
              matched: true,
              result: {
                ok: false,
                errorCode: execution.errorCode,
                error: execution.error,
              },
            };
          }
          const result = StrictJsonValueSchema.safeParse(execution.result);
          return {
            matched: true,
            result: result.success
              ? { ok: true, result: result.data }
              : {
                  ok: false,
                  errorCode: 'invalid_action_output',
                  error: 'The Action returned a non-JSON result',
                },
          };
        }
        return await executeAppliedDaemonPluginActionWithController(
          request, pluginReloadController, pluginActionCurrentIntent,
        );
      },
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
        200: ConnectedAccountRequestAuthLookupSuccessResponseV1Schema,
        ...connectedAccountRequestAuthErrorResponses,
      },
    },
    preHandler: requireConnectedAccountRequestAuth,
  }, async (request, reply) => {
    const principal = takeConnectedAccountRequestAuthPrincipal(request);
    if (!principal || !connectedAccountRequestAuth) {
      return sendConnectedAccountRequestAuthError(reply, 'request_auth_unauthorized');
    }
    const requestLifetime = createConnectedAccountRequestAuthRequestLifetime(request, reply);
    try {
      const value = await connectedAccountRequestAuth.lookupRequestAuth({
        subject: principal,
        purpose: request.body.purpose,
        signal: requestLifetime.signal,
      });
      if (!principal.isCurrent()) {
        return sendConnectedAccountRequestAuthError(reply, 'request_auth_not_active');
      }
      return { ok: true as const, value };
    } catch (error) {
      return sendConnectedAccountRequestAuthFailure(reply, error);
    } finally {
      requestLifetime.dispose();
    }
  });

  typed.post(CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH, {
    schema: {
      body: ConnectedAccountAuthFailureRequestV1Schema,
      response: {
        200: ConnectedAccountRequestAuthFailureSuccessResponseV1Schema,
        ...connectedAccountRequestAuthErrorResponses,
      },
    },
    preHandler: requireConnectedAccountRequestAuth,
  }, async (request, reply) => {
    const principal = takeConnectedAccountRequestAuthPrincipal(request);
    if (!principal || !connectedAccountRequestAuth) {
      return sendConnectedAccountRequestAuthError(reply, 'request_auth_unauthorized');
    }
    const requestLifetime = createConnectedAccountRequestAuthRequestLifetime(request, reply);
    try {
      const value = await connectedAccountRequestAuth.refreshAfterAuthFailure({
        subject: principal,
        request: request.body,
        signal: requestLifetime.signal,
      });
      if (!principal.isCurrent()) {
        return sendConnectedAccountRequestAuthError(reply, 'request_auth_not_active');
      }
      return { ok: true as const, value };
    } catch (error) {
      return sendConnectedAccountRequestAuthFailure(reply, error);
    } finally {
      requestLifetime.dispose();
    }
  });

  typed.post(CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH, {
    schema: {
      body: ConnectedAccountQuotaFailureRequestV1Schema,
      response: {
        200: ConnectedAccountRequestAuthFailureSuccessResponseV1Schema,
        ...connectedAccountRequestAuthErrorResponses,
      },
    },
    preHandler: requireConnectedAccountRequestAuth,
  }, async (request, reply) => {
    const principal = takeConnectedAccountRequestAuthPrincipal(request);
    if (!principal || !connectedAccountRequestAuth) {
      return sendConnectedAccountRequestAuthError(reply, 'request_auth_unauthorized');
    }
    const requestLifetime = createConnectedAccountRequestAuthRequestLifetime(request, reply);
    try {
      const value = await connectedAccountRequestAuth.reportQuotaFailure({
        subject: principal,
        request: request.body,
        signal: requestLifetime.signal,
      });
      if (!principal.isCurrent()) {
        return sendConnectedAccountRequestAuthError(reply, 'request_auth_not_active');
      }
      return { ok: true as const, value };
    } catch (error) {
      return sendConnectedAccountRequestAuthFailure(reply, error);
    } finally {
      requestLifetime.dispose();
    }
  });

  typed.post('/connected-service-auth/session/switch', {
    schema: {
      body: SessionConnectedServiceAuthSwitchRpcParamsSchema,
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
      ...(request.body.rematerializeServiceId === undefined
        ? {}
        : { rematerializeServiceId: request.body.rematerializeServiceId }),
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
    if (isUnattestedPublicV1RunnerRolloutMutation(request.body)) {
      return {
        ok: false as const,
        status: 'ineligible' as const,
        sessionId: request.body.sessionId,
        reasonCode: 'runner_generation_unattested' as const,
      };
    }
    return await handleSessionRunnerRestart(request.body);
  });

  typed.post('/session-runners/restart-v2', {
    schema: {
      body: RestartSessionRunnerRequestV2Schema,
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
    if (isUnattestedPublicV1RunnerRolloutMutation(request.body)) {
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

  typed.post('/session-runners/status-v2', {
    schema: {
      body: SessionRunnerStatusGetRequestV1Schema,
      response: {
        200: SessionRunnerRuntimeStatusV2Schema,
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('unsupported_daemon_version'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleSessionRunnerStatusV2Get) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'unsupported_daemon_version' as const,
      };
    }
    return await handleSessionRunnerStatusV2Get({ sessionId: request.body.sessionId });
  });

  // Session reports itself after creation
  typed.post('/session-started', {
    schema: {
      body: SessionStartedReportSchema,
      response: {
        200: z.object({
          status: z.literal('ok')
        }),
        401: authSchema401,
        503: z.object({
          status: z.literal('error'),
          errorCode: z.enum([
            'session_startup_reconciliation_failed',
            'session_startup_failure_unavailable',
            'persisted_takeover_admission_failed',
            'persisted_takeover_admission_upgrade_required',
          ]),
        }),
      }
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if ('result' in request.body && request.body.result === 'failure') {
      if (!onSessionStartupFailure) {
        reply.code(503);
        return {
          status: 'error' as const,
          errorCode: 'session_startup_failure_unavailable' as const,
        };
      }
      logger.debug('[CONTROL SERVER] Session startup failure report received');
      await onSessionStartupFailure({
        spawnNonce: request.body.spawnNonce,
        errorDetail: request.body.errorDetail,
      });
      return { status: 'ok' as const };
    }

    const successReport = SessionStartedSuccessReportSchema.parse(request.body);
    const {
      sessionId,
      metadata,
      sessionCreationOutcome,
      persistedTakeoverAdmission,
    } = successReport;

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
          mode: persistedTakeoverAdmission.mode,
          operationId: persistedTakeoverAdmission.operationId,
          attemptId: persistedTakeoverAdmission.attemptId,
          phase: persistedTakeoverAdmission.phase,
          publisherPrecondition: persistedTakeoverAdmission.publisherPrecondition,
          signal: requestLifetime.signal,
        });
        return { status: 'ok' as const };
      } catch (error) {
        logger.debug('[CONTROL SERVER] Persisted takeover admission failed');
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

    logger.debug('[CONTROL SERVER] Session startup report received');
    let requiredReadiness: Promise<void>;
    try {
      requiredReadiness = Promise.resolve(
        sessionCreationOutcome
          ? onHappySessionWebhook(
              sessionId,
              metadata,
              undefined,
              sessionCreationOutcome,
            )
          : onHappySessionWebhook(sessionId, metadata),
      );
    } catch (error) {
      requiredReadiness = Promise.reject(error);
    }
    try {
      await requiredReadiness;
    } catch (error) {
      logger.debug('[CONTROL SERVER] Session startup reconciliation failed');
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
      const result = await handleConnectedServiceRuntimeAuthFailure({
        sessionId,
        switchesThisTurn,
        ...(request.body.reportId ? { interruptedOriginId: request.body.reportId } : {}),
        resumePromptMode,
        classification,
        sourceAuthorization,
      });
      return {
        ok: true as const,
        result,
        ...(resolveConnectedServiceRuntimeAuthResumePromptMode ? { resumePromptMode } : {}),
      };
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
      body: ConnectedServiceTurnLifecycleRequestBodySchema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: ConnectedServiceTurnLifecycleResultSchema,
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
      ...(request.body.requestedAction
        ? { requestedAction: request.body.requestedAction }
        : {}),
      ...(request.body.activeTurnId !== undefined
        ? { activeTurnId: request.body.activeTurnId }
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
        deriveCredentialFingerprintFromSource: z.literal(true).optional(),
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
        ...(request.body.deriveCredentialFingerprintFromSource
          ? { deriveCredentialFingerprintFromSource: true as const }
          : {}),
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

  typed.post(AGENT_RUNTIME_DAEMON_SERVICES_PATH, {
    schema: {
      body: AgentRuntimeDaemonServiceRequestV1Schema,
      response: {
        200: AgentRuntimeDaemonServiceResponseV1Schema,
        401: authSchema401,
        403: AgentRuntimeDaemonServiceResponseV1Schema,
        501: AgentRuntimeDaemonServiceResponseV1Schema,
        503: z.union([
          daemonShuttingDownRouteResponseSchema,
          AgentRuntimeDaemonServiceResponseV1Schema,
        ]),
      },
    },
  }, async (request, reply) => {
    const rawCapability =
      request.headers['x-happier-daemon-token'];
    const providedCapability =
      typeof rawCapability === 'string'
        ? rawCapability.trim()
        : Array.isArray(rawCapability)
          ? rawCapability[0]?.trim() ?? ''
          : '';
    if (!providedCapability) {
      reply.code(401);
      return { success: false as const, error: 'Unauthorized' };
    }
    const serviceSessions = getChildren();
    const authorizedTracked = constantTimeEqualUtf8(
      providedCapability,
      request.body.context.token,
    )
      ? findAgentRuntimeDaemonServiceAuthorizedSession(
        request.body,
        serviceSessions,
        providedCapability,
      )
      : null;
    const trackedAuthority = authorizedTracked
      ? await resolveTrackedAgentRuntimeDaemonServiceAuthority(
        authorizedTracked,
        request.body.context.sessionId,
        readPluginHardRevocationRevision,
      )
      : null;
    const tracked = trackedAuthority?.tracked ?? null;
    const canonicalTrackedSubjectExists =
      serviceSessions.some((candidate) =>
        candidate.happySessionId
          === request.body.context.sessionId
      );
    const foregroundSubject = tracked
      ? null
      : canonicalTrackedSubjectExists
        ? null
        : foregroundAgentRuntimeAdmission
          ?.authorizeDaemonServiceRequest({
            request: request.body,
            providedCapability,
          }) ?? null;
    if (!trackedAuthority && !foregroundSubject) {
      reply.code(403);
      return {
        ok: false as const,
        error: {
          code:
            'agent_runtime_daemon_service_forbidden',
          message:
            'Agent runtime daemon service request is forbidden',
        },
      };
    }
    if (
      request.body.operation.kind === 'session.open.attest'
      && !trackedAuthority
    ) {
      reply.code(403);
      return {
        ok: false as const,
        error: {
          code:
            'agent_runtime_daemon_service_session_open_attestation_forbidden',
          message:
            'Runner Agent session-open attestation requires tracked marker custody',
        },
      };
    }
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!agentRuntimeDaemonServices) {
      reply.code(501);
      return {
        ok: false as const,
        error: {
          code:
            'agent_runtime_daemon_service_unavailable',
          message:
            'Agent runtime daemon service is unavailable',
        },
      };
    }
    if (
      request.body.operation.kind
        === 'managed_server.endpoint.resolve'
    ) {
      const witness = request.body.operation.witness;
      const foregroundAdmission =
        foregroundSubject?.readAdmission() ?? null;
      const trackedWitnessAuthorized = trackedAuthority
        ? authorizeTrackedRunnerAgentDaemonServiceOperation({
          tracked: trackedAuthority.tracked,
          sessionId: request.body.context.sessionId,
          runner: trackedAuthority.runner,
          retainedAgent: trackedAuthority.retainedAgent,
          witness,
          allowIdleCurrentGeneration: false,
        })
        : false;
      const foregroundWitnessAuthorized = Boolean(
        foregroundAdmission
        && foregroundAdmission.turnId
          === witness.turnId
        && foregroundAdmission.inputId
          === witness.inputId
        && foregroundAdmission.userMessageSeq
          === witness.userMessageSeq
        && foregroundAdmission.userMessageSeqs.length
          === witness.userMessageSeqs.length
        && foregroundAdmission.userMessageSeqs.every(
          (sequence, index) =>
            sequence
              === witness.userMessageSeqs[index],
        ),
      );
      if (
        trackedAuthority
          ? !trackedWitnessAuthorized
          : !foregroundWitnessAuthorized
      ) {
        reply.code(403);
        return {
          ok: false as const,
          error: {
            code:
              'agent_runtime_daemon_service_turn_forbidden',
            message:
              'Agent runtime daemon service turn witness is forbidden',
          },
        };
      }
    }
    const trackedAuthorityAtDispatch = trackedAuthority;
    const trackedAuthorityRemainsCurrent = async (): Promise<boolean> => {
      if (!trackedAuthorityAtDispatch) return true;
      const current = trackedAuthorityAtDispatch.tracked;
      if (
        current.agentRuntimeRunnerRestartDisposition
          === 'runner_authority_unavailable'
        || !getChildren().some(
          (candidate) => candidate === current,
        )
      ) {
        return false;
      }
      return trackedAgentRuntimeDaemonServiceAuthorityMatches(
        trackedAuthorityAtDispatch,
        await resolveTrackedAgentRuntimeDaemonServiceAuthority(
          current,
          request.body.context.sessionId,
          readPluginHardRevocationRevision,
        ),
      );
    };
    const admissionCustodyUnavailable = () => {
      reply.code(503);
      return {
        ok: false as const,
        error: {
          code:
            'agent_runtime_daemon_service_admission_custody_unavailable',
          message:
            'Agent runtime daemon service admission custody is unavailable',
        },
      };
    };
    const requestLifetime = new AbortController();
    const onClientClose = () => requestLifetime.abort();
    reply.raw.once('close', onClientClose);
    let result: AgentRuntimeDaemonServiceResponseV1;
    try {
      result = await agentRuntimeDaemonServices.dispatch(
        request.body,
        trackedAuthority
          ? {
            sessionId: request.body.context.sessionId,
            runner: trackedAuthority.runner,
            retainedAgent: trackedAuthority.retainedAgent,
            invocationContext: trackedAuthority.invocationContext,
            trackedSession: trackedAuthority.tracked,
            signal: requestLifetime.signal,
          }
          : {
            sessionId: request.body.context.sessionId,
            runner: foregroundSubject!.runner,
            retainedAgent: foregroundSubject!.retainedAgent,
            invocationContext: foregroundSubject!.invocationContext,
            signal: requestLifetime.signal,
          },
      );
    } finally {
      reply.raw.removeListener('close', onClientClose);
    }
    if (tracked && !await trackedAuthorityRemainsCurrent()) {
      return admissionCustodyUnavailable();
    }
    if (
      request.body.operation.kind
        === 'turn.admission.authorize'
      && result.ok
      && result.result.kind === 'turn.admission'
      && result.result.status === 'admitted'
    ) {
      if (!constantTimeEqualUtf8(
          JSON.stringify(result.result.witness),
          JSON.stringify(request.body.operation.witness),
        )) {
        reply.code(503);
        return {
          ok: false as const,
          error: {
            code:
              'agent_runtime_daemon_service_admission_invalid',
            message:
              'Agent runtime daemon service admission result is invalid',
          },
        };
      }
      const admission = {
        turnId: result.result.witness.turnId,
        inputId: result.result.witness.inputId,
        userMessageSeq:
          result.result.witness.userMessageSeq,
        userMessageSeqs:
          result.result.witness.userMessageSeqs,
      } satisfies AgentRuntimeDaemonServiceAdmission;
      const admissionRecorded = await (
        tracked
          ? recordAgentRuntimeDaemonServiceAdmission?.(
            tracked,
            admission,
          ) ?? false
          : foregroundSubject?.recordAdmission({
            turnId: result.result.witness.turnId,
            inputId: result.result.witness.inputId,
            userMessageSeq:
              result.result.witness.userMessageSeq,
            userMessageSeqs:
              result.result.witness.userMessageSeqs,
          }) ?? false
      );
      if (!admissionRecorded) {
        return admissionCustodyUnavailable();
      }
      if (tracked && !await trackedAuthorityRemainsCurrent()) {
        try {
          await clearAgentRuntimeDaemonServiceAdmission?.(
            tracked,
            admission,
          );
        } catch (error) {
          logger.debug(
            '[CONTROL SERVER] Failed to clear stale Runner Agent admission custody',
            error,
          );
        }
        return admissionCustodyUnavailable();
      }
      if (tracked) {
        tracked.activeTurnId =
          result.result.witness.turnId;
        tracked.agentRuntimeDaemonServiceAdmittedTurnId =
          result.result.witness.turnId;
        tracked.agentRuntimeDaemonServiceAdmittedInputId =
          result.result.witness.inputId;
        tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq =
          result.result.witness.userMessageSeq;
        tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [
          ...result.result.witness.userMessageSeqs,
        ];
      }
    }
    return result;
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

  typed.post(FOREGROUND_AGENT_RUNTIME_CLAIM_PATH, {
    schema: {
      body: ForegroundAgentRuntimeClaimRequestV1Schema,
      response: {
        200: ForegroundAgentRuntimeClaimResponseV1Schema,
        401: authSchema401,
        403: authSchema401,
        503: daemonShuttingDownRouteResponseSchema,
      },
    },
  }, async (request, reply) => {
    const rawCapability =
      request.headers['x-happier-daemon-token'];
    const providedCapability =
      typeof rawCapability === 'string'
        ? rawCapability.trim()
        : Array.isArray(rawCapability)
          ? rawCapability[0]?.trim() ?? ''
          : '';
    if (!providedCapability) {
      reply.code(401);
      return { success: false as const, error: 'Unauthorized' };
    }
    if (
      !constantTimeEqualUtf8(
        providedCapability,
        request.body.capability,
      )
    ) {
      reply.code(403);
      return { success: false as const, error: 'Unauthorized' };
    }
    if (isDaemonQuiescing()) {
      reply.code(503);
      return daemonShuttingDownResponse();
    }
    if (!foregroundAgentRuntimeAdmission) {
      reply.code(403);
      return { success: false as const, error: 'Unauthorized' };
    }
    return await foregroundAgentRuntimeAdmission.claimEnvironment(
      request.body,
    );
  });

  typed.post(FOREGROUND_AGENT_RUNTIME_SESSION_OPTIONS_PATH, {
    schema: {
      body: ForegroundAgentRuntimeSessionOptionsRequestV1Schema,
      response: {
        200: ForegroundAgentRuntimeSessionOptionsResponseV1Schema,
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
    return await foregroundAgentRuntimeAdmission.resolveSessionRuntimePreferences({
      ...request.body,
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
          sessionCreationOutcome: SessionCreationOutcomeSchema.optional(),
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
          errorDetail: SessionCreationTerminalSpawnErrorDetailSchema.optional(),
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
          errorDetail: SessionCreationTerminalSpawnErrorDetailSchema.optional(),
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
        const { existingSessionId } = requestBody;
        const spawnNonce = typeof requestBody.spawnNonce === 'string' ? requestBody.spawnNonce.trim() : '';
        const nonceAdmission = claimSpawnNonceAdmission(spawnNonce);
        if (nonceAdmission.type === 'success') {
          return {
            success: true,
            sessionId: nonceAdmission.sessionId,
            ...(nonceAdmission.sessionCreationOutcome
              ? { sessionCreationOutcome: nonceAdmission.sessionCreationOutcome }
              : {}),
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
        if (nonceAdmission.type === 'error') {
          reply.code(500);
          return {
            success: false as const,
            error: nonceAdmission.errorMessage,
            errorCode: nonceAdmission.errorCode,
            ...(isSessionCreationTerminalSpawnErrorDetail(nonceAdmission.errorDetail)
              ? { errorDetail: nonceAdmission.errorDetail }
              : {}),
          };
        }

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
          const message = error instanceof Error ? error.message : String(error);
          const errorCode = resolveThrownSpawnSessionErrorCode(error);
          if (spawnNonce) {
            markSpawnNonceError(spawnNonce, {
              errorCode: SpawnSessionErrorCodeSchema.parse(errorCode),
              errorMessage: `Failed to spawn session: ${message}`,
            });
          }
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
          markSpawnNonceSuccess(
            spawnNonce,
            result.sessionId,
            result.sessionCreationOutcome,
          );
        }
        return {
          success: true,
          sessionId: result.sessionId,
          ...(result.sessionCreationOutcome
            ? { sessionCreationOutcome: result.sessionCreationOutcome }
            : {}),
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
        if (spawnNonce && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT) {
          reply.code(202);
          return {
            success: false as const,
            status: 'pending' as const,
            errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          };
        }
        if (spawnNonce) {
          markSpawnNonceError(spawnNonce, {
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
            ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
          });
        }
        reply.code(500);
        return { 
          success: false,
          error: result.errorMessage,
          errorCode: result.errorCode,
          ...(isSessionCreationTerminalSpawnErrorDetail(
            result.errorDetail,
          ) ? { errorDetail: result.errorDetail } : {}),
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
          status: z.enum(['success', 'error', 'pending', 'not_found']),
          sessionId: z.string().optional(),
          sessionCreationOutcome: SessionCreationOutcomeSchema.optional(),
          errorCode: SpawnSessionErrorCodeSchema.optional(),
          errorMessage: z.string().optional(),
          errorDetail: z.unknown().optional(),
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
          ...(record.sessionCreationOutcome
            ? { sessionCreationOutcome: record.sessionCreationOutcome }
            : {}),
        };
      }
      if (record.status === 'pending') {
        return {
          success: true as const,
          status: 'pending' as const,
        };
      }
      if (record.status === 'error' && record.errorCode && record.errorMessage) {
        return {
          success: true as const,
          status: 'error' as const,
          errorCode: record.errorCode,
          errorMessage: record.errorMessage,
          ...(record.errorDetail ? { errorDetail: record.errorDetail } : {}),
        };
      }
    }

    const tracked = readTrackedSpawnNonceAdmission(normalizedNonce);
    if (tracked) {
      if (tracked.type === 'success') {
        markSpawnNonceSuccess(
          normalizedNonce,
          tracked.sessionId,
          tracked.sessionCreationOutcome,
        );
        return {
          success: true as const,
          status: 'success' as const,
          sessionId: tracked.sessionId,
          ...(tracked.sessionCreationOutcome
            ? { sessionCreationOutcome: tracked.sessionCreationOutcome }
            : {}),
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
    daemonStopRequested = true;
    logger.debug('[CONTROL SERVER] Stop daemon request received', {
      stopSessions,
    });

    // Give time for response to arrive
    setTimeout(() => {
      logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
      const runBeforeShutdown = async (): Promise<void> => {
        if (!beforeShutdown) return;
        try {
          await beforeShutdown();
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
  onSessionStartupFailure,
  admitPersistedTakeover,
  controlToken,
  connectedAccountRequestAuth,
  sshTunnels,
  localServicesInventory,
  localServicesLauncher,
  localServicesPreview,
  localServicesActions,
  localServicesPublicPreview,
  agentRuntimeDaemonServices,
  recordAgentRuntimeDaemonServiceAdmission,
  clearAgentRuntimeDaemonServiceAdmission,
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
  handleSessionRunnerStatusV2Get,
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
  externalActionApi,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  runtimeId?: string;
  prepareStopSession?: (trackedSession: TrackedSession) => Promise<void> | void;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  // True once daemon shutdown / control-server stop has begun. Recovery handlers early-return when
  // set so switch/restart work is never run into a tearing-down daemon (a deferral, not an attempt).
  isShuttingDown?: () => boolean;
  onHappySessionWebhook: (
    sessionId: string,
    metadata: Metadata,
    reconcileCanonicalReadiness?: (tracked: TrackedSession) => Promise<void>,
    sessionCreationOutcome?: SessionCreationOutcome,
  ) => void | Promise<void>;
  onSessionStartupFailure?: (input: Readonly<{
    spawnNonce: string;
    errorDetail: SessionCreationTerminalSpawnErrorDetail;
  }>) => boolean | Promise<boolean>;
  admitPersistedTakeover?: (input: Readonly<{
    sessionId: string;
    mode: TakeoverAdmissionMode;
    operationId: string;
    attemptId: string;
    phase: PersistedTakeoverAdmissionPhase;
    publisherPrecondition: SessionMetadataPublisherPreconditionV1;
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
  localServicesPreview?: Pick<LocalServicePreviewRoutes, 'getSnapshot'>;
  localServicesActions?: LocalServiceActionRoutes;
  localServicesPublicPreview?: LocalServicePublicPreviewRoutes;
  agentRuntimeDaemonServices?: AgentRuntimeDaemonServiceRoutes;
  recordAgentRuntimeDaemonServiceAdmission?: (
    tracked: TrackedSession,
    admission: AgentRuntimeDaemonServiceAdmission,
  ) => Promise<boolean>;
  clearAgentRuntimeDaemonServiceAdmission?: (
    tracked: TrackedSession,
    admission: AgentRuntimeDaemonServiceAdmission,
  ) => Promise<boolean>;
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
  handleConnectedServiceTurnLifecycle?: (
    input: ConnectedServiceTurnLifecycleRequestBody,
  ) => Promise<ConnectedServiceTurnLifecycleResult>;
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
  handleSessionRunnerRestart?: (request: RestartSessionRunnerRequestV1 | RestartSessionRunnerRequestV2) => Promise<RestartSessionRunnerResultV1>;
  handleSessionRunnerRestartAll?: (request: RestartAllSessionRunnersRequestV1) => Promise<RestartAllSessionRunnersResultV1>;
  handleSessionRunnerStatusGet?: (request: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStateV1>;
  handleSessionRunnerStatusV2Get?: (request: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStatusV2>;
  handleConnectedServiceQuotaRecoveryCreditConsume?: (
    input: ConnectedServiceQuotaRecoveryCreditConsumeRequestV1,
  ) => Promise<unknown>;
	  handleProviderAccountUsageSnapshot?: (input: Readonly<{
	    sessionId: string;
	    snapshot: ProviderAccountUsageSnapshotV1;
      source?: ConnectedServiceUsageSourceV1;
	    deriveCredentialFingerprintFromSource?: true;
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
  /** Public PAT-only ingress; intentionally outside the daemon control-token guard. */
  externalActionApi?: DaemonExternalActionApi;
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
      onSessionStartupFailure,
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
      agentRuntimeDaemonServices,
      recordAgentRuntimeDaemonServiceAdmission,
      clearAgentRuntimeDaemonServiceAdmission,
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
      handleSessionRunnerStatusV2Get,
	      handleConnectedServiceTurnLifecycle,
	      handleConnectedServiceUsageLimitWaitResumeCancel,
	      handleConnectedServiceQuotaRecoveryCreditConsume,
	      handleProviderAccountUsageSnapshot,
	      handleProviderAccountUsageAdoption,
      requestSelfRestart,
      pluginChangeService,
      pluginActionCurrentIntent,
      externalActionApi,
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
