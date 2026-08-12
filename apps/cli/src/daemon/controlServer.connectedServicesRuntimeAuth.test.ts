import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import {
  persistOpenCodeBrokerLoadHandshakeObservation,
  resetOpenCodeBrokerLoadHandshakesForTests,
  resolveOpenCodeBrokerLoadHandshakeStatus,
} from '@/backends/opencode/brokerPlugin';
import type {
  ManagedOpenCodeBrokerActivationStateDeps,
  SharedManagedOpenCodeServerState,
} from '@/backends/opencode/server/sharedManagedServer';
import { deriveConnectedServiceBrokerRefreshToken } from './connectedServices/broker/brokerRefreshCapabilityToken';
import {
  resetBrokerBridgeEffectiveSelectionsForTests,
  markBrokerBridgeEffectiveSelectionUnavailable,
  updateBrokerBridgeEffectiveSelection,
} from './connectedServices/broker/brokerBridgeEffectiveSelectionRegistry';
import { createDaemonControlApp, startDaemonControlServer } from './controlServer';

/** Scoped broker-refresh token for the master control token the bridge endpoints now require (F2). */
const BROKER_SCOPED_TOKEN = deriveConnectedServiceBrokerRefreshToken('token');
import { buildRuntimeAuthRecoveryKey } from './connectedServices/runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import {
  RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryDiagnostic,
} from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import {
  reportConnectedServiceRuntimeAuthFailureToDaemon,
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests,
} from './connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { readRuntimeAuthFailureReportOutboxItems } from './connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox';
import type { ConnectedServiceRuntimeFailureClassification } from './connectedServices/runtimeAuth/types';
import { authorizeConnectedServiceRuntimeAuthFailureSource } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { resolveCurrentCodexRuntimeAuthFailureSource } from './connectedServices/runtimeAuth/resolveCurrentCodexRuntimeAuthFailureSource';
import { ConnectedServiceCredentialRefreshError } from './connectedServices/refresh/ConnectedServiceRefreshCoordinator';

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('createDaemonControlApp connected-service runtime auth handling', () => {
  it('returns typed reconnect-required bridge failure instead of HTTP 500', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => {
      throw new ConnectedServiceCredentialRefreshError({
        serviceId: 'openai-codex',
        profileId: 'work',
        reason: 'provider_auth_bridge',
        status: 'blocked_by_credential_health',
        refreshWindowMs: 60_000,
      });
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
          chatgptPlanType: 'plus',
          forceRefresh: true,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_credential_reconnect_required',
        credentialHealthStatus: 'needs_reauth',
      });
    } finally {
      await app.close();
    }
  });

  it('returns the same typed reconnect-required failure for the Claude refresh bridge', async () => {
    const handleClaudeSubscriptionAuthTokensRefresh = vi.fn(async () => {
      throw new ConnectedServiceCredentialRefreshError({
        serviceId: 'claude-subscription',
        profileId: 'work',
        reason: 'provider_auth_bridge',
        status: 'blocked_by_credential_health',
        refreshWindowMs: 60_000,
      });
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleClaudeSubscriptionAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
          forceRefresh: true,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_credential_reconnect_required',
        credentialHealthStatus: 'needs_reauth',
      });
    } finally {
      await app.close();
    }
  });

  it('returns retryable intake failure when exact source verification is temporarily unavailable', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      authorizeConnectedServiceRuntimeAuthFailure: async () => {
        throw new Error('runtime identity transport unavailable');
      },
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:source-verifier-unavailable',
          sessionId: 'sess_source_verifier_unavailable',
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            groupGeneration: 7,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
            recoveryAction: { kind: 'quota_recovery_required' },
          },
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_runtime_auth_recovery_intake_failed',
      });
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('accepts and retires an exact old-target report after the registered runtime adopted a newer generation', async () => {
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
    const outboxDir = await createTempDir('happier-runtime-auth-post-apply-superseded-');
    const beginClassifiedFailure = vi.fn();
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'recovery_superseded' as const,
      reason: 'source_tuple_mismatch' as const,
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'edison',
    }));
    const readRuntimeIdentity = vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'runtime_identity_probe_account_mismatch',
    }));
    const tracked = {
      startedBy: 'daemon' as const,
      happySessionId: 'cmrgveac',
      pid: 123,
      spawnOptions: { directory: '/tmp/project' },
    };
    const app = createDaemonControlApp({
      getChildren: () => [tracked],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      authorizeConnectedServiceRuntimeAuthFailure: async ({ sessionId, classification }) =>
        await authorizeConnectedServiceRuntimeAuthFailureSource({
          getChildren: () => [tracked],
          sessionId,
          classification,
          resolveRegisteredRuntimeAuthFailureSource: () => ({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'batiplus',
            generation: 1225,
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
          }),
          resolveCurrentRuntimeAuthFailureSource: async ({ classification: currentClassification }) =>
            await resolveCurrentCodexRuntimeAuthFailureSource({
              classification: currentClassification,
              readRuntimeIdentity,
              resolveCurrentCredential: async () => null,
            }),
          runtimeAuthApply: {
            directLiveHotAuth: {
              supportsInTurnApply: true,
              requiresExactRuntimeIdentity: true,
              refreshSelectionResync: 'required',
              authMode: {
                kind: 'external_token_injection',
                surface: 'test-codex-runtime',
              },
            },
          },
        }),
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: {
        beginClassifiedFailure,
      } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>,
    });

    try {
      const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: tracked.happySessionId,
        switchesThisTurn: 0,
        classification: {
          kind: 'auth_expired',
          serviceId: 'openai-codex',
          profileId: 'edison',
          groupId: 'main',
          groupGeneration: 1224,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
          resetsAtMs: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
        },
        notify: async (body) => {
          const response = await app.inject({
            method: 'POST',
            url: '/connected-service-runtime-auth/failure',
            headers: { 'x-happier-daemon-token': 'token' },
            payload: body,
          });
          expect(response.statusCode).toBe(200);
          return response.json();
        },
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
        createReportId: () => 'runtime-auth-report:post-apply-superseded',
      });

      expect(report.report).toEqual({
        ok: true,
        result: {
          status: 'recovery_superseded',
          reason: 'source_tuple_mismatch',
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'edison',
        },
      });
      expect(readRuntimeIdentity).not.toHaveBeenCalled();
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: tracked.happySessionId,
        interruptedOriginId: 'runtime-auth-report:post-apply-superseded',
        sourceAuthorization: expect.objectContaining({
          status: 'recovery_superseded',
          reason: 'source_tuple_mismatch',
        }),
      }));
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toHaveLength(0);
    } finally {
      await app.close();
      await removeTempDir(outboxDir);
    }
  });

  it('returns retryable intake failure when the current exact binding is temporarily unregistered', async () => {
    const beginClassifiedFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({ status: 'switch_attempted' }));
    const tracked = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_missing',
      pid: 123,
      spawnOptions: { directory: '/tmp/project' },
    };
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      authorizeConnectedServiceRuntimeAuthFailure: async ({ sessionId, classification }) =>
        await authorizeConnectedServiceRuntimeAuthFailureSource({
          getChildren: () => [tracked],
          sessionId,
          classification,
          resolveRegisteredRuntimeAuthFailureSource: () => null,
        }),
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { beginClassifiedFailure },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:missing-exact-tuple',
          sessionId: 'sess_missing',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            groupGeneration: 1,
            credentialRevision: 'rev-1',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
            recoveryAction: { kind: 'quota_recovery_required' },
          },
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_runtime_auth_recovery_intake_failed',
      });
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('retains an exact report in the bounded outbox while the current binding is unavailable', async () => {
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
    const outboxDir = await createTempDir('happier-runtime-auth-source-binding-unavailable-');
    const tracked = {
      startedBy: 'daemon' as const,
      happySessionId: 'sess_binding_unavailable',
      pid: 123,
      spawnOptions: { directory: '/tmp/project' },
    };
    const handleConnectedServiceRuntimeAuthFailure = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [tracked],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      authorizeConnectedServiceRuntimeAuthFailure: async ({ sessionId, classification }) =>
        await authorizeConnectedServiceRuntimeAuthFailureSource({
          getChildren: () => [tracked],
          sessionId,
          classification,
          resolveRegisteredRuntimeAuthFailureSource: () => null,
        }),
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: tracked.happySessionId,
        switchesThisTurn: 0,
        classification: {
          kind: 'usage_limit',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          groupGeneration: 7,
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
          resetsAtMs: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
          recoveryAction: { kind: 'quota_recovery_required' },
        },
        notify: async (body) => {
          const response = await app.inject({
            method: 'POST',
            url: '/connected-service-runtime-auth/failure',
            headers: { 'x-happier-daemon-token': 'token' },
            payload: body,
          });
          expect(response.statusCode).toBe(503);
          return response.json();
        },
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: {
          ok: false,
          errorCode: 'connected_service_runtime_auth_recovery_intake_failed',
        },
      });

      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      await expect(readRuntimeAuthFailureReportOutboxItems({ outboxDir })).resolves.toHaveLength(1);
    } finally {
      await app.close();
      await removeTempDir(outboxDir);
    }
  });

  it('accepts a surviving runner report from a previous daemon generation through current source authority', async () => {
    const sourceAuthorization = { status: 'authorized' as const, tracked: null };
    const authorizeConnectedServiceRuntimeAuthFailure = vi.fn(async () => sourceAuthorization);
    const beginClassifiedFailure = vi.fn(async () => ({
      status: 'waiting' as const,
      attemptId: 'attempt-surviving-runner',
      reportId: 'runtime-auth-report:surviving-runner',
    }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'temporary_retry_armed' as const,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      authorizeConnectedServiceRuntimeAuthFailure,
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: {
        beginClassifiedFailure,
      } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:surviving-runner',
          originDaemonExecutionGenerationV1: 'daemon-before-restart',
          sessionId: 'sess_stale_runner',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: { status: 'temporary_retry_armed' },
      });
      expect(beginClassifiedFailure).toHaveBeenCalledOnce();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(
        expect.objectContaining({ sourceAuthorization }),
      );
    } finally {
      await app.close();
    }
  });

  it('uses the exact authorized live binding for durable intake and recovery handling', async () => {
    const sourceAuthorization = {
      status: 'authorized' as const,
      tracked: null,
      sourceBinding: {
        serviceId: 'openai-codex' as const,
        groupId: 'main',
        profileId: 'backup',
        generation: 9,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    };
    const beginClassifiedFailure = vi.fn(async () => ({
      status: 'waiting' as const,
      attemptId: 'attempt-live-binding',
    }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'temporary_retry_armed' as const,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      authorizeConnectedServiceRuntimeAuthFailure: async () => sourceAuthorization,
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: {
        beginClassifiedFailure,
      } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:live-binding',
          sessionId: 'sess_live_binding',
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'backup',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const exactClassification = expect.objectContaining({
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'backup',
        groupGeneration: 9,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      });
      expect(beginClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
        classification: exactClassification,
      }));
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
        classification: exactClassification,
        sourceAuthorization,
      }));
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      outcome: 'proven-success',
      finish: async () => ({
        status: 'switch_attempted',
        result: {
          status: 'switched',
          activeProfileId: 'backup',
          generation: 2,
          verificationByServiceId: {
            'openai-codex': { status: 'verified' },
          },
        },
      }),
    },
    {
      outcome: 'terminal',
      finish: async () => ({
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          reason: 'auth_expired',
        },
      }),
    },
    {
      outcome: 'apply-failure',
      finish: async () => ({
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'backup',
          generation: 2,
          errorCode: 'post_switch_verification_failed',
          diagnostics: { retryable: true },
        },
      }),
    },
    {
      outcome: 'handler-failure',
      finish: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
    },
  ])('does not let an older $outcome handler result mutate a newer source epoch', async ({ finish }) => {
    const handlerStarted = createDeferred<void>();
    const releaseHandler = createDeferred<void>();
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      handlerStarted.resolve();
      await releaseHandler.promise;
      return await finish();
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_attempt_fence',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    try {
      const olderRequest = app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:older-handler',
          sessionId: 'sess_attempt_fence',
          switchesThisTurn: 0,
          classification: {
            kind: 'auth_expired',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
            sourceKey: 'older-source-epoch',
          },
        },
      });
      await handlerStarted.promise;
      const newer = await runtimeAuthRecoveryScheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:newer-handler',
        sessionId: 'sess_attempt_fence',
        switchesThisTurn: 0,
        classification: {
          kind: 'auth_expired',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          resetsAtMs: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
          sourceKey: 'newer-source-epoch',
        } as ConnectedServiceRuntimeFailureClassification,
      });

      releaseHandler.resolve();
      const olderResponse = await olderRequest;

      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'waiting',
        attemptId: newer.attemptId,
        classification: expect.objectContaining({ sourceKey: 'newer-source-epoch' }),
      });
      expect(olderResponse.json()).toMatchObject({
        recoveryReceipt: {
          reportId: 'runtime-auth-report:older-handler',
          attemptId: expect.not.stringMatching(String(newer.attemptId)),
        },
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        attemptId: expect.not.stringMatching(String(newer.attemptId)),
        transition: expect.stringMatching(/^(scheduled|terminal|recovered)$/),
      }));
    } finally {
      releaseHandler.resolve();
      runtimeAuthRecoveryScheduler.dispose();
      await app.close();
    }
  });

  it('fails closed instead of using unfenced recovery fallbacks when intake omits an attempt id', async () => {
    const beginClassifiedFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const markProviderOutcomeProofByKey = vi.fn(async () => ({ status: 'recovered' }));
    const markSucceededByKey = vi.fn(async () => ({ status: 'recovered' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: {
        beginClassifiedFailure,
        markProviderOutcomeProofByKey,
        markSucceededByKey,
        cancelByKey,
      },
    } as Parameters<typeof createDaemonControlApp>[0]);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:missing-attempt',
          sessionId: 'sess_missing_attempt',
          classification: {
            kind: 'auth_expired',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(beginClassifiedFailure).toHaveBeenCalledOnce();
      expect(markProviderOutcomeProofByKey).not.toHaveBeenCalled();
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
      expect(response.json()).not.toHaveProperty('recoveryReceipt');
    } finally {
      await app.close();
    }
  });
  it('propagates a joined intake failure status and evicts it so the same report can retry', async () => {
    let rejectIntake!: (error: Error) => void;
    const failedIntake = new Promise<never>((_resolve, reject) => {
      rejectIntake = reject;
    });
    const beginClassifiedFailure = vi.fn()
      .mockImplementationOnce(async () => await failedIntake)
      .mockResolvedValue({ status: 'scheduled', retryable: true });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'recovery_action_required',
      reason: 'reconnect',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { beginClassifiedFailure },
    } as Parameters<typeof createDaemonControlApp>[0]);

    const payload = {
      reportId: 'runtime-auth-report:retry-after-intake-failure',
      sessionId: 'sess_retry_after_intake_failure',
      classification: {
        kind: 'auth_expired',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    };

    try {
      const first = app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload,
      });
      const joined = app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload,
      });
      await vi.waitFor(() => expect(beginClassifiedFailure).toHaveBeenCalledOnce());
      rejectIntake(new Error('durable intake unavailable'));

      const failedResponses = await Promise.all([first, joined]);
      expect(failedResponses.map((response) => response.statusCode)).toEqual([503, 503]);
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();

      const retried = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload,
      });
      expect(retried.statusCode).toBe(200);
      expect(beginClassifiedFailure).toHaveBeenCalledTimes(2);
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('claims one stable report id so concurrent direct and outbox retries join one recovery decision', async () => {
    let releaseHandler!: () => void;
    const handlerBarrier = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const beginClassifiedFailure = vi.fn(async () => ({
      status: 'scheduled',
      retryable: true,
      attemptId: 'runtime-auth-attempt:claim-join',
      transition: 'working',
    }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      await handlerBarrier;
      return { status: 'recovery_action_required', reason: 'reconnect' };
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { beginClassifiedFailure },
    } as Parameters<typeof createDaemonControlApp>[0]);

    try {
      const payload = {
        reportId: 'runtime-auth-report:claim-join-test',
        sessionId: 'sess_claim_join',
        switchesThisTurn: 0,
        classification: {
          kind: 'auth_expired',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          resetsAtMs: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
        },
      };
      const requests = Array.from({ length: 11 }, () => app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload,
      }));
      await vi.waitFor(() => expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce());
      releaseHandler();
      const responses = await Promise.all(requests);

      expect(new Set(responses.map((response) => response.body)).size).toBe(1);
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(responses[0]?.json()).toMatchObject({
        recoveryReceipt: {
          reportId: 'runtime-auth-report:claim-join-test',
          attemptId: 'runtime-auth-attempt:claim-join',
          transition: 'working',
          eventLocalId: expect.stringMatching(/^connected-service-runtime-auth-recovery:/),
        },
      });
      expect(beginClassifiedFailure).toHaveBeenCalledOnce();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();

      const replay = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload,
      });
      expect(replay.body).toBe(responses[0]?.body);
      expect(beginClassifiedFailure).toHaveBeenCalledOnce();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
    } finally {
      releaseHandler();
      await app.close();
    }
  });

  it('bounds settled runtime-auth report claims after a concurrent intake burst while preserving in-flight coalescing', async () => {
    const releases: Array<() => void> = [];
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { status: 'not_classified' as const };
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });
    const request = async (reportId: string) => await app.inject({
      method: 'POST',
      url: '/connected-service-runtime-auth/failure',
      headers: { 'x-happier-daemon-token': 'token' },
      payload: {
        reportId,
        sessionId: 'sess_bounded_claims',
        classification: {
          kind: 'auth_expired',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          resetsAtMs: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
        },
      },
    });

    try {
      const burst = Array.from(
        { length: 257 },
        (_, index) => request(`runtime-auth-report:bounded-${index}`),
      );
      await vi.waitFor(() => expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(257));
      for (const release of releases) release();
      expect((await Promise.all(burst)).every((response) => response.statusCode === 200)).toBe(true);
      const replay = request('runtime-auth-report:bounded-0');
      await vi.waitFor(() => expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(258));
      releases.at(-1)?.();
      await replay;
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(258);
    } finally {
      for (const release of releases) release();
      await app.close();
    }
  });

  it('dispatches manual session auth switches to the daemon handler', async () => {
    const handleSessionConnectedServiceAuthSwitch = vi.fn(async () => ({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
      warnings: [],
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleSessionConnectedServiceAuthSwitch,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/session/switch',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          agentId: 'claude',
          bindings: {
            v: 1,
            bindingsByServiceId: {
              anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
          },
          rematerializeServiceId: 'anthropic',
          expectedGroupGenerationByServiceId: { anthropic: 4 },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          ok: true,
          action: 'restart_requested',
          normalizedBindings: {
            v: 1,
            bindingsByServiceId: {
              anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
          },
          continuityByServiceId: { anthropic: 'restart_rematerialize' },
          warnings: [],
        },
      });
      expect(handleSessionConnectedServiceAuthSwitch).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
          },
        },
        rematerializeServiceId: 'anthropic',
        expectedGroupGenerationByServiceId: { anthropic: 4 },
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches reported provider runtime auth failure kinds to the daemon handler', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          resumePromptMode: 'custom',
          classification: {
            kind: 'capacity',
            limitCategory: 'capacity',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        },
      });
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        resumePromptMode: 'custom',
        classification: expect.objectContaining({
          kind: 'capacity',
          serviceId: 'openai-codex',
          limitCategory: 'capacity',
          groupId: 'main',
        }),
      });
    } finally {
      await app.close();
    }
  });

  it('does NOT clear the recovery intent for credential_refreshed without provider-outcome proof', async () => {
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'credential_refreshed',
      restartRequested: true,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { cancelByKey, markSucceededByKey },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'credential_refreshed',
          restartRequested: true,
        },
      });
      // No deterministic provider-outcome proof => recovery stays pending.
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('creates durable runtime-auth recovery intake before running local repair', async () => {
    const calls: string[] = [];
    const beginClassifiedFailure = vi.fn(async () => {
      calls.push('begin');
      return { status: 'scheduled', retryable: true, resumePromptMode: 'custom' as const };
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      calls.push('handler');
      expect(calls).toEqual(['begin', 'handler']);
      return {
        status: 'credential_refreshed' as const,
        restartRequested: true,
      };
    });
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const resolveConnectedServiceRuntimeAuthResumePromptMode = vi.fn(async () => 'off' as const);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      resolveConnectedServiceRuntimeAuthResumePromptMode,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const classification = {
        kind: 'auth_expired',
        serviceId: 'claude-subscription',
        profileId: 'leeroy_new',
        groupId: 'claude',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_claude_group',
          switchesThisTurn: 0,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'credential_refreshed',
          restartRequested: true,
        },
        resumePromptMode: 'custom',
      });
      expect(beginClassifiedFailure).toHaveBeenCalledWith({
        sessionId: 'sess_claude_group',
        switchesThisTurn: 0,
        classification: expect.objectContaining(classification),
        reportId: undefined,
        resumePromptMode: 'off',
      });
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({ resumePromptMode: 'custom' }));
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
      expect(calls).toEqual(['begin', 'handler']);
    } finally {
      await app.close();
    }
  });

  it('routes temporary throttles without creating broad runtime-auth recovery intake', async () => {
    const beginClassifiedFailure = vi.fn(async () => {
      throw new Error('temporary throttle must not arm broad runtime-auth recovery');
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'temporary_retry_armed' as const,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      groupId: 'claude',
      retryAfterMs: 1_250,
      resetAtMs: null,
      recovery: {
        status: 'scheduled',
        nextRetryAtMs: 2_250,
        attemptCount: 0,
      },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const classification = {
        kind: 'temporary_throttle',
        limitCategory: 'rate_limit',
        serviceId: 'claude-subscription',
        profileId: 'primary',
        groupId: 'claude',
        resetsAtMs: null,
        retryAfterMs: 1_250,
        quotaScope: 'provider',
        providerLimitId: 'transient',
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_claude_temp_throttle',
          switchesThisTurn: 0,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: expect.objectContaining({
          status: 'temporary_retry_armed',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'claude',
        }),
      });
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_claude_temp_throttle',
        switchesThisTurn: 0,
        classification: expect.objectContaining(classification),
        resumePromptMode: 'standard',
      });
    } finally {
      await app.close();
    }
  });

  it('does not route temporary-throttle handler outcomes into broad runtime-auth settlement', async () => {
    const beginClassifiedFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const enqueueApplyFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'post_switch_verification_failed',
        diagnostics: { retryable: true },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { beginClassifiedFailure, enqueueApplyFailure },
    } as Parameters<typeof createDaemonControlApp>[0]);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_temporary_apply',
          classification: {
            kind: 'temporary_throttle',
            limitCategory: 'rate_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            retryAfterMs: 1_000,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(enqueueApplyFailure).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('routes provider capacity temporary retries without broad runtime-auth recovery intake', async () => {
    const beginClassifiedFailure = vi.fn(async () => {
      throw new Error('provider capacity retry must not arm broad runtime-auth recovery');
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'temporary_retry_armed' as const,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      groupId: 'claude',
      retryAfterMs: 2_000,
      resetAtMs: null,
      recovery: {
        status: 'scheduled',
        nextRetryAtMs: 3_000,
        attemptCount: 0,
      },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const classification = {
        kind: 'capacity',
        limitCategory: 'capacity',
        serviceId: 'claude-subscription',
        profileId: 'primary',
        groupId: 'claude',
        resetsAtMs: null,
        retryAfterMs: 2_000,
        quotaScope: 'provider',
        providerLimitId: 'server_overloaded',
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_claude_capacity',
          switchesThisTurn: 0,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_claude_capacity',
        switchesThisTurn: 0,
        classification: expect.objectContaining(classification),
        resumePromptMode: 'standard',
      });
    } finally {
      await app.close();
    }
  });

  it('marks report-path credential refresh without provider proof as awaiting provider outcome', async () => {
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      providerOutcomePendingWaitMs: 5_000,
      recover: async () => ({ status: 'credential_refreshed', restartRequested: true }),
    });
    const markAwaitingProviderOutcomeProofForResultByKey = vi.spyOn(
      runtimeAuthRecoveryScheduler,
      'markAwaitingProviderOutcomeProofForResultByKey',
    );
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'credential_refreshed' as const,
      restartRequested: true,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'resumed_awaiting_proof',
        lastError: 'recovery_unproven_awaiting_provider_outcome',
        nextRetryAtMs: 6_000,
      });
      expect(markAwaitingProviderOutcomeProofForResultByKey).toHaveBeenCalledWith(expect.objectContaining({
        recoveryKey,
        expectedAttemptId: runtimeAuthRecoveryScheduler.readByKey(recoveryKey)?.attemptId,
      }));
    } finally {
      await app.close();
    }
  });

  it('does not terminalize a group-exhausted no_eligible_member result when a reset wait is armed', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted' as const,
      result: {
        status: 'no_eligible_member' as const,
        generation: 17,
        groupExhausted: true,
        retryAtMs: 5_000,
        excluded: [
          { profileId: 'primary', reason: 'quota_exhausted', retryAtMs: 5_000 },
        ],
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: 5_000,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'no_eligible_member',
            generation: 17,
            groupExhausted: true,
            retryAtMs: 5_000,
            excluded: [
              { profileId: 'primary', reason: 'quota_exhausted', retryAtMs: 5_000 },
            ],
          },
        },
      });
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'waiting',
        nextRetryAtMs: 5_000,
        terminalReason: null,
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
      }));
    } finally {
      await app.close();
    }
  });

  it('re-arms a durable wait instead of terminalizing a timing-less group-exhausted no_eligible_member (F0)', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const markDurableWaitForResultByKey = vi.spyOn(
      runtimeAuthRecoveryScheduler,
      'markDurableWaitForResultByKey',
    );
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    // Genuinely timing-less group exhaustion (live incident cmq7pyq shape): no
    // retryAtMs, no resetsAtMs anywhere. The in-band path must mirror the
    // scheduler's F0 fix: durable wait at the policy floor, never terminal.
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted' as const,
      result: {
        status: 'no_eligible_member' as const,
        generation: 17,
        groupExhausted: true,
        retryAtMs: null,
        excluded: [
          { profileId: 'primary', reason: 'quota_exhausted', retryAtMs: null },
        ],
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      // Durable wait at the 30s group-exhausted floor, mirroring the scheduler-side
      // F0 fix — NOT cancelled, so the same key can be re-armed by later reports.
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'waiting',
        nextRetryAtMs: 31_000,
        terminalReason: null,
      });
      expect(markDurableWaitForResultByKey).toHaveBeenCalledWith(expect.objectContaining({
        recoveryKey,
        expectedAttemptId: runtimeAuthRecoveryScheduler.readByKey(recoveryKey)?.attemptId,
      }));
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
      }));
    } finally {
      await app.close();
    }
  });

  it('re-arms a durable wait with the switch-limit floor instead of terminalizing switch_limit_reached (INC-2)', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted' as const,
      result: {
        status: 'switch_limit_reached' as const,
        limit: 3,
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 3,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      // The per-session switch budget frees on a rolling hour window: durable wait
      // on the 5-minute switch-limit floor (INC-2), never a terminal record that
      // blocks re-arming the same key.
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'waiting',
        nextRetryAtMs: 301_000,
        terminalReason: null,
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
      }));
    } finally {
      await app.close();
    }
  });

  it('does NOT clear the recovery intent for a generic ok:true switch result without proof', async () => {
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        ok: true,
        action: 'restart_requested',
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { cancelByKey, markSucceededByKey },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            ok: true,
            action: 'restart_requested',
          },
        },
      });
      // No deterministic provider-outcome proof => recovery stays pending.
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('terminalizes the matching runtime-auth recovery key when the handler returns action-required', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'claude-subscription',
      profileId: 'leeroy_new',
      groupId: 'claude',
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'recovery_action_required' as const,
      action: {
        kind: 'reconnect_profile' as const,
        serviceId: 'claude-subscription',
        profileId: 'leeroy_new',
        groupId: 'claude',
        reason: 'auth_expired' as const,
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:terminal-action-required',
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'auth_expired',
            serviceId: 'claude-subscription',
            profileId: 'leeroy_new',
            groupId: 'claude',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: 'recovery_action_required',
          action: {
            kind: 'reconnect_profile',
            serviceId: 'claude-subscription',
            profileId: 'leeroy_new',
            groupId: 'claude',
            reason: 'auth_expired',
          },
        },
        recoveryReceipt: {
          reportId: 'runtime-auth-report:terminal-action-required',
          transition: 'terminal',
          attemptId: expect.stringMatching(/^runtime-auth-attempt:/),
        },
      });
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'cancelled',
        terminalReason: 'recovery_action_required',
      });
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
        sessionId: 'sess_1',
        serviceId: 'claude-subscription',
        profileId: 'leeroy_new',
        groupId: 'claude',
      }));
    } finally {
      await app.close();
    }
  });

  it('keeps the matching runtime-auth recovery key pending when switch handling only reports generic verification', async () => {
    const cancel = vi.fn(async () => ({ status: 'cancelled' }));
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const markProviderOutcomeProofByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: {
        cancel,
        cancelByKey,
        markSucceededByKey,
        markProviderOutcomeProofByKey,
      } as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']> & {
        markProviderOutcomeProofByKey: typeof markProviderOutcomeProofByKey;
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(markProviderOutcomeProofByKey).not.toHaveBeenCalled();
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('keeps an exhausted runtime-auth recovery dead-letter when in-band handling returns only generic verification', async () => {
    const recoveryClassification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } as ConnectedServiceRuntimeFailureClassification;
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    await runtimeAuthRecoveryScheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: recoveryClassification,
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(runtimeAuthRecoveryScheduler.wake({ sessionId: 'sess_1', reason: 'manual' }))
      .resolves.toEqual({ status: 'exhausted' });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'exhausted',
    });

    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: recoveryClassification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'exhausted',
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_success',
      }));
    } finally {
      await app.close();
    }
  });

  it('does not settle a recovery intent from generic switch verification via a real scheduler', async () => {
    // Regression for the unbound-method bug: controlServer used to extract
    // `scheduler.markSucceededByKey` into a local and call it, losing `this`, so
    // `markSucceededByKey` threw "Cannot read properties of undefined (reading
    // 'readByKey')" — swallowed by `.catch` — and the intent was never cleared.
    // This drives a REAL scheduler instance end-to-end through the control server.
    const recoveryClassification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } as ConnectedServiceRuntimeFailureClassification;
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      // Inner recover never runs in this flow; the control-server success branch
      // settles the pre-armed intent directly.
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    // Arm a waiting recovery intent that the success branch must settle.
    await runtimeAuthRecoveryScheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: recoveryClassification,
      error: new Error('timeout of 5000ms exceeded'),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).not.toBeNull();

    // Proven success: switch with verified account adoption.
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: recoveryClassification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toMatchObject({
        status: 'resumed_awaiting_proof',
      });
      expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_success');
    } finally {
      await app.close();
    }
  });

  it('returns a typed recovery failure when runtime auth handling throws', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'recovery_handler_failed',
          errorCode: 'unexpected_error',
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth failure handler failed',
        expect.objectContaining({
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          kind: 'usage_limit',
        }),
      );
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('preserves generation apply failure results when recovery scheduling fails', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'post_switch_verification_failed',
      },
    }));
    const enqueueApplyFailure = vi.fn(async () => {
      throw new Error('intent store unavailable');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'generation_apply_failed',
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'post_switch_verification_failed',
          },
        },
      });
      expect(enqueueApplyFailure).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after apply failure',
        expect.objectContaining({ sessionId: 'sess_1' }),
      );
    } finally {
      debugSpy.mockRestore();
      await app.close();
    }
  });

  it('returns scheduled runtime-auth recovery diagnostics with retry metadata', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'hot_apply_failed',
      },
    }));
    const enqueueApplyFailure = vi.fn(async () => ({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 1_700_000_100_000,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: 'recovery_retry_scheduled',
          recovery: {
            status: 'scheduled',
            retryable: true,
            nextRetryAtMs: 1_700_000_100_000,
          },
          uxDiagnostic: {
            code: 'recovery_retry_scheduled',
            failurePhase: 'runtime_auth_recovery',
            source: 'runtime_auth_recovery',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            retryable: true,
            diagnostics: {
              runtimeFailureKind: 'usage_limit',
              classificationSource: 'structured_provider_error',
              nextRetryAtMs: 1_700_000_100_000,
            },
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('projects one retryable visible recovery event when predecessor retirement is unproven', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const retirementError = Object.assign(
      new Error('connected_service_previous_runner_retirement_unproven:timeout'),
      {
        code: 'connected_service_previous_runner_retirement_unproven',
        retryable: true,
      },
    );
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw retirementError;
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:retirement-unproven',
          sessionId: 'sess_retirement_unproven',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: 'recovery_retry_scheduled',
          uxDiagnostic: {
            code: 'recovery_retry_scheduled',
            retryable: true,
            diagnostics: {
              nextRetryAtMs: 1_100,
            },
          },
          transcriptEvent: {
            type: 'connected-service-runtime-auth-recovery',
            status: 'retry_scheduled',
            terminal: false,
            diagnostic: {
              code: 'recovery_retry_scheduled',
              retryable: true,
            },
          },
        },
      });
      expect(diagnostics.filter((event) => event.transcriptEvent?.status === 'retry_scheduled'))
        .toHaveLength(1);
    } finally {
      runtimeAuthRecoveryScheduler.dispose();
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      recovery: {
        status: 'exhausted',
        retryable: false,
        attemptCount: 5,
        lastError: 'max_attempts_exhausted',
      },
      expectedStatus: 'recovery_dead_lettered',
    },
    {
      name: 'cancelled',
      recovery: {
        status: 'cancelled',
        retryable: false,
      },
      expectedStatus: 'recovery_cancelled',
    },
    {
      name: 'terminal non-retry',
      recovery: {
        status: 'terminal_non_retry',
        retryable: false,
      },
      expectedStatus: 'recovery_terminal',
    },
  ])('surfaces terminal apply-failure recovery scheduling results: $name', async ({
    recovery,
    expectedStatus,
  }) => {
    const originalResult = {
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'hot_apply_failed',
      },
    };
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => originalResult);
    const enqueueApplyFailure = vi.fn(async () => recovery);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: expectedStatus,
          recovery,
          originalResult,
          terminal: true,
        },
      });
      expect(response.json().result.status).not.toBe('switch_attempted');
      expect(response.json().result.status).not.toBe('recovery_retry_scheduled');
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
      expect(enqueueApplyFailure).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      recovery: {
        status: 'exhausted',
        retryable: false,
        attemptCount: 5,
        lastError: 'max_attempts_exhausted',
      },
      expectedStatus: 'recovery_dead_lettered',
    },
    {
      name: 'cancelled',
      recovery: {
        status: 'cancelled',
        retryable: false,
      },
      expectedStatus: 'recovery_cancelled',
    },
    {
      name: 'terminal non-retry',
      recovery: {
        status: 'terminal_non_retry',
        retryable: false,
      },
      expectedStatus: 'recovery_terminal',
    },
  ])('surfaces terminal handler-failure recovery scheduling results: $name', async ({
    recovery,
    expectedStatus,
  }) => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const enqueueHandlerFailure = vi.fn(async () => recovery);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueHandlerFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: expectedStatus,
          recovery,
          terminal: true,
        },
      });
      expect(response.json().result.status).not.toBe('recovery_handler_failed');
      expect(response.json().result.status).not.toBe('recovery_retry_scheduled');
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
      expect(enqueueHandlerFailure).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      prepare: async (input: Readonly<{
        scheduler: RuntimeAuthRecoveryScheduler;
        sessionId: string;
        classification: ConnectedServiceRuntimeFailureClassification;
        applyFailure: unknown;
      }>) => {
        await input.scheduler.enqueueApplyFailure({
          sessionId: input.sessionId,
          switchesThisTurn: 1,
          classification: input.classification,
          result: input.applyFailure,
        });
        await expect(input.scheduler.wake({ sessionId: input.sessionId, reason: 'manual' }))
          .resolves.toEqual({ status: 'exhausted' });
      },
      expectedDeadLetterEvents: 1,
    },
    {
      name: 'cancelled',
      prepare: async (input: Readonly<{
        scheduler: RuntimeAuthRecoveryScheduler;
        sessionId: string;
        classification: ConnectedServiceRuntimeFailureClassification;
        applyFailure: unknown;
      }>) => {
        await input.scheduler.enqueueApplyFailure({
          sessionId: input.sessionId,
          switchesThisTurn: 1,
          classification: input.classification,
          result: input.applyFailure,
        });
        await input.scheduler.cancelByKey(buildRuntimeAuthRecoveryKey({
          sessionId: input.sessionId,
          serviceId: input.classification.serviceId,
          profileId: input.classification.profileId,
          groupId: input.classification.groupId,
        }));
      },
      expectedDeadLetterEvents: 0,
    },
  ])('does not re-emit a terminal transcript event for an already $name recovery', async ({
    prepare,
    expectedDeadLetterEvents,
  }) => {
    const sessionId = 'sess_1';
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const applyFailure = {
      status: 'generation_apply_failed',
      errorCode: 'hot_apply_failed',
      diagnostics: {
        underlyingError: 'timeout of 5000ms exceeded',
      },
    };
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => applyFailure,
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    await prepare({ scheduler, sessionId, classification, applyFailure });

    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: applyFailure,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: scheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId,
          switchesThisTurn: 2,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: applyFailure,
        },
      });
      expect(body.result).not.toHaveProperty('transcriptEvent');
      expect(diagnostics.filter((event) => (
        event.event === 'runtime_auth_recovery_dead_letter' && event.transcriptEvent
      ))).toHaveLength(expectedDeadLetterEvents);
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns typed handler failures when handler recovery scheduling also fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const enqueueHandlerFailure = vi.fn(async () => {
      throw new Error('intent store unavailable');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueHandlerFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'recovery_handler_failed',
          errorCode: 'unexpected_error',
        },
      });
      expect(enqueueHandlerFailure).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after handler failure',
        expect.objectContaining({ sessionId: 'sess_1' }),
      );
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('sanitizes raw handler error messages before logging runtime auth diagnostics', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('refresh failed Bearer raw-secret-token accessToken=raw-access-token');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('raw-secret-token');
      expect(logged).not.toContain('raw-access-token');
      expect(logged).toContain('[REDACTED]');
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('acknowledges reported in-band quota snapshots only after canonical intake accepts them', async () => {
    let settleHandler: (result: { status: 'recorded' }) => void = () => {};
    const unsettledHandler = new Promise<{ status: 'recorded' }>((resolve) => {
      settleHandler = resolve;
    });
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => await unsettledHandler);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const responsePromise = app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          groupId: 'main',
          groupGeneration: 7,
          credentialFingerprint: 'sha256:abcdef12',
          policyDisposition: 'evidence_only',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        },
      });
      let responseSettled = false;
      void responsePromise.then(() => {
        responseSettled = true;
      });
      await vi.waitFor(() => {
        expect(handleConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          groupId: 'main',
          groupGeneration: 7,
          credentialFingerprint: 'sha256:abcdef12',
          policyDisposition: 'evidence_only',
          snapshot: expect.objectContaining({
            serviceId: 'openai-codex',
            profileId: 'primary',
          }),
        });
      });
      expect(responseSettled).toBe(false);
      settleHandler({ status: 'recorded', quotaStateRecorded: true } as { status: 'recorded' });
      const settledResponse = await responsePromise;
      expect(settledResponse.statusCode).toBe(200);
      expect(settledResponse.json()).toEqual({
        ok: true,
        result: { status: 'recorded', quotaStateRecorded: true },
      });
    } finally {
      settleHandler({ status: 'recorded', quotaStateRecorded: true } as { status: 'recorded' });
      await app.close();
    }
  });

  it('rejects quota delivery when canonical intake fails or lacks custody so the runner outbox can retry', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async (): Promise<unknown> => {
      throw new Error('downstream quota processing failed');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_quota_snapshot_intake_failed',
      });
      expect(handleConnectedServiceQuotaSnapshot).toHaveBeenCalledOnce();

      handleConnectedServiceQuotaSnapshot.mockResolvedValueOnce({ status: 'session_not_found' });
      const untrackedResponse = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_not_tracked_yet',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        },
      });
      expect(untrackedResponse.statusCode).toBe(503);
      expect(untrackedResponse.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_quota_snapshot_intake_failed',
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches connected-service recovery credit consume requests to the daemon handler', async () => {
    const handleConnectedServiceQuotaRecoveryCreditConsume = vi.fn(async () => ({
      ok: true,
      snapshot: null,
      receipt: {
        idempotencyKey: 'reset-req-1',
        providerCreditId: 'credit-1',
        status: 'consumed',
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaRecoveryCreditConsume,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-recovery-credit/consume',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          serviceId: 'openai-codex',
          profileId: 'primary',
          idempotencyKey: 'reset-req-1',
          providerCreditId: 'credit-1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          ok: true,
          snapshot: null,
          receipt: {
            idempotencyKey: 'reset-req-1',
            providerCreditId: 'credit-1',
            status: 'consumed',
          },
        },
      });
      expect(handleConnectedServiceQuotaRecoveryCreditConsume).toHaveBeenCalledWith({
        serviceId: 'openai-codex',
        profileId: 'primary',
        idempotencyKey: 'reset-req-1',
        providerCreditId: 'credit-1',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects in-band quota producers while the daemon is shutting down', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({ status: 'recorded' }));
    const handleConnectedServiceQuotaRecoveryCreditConsume = vi.fn(async () => ({ ok: true, snapshot: null }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      isShuttingDown: () => true,
      handleConnectedServiceQuotaSnapshot,
      handleConnectedServiceQuotaRecoveryCreditConsume,
    });

    try {
      const snapshotResponse = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        },
      });
      const consumeResponse = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-recovery-credit/consume',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          serviceId: 'openai-codex',
          profileId: 'primary',
          idempotencyKey: 'reset-req-1',
        },
      });

      expect(snapshotResponse.statusCode).toBe(503);
      expect(snapshotResponse.json()).toEqual({
        ok: false,
        errorCode: 'daemon_shutting_down',
      });
      expect(consumeResponse.statusCode).toBe(503);
      expect(consumeResponse.json()).toEqual({
        ok: false,
        errorCode: 'daemon_shutting_down',
      });
      expect(handleConnectedServiceQuotaSnapshot).not.toHaveBeenCalled();
      expect(handleConnectedServiceQuotaRecoveryCreditConsume).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects in-band quota snapshots with mismatched service ids before dispatching', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
      status: 'recorded',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'claude-subscription',
            profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            providerId: 'claude',
            planLabel: null,
            accountLabel: null,
            meters: [],
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(handleConnectedServiceQuotaSnapshot).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('dispatches the exact prompt authorization descriptor to the daemon handler', async () => {
    const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({
      status: 'continue' as const,
      turnCustody: {
        status: 'recorded' as const,
        activeTurnId: 'session-turn:exact-1',
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceTurnLifecycle,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-turn-lifecycle',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          event: 'prompt_or_steer',
          requestedAction: { v: 1, kind: 'steer_if_active' },
          activeTurnId: 'session-turn:exact-1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'continue',
          turnCustody: {
            status: 'recorded',
            activeTurnId: 'session-turn:exact-1',
          },
        },
      });
      expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'steer_if_active' },
        activeTurnId: 'session-turn:exact-1',
      });
    } finally {
      await app.close();
    }
  });

  // QAE-1: user "Stop waiting" must clear the daemon-side durable recovery wait
  // state regardless of provider runtime controls; runners notify this endpoint.
  it('dispatches usage-limit wait-resume cancels to the daemon recovery owner', async () => {
    const handleConnectedServiceUsageLimitWaitResumeCancel = vi.fn(async () => ({ ok: true }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceUsageLimitWaitResumeCancel,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-usage-limit/wait-resume-cancel',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { sessionId: 'sess_1', attemptId: 'runtime-auth-attempt:exact-1' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: { ok: true },
      });
      expect(handleConnectedServiceUsageLimitWaitResumeCancel).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        attemptId: 'runtime-auth-attempt:exact-1',
      });
    } finally {
      await app.close();
    }
  });

  it('returns 501 for usage-limit wait-resume cancels when no daemon handler is wired', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-usage-limit/wait-resume-cancel',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          attemptId: 'runtime-auth-attempt:exact-1',
        },
      });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_usage_limit_wait_resume_cancel_handler_unavailable',
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches Codex ChatGPT refresh bridge requests to the daemon handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        // SEC-F1: session-mode (sessionId, no broker identity) requires the MASTER control token —
        // the credential runner processes actually hold. The scoped broker token is identity-mode only.
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            fallbackProfileId: 'work',
            generation: 7,
          },
          chatgptPlanType: 'plus',
          forceRefresh: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-access',
          chatgptAccountId: 'acct_123',
          chatgptPlanType: 'plus',
        },
      });
      expect(response.json().result).not.toHaveProperty('refreshToken');
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        brokerSelectionIdentity: null,
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'work',
          generation: 7,
        },
        chatgptPlanType: 'plus',
        forceRefresh: false,
        failingAccessTokenFingerprint: null,
      });
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the bridge handler rejects the session selection authorization', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => {
      throw new Error('connected_service_bridge_selection_not_authorized');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'sess_1',
          selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'other-profile' },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_bridge_selection_not_authorized',
      });
    } finally {
      await app.close();
    }
  });

  it('resolves the effective broker selection by selection identity before dispatching refresh handlers', async () => {
    resetBrokerBridgeEffectiveSelectionsForTests();
    const updated = updateBrokerBridgeEffectiveSelection({
      selectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
      serviceId: 'openai-codex',
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 15,
        credentialRevision: 'rev-15',
        credentialFingerprint: 'sha256:abcdef12',
      },
    });
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_new',
      chatgptPlanType: 'plus',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'opencode-broker:openai:1',
          selectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
          selection: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'profile-old',
          },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-access',
          chatgptAccountId: 'acct_new',
          chatgptPlanType: 'plus',
          selectionEpoch: updated.selectionEpoch,
        },
      });
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'opencode-broker:openai:1',
        brokerSelectionIdentity: 'opencode|connected|broker:1|openai-codex:acct-old:',
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'profile-new',
          fallbackProfileId: 'profile-old',
          generation: 15,
        },
        chatgptPlanType: 'plus',
        forceRefresh: false,
        failingAccessTokenFingerprint: null,
      });
    } finally {
      await app.close();
      resetBrokerBridgeEffectiveSelectionsForTests();
    }
  });

  it('blocks broker token requests after exact current truth becomes unavailable', async () => {
    resetBrokerBridgeEffectiveSelectionsForTests();
    const selectionIdentity = 'opencode|connected|broker:1|openai-codex:acct-old:';
    markBrokerBridgeEffectiveSelectionUnavailable({
      selectionIdentity,
      serviceId: 'openai-codex',
      groupId: 'main',
      unavailableReason: 'active_profile_missing',
    });
    const handleCodexChatGptAuthTokensRefresh = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'opencode-broker:openai:1',
          selectionIdentity,
          selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'profile-old' },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(handleCodexChatGptAuthTokensRefresh).not.toHaveBeenCalled();
    } finally {
      await app.close();
      resetBrokerBridgeEffectiveSelectionsForTests();
    }
  });

  it('rejects Codex ChatGPT refresh bridge payloads with invalid group ids before they reach the handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'sess_1',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: '../escape',
            activeProfileId: 'backup',
            fallbackProfileId: 'work',
            generation: 7,
          },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(handleCodexChatGptAuthTokensRefresh).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('dispatches Claude subscription Anthropic refresh bridge requests to the daemon handler (access-only response)', async () => {
    const handleClaudeSubscriptionAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-claude-access',
      anthropicAccountId: 'anthropic-acct',
      expiresAt: 123_456,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleClaudeSubscriptionAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh',
        // SEC-F1: session-mode requires the MASTER control token (see codex twin above).
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          selection: {
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'main',
            activeProfileId: 'backup',
            fallbackProfileId: 'work',
            generation: 7,
          },
          forceRefresh: true,
        },
      });

      expect(response.statusCode).toBe(200);
      // The bridge returns ONLY the access token (+ non-secret account/expiry); never a refresh token.
      expect(response.json()).toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-claude-access',
          anthropicAccountId: 'anthropic-acct',
          expiresAt: 123_456,
        },
      });
      expect(response.json().result).not.toHaveProperty('refreshToken');
      expect(handleClaudeSubscriptionAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        brokerSelectionIdentity: null,
        selection: {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'work',
          generation: 7,
        },
        forceRefresh: true,
        failingAccessTokenFingerprint: null,
      });
    } finally {
      await app.close();
    }
  });

  it('SEC-F1: bridge auth is principal-discriminated — missing/wrong tokens 401; scoped token without a broker identity 403; scoped token with identity accepted', async () => {
    // Security boundary (no-leak, plan §5 item 6 / Lane C + F2 least privilege): the access-token
    // bridges MUST reject any call lacking the SCOPED broker-refresh token and never run the refresh
    // handler. A missing token, a wrong token, AND the broad MASTER control token all fail closed with
    // 401 before the handler can mint/return an access token — only the scoped capability token passes.
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'must-not-be-minted',
      chatgptAccountId: null,
      chatgptPlanType: null,
    }));
    const handleClaudeSubscriptionAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'must-not-be-minted',
      anthropicAccountId: null,
      expiresAt: null,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
      handleClaudeSubscriptionAuthTokensRefresh,
    });

    try {
      const cases: ReadonlyArray<{ url: string; headers: Record<string, string> }> = [
        // SEC-F1: the master token is a valid SESSION-MODE credential on the bridge routes (it is a
        // strict privilege superset of this control surface) — its acceptance is pinned by the
        // dispatch tests above. Missing/wrong tokens stay 401.
        { url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh', headers: {} },
        { url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh', headers: { 'x-happier-daemon-token': 'wrong' } },
        { url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh', headers: {} },
        { url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh', headers: { 'x-happier-daemon-token': 'wrong' } },
      ];
      for (const testCase of cases) {
        const response = await app.inject({
          method: 'POST',
          url: testCase.url,
          headers: testCase.headers,
          payload: {
            sessionId: 'sess_1',
            selection: { kind: 'profile', serviceId: testCase.url.includes('claude') ? 'claude-subscription' : 'openai-codex', profileId: 'work' },
          },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ success: false, error: 'Unauthorized' });
      }
      expect(handleClaudeSubscriptionAuthTokensRefresh).not.toHaveBeenCalled();
      expect(handleCodexChatGptAuthTokensRefresh).not.toHaveBeenCalled();

      // SEC-F1: the SCOPED broker token is IDENTITY-MODE ONLY. A scoped-token holder naming a
      // sessionId without a broker selection identity is rejected BEFORE the handler runs —
      // otherwise a leaked broker token could name a live victim session and receive that
      // session's refreshed access token.
      const scopedSessionOnly = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: { sessionId: 'sess_victim', selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' } },
      });
      expect(scopedSessionOnly.statusCode).toBe(403);
      expect(scopedSessionOnly.json()).toEqual({ ok: false, errorCode: 'connected_service_bridge_selection_not_authorized' });
      const scopedSessionOnlyClaude = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: { sessionId: 'sess_victim', selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' } },
      });
      expect(scopedSessionOnlyClaude.statusCode).toBe(403);
      expect(handleCodexChatGptAuthTokensRefresh).not.toHaveBeenCalled();
      expect(handleClaudeSubscriptionAuthTokensRefresh).not.toHaveBeenCalled();

      // The SCOPED token WITH a broker selection identity is accepted (identity-mode).
      const ok = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: {
          sessionId: 'opencode-broker:openai:1',
          selectionIdentity: 'opencode|connected|broker:1|openai-codex:work:',
          selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('durably binds the OpenCode load handshake before acknowledging it so daemon B can recover without an A readiness query', async () => {
    resetOpenCodeBrokerLoadHandshakesForTests();
    const identity = 'opencode|connected|broker:1|openai-codex:p:';
    const loadNonce = 'spawn-control-server-test';
    const statusPayload = {
      runtimeKind: 'opencode_managed_server' as const,
      selectionIdentity: identity,
      loadNonce,
      providers: ['openai'] as const,
      pluginVersion: '1',
    };
    const processCommand = 'opencode serve --hostname=127.0.0.1 --port=64275';
    const states = new Map<string, SharedManagedOpenCodeServerState>([
      ['managed-child', {
        v: 2,
        baseUrl: 'http://127.0.0.1:64275',
        pid: 4242,
        startedAtMs: 1_000,
        status: 'ready',
        launchEnvFingerprint: 'launch-fingerprint',
        ownerToken: 'managed-child-owner',
        startTimeMs: 2_500,
        processInstanceFingerprint: 'win32-cim:2026-07-30T10:00:00.0000000Z',
        expectedCmdlineHash: createHash('sha256').update(processCommand).digest('hex'),
        activeServerDir: '/tmp/happier/servers/cloud',
        daemonInstanceId: 'daemon-a',
        brokerLoadNonce: loadNonce,
      }],
    ]);
    let brokerStateUsable = true;
    const activationDeps: ManagedOpenCodeBrokerActivationStateDeps = {
      listStateKeys: async () => [...states.keys()],
      withStateLock: async <T>(_stateKey: string, fn: () => Promise<T>) => await fn(),
      readState: async (stateKey) => states.get(stateKey) ?? null,
      writeState: async (stateKey, state) => {
        states.set(stateKey, state);
      },
      isPidAlive: () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: processCommand }),
      // Windows has no POSIX `ps` start time; exact process-birth proof comes from CIM.
      readProcessStartTimeMs: async () => null,
      readProcessInstanceFingerprint: async () =>
        'win32-cim:2026-07-30T10:00:00.0000000Z',
      currentActiveServerDir: '/tmp/happier/servers/cloud',
      isCurrentBrokerStateUsable: async () => brokerStateUsable,
    };
    const createApp = (controlToken: string) => createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken,
      persistOpenCodeBrokerLoadHandshakeObservation: async (expectation) =>
        await persistOpenCodeBrokerLoadHandshakeObservation(expectation, {
          managedOpenCodeActivationStateDeps: activationDeps,
        }),
      resolveOpenCodeBrokerLoadHandshakeStatus: async (expectation) =>
        await resolveOpenCodeBrokerLoadHandshakeStatus(expectation, {
          managedOpenCodeActivationStateDeps: activationDeps,
        }),
    });
    const appA = createApp('token');
    try {
      // Before any handshake, loaded-status (master-token query) reports not-observed.
      const before = await appA.inject({
        method: 'POST',
        url: '/connected-service-auth/opencode-broker/loaded-status',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: statusPayload,
      });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ ok: true, observed: false });

      // The broker registers its handshake using the SCOPED token (master token is rejected here).
      const masterRejected = await appA.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { ...statusPayload, processPid: 4242 },
      });
      expect(masterRejected.statusCode).toBe(401);

      // A handshake whose exact generation cannot yet be durably bound is not acknowledged. The
      // same one-shot observation can be presented again after its current broker authority is usable.
      brokerStateUsable = false;
      const notPersisted = await appA.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: { ...statusPayload, processPid: 4242 },
      });
      expect(notPersisted.statusCode).toBe(503);
      expect(notPersisted.json()).toEqual({
        ok: false,
        errorCode: 'connected_service_broker_activation_proof_unavailable',
      });
      expect(states.get('managed-child')?.brokerActivationProof).toBeUndefined();

      brokerStateUsable = true;
      const registered = await appA.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded',
        headers: { 'x-happier-daemon-token': BROKER_SCOPED_TOKEN },
        payload: { ...statusPayload, processPid: 4242 },
      });
      expect(registered.statusCode).toBe(200);
      expect(registered.json()).toEqual({ ok: true, result: { acknowledged: true } });

      // This is the durability boundary: no loaded-status/readiness call has run after the one-shot
      // plugin handshake. A successful acknowledgement must already have committed the exact proof
      // to the existing managed-child generation owner.
      expect(states.get('managed-child')?.brokerActivationProof).toEqual(expect.objectContaining({
        loadNonce,
        processPid: 4242,
        pluginVersion: '1',
        providers: ['openai'],
      }));
    } finally {
      await appA.close();
    }

    // Daemon B starts with an empty process-local Map and a different master control token. The same
    // exact child is accepted from its real managed-state proof; no child restart or provider call
    // participates in the decision.
    resetOpenCodeBrokerLoadHandshakesForTests();
    const appB = createApp('token-b');
    try {
      const afterReplacement = await appB.inject({
        method: 'POST',
        url: '/connected-service-auth/opencode-broker/loaded-status',
        headers: { 'x-happier-daemon-token': 'token-b' },
        payload: statusPayload,
      });
      expect(afterReplacement.statusCode).toBe(200);
      expect(afterReplacement.json()).toEqual({ ok: true, observed: true });

      const staleDaemonCapabilityRejected = await appB.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded',
        headers: {
          'x-happier-daemon-token': deriveConnectedServiceBrokerRefreshToken('token'),
        },
        payload: {
          runtimeKind: 'pi_rpc_process',
          selectionIdentity: 'pi|connected|broker:1|anthropic:p:',
          loadNonce: 'stale-daemon-child',
          providers: ['anthropic'],
          pluginVersion: '1',
          processPid: 5151,
        },
      });
      expect(staleDaemonCapabilityRejected.statusCode).toBe(401);

      // Pi has no independently reattachable managed child. Its surviving PiRpcBackend owns and
      // caches readiness for the exact stdio child; a respawn rotates nonce and handshakes anew.
      // Therefore a fresh Pi Map hit succeeds without OpenCode persistence, while an empty Map can
      // never consume OpenCode's durable proof.
      const piIdentity = 'pi|connected|broker:1|anthropic:p:';
      const piStatusPayload = {
        runtimeKind: 'pi_rpc_process' as const,
        selectionIdentity: piIdentity,
        loadNonce: 'pi-child-nonce',
        providers: ['anthropic'],
        pluginVersion: '1',
      };
      const piRegistered = await appB.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded',
        headers: {
          'x-happier-daemon-token': deriveConnectedServiceBrokerRefreshToken('token-b'),
        },
        payload: { ...piStatusPayload, processPid: 5252 },
      });
      expect(piRegistered.statusCode).toBe(200);
      const piObserved = await appB.inject({
        method: 'POST',
        url: '/connected-service-auth/opencode-broker/loaded-status',
        headers: { 'x-happier-daemon-token': 'token-b' },
        payload: piStatusPayload,
      });
      expect(piObserved.json()).toEqual({ ok: true, observed: true });

      resetOpenCodeBrokerLoadHandshakesForTests();
      const piWithoutCurrentHandshake = await appB.inject({
        method: 'POST',
        url: '/connected-service-auth/opencode-broker/loaded-status',
        headers: { 'x-happier-daemon-token': 'token-b' },
        payload: piStatusPayload,
      });
      expect(piWithoutCurrentHandshake.json()).toEqual({ ok: true, observed: false });
    } finally {
      resetOpenCodeBrokerLoadHandshakesForTests();
      await appB.close();
    }
  });
});

