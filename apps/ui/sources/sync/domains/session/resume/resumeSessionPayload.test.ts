import { describe, expect, test } from 'vitest';

import { buildResumeHappySessionRpcParams } from './resumeSessionPayload';

describe('buildResumeHappySessionRpcParams', () => {
    test('builds typed params for resume-session', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'claude-sonnet-4-5',
            modelUpdatedAt: 123,
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            modelId: 'claude-sonnet-4-5',
            modelUpdatedAt: 123,
        });
    });

    test('omits model override when pair is incomplete', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelUpdatedAt: 123,
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        });

        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'claude-sonnet-4-5',
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        });
    });

    test('omits sentinel default model override', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'default',
            modelUpdatedAt: 123,
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        });
    });

    test('includes environment variables when provided', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
            },
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
            },
        });
    });

    test('includes transcriptStorage when provided', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            transcriptStorage: 'direct',
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            transcriptStorage: 'direct',
        });
    });

    test('includes initial transcript catch-up cursor when provided', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            initialTranscriptAfterSeq: 36,
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            initialTranscriptAfterSeq: 36,
        });
    });

    test('includes an initial goal when resuming a session for goal editing', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            initialGoal: {
                objective: 'Ship work-state controls',
                status: 'active',
                tokenBudget: 25000,
            },
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            initialGoal: {
                objective: 'Ship work-state controls',
                status: 'active',
                tokenBudget: 25000,
            },
        });
    });

    test('includes connectedServices and freshness when provided', () => {
        const connectedServices = {
            v: 1,
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    profileId: 'profile-1',
                },
            },
        };
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            connectedServices,
            connectedServicesUpdatedAt: 1234,
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            connectedServices,
            connectedServicesUpdatedAt: 1234,
        });
    });

    test('includes attachMetadataIdentityPolicy when provided', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        });
    });

    test('includes configured ACP backend backend targets when provided', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'custom-kiro', configuredBackendId: 'custom-kiro', sourceKind: 'configured' },
        });
    });

    test('preserves canonical V2 backend target inputs through the resume payload', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
                sourceKind: 'configured',
            },
        } as any)).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        });
    });

    test('prefers codexBackendMode over legacy experimentalCodexAcp when provided together', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            experimentalCodexAcp: true,
        } as any)).toMatchObject({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'appServer',
                }),
            },
        });
    });

    test('normalizes legacy experimentalCodexAcp onto canonical codexBackendMode when codexBackendMode is absent', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
        } as any)).toMatchObject({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'acp',
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'acp',
                }),
            },
        });
    });

    test('prefers runtimeDescriptorV1 over legacy experimentalCodexAcp when codexBackendMode is absent', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-2',
                },
            },
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-2',
                },
            },
        });
    });

    test('carries runtimeDescriptorV1 through the resume RPC payload', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-1',
                },
            },
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-1',
                },
            },
        });
    });

    test('ignores legacy agentRuntimeDescriptorV1 input when building the canonical resume payload', () => {
        const params = buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'legacy-thread',
                },
            },
        } as any);

        expect(params).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        });
    });

    test('does not emit codex transport fields when the target backend is not codex', () => {
        const params = buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            codexBackendMode: 'acp',
            experimentalCodexAcp: true,
        } as any);

        expect(params).not.toHaveProperty('codexBackendMode');
        expect(params).not.toHaveProperty('runtimeDescriptorV1');
    });

    test('derives codex runtime descriptor for canonical codex backend targets', () => {
        const params = buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: {
                kind: 'backend',
                backendId: 'codex',
                sourceKind: 'built_in',
            },
            resume: 'codex-session-canonical',
            codexBackendMode: 'appServer',
        } as any);

        expect(params).toMatchObject({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: {
                kind: 'backend',
                backendId: 'codex',
                sourceKind: 'built_in',
            },
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: expect.objectContaining({
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-canonical',
                }),
            }),
        });
    });
});
