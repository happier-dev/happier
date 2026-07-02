/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import {
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH,
  CodexChatGptAuthTokensRefreshResponseSchema,
  CodexChatGptAuthTokensRefreshSelectionSchema,
  type CodexChatGptAuthTokensRefreshResponse,
  type CodexChatGptAuthTokensRefreshSelection,
} from '@happier-dev/plugins-codex/agent/auth/services/openai/cloud/refreshBridge';
import { TrackedSession } from './types';
import { SPAWN_SESSION_ERROR_CODES, SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { mergeSpawnSessionOptions, SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { parseSessionContinueWithReplayRpcParamsCompatIngress } from '@happier-dev/protocol';
import {
	  ConnectedServiceBindingsV1Schema,
	  ConnectedServiceIdSchema,
	  ConnectedServiceQuotaSnapshotV1Schema,
	  ProviderAccountUsageAdoptionV1Schema,
	  ProviderAccountUsageSnapshotV1Schema,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  SshTunnelEnsureRequestSchema,
  SshTunnelProbeRequestSchema,
  SshTunnelReleaseRequestSchema,
  SshTunnelStopRequestSchema,
  type ConnectedServiceBindingsV1,
	  type ConnectedServiceId,
	  type ConnectedServiceQuotaSnapshotV1,
	  type ProviderAccountUsageAdoptionV1,
	  type ProviderAccountUsageSnapshotV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
	} from '@happier-dev/protocol';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { toSshTunnelErrorResponse, type SshTunnelSupervisor } from '@/daemon/ssh/tunnels';
import type { LocalServiceInventoryRoutes } from './local/services/inventory/routes';
import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeFailureClassification,
} from './connectedServices/runtimeAuth/types';
import type { RuntimeAuthRecoverySchedulerLike } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { sanitizeConnectedServiceDiagnosticString } from './connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import {
  isLocallyCompleteWithoutProof,
  isProvenRuntimeAuthRecoverySuccess,
} from './connectedServices/runtimeAuth/resolveRuntimeAuthRecoveryOutcome';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from './connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import { buildRuntimeAuthRecoveryScheduledResult } from './connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
import { projectConnectedServiceQuotaSnapshotToProviderAccountUsageSnapshot } from './connectedServices/accountUsage/compatibility';

const DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY = 'HAPPIER_DAEMON_CONTROL_BODY_LIMIT_BYTES';
const DEFAULT_SPAWN_NONCE_PENDING_TTL_MS = 5 * 60_000;
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

function isCanonicalSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return !/^PID-\d+$/.test(normalized);
}