describe('startDaemonControlServer connected-service runtime wiring', () => {
  it('wires reported runtime auth failures to the production control server handler', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'recovery_action_required',
      action: {
        kind: 'reconnect_profile',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: null,
        reason: 'usage_limit',
      },
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-runtime-auth/failure`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          reportId: 'runtime-auth-report:continuation-origin',
          sessionId: 'sess_1',
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: null,
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          status: 'recovery_action_required',
          action: {
            kind: 'reconnect_profile',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: null,
            reason: 'usage_limit',
          },
        },
      });
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        interruptedOriginId: 'runtime-auth-report:continuation-origin',
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'usage_limit',
          serviceId: 'openai-codex',
        }),
        resumePromptMode: 'standard',
      });
    } finally {
      await server.stop();
    }
  });

  it('wires reported quota snapshots to the production control server handler', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
      status: 'recorded',
      groupRuntimeStateRecorded: true,
      quotaStateRecorded: true,
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-quota-snapshot`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          status: 'recorded',
          groupRuntimeStateRecorded: true,
          quotaStateRecorded: true,
        },
      });
      expect(handleConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        serviceId: 'openai-codex',
        snapshot: expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'primary',
        }),
      });
    } finally {
      await server.stop();
    }
  });

  it('wires connected-service turn lifecycle events to the production control server handler', async () => {
    const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({
      status: 'continue' as const,
      turnCustody: {
        status: 'recorded' as const,
        activeTurnId: null,
      },
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceTurnLifecycle,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-turn-lifecycle`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          event: 'turn_cancelled',
          turnId: 'session-turn:exact-1',
        }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({
        ok: true,
        result: {
          status: 'continue',
          turnCustody: {
            status: 'recorded',
            activeTurnId: null,
          },
        },
      });
      expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        event: 'turn_cancelled',
        turnId: 'session-turn:exact-1',
      });
    } finally {
      await server.stop();
    }
  });

  it('wires Codex ChatGPT refresh bridge requests to the production control server handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: null,
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // SEC-F1: session-mode (sessionId, no broker identity) authenticates with the MASTER token.
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          selection: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'work',
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-access',
          chatgptAccountId: 'acct_123',
          chatgptPlanType: null,
        },
      });
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        brokerSelectionIdentity: null,
        selection: {
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'work',
        },
        chatgptPlanType: null,
        forceRefresh: false,
        failingAccessTokenFingerprint: null,
      });
    } finally {
      await server.stop();
    }
  });

  it('defers runtime-auth recovery without running the handler while the daemon is shutting down', async () => {
    // Daemon-lifecycle guard: during shutdown the handler must NOT run (no switch/restart/
    // continuation), must NOT enqueue, must NOT clear the recovery intent, and must NOT emit
    // an account-switch success. The recovery intent is deferred (left for a future daemon).
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const enqueueHandlerFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { markSucceededByKey, cancelByKey, enqueueHandlerFailure },
      isShuttingDown: () => true,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'daemon_lifecycle_unavailable',
          reason: 'recovery_deferred_shutdown',
        },
      });
      // The handler never ran, nothing was enqueued, and recovery was neither cleared nor terminated.
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(enqueueHandlerFailure).not.toHaveBeenCalled();
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not create durable runtime-auth recovery intake before shutdown deferral', async () => {
    const beginClassifiedFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
      isShuttingDown: () => true,
    });

    try {
      const classification = {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      };
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'daemon_lifecycle_unavailable',
          reason: 'recovery_deferred_shutdown',
        },
      });
      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves shutdown deferrals in the session-side runtime-auth report outbox', async () => {
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
    const outboxDir = await createTempDir('happier-runtime-auth-control-shutdown-deferral-');
    const beginClassifiedFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
    } as unknown as NonNullable<Parameters<typeof createDaemonControlApp>[0]['runtimeAuthRecoveryScheduler']>;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
      isShuttingDown: () => true,
    });

    try {
      const classification = {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetsAtMs: null,
        providerLimitId: 'refresh-token-secret',
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
        accessToken: 'secret-access-token',
      };
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_shutdown_route_report',
        switchesThisTurn: 0,
        classification,
        notify: async (body) => {
          const response = await app.inject({
            method: 'POST',
            url: '/connected-service-runtime-auth/failure',
            headers: { 'x-happier-daemon-token': 'token' },
            payload: body,
          });
          expect(response.statusCode).toBe(200);
          return response.json();
        },
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: {
          ok: true,
          result: {
            status: 'daemon_lifecycle_unavailable',
            reason: 'recovery_deferred_shutdown',
          },
        },
      });

      expect(beginClassifiedFailure).not.toHaveBeenCalled();
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'sess_shutdown_route_report',
        classification: expect.objectContaining({
          kind: 'usage_limit',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'main',
          providerLimitId: null,
        }),
      });
      expect(JSON.stringify(items[0])).not.toContain('secret-access-token');
      expect(JSON.stringify(items[0])).not.toContain('refresh-token-secret');
    } finally {
      await app.close();
      await removeTempDir(outboxDir);
    }
  });
});
