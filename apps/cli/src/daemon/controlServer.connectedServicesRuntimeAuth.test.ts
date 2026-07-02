import { describe, expect, it, vi } from 'vitest';
import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import type { RuntimeAuthRecoveryScheduleResult } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { createDaemonControlApp } from './controlServer';

function createScheduledRuntimeAuthRecoveryResult(
    overrides?: Partial<Extract<RuntimeAuthRecoveryScheduleResult, { status: 'scheduled' }>>,
): Extract<RuntimeAuthRecoveryScheduleResult, { status: 'scheduled' }> {
    return {
        status: 'scheduled',
        retryable: true,
        nextRetryAtMs: 2_000,
        attemptCount: 0,
        maxAttempts: 3,
        ...overrides,
    };
}

describe('createDaemonControlApp connected-service runtime auth handling', () => {
    it('dispatches reported runtime auth failures to the daemon handler', async () => {
        const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        }));
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
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

    it('creates durable runtime-auth recovery intake before running local repair', async () => {
        const calls: string[] = [];
        const beginClassifiedFailure = vi.fn(async () => {
            calls.push('begin');
            return createScheduledRuntimeAuthRecoveryResult();
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
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
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
            });
            expect(beginClassifiedFailure).toHaveBeenCalledWith({
                sessionId: 'sess_claude_group',
                switchesThisTurn: 0,
                classification: expect.objectContaining(classification),
            });
            expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
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
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
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
            stopSession: async () => false,
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
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
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

    it('schedules apply-time hot-apply retry and cancels durable retry after success', async () => {
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult()),
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
            cancelByKey: vi.fn(async () => null),
            markSucceededByKey: vi.fn(async () => null),
            markAwaitingProviderOutcomeProofByKey: vi.fn(async () => null),
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
            stopSession: async () => false,
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
            // Proven account-adoption verification clears recovery.
            expect(runtimeAuthRecoveryScheduler.markSucceededByKey).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
            });
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
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
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
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
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
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult()),
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(async () => null),
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
            stopSession: async () => false,
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
                result: { status: 'credential_refreshed' },
            });
            // A fresh token is not proof the provider accepts it; recovery stays pending.
            expect(runtimeAuthRecoveryScheduler.markSucceededByKey).not.toHaveBeenCalled();
            expect(runtimeAuthRecoveryScheduler.markAwaitingProviderOutcomeProofByKey).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
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
            stopSession: async () => false,
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

    it('clears durable retry when a switch-owner result is proven (account adoption verified)', async () => {
        const runtimeAuthRecoveryScheduler = {
            beginClassifiedFailure: vi.fn(async () => createScheduledRuntimeAuthRecoveryResult()),
            enqueueHandlerFailure: vi.fn(),
            enqueueApplyFailure: vi.fn(),
            read: vi.fn(),
            readForSession: vi.fn(() => []),
            hydrate: vi.fn(() => []),
            wake: vi.fn(),
            cancel: vi.fn(async () => null),
            cancelByKey: vi.fn(async () => null),
            markSucceededByKey: vi.fn(async () => null),
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
            stopSession: async () => false,
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
            // Proven via post-switch account-adoption verification.
            expect(runtimeAuthRecoveryScheduler.markSucceededByKey).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
            });
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
            cancelByKey: vi.fn(),
            markSucceededByKey: vi.fn(),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
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
            stopSession: async () => false,
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

  it('dispatches reported in-band quota snapshots to the daemon handler', async () => {
        const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
            status: 'recorded',
        }));
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
            spawnSession: async () => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'token',
            handleConnectedServiceQuotaSnapshot,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceQuotaSnapshot: typeof handleConnectedServiceQuotaSnapshot;
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

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: { status: 'recorded' },
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
      await app.close();
    }
  });

    it('rejects mismatched in-band quota snapshots before the daemon handler', async () => {
        const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
            status: 'recorded',
        }));
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
            spawnSession: async () => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'token',
            handleConnectedServiceQuotaSnapshot,
        } as Parameters<typeof createDaemonControlApp>[0] & {
            handleConnectedServiceQuotaSnapshot: typeof handleConnectedServiceQuotaSnapshot;
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-quota-snapshot',
                headers: { 'x-happier-daemon-token': 'token' },
                payload: {
                    sessionId: 'sess_1',
                    serviceId: 'openai',
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

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'connected_service_quota_snapshot_service_id_mismatch',
            });
            expect(handleConnectedServiceQuotaSnapshot).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('dispatches session turn lifecycle events to the daemon handler', async () => {
        const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({ ok: true }));
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine',
            stopSession: async () => false,
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
                    event: 'assistant_message_end',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: { ok: true },
            });
            expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                event: 'assistant_message_end',
            });
        } finally {
            await app.close();
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
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    } as Parameters<typeof createDaemonControlApp>[0] & {
      handleCodexChatGptAuthTokensRefresh: typeof handleCodexChatGptAuthTokensRefresh;
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': 'token' },
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

    it('creates durable runtime-auth recovery intake before shutdown deferral', async () => {
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
      cancelByKey: vi.fn(async () => null),
      markSucceededByKey,
    };
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
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
            // No switch work was run; no recovery intent was cleared (deferral, not an attempt).
            expect(beginClassifiedFailure).toHaveBeenCalledWith({
                sessionId: 'sess_1',
                switchesThisTurn: 0,
                classification: expect.objectContaining({
                    kind: 'usage_limit',
                    serviceId: 'openai-codex',
                    groupId: 'main',
                }),
            });
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
      cancelByKey: vi.fn(async () => null),
      markSucceededByKey: vi.fn(async () => null),
    };
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
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
