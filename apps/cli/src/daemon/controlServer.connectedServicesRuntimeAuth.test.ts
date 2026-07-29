import { describe, expect, it, vi } from 'vitest';
import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import type { RuntimeAuthRecoveryScheduleResult } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { createDaemonControlApp } from './controlServer';
import { authorizeConnectedServiceRuntimeAuthFailureSource } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from './connectedServices/connectedServiceChildEnvironment';

function createScheduledRuntimeAuthRecoveryResult(
    overrides?: Partial<Extract<RuntimeAuthRecoveryScheduleResult, { status: 'scheduled' }>>,
): Extract<RuntimeAuthRecoveryScheduleResult, { status: 'scheduled' }> {
    return {
        status: 'scheduled',
        retryable: true,
        nextRetryAtMs: 2_000,
        attemptCount: 0,
        maxAttempts: 3,
        resumePromptMode: 'standard',
        ...overrides,
    };
}

describe('createDaemonControlApp connected-service runtime auth handling', () => {
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
            expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
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

  it('uses the exact authorized live binding for durable intake and recovery handling', async () => {
    const sourceAuthorization = {
      status: 'authorized' as const,
      tracked: null,
      inactive: null,
      sourceBinding: {
        serviceId: 'openai-codex' as const,
        groupId: 'main',
        profileId: 'backup',
        generation: 9,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    };
    const beginClassifiedFailure = vi.fn(async () => ({
      ...createScheduledRuntimeAuthRecoveryResult(),
      attemptId: 'runtime-auth-attempt:live-binding',
    }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'recovery_action_required' as const,
      reason: 'usage_limit',
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
      runtimeAuthRecoveryScheduler: { beginClassifiedFailure } as never,
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
        expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      });
      expect(beginClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
        classification: exactClassification,
      }));
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
        classification: exactClassification,
        interruptedOriginId: 'runtime-auth-report:live-binding',
        sourceAuthorization,
      }));
    } finally {
      await app.close();
    }
  });

  it('returns the stable intake attempt id for a durable action-required wait', async () => {
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure: vi.fn(async () => ({
        ...createScheduledRuntimeAuthRecoveryResult(),
        attemptId: 'runtime-auth-attempt:action-required-1',
        transition: 'working',
      })),
    };
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine', stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      runtimeAuthRecoveryScheduler: runtimeAuthRecoveryScheduler as never,
      handleConnectedServiceRuntimeAuthFailure: async () => ({ status: 'recovery_action_required', reason: 'usage_limit' }),
    } as Parameters<typeof createDaemonControlApp>[0]);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          reportId: 'runtime-auth-report:action-required-1',
          sessionId: 'sess_action_required',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: 2_000,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        recoveryReceipt: {
          reportId: 'runtime-auth-report:action-required-1',
          attemptId: 'runtime-auth-attempt:action-required-1',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('joins concurrent deliveries carrying the same stable runtime-auth report id', async () => {
    let releaseHandler!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      await barrier;
      return { status: 'recovery_action_required', reason: 'reconnect' };
    });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine', stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    } as Parameters<typeof createDaemonControlApp>[0]);
    try {
      const payload = {
        reportId: 'runtime-auth-report:claim-join-test', sessionId: 'sess_claim_join', switchesThisTurn: 0,
        classification: { kind: 'auth_expired', serviceId: 'openai-codex', profileId: 'primary', groupId: 'main', resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' },
      };
      const requests = Array.from({ length: 11 }, () => app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure', headers: { 'x-happier-daemon-token': 'token' }, payload }));
      await vi.waitFor(() => expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce());
      releaseHandler();
      const responses = await Promise.all(requests);
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it('propagates a joined intake failure status and evicts it so the report can retry', async () => {
    let rejectIntake!: (error: Error) => void;
    const failedIntake = new Promise<never>((_resolve, reject) => {
      rejectIntake = reject;
    });
    const beginClassifiedFailure = vi.fn()
      .mockImplementationOnce(async () => await failedIntake)
      .mockResolvedValue(createScheduledRuntimeAuthRecoveryResult());
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({ status: 'not_classified' as const }));
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
      runtimeAuthRecoveryScheduler: { beginClassifiedFailure } as never,
    });
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

  it('bounds settled runtime-auth report claims while preserving in-flight coalescing', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({ status: 'not_classified' as const }));
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
      for (let index = 0; index <= 256; index += 1) {
        expect((await request(`runtime-auth-report:bounded-${index}`)).statusCode).toBe(200);
      }
      await request('runtime-auth-report:bounded-0');
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(258);
    } finally {
      await app.close();
    }
  });

  it('accepts a surviving runner report from a previous daemon through current source authority', async () => {
    const beginClassifiedFailure = vi.fn(async () => createScheduledRuntimeAuthRecoveryResult());
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({ status: 'switch_attempted' }));
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
      runtimeAuthRecoveryScheduler: { beginClassifiedFailure } as never,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          originDaemonExecutionGenerationV1: 'daemon-old',
          sessionId: 'session-stale-runner',
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
      expect(response.json()).toMatchObject({
        ok: true,
        result: { status: 'switch_attempted' },
      });
      expect(beginClassifiedFailure).toHaveBeenCalledOnce();
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
    it('dispatches trusted session runtime-auth refresh through the session-scoped handler', async () => {
        const handleSessionConnectedServiceRuntimeAuthRefresh = vi.fn(async () => ({
            ok: true as const,
            result: {
                status: 'refreshed' as const,
                result: {
                    accessToken: 'fresh-token',
                    chatgptAccountId: 'acct-1',
                    chatgptPlanType: 'plus',
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
            handleSessionConnectedServiceRuntimeAuthRefresh,
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-auth/session/refresh-runtime-auth',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'session-1',
                    serviceId: 'openai-codex',
                    refreshAttemptId: 'codex-refresh-attempt-route',
                    selection: {
                        kind: 'profile',
                        serviceId: 'openai-codex',
                        profileId: 'work',
                    },
                    planType: 'plus',
                    failingAccessTokenFingerprint: 'sha256:failed',
                    expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                    reason: 'chatgpt_auth_tokens_refresh',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: {
                    status: 'refreshed',
                    result: {
                        accessToken: 'fresh-token',
                        chatgptAccountId: 'acct-1',
                        chatgptPlanType: 'plus',
                    },
                },
            });
            expect(handleSessionConnectedServiceRuntimeAuthRefresh).toHaveBeenCalledWith({
                sessionId: 'session-1',
                refreshAttemptId: 'codex-refresh-attempt-route',
                selection: {
                    kind: 'profile',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                },
                planType: 'plus',
                failingAccessTokenFingerprint: 'sha256:failed',
                expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                reason: 'chatgpt_auth_tokens_refresh',
            });
        } finally {
            await app.close();
        }
    });

    it('dispatches reported runtime auth failures to the daemon handler', async () => {
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
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
                    result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
                },
            });
            expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                switchesThisTurn: 0,
                resumePromptMode: 'custom',
                classification: expect.objectContaining({
                    kind: 'usage_limit',
                    serviceId: 'openai-codex',
                    groupId: 'main',
                }),
            });
        } finally {
            await app.close();
        }
    });

    it('rejects an incomplete Codex quota source tuple before durable intake or repair', async () => {
        const children = [{
            startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_exact_route',
            spawnOptions: {
                directory: '/tmp/project',
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'main',
                        activeProfileId: 'primary',
                        fallbackProfileId: 'primary',
                        generation: 7,
                        policy: null,
                        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                    }]),
                },
            },
        }];
        const beginClassifiedFailure = vi.fn();
        const handleConnectedServiceRuntimeAuthFailure = vi.fn();
        const app = createDaemonControlApp({
            getChildren: () => children,
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
            runtimeAuthRecoveryScheduler: { beginClassifiedFailure } as never,
            handleConnectedServiceRuntimeAuthFailure,
            authorizeConnectedServiceRuntimeAuthFailure: ({ sessionId, classification }) =>
                authorizeConnectedServiceRuntimeAuthFailureSource({
                    getChildren: () => children,
                    sessionId,
                    classification,
                    runtimeAuthApplyCapability: {
                        directLiveHotAuth: {
                            supportsInTurnApply: true,
                            requiresExactRuntimeIdentity: true,
                            refreshSelectionResync: 'not_applicable',
                            authMode: { kind: 'managed_provider_session' },
                        },
                    },
                }),
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-runtime-auth/failure',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_exact_route',
                    switchesThisTurn: 0,
                    classification: {
                        kind: 'usage_limit',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'main',
                        groupGeneration: 7,
                        resetsAtMs: null,
                        planType: null,
                        rateLimits: null,
                        source: 'structured_provider_error',
                        recoveryAction: { kind: 'quota_recovery_required' },
                    },
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                ok: true,
                result: { status: 'recovery_superseded', reason: 'source_tuple_unavailable' },
            });
            expect(beginClassifiedFailure).not.toHaveBeenCalled();
            expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('sanitizes reported runtime auth classifications before durable intake and local repair', async () => {
        const beginClassifiedFailure = vi.fn(async () => createScheduledRuntimeAuthRecoveryResult());
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'switch_attempted',
            result: { status: 'not_group_selection' },
        }));
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure,
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(),
            cancelExact: vi.fn(),
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
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
            handleConnectedServiceRuntimeAuthFailure,
            runtimeAuthRecoveryScheduler,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-runtime-auth/failure',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_sanitize',
                    switchesThisTurn: 1,
                    classification: {
                        kind: 'usage_limit',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'main',
                        resetsAtMs: null,
                        providerLimitId: 'Bearer raw-token',
                        planType: 'secret-enterprise-plan',
                        action: {
                            kind: 'open_url',
                            url: 'https://example.test/upgrade?access_token=raw-token',
                        },
                        rateLimits: {
                            providerLimitId: 'safe-weekly',
                            action: {
                                kind: 'open_url',
                                url: 'https://example.test/safe-upgrade',
                            },
                        },
                        source: 'structured_provider_error',
                    },
                },
            });

            expect(response.statusCode).toBe(200);
            const expectedClassification = expect.objectContaining({
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                providerLimitId: null,
                planType: null,
                action: null,
                rateLimits: null,
                source: 'structured_provider_error',
            });
            expect(beginClassifiedFailure).toHaveBeenCalledWith({
                sessionId: 'sess_sanitize',
                switchesThisTurn: 1,
                classification: expectedClassification,
                resumePromptMode: 'standard',
            });
            expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
                sessionId: 'sess_sanitize',
                switchesThisTurn: 1,
                classification: expectedClassification,
                resumePromptMode: 'standard',
            });
        } finally {
            await app.close();
        }
    });

    it('creates durable runtime-auth recovery intake before running local repair', async () => {
        const calls: string[] = [];
        const beginClassifiedFailure = vi.fn(async () => {
            calls.push('begin');
            return {
                ...createScheduledRuntimeAuthRecoveryResult(),
                resumePromptMode: 'custom' as const,
            };
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
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(),
            cancelExact: vi.fn(),
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
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
            handleConnectedServiceRuntimeAuthFailure,
            resolveConnectedServiceRuntimeAuthResumePromptMode: async () => 'off',
            runtimeAuthRecoveryScheduler,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
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
                resumePromptMode: 'off',
            });
            expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
            expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
                resumePromptMode: 'custom',
            }));
            expect(calls).toEqual(['begin', 'handler']);
        } finally {
            await app.close();
        }
    });

    it('returns a typed unavailable response when durable runtime-auth intake fails', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const beginClassifiedFailure = vi.fn(async () => {
            throw new Error('intent store unavailable authorization=Bearer raw-token');
        });
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'credential_refreshed',
        }));
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure,
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(),
            cancelExact: vi.fn(),
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
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
            handleConnectedServiceRuntimeAuthFailure,
            runtimeAuthRecoveryScheduler,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
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

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'connected_service_runtime_auth_recovery_intake_failed',
            });
            expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
            expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('raw-token');
            expect(JSON.stringify(warnSpy.mock.calls)).toContain('[REDACTED]');
        } finally {
            warnSpy.mockRestore();
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
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
                    decision: 'reactive_runtime_auth_switch',
                    resultStatus: 'recovery_handler_failed',
                    failurePhase: 'handler',
                    routedThroughFsm: false,
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

    it('schedules a durable retry when runtime auth handling fails transiently', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
            throw new Error('Failed to get connected service auth group: timeout of 5000ms exceeded');
        });
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult()),
            enqueueHandlerFailure: vi.fn(async () => ({
                status: 'scheduled' as const,
                retryable: true as const,
                nextRetryAtMs: 2_000,
                attemptCount: 0,
                maxAttempts: 3,
            })),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(),
            cancelExact: vi.fn(),
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
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
            handleConnectedServiceRuntimeAuthFailure,
            runtimeAuthRecoveryScheduler,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-runtime-auth/failure',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    switchesThisTurn: 2,
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
                    status: 'recovery_retry_scheduled',
                    recovery: {
                        status: 'scheduled',
                        retryable: true,
                        nextRetryAtMs: 2_000,
                        attemptCount: 0,
                        maxAttempts: 3,
                    },
                    uxDiagnostic: expect.objectContaining({
                        code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
                        failurePhase: 'runtime_auth_recovery',
                        source: 'runtime_auth_recovery',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'main',
                        retryable: true,
                        diagnostics: expect.objectContaining({
                            runtimeFailureKind: 'usage_limit',
                            classificationSource: 'structured_provider_error',
                        }),
                    }),
                    transcriptEvent: expect.objectContaining({
                        type: 'connected-service-runtime-auth-recovery',
                        status: 'retry_scheduled',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'main',
                        nextRetryAtMs: 2_000,
                        terminal: false,
                    }),
                },
            });
            expect(runtimeAuthRecoveryScheduler.enqueueHandlerFailure).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                switchesThisTurn: 2,
                classification: expect.objectContaining({ kind: 'usage_limit', serviceId: 'openai-codex' }),
                error: expect.any(Error),
            });
        } finally {
            warnSpy.mockRestore();
            await app.close();
        }
    });

    it('schedules apply-time hot-apply retry and keeps local success awaiting provider outcome', async () => {
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult({
                attemptId: 'runtime-auth-attempt:hot-apply',
            })),
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(async () => ({
                status: 'scheduled' as const,
                retryable: true as const,
                nextRetryAtMs: 2_500,
                attemptCount: 0,
                maxAttempts: 3,
            })),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(async () => null),
            cancelExact: vi.fn(async () => []),
            cancelByKey: vi.fn(async () => null),
            markSucceededByKey: vi.fn(async () => null),
            markAwaitingProviderOutcomeProofByKey: vi.fn(async () => null),
            markProviderOutcomeProofByIdentity: vi.fn(async () => []),
        };
        const handleConnectedServiceRuntimeAuthFailure = vi
            .fn()
            .mockResolvedValueOnce({
                status: 'switch_attempted',
                result: {
                    status: 'apply_failed',
                    activeProfileId: 'backup',
                    generation: 3,
                    applyResult: {
                        ok: false,
                        errorCode: 'hot_apply_failed',
                        serviceId: 'openai-codex',
                        diagnostics: {
                            failurePhase: 'hot_apply',
                            underlyingError: 'Codex app-server request timed out after 5000ms',
                        },
                    },
                },
            })
            .mockResolvedValueOnce({
                status: 'switch_attempted',
                result: {
                    status: 'switched',
                    fromProfileId: 'primary',
                    activeProfileId: 'backup',
                    generation: 4,
                    verificationByServiceId: {
                        'openai-codex': { status: 'verified', reason: 'test_verified' },
                    },
                },
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
        });

        try {
            const payload = {
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
            };
            const applyResponse = await app.inject({
                method: 'POST',
                url: '/connected-service-runtime-auth/failure',
                headers: { 'x-happier-daemon-token': 'token' },
                payload,
            });
            const successResponse = await app.inject({
                method: 'POST',
                url: '/connected-service-runtime-auth/failure',
                headers: { 'x-happier-daemon-token': 'token' },
                payload,
            });

            expect(applyResponse.json()).toMatchObject({
                ok: true,
                result: {
                    status: 'recovery_retry_scheduled',
                    recovery: { status: 'scheduled', retryable: true, nextRetryAtMs: 2_500 },
                    uxDiagnostic: expect.objectContaining({
                        code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
                        failurePhase: 'runtime_auth_recovery',
                        source: 'runtime_auth_recovery',
                    }),
                    transcriptEvent: expect.objectContaining({
                        type: 'connected-service-runtime-auth-recovery',
                        status: 'retry_scheduled',
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                        groupId: 'main',
                        nextRetryAtMs: 2_500,
                        terminal: false,
                    }),
                    originalResult: {
                        status: 'switch_attempted',
                        result: { status: 'apply_failed' },
                    },
                },
            });
            expect(runtimeAuthRecoveryScheduler.enqueueApplyFailure).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                switchesThisTurn: 0,
                expectedAttemptId: 'runtime-auth-attempt:hot-apply',
                classification: expect.objectContaining({ serviceId: 'openai-codex' }),
                result: expect.objectContaining({ status: 'switch_attempted' }),
            });
            expect(successResponse.json()).toMatchObject({
                ok: true,
                result: {
                    status: 'switch_attempted',
                    result: { status: 'switched' },
                },
            });
            expect(runtimeAuthRecoveryScheduler.markAwaitingProviderOutcomeProofByKey).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                expectedAttemptId: expect.any(String),
                result: expect.objectContaining({
                    status: 'switch_attempted',
                    result: expect.objectContaining({ status: 'switched' }),
                }),
            });
            expect(runtimeAuthRecoveryScheduler.markProviderOutcomeProofByIdentity).not.toHaveBeenCalled();
            expect(runtimeAuthRecoveryScheduler.markSucceededByKey).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('preserves apply failure results when durable apply recovery scheduling fails', async () => {
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'switch_attempted',
            result: {
                status: 'apply_failed',
                activeProfileId: 'backup',
                generation: 3,
                applyResult: {
                    ok: false,
                    errorCode: 'hot_apply_failed',
                    serviceId: 'openai-codex',
                    diagnostics: { failurePhase: 'hot_apply' },
                },
            },
        }));
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult()),
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(async () => {
                throw new Error('intent store unavailable');
            }),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(),
            cancelExact: vi.fn(),
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
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
            handleConnectedServiceRuntimeAuthFailure,
            runtimeAuthRecoveryScheduler,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
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
                    status: 'switch_attempted',
                    result: {
                        status: 'apply_failed',
                        applyResult: { errorCode: 'hot_apply_failed' },
                    },
                },
            });
            expect(debugSpy).toHaveBeenCalledWith(
                '[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after apply failure',
                expect.objectContaining({ sessionId: 'sess_1' }),
            );
            expect(runtimeAuthRecoveryScheduler.enqueueHandlerFailure).not.toHaveBeenCalled();
        } finally {
            debugSpy.mockRestore();
            await app.close();
        }
    });

    it('returns typed handler failures when durable handler recovery scheduling also fails', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
            throw new Error('switch coordinator crashed');
        });
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult()),
            enqueueHandlerFailure: vi.fn(async () => {
                throw new Error('intent store unavailable');
            }),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(),
            cancelExact: vi.fn(),
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
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
            handleConnectedServiceRuntimeAuthFailure,
            runtimeAuthRecoveryScheduler,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
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
            expect(debugSpy).toHaveBeenCalledWith(
                '[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after handler failure',
                expect.objectContaining({ sessionId: 'sess_1' }),
            );
            expect(warnSpy).toHaveBeenCalledWith(
                '[CONTROL SERVER] Connected-service runtime auth failure handler failed',
                expect.objectContaining({ resultStatus: 'recovery_handler_failed' }),
            );
        } finally {
            debugSpy.mockRestore();
            warnSpy.mockRestore();
            await app.close();
        }
    });

    it('does NOT clear durable retry on a bare credential refresh without provider-outcome proof', async () => {
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult({
                attemptId: 'runtime-auth-attempt:credential-refresh',
            })),
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(async () => null),
            cancelExact: vi.fn(async () => []),
            cancelByKey: vi.fn(async () => null),
            markSucceededByKey: vi.fn(async () => null),
            markAwaitingProviderOutcomeProofByKey: vi.fn(async () => null),
        };
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'credential_refreshed',
            serviceId: 'openai-codex',
            profileId: 'primary',
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
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
                    status: 'credential_refreshed',
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                },
            });
            // A fresh token is not proof the provider accepts it; recovery stays pending.
            expect(runtimeAuthRecoveryScheduler.markSucceededByKey).not.toHaveBeenCalled();
            expect(runtimeAuthRecoveryScheduler.markAwaitingProviderOutcomeProofByKey).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                expectedAttemptId: expect.any(String),
                result: {
                    status: 'credential_refreshed',
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                },
            });
        } finally {
            await app.close();
        }
    });

    it('does NOT clear durable retry when a switch attempt only reports credential refresh', async () => {
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult()),
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(async () => null),
            cancelExact: vi.fn(async () => []),
            cancelByKey: vi.fn(async () => null),
            markSucceededByKey: vi.fn(async () => null),
        };
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'switch_attempted',
            result: {
                status: 'credential_refreshed',
                serviceId: 'openai-codex',
                profileId: 'primary',
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
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
                    status: 'switch_attempted',
                    result: { status: 'credential_refreshed' },
                },
            });
            expect(runtimeAuthRecoveryScheduler.markSucceededByKey).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('keeps a locally verified restart request awaiting exact provider outcome', async () => {
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult({
                attemptId: 'runtime-auth-attempt:restart-requested',
            })),
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(async () => null),
            cancelExact: vi.fn(async () => []),
            cancelByKey: vi.fn(async () => null),
            markSucceededByKey: vi.fn(async () => null),
            markAwaitingProviderOutcomeProofByKey: vi.fn(async () => null),
        };
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'switch_attempted',
            result: {
                ok: true,
                action: 'restart_requested',
                verificationByServiceId: { 'openai-codex': { status: 'verified' } },
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
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
                    status: 'switch_attempted',
                    result: {
                        ok: true,
                        action: 'restart_requested',
                    },
                },
            });
            expect(runtimeAuthRecoveryScheduler.markAwaitingProviderOutcomeProofByKey).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                expectedAttemptId: expect.any(String),
                result: expect.objectContaining({
                    status: 'switch_attempted',
                    result: expect.objectContaining({ action: 'restart_requested' }),
                }),
            });
            expect(runtimeAuthRecoveryScheduler.markSucceededByKey).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('redacts handler exception diagnostics before writing control-server warnings', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
            throw new Error('handler failed authorization=Bearer raw-control-secret-token');
        });
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult()),
            enqueueHandlerFailure: vi.fn(async () => ({
                status: 'scheduled' as const,
                retryable: true as const,
                nextRetryAtMs: 2_000,
                attemptCount: 0,
                maxAttempts: 3,
            })),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(),
            cancelExact: vi.fn(),
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
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
            handleConnectedServiceRuntimeAuthFailure,
            runtimeAuthRecoveryScheduler,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
            runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
        });

        try {
            await app.inject({
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

            const warningPayload = warnSpy.mock.calls[0]?.[1];
            expect(JSON.stringify(warningPayload)).not.toContain('raw-control-secret-token');
            expect(JSON.stringify(warningPayload)).toContain('[REDACTED]');
        } finally {
            warnSpy.mockRestore();
            await app.close();
        }
    });

    it('accepts every connected-service runtime auth failure kind from the daemon contract', async () => {
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'ignored',
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
        });

        try {
            for (const kind of ['capacity', 'plan', 'validation', 'account_disabled'] as const) {
                const response = await app.inject({
                    method: 'POST',
                    url: '/connected-service-runtime-auth/failure',
                    headers: { 'x-happier-daemon-token': 'token' },
                    payload: {
                        sessionId: 'sess_1',
                        classification: {
                            kind,
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
            }
            expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(4);
        } finally {
            await app.close();
        }
    });

  it('dispatches connected-service recovery credit consume requests to the daemon handler', async () => {
        const handleConnectedServiceQuotaRecoveryCreditConsume = vi.fn(async () => ({
            ok: true,
            receipt: {
                idempotencyKey: 'consume:sess_1:credit-1',
                providerCreditId: 'credit-1',
                status: 'consumed',
            },
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceQuotaRecoveryCreditConsume: typeof handleConnectedServiceQuotaRecoveryCreditConsume;
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-quota-recovery-credit/consume',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    idempotencyKey: 'consume:sess_1:credit-1',
                    providerCreditId: 'credit-1',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: {
                    ok: true,
                    receipt: {
                        idempotencyKey: 'consume:sess_1:credit-1',
                        providerCreditId: 'credit-1',
                        status: 'consumed',
                    },
                    snapshot: expect.objectContaining({
                        serviceId: 'openai-codex',
                        profileId: 'primary',
                    }),
                },
            });
            expect(handleConnectedServiceQuotaRecoveryCreditConsume).toHaveBeenCalledWith({
                serviceId: 'openai-codex',
                profileId: 'primary',
                idempotencyKey: 'consume:sess_1:credit-1',
                providerCreditId: 'credit-1',
            });
        } finally {
      await app.close();
    }
  });

  it('rejects recovery credit consume requests while daemon shutdown is quiescing producers', async () => {
        const handleConnectedServiceQuotaRecoveryCreditConsume = vi.fn(async () => ({ ok: true }));
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
            isShuttingDown: () => true,
            onHappySessionWebhook: () => {},
            controlToken: 'token',
            handleConnectedServiceQuotaRecoveryCreditConsume,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceQuotaRecoveryCreditConsume: typeof handleConnectedServiceQuotaRecoveryCreditConsume;
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-quota-recovery-credit/consume',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    idempotencyKey: 'consume:sess_1:credit-1',
                    providerCreditId: 'credit-1',
                },
            });

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'daemon_shutting_down',
            });
            expect(handleConnectedServiceQuotaRecoveryCreditConsume).not.toHaveBeenCalled();
        } finally {
      await app.close();
    }
  });

  it('rejects recovery credit consume requests without idempotency before the daemon handler', async () => {
        const handleConnectedServiceQuotaRecoveryCreditConsume = vi.fn(async () => ({ ok: true }));
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceQuotaRecoveryCreditConsume: typeof handleConnectedServiceQuotaRecoveryCreditConsume;
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-quota-recovery-credit/consume',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                },
            });

            expect(response.statusCode).toBe(400);
            expect(handleConnectedServiceQuotaRecoveryCreditConsume).not.toHaveBeenCalled();
        } finally {
      await app.close();
    }
  });

  it('dispatches session turn lifecycle events to the daemon handler', async () => {
        const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({ ok: true }));
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
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceTurnLifecycle: typeof handleConnectedServiceTurnLifecycle;
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-turn-lifecycle',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    turnId: 'session-turn:exact-1',
                    event: 'assistant_message_end',
                    terminalStatus: 'failed',
                    connectedServiceSelectionsEnvRaw: '[{"kind":"profile","serviceId":"gemini","profileId":"work"}]',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: { ok: true },
            });
            expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                turnId: 'session-turn:exact-1',
                event: 'assistant_message_end',
                terminalStatus: 'failed',
                connectedServiceSelectionsEnvRaw: '[{"kind":"profile","serviceId":"gemini","profileId":"work"}]',
            });
        } finally {
            await app.close();
    }
  });

  it('dispatches exact usage-limit wait-resume cancellation by stable runtime attempt id', async () => {
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
                payload: {
                    sessionId: 'sess_1',
                    attemptId: 'runtime-auth-attempt:exact-1',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, result: { ok: true } });
            expect(handleConnectedServiceUsageLimitWaitResumeCancel).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                attemptId: 'runtime-auth-attempt:exact-1',
            });
        } finally {
            await app.close();
        }
  });

  it('does not expose the retired broker load-handshake routes', async () => {
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
      controlToken: 'master-token',
    } as Parameters<typeof createDaemonControlApp>[0]);

    try {
      const record = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded',
        headers: { 'x-happier-daemon-token': 'master-token' },
        payload: {
          selectionIdentity: 'opencode|connected|broker:1|openai-codex:p:',
          loadNonce: 'opencode-spawn-control-test',
        },
      });
      const status = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/broker/loaded-status',
        headers: { 'x-happier-daemon-token': 'master-token' },
        payload: {
          selectionIdentity: 'opencode|connected|broker:1|openai-codex:p:',
          loadNonce: 'opencode-spawn-control-test',
        },
      });

      expect(record.statusCode).toBe(404);
      expect(status.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

    it('defers runtime-auth reports while shutting down before durable intake starts', async () => {
        const beginClassifiedFailure = vi.fn(async () => createScheduledRuntimeAuthRecoveryResult());
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'switch_attempted',
            result: { status: 'switched', fromProfileId: 'primary', activeProfileId: 'backup', generation: 2 },
        }));
        const markSucceededByKey = vi.fn(async () => null);
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure,
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
      cancel: vi.fn(async () => null),
            cancelExact: vi.fn(async () => []),
      cancelByKey: vi.fn(async () => null),
      markSucceededByKey,
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
      isShuttingDown: () => true,
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    } as Parameters<typeof createDaemonControlApp>[0] & {
      handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
      runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
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
            expect(beginClassifiedFailure).not.toHaveBeenCalled();
            expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
            expect(markSucceededByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('defers runtime-auth reports after a stop request before durable intake starts', async () => {
    const beginClassifiedFailure = vi.fn(async () => createScheduledRuntimeAuthRecoveryResult());
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const runtimeAuthRecoveryScheduler = {
      beginClassifiedFailure,
      enqueueHandlerFailure: vi.fn(),
      enqueueApplyFailure: vi.fn(),
      read: vi.fn(),
      readForSession: vi.fn(() => []),
      hydrate: vi.fn(() => []),
      wake: vi.fn(),
      cancel: vi.fn(async () => null),
            cancelExact: vi.fn(async () => []),
      cancelByKey: vi.fn(async () => null),
      markSucceededByKey: vi.fn(async () => null),
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
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    } as Parameters<typeof createDaemonControlApp>[0] & {
      handleConnectedServiceRuntimeAuthFailure: typeof handleConnectedServiceRuntimeAuthFailure;
      runtimeAuthRecoveryScheduler: typeof runtimeAuthRecoveryScheduler;
    });

    try {
      const stopResponse = await app.inject({
        method: 'POST',
        url: '/stop',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { stopSessions: false },
      });
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

      expect(stopResponse.statusCode).toBe(200);
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
});
