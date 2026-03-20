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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            transcriptStorage: 'direct',
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            agentRuntimeDescriptorV1: {
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
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'acp',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'acp',
                }),
            },
        });
    });

    test('prefers agentRuntimeDescriptorV1 over legacy experimentalCodexAcp when codexBackendMode is absent', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'codex-session-2',
                },
            },
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'codex-session-2',
                },
            },
        });
    });

    test('carries agentRuntimeDescriptorV1 through the resume RPC payload', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'codex-session-1',
                },
            },
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'codex-session-1',
                },
            },
        });
    });
});
