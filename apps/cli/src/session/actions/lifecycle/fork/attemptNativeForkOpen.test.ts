import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTurnProviderCheckpointV1Schema } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
    fetchSessionTurnsProjection: vi.fn(),
    fetchForkChildSessionOrThrow: vi.fn(),
    updateSessionMetadataWithRetry: vi.fn(),
    cleanupForkChildBestEffort: vi.fn(),
    archiveSessionBestEffort: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionTurnsProjection: (...args: unknown[]) => mocks.fetchSessionTurnsProjection(...args),
}));
vi.mock('./forkChildSessionRecovery', () => ({
    fetchForkChildSessionOrThrow: (...args: unknown[]) => mocks.fetchForkChildSessionOrThrow(...args),
    cleanupForkChildBestEffort: (...args: unknown[]) => mocks.cleanupForkChildBestEffort(...args),
    archiveSessionBestEffort: (...args: unknown[]) => mocks.archiveSessionBestEffort(...args),
}));
vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
    updateSessionMetadataWithRetry: (...args: unknown[]) => mocks.updateSessionMetadataWithRetry(...args),
}));

import { attemptNativeForkOpen } from './attemptNativeForkOpen';

const credentials = {
    token: 'token',
    encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3]) },
};
const parentMetadata = {
    runtimeDescriptorV1: {
        v: 1,
        agentId: 'grok',
        agent: { providerSessionId: 'provider-parent' },
    },
};
const forkBackendResolution = {
    ok: true as const,
    catalogAgentId: 'grok' as const,
    agentHintAgentId: 'grok',
    backendTargetV2: {
        kind: 'backend' as const,
        backendId: 'grok',
        sourceKind: 'built_in' as const,
    },
    backendTarget: { kind: 'builtInAgent' as const, agentId: 'grok' as const },
    replayFlavor: 'grok',
    metadataOverlay: {},
    configuredAcp: null,
};