function safeTokenEquals(provided: string, expected: string): boolean {
  const hashA = createHash('sha256').update(provided).digest();
  const hashB = createHash('sha256').update(expected).digest();
  return timingSafeEqual(hashA, hashB);
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

// Recovery success here clears the durable recovery intent (markSucceededByKey).
// It must require deterministic provider-outcome proof, NOT a local-only
// completion (credential_refreshed / unverified switch / observed_generation /
// generic ok), so the recovery is not fabricated as recovered while the provider
// session is still broken. Shared with the scheduler success boundary via
// isProvenRuntimeAuthRecoverySuccess.
function isConnectedServiceRuntimeAuthSuccess(result: unknown): boolean {
  return isProvenRuntimeAuthRecoverySuccess(result);
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
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerLike | null;
  sessionId: string;
  switchesThisTurn: number;
  classification: ConnectedServiceRuntimeFailureClassification;
}>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: unknown }>> {
  if (!input.runtimeAuthRecoveryScheduler?.beginClassifiedFailure) return { ok: true };
  try {
    await input.runtimeAuthRecoveryScheduler.beginClassifiedFailure({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

type SpawnNonceCorrelationRecord = Readonly<{
  status: 'pending' | 'success';
  sessionId?: string;
  updatedAtMs: number;
  expiresAtMs: number;
}>;

export function createDaemonControlApp({
  getChildren,
  machineId,
  stopSession,
  spawnSession,
  requestShutdown,
  beforeShutdown,
  isShuttingDown,
  onHappySessionWebhook,
  controlToken,
  sshTunnels,
  handleConnectedServiceRuntimeAuthFailure,
  runtimeAuthRecoveryScheduler,
  handleSessionConnectedServiceAuthSwitch,
  handleConnectedServiceTurnLifecycle,
  handleConnectedServiceQuotaSnapshot,
  handleProviderAccountUsageSnapshot,
  handleProviderAccountUsageAdoption,
  handleCodexChatGptAuthTokensRefresh,
  localServicesInventory,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  stopSession: (sessionId: string) => Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  // True once daemon shutdown / control-server stop has begun. Recovery handlers early-return when
  // set so switch/restart work is never run into a tearing-down daemon (a deferral, not an attempt).
  isShuttingDown?: () => boolean;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
  sshTunnels?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
  handleConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => Promise<unknown>;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerLike | null;
  handleConnectedServiceTurnLifecycle?: (input: Readonly<{
    sessionId: string;
    event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
  }>) => Promise<unknown>;
  handleSessionConnectedServiceAuthSwitch?: (input: Readonly<{
    sessionId: string;
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
  }>) => Promise<unknown>;
  handleConnectedServiceQuotaSnapshot?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>) => Promise<unknown>;
  handleProviderAccountUsageSnapshot?: (input: Readonly<{
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
  }>) => Promise<unknown>;
  handleProviderAccountUsageAdoption?: (input: Readonly<{
    sessionId: string;
    adoption: ProviderAccountUsageAdoptionV1;
  }>) => Promise<unknown>;
  handleCodexChatGptAuthTokensRefresh?: (input: Readonly<{
    sessionId: string;
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
  }>) => Promise<CodexChatGptAuthTokensRefreshResponse>;
  localServicesInventory?: LocalServiceInventoryRoutes;
}): FastifyInstance {
  void machineId;
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

  const requireAuth = async (request: { headers: Record<string, unknown> }, reply: any): Promise<void> => {
    const rawHeader = (request.headers as any)['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;
    if (!provided || !safeTokenEquals(provided, normalizedControlToken)) {
      reply.code(401);
      return reply.send({ success: false as const, error: 'Unauthorized' });
    }
  };

  typed.post('/ping', {
    schema: {
      response: {
        200: z.object({ status: z.literal('ok') }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    return { status: 'ok' as const };
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
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_auth_switch_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
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

  // Session reports itself after creation
  typed.post('/session-started', {
    schema: {
      body: z.object({
        sessionId: z.string(),
        metadata: z.any() // Metadata type from API
      }),
      response: {
        200: z.object({
          status: z.literal('ok')
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const { sessionId, metadata } = request.body;

    logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
    onHappySessionWebhook(sessionId, metadata);
    markSpawnNonceFromTrackedSession(sessionId);

    return { status: 'ok' as const };
  });

  typed.post('/connected-service-runtime-auth/failure', {
    schema: {
      body: z.object({
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
        }),
        401: authSchema401,
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
    const resumePromptMode = request.body.resumePromptMode;
    const classification = request.body.classification as ConnectedServiceRuntimeFailureClassification;
    if (daemonStopRequested) {
      return {
        ok: true as const,
        result: {
          status: 'daemon_lifecycle_unavailable' as const,
          reason: 'recovery_deferred_shutdown' as const,
        },
      };
    }
    const intake = await beginRuntimeAuthRecoveryIntake({
      runtimeAuthRecoveryScheduler,
      sessionId,
      switchesThisTurn,
      classification,
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
    // Daemon shutdown / control-server stop in progress: defer recovery without running switch /
    // restart work and without clearing the recovery intent. The classified failure has already
    // been durably recorded above, so a healthy future daemon can re-drive it.
    if (isShuttingDown?.() === true) {
      return {
        ok: true as const,
        result: {
          status: 'daemon_lifecycle_unavailable' as const,
          reason: 'recovery_deferred_shutdown' as const,
        },
      };
    }
    try {
      const result = await handleConnectedServiceRuntimeAuthFailure({
        sessionId,
        switchesThisTurn,
        ...(resumePromptMode ? { resumePromptMode } : {}),
        classification,
      });
      if (isConnectedServiceRuntimeAuthApplyFailure(result) && runtimeAuthRecoveryScheduler) {
        try {
          const recovery = await runtimeAuthRecoveryScheduler.enqueueApplyFailure({
            sessionId,
            switchesThisTurn,
            classification,
            result,
          });
          if (isRuntimeAuthRecoveryScheduled(recovery)) {
            return {
              ok: true as const,
              result: {
                ...buildRuntimeAuthRecoveryScheduledResult({
                  classification,
                  recovery,
                  originalResult: result,
                }),
              },
            };
          }
        } catch (schedulerError) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after apply failure', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(schedulerError),
          });
        }
      }
      if (isLocallyCompleteWithoutProof(result)) {
        await runtimeAuthRecoveryScheduler?.markAwaitingProviderOutcomeProofByKey?.({
          sessionId,
          serviceId: classification.serviceId,
          profileId: classification.profileId ?? null,
          groupId: classification.groupId ?? null,
        }).catch((error) => {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery proof-wait mark failed after local completion', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        });
      }
      if (isConnectedServiceRuntimeAuthSuccess(result)) {
        await runtimeAuthRecoveryScheduler?.markSucceededByKey({
          sessionId,
          serviceId: classification.serviceId,
          profileId: classification.profileId ?? null,
          groupId: classification.groupId ?? null,
        }).catch((error) => {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery cancel failed after success', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        });
      }
      return { ok: true as const, result };
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
            sessionId,
            switchesThisTurn,
            classification,
            error,
          });
          if (isRuntimeAuthRecoveryScheduled(recovery)) {
            return {
              ok: true as const,
              result: {
                ...buildRuntimeAuthRecoveryScheduledResult({
                  classification,
                  recovery,
                }),
              },
            };
          }
        } catch (schedulerError) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after handler failure', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(schedulerError),
          });
        }
      }
      return {
        ok: true as const,
        result: {
          status: 'recovery_handler_failed' as const,
          errorCode: 'unexpected_error' as const,
        },
      };
    }
  });

  typed.post('/connected-service-turn-lifecycle', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        event: z.enum(['prompt_or_steer', 'task_started', 'assistant_message_end', 'turn_cancelled']),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_turn_lifecycle_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleConnectedServiceTurnLifecycle) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_turn_lifecycle_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceTurnLifecycle({
      sessionId: request.body.sessionId,
      event: request.body.event,
    });
    return { ok: true as const, result };
  });

  typed.post('/connected-service-quota-snapshot', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        serviceId: ConnectedServiceIdSchema,
        snapshot: ConnectedServiceQuotaSnapshotV1Schema,
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        400: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_quota_snapshot_service_id_mismatch'),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_quota_snapshot_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (request.body.snapshot.serviceId !== request.body.serviceId) {
      reply.code(400);
      return {
        ok: false as const,
        errorCode: 'connected_service_quota_snapshot_service_id_mismatch' as const,
      };
    }
    if (handleProviderAccountUsageSnapshot) {
      const snapshot = projectConnectedServiceQuotaSnapshotToProviderAccountUsageSnapshot({
        sessionId: request.body.sessionId,
        serviceId: request.body.serviceId,
        snapshot: request.body.snapshot,
      });
      const result = await handleProviderAccountUsageSnapshot({
        sessionId: request.body.sessionId,
        snapshot,
      });
      if (handleConnectedServiceQuotaSnapshot) {
        await handleConnectedServiceQuotaSnapshot({
          sessionId: request.body.sessionId,
          serviceId: request.body.serviceId,
          snapshot: request.body.snapshot,
        });
      }
      return { ok: true as const, result };
    }
    if (!handleConnectedServiceQuotaSnapshot) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_quota_snapshot_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceQuotaSnapshot({
      sessionId: request.body.sessionId,
      serviceId: request.body.serviceId,
      snapshot: request.body.snapshot,
    });
    return { ok: true as const, result };
  });

	  typed.post('/provider-account-usage-snapshot', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        snapshot: ProviderAccountUsageSnapshotV1Schema,
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('provider_account_usage_snapshot_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleProviderAccountUsageSnapshot) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'provider_account_usage_snapshot_handler_unavailable' as const,
      };
    }
    const result = await handleProviderAccountUsageSnapshot({
      sessionId: request.body.sessionId,
      snapshot: request.body.snapshot,
    });
	    return { ok: true as const, result };
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
	        501: z.object({
	          ok: z.literal(false),
	          errorCode: z.literal('provider_account_usage_adoption_handler_unavailable'),
	        }),
	      },
	    },
	    preHandler: requireAuth,
	  }, async (request, reply) => {
	    if (!handleProviderAccountUsageAdoption) {
	      reply.code(501);
	      return {
	        ok: false as const,
	        errorCode: 'provider_account_usage_adoption_handler_unavailable' as const,
	      };
	    }
	    const result = await handleProviderAccountUsageAdoption({
	      sessionId: request.body.sessionId,
	      adoption: request.body.adoption,
	    });
	    return { ok: true as const, result };
	  });

	  typed.post(CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH, {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        selection: CodexChatGptAuthTokensRefreshSelectionSchema,
        chatgptPlanType: z.string().nullable().optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: CodexChatGptAuthTokensRefreshResponseSchema,
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_chatgpt_refresh_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleCodexChatGptAuthTokensRefresh) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_chatgpt_refresh_handler_unavailable' as const,
      };
    }
    const result = await handleCodexChatGptAuthTokensRefresh({
      sessionId: request.body.sessionId,
      selection: request.body.selection,
      chatgptPlanType: request.body.chatgptPlanType ?? null,
    });
    return { ok: true as const, result };
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
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_inventory_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
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
        501: z.object({ ok: z.literal(false), errorCode: z.literal('local_services_inventory_unavailable') }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
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
        200: z.object({
          success: z.boolean()
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const { sessionId } = request.body;

    logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
    const success = await stopSession(sessionId);
    return { success };
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
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
        })
      }
    },
    preHandler: requireAuth,
      }, async (request, reply) => {
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
        if (spawnNonce) {
          markSpawnNoncePending(spawnNonce);
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
          const message = error instanceof Error ? error.message : String(error);
          reply.code(500);
          return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      };
    }

    switch (result.type) {
      case 'success':
        // Check if sessionId exists, if not return error
        if (!result.sessionId) {
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
        reply.code(409); // Conflict - user input needed
        return { 
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory
        };
      
      case 'error':
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

    for (const child of getChildren()) {
      const childNonce = typeof child.spawnOptions?.spawnNonce === 'string' ? child.spawnOptions.spawnNonce.trim() : '';
      if (!childNonce || childNonce !== normalizedNonce) continue;
      const childSessionId = typeof child.happySessionId === 'string' ? child.happySessionId.trim() : '';
      if (isCanonicalSessionId(childSessionId)) {
        markSpawnNonceSuccess(normalizedNonce, childSessionId);
        return {
          success: true as const,
          status: 'success' as const,
          sessionId: childSessionId,
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
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
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
          modelId: requestBody.modelId,
          modelUpdatedAt: requestBody.modelUpdatedAt,
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
      reply.code(500);
      return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
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

  // Stop daemon
  typed.post('/stop', {
    schema: {
      body: z
        .object({
          stopSessions: z.boolean().optional(),
        })
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
    logger.debug('[CONTROL SERVER] Stop daemon request received', { stopSessions });

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
  stopSession,
  spawnSession,
  requestShutdown,
  beforeShutdown,
  isShuttingDown,
  onHappySessionWebhook,
  controlToken,
  sshTunnels,
  localServicesInventory,
  handleConnectedServiceRuntimeAuthFailure,
  runtimeAuthRecoveryScheduler,
  handleSessionConnectedServiceAuthSwitch,
  handleConnectedServiceTurnLifecycle,
  handleConnectedServiceQuotaSnapshot,
  handleProviderAccountUsageSnapshot,
  handleProviderAccountUsageAdoption,
  handleCodexChatGptAuthTokensRefresh,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  stopSession: (sessionId: string) => Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  // True once daemon shutdown / control-server stop has begun. Recovery handlers early-return when
  // set so switch/restart work is never run into a tearing-down daemon (a deferral, not an attempt).
  isShuttingDown?: () => boolean;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
  sshTunnels?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
  localServicesInventory?: LocalServiceInventoryRoutes;
  handleConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => Promise<unknown>;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerLike | null;
  handleConnectedServiceTurnLifecycle?: (input: Readonly<{
    sessionId: string;
    event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
  }>) => Promise<unknown>;
  handleSessionConnectedServiceAuthSwitch?: (input: Readonly<{
    sessionId: string;
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
  }>) => Promise<unknown>;
  handleConnectedServiceQuotaSnapshot?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>) => Promise<unknown>;
	  handleProviderAccountUsageSnapshot?: (input: Readonly<{
	    sessionId: string;
	    snapshot: ProviderAccountUsageSnapshotV1;
	  }>) => Promise<unknown>;
	  handleProviderAccountUsageAdoption?: (input: Readonly<{
	    sessionId: string;
	    adoption: ProviderAccountUsageAdoptionV1;
	  }>) => Promise<unknown>;
	  handleCodexChatGptAuthTokensRefresh?: (input: Readonly<{
    sessionId: string;
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
  }>) => Promise<CodexChatGptAuthTokensRefreshResponse>;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = createDaemonControlApp({
      getChildren,
      machineId,
      stopSession,
      spawnSession,
      requestShutdown,
      beforeShutdown,
      isShuttingDown,
      onHappySessionWebhook,
      controlToken,
      sshTunnels,
      localServicesInventory,
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
      handleSessionConnectedServiceAuthSwitch,
	      handleConnectedServiceTurnLifecycle,
	      handleConnectedServiceQuotaSnapshot,
	      handleProviderAccountUsageSnapshot,
	      handleProviderAccountUsageAdoption,
	      handleCodexChatGptAuthTokensRefresh,
	    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
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