describe('attemptNativeForkOpen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.fetchForkChildSessionOrThrow.mockResolvedValue({ id: 'host-child', metadata: '{}' });
        mocks.updateSessionMetadataWithRetry.mockResolvedValue(undefined);
    });

    it('hydrates one exact point checkpoint and passes it to the child spawn without pre-forking', async () => {
        const persistedCheckpoint = SessionTurnProviderCheckpointV1Schema.parse({
            kind: 'grok_prompt_index',
            promptIndex: 42,
        });
        mocks.fetchSessionTurnsProjection.mockResolvedValue({
            v: 1,
            sessionId: 'host-parent',
            updatedAt: 10,
            turns: [{
                turnId: 'host-turn-42',
                status: 'completed',
                startedAt: 1,
                updatedAt: 2,
                transcriptAnchors: {
                    startUserMessageSeq: 7,
                    startSeqInclusive: 7,
                    endSeqInclusive: 9,
                    providerCheckpoint: persistedCheckpoint,
                },
                rollback: {
                    state: 'eligible',
                    providerCheckpoint: persistedCheckpoint,
                    updatedAt: 3,
                },
            }],
        });
        const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'host-child' }));
        const awaitAgentSessionOpen = vi.fn(async () => ({
            status: 'opened' as const,
            request: {
                kind: 'fork' as const,
                sessionId: 'host-child',
                cwd: '/source',
                source: {
                    sessionId: 'host-parent',
                    providerSessionId: 'provider-parent',
                    cwd: '/source',
                    target: {
                        turnId: 'host-turn-42',
                        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
                    },
                },
            },
        }));

        await expect(attemptNativeForkOpen({
            credentials,
            parentSessionId: 'host-parent',
            parentMetadata,
            directory: '/source',
            forkPoint: { type: 'seq', upToSeqInclusive: 8 },
            targetSeqInclusive: 8,
            effectiveCutoffSeqInclusive: 9,
            spawnNonce: 'fork:native-open',
            forkBackendResolution,
            inheritedForkOverrides: { spawn: {}, metadata: {} },
            spawnSession,
            stopSession: vi.fn(),
            awaitAgentSessionOpen,
        })).resolves.toEqual({ ok: true, childSessionId: 'host-child' });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            runtimeDescriptorV1: parentMetadata.runtimeDescriptorV1,
            nativeForkSource: {
                sessionId: 'host-parent',
                providerSessionId: 'provider-parent',
                cwd: '/source',
                target: {
                    turnId: 'host-turn-42',
                    providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
                },
            },
        }));
        expect(awaitAgentSessionOpen).toHaveBeenCalledWith({
            sessionId: 'host-child',
        });
        expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledOnce();
        const updater = mocks.updateSessionMetadataWithRetry.mock.calls[0]?.[0]
            ?.updater as ((metadata: Record<string, unknown>) => Record<string, unknown>);
        expect(updater({})).toMatchObject({
            forkV1: {
                parentSessionId: 'host-parent',
                parentCutoffSeqInclusive: 9,
                strategy: 'provider_native',
            },
        });
    });

    it('omits the target for a whole-conversation fork', async () => {
        const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'host-child' }));
        const awaitAgentSessionOpen = vi.fn(async () => ({
            status: 'opened' as const,
            request: {
                kind: 'fork' as const,
                sessionId: 'host-child',
                cwd: '/source',
                source: {
                    sessionId: 'host-parent',
                    providerSessionId: 'provider-parent',
                    cwd: '/source',
                },
            },
        }));

        await attemptNativeForkOpen({
            credentials,
            parentSessionId: 'host-parent',
            parentMetadata,
            directory: '/source',
            forkPoint: { type: 'latest' },
            targetSeqInclusive: 12,
            effectiveCutoffSeqInclusive: 12,
            spawnNonce: 'fork:native-open',
            forkBackendResolution,
            inheritedForkOverrides: { spawn: {}, metadata: {} },
            spawnSession,
            stopSession: vi.fn(),
            awaitAgentSessionOpen,
        });

        expect(mocks.fetchSessionTurnsProjection).not.toHaveBeenCalled();
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            nativeForkSource: {
                sessionId: 'host-parent',
                providerSessionId: 'provider-parent',
                cwd: '/source',
            },
        }));
    });

    it.each([
        {
            label: 'a fresh create open',
            attestation: {
                status: 'opened' as const,
                request: {
                    kind: 'create' as const,
                    sessionId: 'host-child',
                    cwd: '/source',
                },
            },
        },
        {
            label: 'a resume open',
            attestation: {
                status: 'opened' as const,
                request: {
                    kind: 'resume' as const,
                    sessionId: 'host-child',
                    cwd: '/source',
                    providerSessionId: 'provider-parent',
                },
            },
        },
        {
            label: 'a mismatched fork open',
            attestation: {
                status: 'opened' as const,
                request: {
                    kind: 'fork' as const,
                    sessionId: 'host-child',
                    cwd: '/source',
                    source: {
                        sessionId: 'different-parent',
                        providerSessionId: 'provider-parent',
                        cwd: '/source',
                    },
                },
            },
        },
        {
            label: 'a missing completed open',
            attestation: {
                status: 'timeout' as const,
            },
        },
    ])('does not publish provider-native provenance after $label', async ({ label, attestation }) => {
        const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'host-child' }));
        const stopSession = vi.fn();
        const awaitAgentSessionOpen = vi.fn(async () => attestation);

        const result = await attemptNativeForkOpen({
            credentials,
            parentSessionId: 'host-parent',
            parentMetadata,
            directory: '/source',
            forkPoint: { type: 'latest' },
            targetSeqInclusive: 12,
            effectiveCutoffSeqInclusive: 12,
            spawnNonce: 'fork:native-open',
            forkBackendResolution,
            inheritedForkOverrides: { spawn: {}, metadata: {} },
            spawnSession,
            stopSession,
            awaitAgentSessionOpen,
        });
        expect(result).toMatchObject({
            ok: false,
            errorCode: 'UNEXPECTED',
        });
        if (label === 'a mismatched fork open') {
            expect(result).toMatchObject({
                errorMessage: 'Child runtime opened with a different parent session identity',
            });
        }

        expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
        expect(mocks.fetchForkChildSessionOrThrow).not.toHaveBeenCalled();
        expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledWith(
            {
                credentials,
                fallbackStopSession: stopSession,
                sessionId: 'host-child',
            },
        );
        expect(mocks.archiveSessionBestEffort).toHaveBeenCalledWith('token', 'host-child');
    });

    it('runs stop-then-archive recovery when fork metadata finalization fails', async () => {
        const metadataError = new Error('metadata finalization failed');
        mocks.updateSessionMetadataWithRetry.mockRejectedValue(metadataError);
        const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'host-child' }));
        const stopSession = vi.fn();
        const awaitAgentSessionOpen = vi.fn(async () => ({
            status: 'opened' as const,
            request: {
                kind: 'fork' as const,
                sessionId: 'host-child',
                cwd: '/source',
                source: {
                    sessionId: 'host-parent',
                    providerSessionId: 'provider-parent',
                    cwd: '/source',
                },
            },
        }));

        await expect(attemptNativeForkOpen({
            credentials,
            parentSessionId: 'host-parent',
            parentMetadata,
            directory: '/source',
            forkPoint: { type: 'latest' },
            targetSeqInclusive: 12,
            effectiveCutoffSeqInclusive: 12,
            spawnNonce: 'fork:native-open',
            forkBackendResolution,
            inheritedForkOverrides: { spawn: {}, metadata: {} },
            spawnSession,
            stopSession,
            awaitAgentSessionOpen,
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: metadataError.message,
        });

        expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledWith(
            {
                credentials,
                fallbackStopSession: stopSession,
                sessionId: 'host-child',
            },
        );
        expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
        expect(mocks.archiveSessionBestEffort).toHaveBeenCalledWith('token', 'host-child');
        expect(mocks.archiveSessionBestEffort).toHaveBeenCalledOnce();
        expect(mocks.cleanupForkChildBestEffort.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.archiveSessionBestEffort.mock.invocationCallOrder[0]!,
        );
    });

    it('preserves the initiating finalization failure when child archival also fails', async () => {
        const metadataError = new Error('metadata finalization failed');
        mocks.updateSessionMetadataWithRetry.mockRejectedValue(metadataError);
        mocks.archiveSessionBestEffort.mockRejectedValue(
            Object.assign(new Error('Cannot archive an active session'), {
                code: 'session_active',
            }),
        );
        const stopSession = vi.fn();

        await expect(attemptNativeForkOpen({
            credentials,
            parentSessionId: 'host-parent',
            parentMetadata,
            directory: '/source',
            forkPoint: { type: 'latest' },
            targetSeqInclusive: 12,
            effectiveCutoffSeqInclusive: 12,
            spawnNonce: 'fork:native-finalization-cleanup-failure',
            forkBackendResolution,
            inheritedForkOverrides: { spawn: {}, metadata: {} },
            spawnSession: vi.fn(async () => ({
                type: 'success' as const,
                sessionId: 'host-child',
            })),
            stopSession,
            awaitAgentSessionOpen: vi.fn(async () => ({
                status: 'opened' as const,
                request: {
                    kind: 'fork' as const,
                    sessionId: 'host-child',
                    cwd: '/source',
                    source: {
                        sessionId: 'host-parent',
                        providerSessionId: 'provider-parent',
                        cwd: '/source',
                    },
                },
            })),
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: metadataError.message,
        });

        expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledWith(
            {
                credentials,
                fallbackStopSession: stopSession,
                sessionId: 'host-child',
            },
        );
        expect(mocks.archiveSessionBestEffort).toHaveBeenCalledWith(
            'token',
            'host-child',
        );
    });

    it('waits for one machine-local stop before propagating a post-spawn authentication error', async () => {
        const authenticationError = Object.assign(new Error('expired credentials'), {
            response: { status: 401 },
        });
        mocks.fetchForkChildSessionOrThrow.mockRejectedValueOnce(authenticationError);
        let releaseCleanup: (() => void) | undefined;
        mocks.cleanupForkChildBestEffort.mockImplementationOnce(
            async (input: Readonly<{
                fallbackStopSession: (sessionId: string) => Promise<unknown>;
                sessionId: string;
            }>) => {
                await input.fallbackStopSession(input.sessionId);
                await new Promise<void>((resolve) => {
                    releaseCleanup = resolve;
                });
            },
        );
        const stopSession = vi.fn();
        const attempt = attemptNativeForkOpen({
            credentials,
            parentSessionId: 'host-parent',
            parentMetadata,
            directory: '/source',
            forkPoint: { type: 'latest' },
            targetSeqInclusive: 12,
            effectiveCutoffSeqInclusive: 12,
            spawnNonce: 'fork:native-auth-failure',
            forkBackendResolution,
            inheritedForkOverrides: { spawn: {}, metadata: {} },
            spawnSession: vi.fn(async () => ({
                type: 'success' as const,
                sessionId: 'host-child',
            })),
            stopSession,
            awaitAgentSessionOpen: vi.fn(async () => ({
                status: 'opened' as const,
                request: {
                    kind: 'fork' as const,
                    sessionId: 'host-child',
                    cwd: '/source',
                    source: {
                        sessionId: 'host-parent',
                        providerSessionId: 'provider-parent',
                        cwd: '/source',
                    },
                },
            })),
        });
        let settled = false;
        void attempt.finally(() => {
            settled = true;
        }).catch(() => undefined);

        await vi.waitFor(() => {
            expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
        });
        expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledWith(
            {
                credentials,
                fallbackStopSession: stopSession,
                sessionId: 'host-child',
            },
        );
        expect(stopSession).toHaveBeenCalledOnce();
        expect(stopSession).toHaveBeenCalledWith('host-child');
        expect(settled).toBe(false);
        expect(mocks.archiveSessionBestEffort).not.toHaveBeenCalled();

        releaseCleanup?.();
        await expect(attempt).rejects.toBe(authenticationError);
        expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
        expect(stopSession).toHaveBeenCalledOnce();
    });

    it('fails closed before spawn when a point checkpoint is absent or ambiguous', async () => {
        mocks.fetchSessionTurnsProjection.mockResolvedValue({
            v: 1,
            sessionId: 'host-parent',
            updatedAt: 10,
            turns: [],
        });
        const spawnSession = vi.fn();

        await expect(attemptNativeForkOpen({
            credentials,
            parentSessionId: 'host-parent',
            parentMetadata,
            directory: '/source',
            forkPoint: { type: 'seq', upToSeqInclusive: 8 },
            targetSeqInclusive: 8,
            effectiveCutoffSeqInclusive: 8,
            spawnNonce: 'fork:native-open',
            forkBackendResolution,
            inheritedForkOverrides: { spawn: {}, metadata: {} },
            spawnSession,
            stopSession: vi.fn(),
            awaitAgentSessionOpen: vi.fn(),
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'INVALID_REQUEST',
        });
        expect(spawnSession).not.toHaveBeenCalled();
    });
});
