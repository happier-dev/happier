import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const storageState = vi.hoisted(() => ({
    value: {
        machines: {},
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => storageState.value,
        },
    });
});

const directSource = {
    kind: 'codexHome' as const,
    home: 'user' as const,
};

function encodeRawCodexCursor(value: unknown): string {
    return encodeBase64(new TextEncoder().encode(JSON.stringify(value)), 'base64url');
}

const takeoverStartRequest = {
    v: 1 as const,
    idempotencyKey: 'takeover-request-1',
    sessionId: 'happy-session-1',
    source: {
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        qualifiedIdentity: {
            v: 1 as const,
            agent: { pluginId: 'com.example.agent', localId: 'example' },
            source: { kind: 'jsonl', contractVersion: 1 as const },
        },
        linkGeneration: 'link-1',
    },
    plan: 'takeover' as const,
    targetStorageMode: 'persisted' as const,
    targetRuntimeMode: 'terminal' as const,
};
const externalLinkedTakeoverStartRequest = {
    ...takeoverStartRequest,
    idempotencyKey: 'takeover-external-linked-1',
    targetStorageMode: 'external-linked' as const,
};

const takeoverStartResponse = {
    ok: true as const,
    progress: {
        v: 1 as const,
        operationId: 'operation-1',
        revision: 0,
        request: {
            plan: 'takeover' as const,
            targetStorageMode: 'persisted' as const,
            targetRuntimeMode: 'terminal' as const,
        },
        status: 'awaiting_user_resume' as const,
        phase: 'validating' as const,
        timeline: [
            'validating',
            'quiescing',
            'staging',
            'importing',
            'final_catch_up',
            'admitting',
            'spawning',
            'finalizing',
        ] as const,
        updatedAtMs: 1,
        priorStableStorage: { state: 'machine_only' as const },
        currentStorageState: 'machine_only' as const,
        checkpoint: {
            sourcePagesRead: 0,
            stagedItemCount: 0,
            importedItemCount: 0,
            requiredItemFailures: {
                total: 0,
                record: 0,
                media: 0,
                conversion: 0,
                diagnosticsTruncated: false,
            },
        },
        fence: { kind: 'none' as const },
        retryTargetPhase: 'validating' as const,
    },
};

const materializeStartRequest = {
    v: 1 as const,
    idempotencyKey: 'materialize-request-1',
    sessionId: 'happy-session-1',
    plan: 'materialize' as const,
    targetStorageMode: 'external-linked' as const,
    targetRuntimeMode: null,
};

const materializeStartResponse = {
    ok: false as const,
    error: {
        code: 'internal_error' as const,
        message: 'fixture',
    },
};

describe('machine direct sessions ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        storageState.value = { machines: {} };
    });

    it('routes direct session candidate listing through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            candidates: [],
            nextCursor: null,
        });
        const { machineExternalSessionsCandidatesList } = await import('./machineExternalSessions');

        const result = await machineExternalSessionsCandidatesList({
            machineId: 'machine-1',
            agentId: 'codex',
            source: directSource,
            limit: 20,
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, candidates: [], nextCursor: null });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.candidates.list',
            payload: expect.objectContaining({
                agentId: 'codex',
                limit: 20,
            }),
        }));
    });

    it('threads candidate-list cancellation through canonical and released RPC attempts', async () => {
        const controller = new AbortController();
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                candidates: [],
                nextCursor: null,
            });
        const { machineExternalSessionsCandidatesList } = await import('./machineExternalSessions');

        await expect(machineExternalSessionsCandidatesList({
            machineId: 'machine-1',
            agentId: 'codex',
            source: directSource,
            limit: 20,
        }, {
            serverId: 'server-a',
            signal: controller.signal,
        })).resolves.toMatchObject({ ok: true });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'daemon.externalSessions.candidates.list',
            signal: controller.signal,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.directSessions.candidates.list',
            signal: controller.signal,
        }));
    });

    it('retries a released legacy candidate-list method only after canonical method-not-found', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                candidates: [],
                nextCursor: null,
            });
        const { machineExternalSessionsCandidatesList } = await import('./machineExternalSessions');

        await expect(machineExternalSessionsCandidatesList({
            machineId: 'machine-1',
            agentId: 'codex',
            source: directSource,
            limit: 20,
        }, { serverId: 'server-a' })).resolves.toEqual({
            ok: true,
            candidates: [],
            nextCursor: null,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'daemon.externalSessions.candidates.list',
            payload: expect.objectContaining({ agentId: 'codex' }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.directSessions.candidates.list',
            payload: {
                machineId: 'machine-1',
                providerId: 'codex',
                source: directSource,
                limit: 20,
            },
        }));
    });

    it('normalizes the released provider-unavailable response after legacy fallback', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'provider_unavailable',
                error: 'direct_session_provider_unavailable',
            });
        const { machineExternalSessionsCandidatesList } = await import('./machineExternalSessions');

        await expect(machineExternalSessionsCandidatesList({
            machineId: 'machine-1',
            agentId: 'codex',
            source: directSource,
            limit: 20,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'direct_session_provider_unavailable',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN),
        new RpcError('Method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE),
        Object.assign(new Error('Machine RPC timed out'), { code: 'MACHINE_RPC_TIMEOUT' }),
        new Error('ambiguous transport failure'),
    ])('does not retry legacy RPC after any non-method-not-found failure', async (canonicalError) => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(canonicalError);
        const { machineExternalSessionsCandidatesList } = await import('./machineExternalSessions');

        await expect(machineExternalSessionsCandidatesList({
            machineId: 'machine-1',
            agentId: 'codex',
            source: directSource,
            limit: 20,
        })).rejects.toBe(canonicalError);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('routes direct session linking hints through server-scoped machine rpc', async () => {
        const runtimeDescriptor = {
            v: 1 as const,
            agentId: 'codex' as const,
            agent: {
                backendMode: 'appServer' as const,
                providerSessionId: 'vendor-session-1',
                home: 'user' as const,
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            sessionId: 'happy-session-1',
            created: true,
        });
        const { machineExternalSessionLinkEnsure } = await import('./machineExternalSessions');

        const result = await machineExternalSessionLinkEnsure({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            titleHint: 'Existing Codex Session',
            directoryHint: '/tmp/worktree',
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: runtimeDescriptor,
            source: directSource,
        } as any, { serverId: 'server-a' });

        expect(result).toEqual({
            ok: true,
            sessionId: 'happy-session-1',
            created: true,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.link.ensure',
            payload: {
                machineId: 'machine-1',
                agentId: 'codex',
                remoteSessionId: 'vendor-session-1',
                titleHint: 'Existing Codex Session',
                directoryHint: '/tmp/worktree',
                codexBackendMode: 'appServer',
                runtimeDescriptorV1: runtimeDescriptor,
                source: directSource,
            },
        }));
    });

    it('downconverts canonical link identity and runtime descriptor for a released daemon', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                sessionId: 'happy-session-1',
                created: true,
            });
        const { machineExternalSessionLinkEnsure } = await import('./machineExternalSessions');

        await expect(machineExternalSessionLinkEnsure({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    providerSessionId: 'vendor-session-1',
                    agentExtra: { owner: 'codex', schemaId: 'codex.runtime', v: 1 },
                },
            },
        })).resolves.toMatchObject({ ok: true, sessionId: 'happy-session-1' });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.directSessions.link.ensure',
            payload: {
                machineId: 'machine-1',
                providerId: 'codex',
                remoteSessionId: 'vendor-session-1',
                source: directSource,
                runtimeDescriptor: {
                    v: 1,
                    providerId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        providerSessionId: 'vendor-session-1',
                        providerExtra: { owner: 'codex', schemaId: 'codex.runtime', v: 1 },
                    },
                },
            },
        }));
    });

    it('routes direct session attach and detach through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: true,
                leaseId: 'lease-1',
                expiresAtMs: 45_000,
            })
            .mockResolvedValueOnce({
                ok: true,
                detached: true,
            });
        const { machineExternalSessionAttach, machineExternalSessionDetach } = await import('./machineExternalSessions');

        const attachResult = await machineExternalSessionAttach({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            ttlMs: 30_000,
        }, { serverId: 'server-a' });
        const detachResult = await machineExternalSessionDetach({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            leaseId: 'lease-1',
        }, { serverId: 'server-a' });

        expect(attachResult).toEqual({ ok: true, leaseId: 'lease-1', expiresAtMs: 45_000 });
        expect(detachResult).toEqual({ ok: true, detached: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.attach',
            payload: expect.objectContaining({
                sessionId: 'happy-session-1',
                remoteSessionId: 'vendor-session-1',
                ttlMs: 30_000,
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.detach',
            payload: {
                machineId: 'machine-1',
                sessionId: 'happy-session-1',
                leaseId: 'lease-1',
            },
        }));
    });

    it('retries released attach, detach, and follow-policy methods with their legacy request shapes', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'provider_unavailable',
                error: 'direct_session_provider_unavailable',
            })
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                detached: true,
            })
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                enabled: true,
                leaseActive: true,
                updatedAtMs: 42,
            });
        const {
            machineExternalSessionAttach,
            machineExternalSessionDetach,
            machineExternalSessionFollowPolicySet,
        } = await import('./machineExternalSessions');

        await expect(machineExternalSessionAttach({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            ttlMs: 30_000,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'direct_session_provider_unavailable',
        });
        await expect(machineExternalSessionDetach({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            leaseId: 'lease-1',
        })).resolves.toEqual({ ok: true, detached: true });
        await expect(machineExternalSessionFollowPolicySet({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            enabled: true,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'background_follow_not_supported',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.directSessions.attach',
            payload: {
                machineId: 'machine-1',
                sessionId: 'happy-session-1',
                providerId: 'codex',
                remoteSessionId: 'vendor-session-1',
                source: directSource,
                ttlMs: 30_000,
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(4, expect.objectContaining({
            method: 'daemon.directSessions.detach',
            payload: {
                machineId: 'machine-1',
                sessionId: 'happy-session-1',
                leaseId: 'lease-1',
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(5);
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.directSessions.followPolicy.set',
        }));
    });

    it('uses the predecessor direct RPC only to disable an already-enabled policy', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                enabled: false,
                leaseActive: false,
                updatedAtMs: 42,
            });
        const { machineExternalSessionFollowPolicySet } = await import('./machineExternalSessions');

        await expect(machineExternalSessionFollowPolicySet({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            enabled: false,
        })).resolves.toEqual({
            ok: true,
            enabled: false,
            leaseActive: false,
            updatedAtMs: 42,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.directSessions.followPolicy.set',
            payload: expect.objectContaining({
                providerId: 'codex',
                enabled: false,
            }),
        }));
    });

    it('routes background follow updates through the canonical external-session machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            enabled: true,
            leaseActive: true,
            updatedAtMs: 42,
        });
        const { machineExternalSessionFollowPolicySet } = await import('./machineExternalSessions');

        const result = await machineExternalSessionFollowPolicySet({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            enabled: true,
        }, { serverId: 'server-a' });

        expect(result).toEqual({
            ok: true,
            enabled: true,
            leaseActive: true,
            updatedAtMs: 42,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.backgroundFollow.set',
            payload: {
                machineId: 'machine-1',
                sessionId: 'happy-session-1',
                agentId: 'codex',
                remoteSessionId: 'vendor-session-1',
                source: directSource,
                enabled: true,
            },
        }));
    });

    it('routes direct transcript paging through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'cursor-2',
            hasMore: true,
        });
        const { machineExternalSessionTranscriptPage } = await import('./machineExternalSessions');

        const result = await machineExternalSessionTranscriptPage({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
        }, { serverId: 'server-a' });

        expect(result).toEqual({
            ok: true,
            items: [],
            nextCursor: 'cursor-2',
            hasMore: true,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.transcript.page',
            payload: expect.objectContaining({
                remoteSessionId: 'vendor-session-1',
                direction: 'older',
            }),
        }));
    });

    it('rejects predecessor raw Codex forward v5 and backward v3 while preserving released cursor fallbacks', async () => {
        const predecessorForwardV5 = encodeRawCodexCursor({
            v: 5,
            kind: 'codexForwardStreamVector',
            streams: [{
                fileRelPath: 'sessions/2026/07/27/rollout.jsonl',
                nextOffsetBytes: 123,
                subIndex: 0,
                fingerprintOffsetBytes: 123,
                fileIdentity: 'a'.repeat(64),
                contentFingerprint: 'b'.repeat(64),
            }],
        });
        const releasedForwardV3 = encodeRawCodexCursor({
            v: 3,
            kind: 'codexForwardMerged',
            lastCreatedAtMs: 123,
            lastId: 'thread-1',
        });
        const releasedBackwardV2 = encodeRawCodexCursor({
            v: 2,
            kind: 'codexBackwardMerged',
            endIndex: 12,
        });
        const predecessorBackwardV3 = encodeRawCodexCursor({
            v: 3,
            kind: 'codexBackwardStreamVector',
            streams: [{
                fileRelPath: 'sessions/2026/07/27/rollout.jsonl',
                endOffsetBytes: 123,
            }],
        });
        const { machineExternalSessionTranscriptPage, machineExternalSessionTranscriptReadAfter } = await import('./machineExternalSessions');

        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                truncated: false,
            });

        await expect(machineExternalSessionTranscriptReadAfter({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            cursor: predecessorForwardV5,
        })).rejects.toMatchObject({
            code: 'external_session_cursor_reset_required',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);

        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                truncated: false,
            });

        await expect(machineExternalSessionTranscriptReadAfter({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            cursor: releasedForwardV3,
        })).resolves.toMatchObject({ ok: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.directSessions.transcript.readAfter',
            payload: expect.objectContaining({ cursor: releasedForwardV3 }),
        }));

        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            });

        await expect(machineExternalSessionTranscriptPage({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
            cursor: predecessorBackwardV3,
        })).rejects.toMatchObject({
            code: 'external_session_cursor_reset_required',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);

        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            });

        await expect(machineExternalSessionTranscriptPage({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
            cursor: releasedBackwardV2,
        })).resolves.toMatchObject({ ok: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.directSessions.transcript.page',
            payload: expect.objectContaining({ cursor: releasedBackwardV2 }),
        }));
    });

    it('does not send a previously written raw Codex v4 forward cursor to a released daemon without typed cursor outcomes', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                truncated: false,
            });
        const { machineExternalSessionTranscriptReadAfter } = await import('./machineExternalSessions');

        await expect(machineExternalSessionTranscriptReadAfter({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            // Previous worktree writers emitted raw forward v4/v6 and backward
            // v4. The released daemon can report only its legacy truncated
            // shape, not the current typed reset outcome.
            cursor: 'eyJ2Ijo0LCJraW5kIjoiY29kZXhGb3J3YXJkU3RyZWFtVmVjdG9yIiwic3RyZWFtcyI6W3siZmlsZVJlbFBhdGgiOiJzZXNzaW9ucy8yMDI2LzAyLzE4L3JvbGxvdXQuanNvbmwiLCJuZXh0T2Zmc2V0Qnl0ZXMiOjEyMywic3ViSW5kZXgiOjB9XX0',
        })).rejects.toThrow('Codex transcript cursor reset required before released-daemon fallback');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('does not send a host-qualified current Codex v6 forward cursor to a released daemon', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                truncated: false,
            });
        const { machineExternalSessionTranscriptReadAfter } = await import('./machineExternalSessions');

        await expect(machineExternalSessionTranscriptReadAfter({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            // A previously current public-host wrapper around the Codex leaf's
            // forward v6 rollout/sidechain generation vector.
            cursor: 'happier_external_cursor_v1:eyJ2IjoxLCJwIjoiaGFwcGllci5hZ2VudC5jb2RleCIsImEiOiJjb2RleCIsImciOiJnZW5lcmF0aW9uLWN1cnJlbnQiLCJzIjoic291cmNlLWRpZ2VzdCIsIm0iOiJyZWFkQWZ0ZXJUcmFuc2NyaXB0IiwiciI6InZlbmRvci1zZXNzaW9uLTEiLCJjIjoiZXlKMklqbzJMQ0pyYVc1a0lqb2lZMjlrWlhoR2IzSjNZWEprVTNSeVpXRnRWbVZqZEc5eUlpd2ljMjkxY21ObFIyVnVaWEpoZEdsdmJpSTZXeUpvYjIxbElpd2ljMlZ6YzJsdmJuTWlYU3dpYzNSeVpXRnRjeUk2VzNzaVptbHNaVkpsYkZCaGRHZ2lPaUp6WlhOemFXOXVjeTh5TURJMkx6QTNMekl6TDNKdmJHeHZkWFF0YzJWemMybHZiaTVxYzI5dWJDSXNJbkJvZVhOcFkyRnNSMlZ1WlhKaGRHbHZiaUk2SWpFNk1qb3pJaXdpYm1WNGRFOW1abk5sZEVKNWRHVnpJam94TWpNc0luTjFZa2x1WkdWNElqb3dmVjE5In0',
        })).rejects.toMatchObject({
            code: 'external_session_cursor_reset_required',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('does not send a host-qualified current Codex backward v4 cursor to a released daemon', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            });
        const { machineExternalSessionTranscriptPage } = await import('./machineExternalSessions');

        await expect(machineExternalSessionTranscriptPage({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
            // A previously current public-host wrapper around the Codex leaf's
            // backward v4 rollout/sidechain generation vector.
            cursor: 'happier_external_cursor_v1:eyJ2IjoxLCJwIjoiaGFwcGllci5hZ2VudC5jb2RleCIsImEiOiJjb2RleCIsImciOiJnZW5lcmF0aW9uLWN1cnJlbnQiLCJzIjoic291cmNlLWRpZ2VzdCIsIm0iOiJwYWdlVHJhbnNjcmlwdCIsInIiOiJ2ZW5kb3Itc2Vzc2lvbi0xIiwiYyI6ImV5SjJJam8wTENKcmFXNWtJam9pWTI5a1pYaENZV05yZDJGeVpGTjBjbVZoYlZabFkzUnZjaUlzSW5OdmRYSmpaVWRsYm1WeVlYUnBiMjRpT2xzaWFHOXRaU0lzSW5ObGMzTnBiMjV6SWwwc0luTjBjbVZoYlhNaU9sdDdJbVpwYkdWU1pXeFFZWFJvSWpvaWMyVnpjMmx2Ym5Ndk1qQXlOaTh3Tnk4eU15OXliMnhzYjNWMExYTmxjM05wYjI0dWFuTnZibXdpTENKd2FIbHphV05oYkVkbGJtVnlZWFJwYjI0aU9pSXhPakk2TXlJc0ltVnVaRTltWm5ObGRFSjVkR1Z6SWpvek1qRjlYWDAifQ',
        })).rejects.toMatchObject({
            code: 'external_session_cursor_reset_required',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            direction: 'forward',
            cursor: encodeRawCodexCursor({
                v: 7,
                kind: 'codexForwardStreamVector',
                sourceGeneration: ['home', 'sessions', 'archived'],
                streams: [{
                    fileRelPath: 'sessions/2026/07/27/rollout.jsonl',
                    physicalGeneration: '1:2:3',
                    nextOffsetBytes: 123,
                    subIndex: 0,
                    fingerprintOffsetBytes: 123,
                    contentFingerprint: 'a'.repeat(64),
                }],
            }),
        },
        {
            direction: 'backward',
            cursor: encodeRawCodexCursor({
                v: 5,
                kind: 'codexBackwardStreamVector',
                sourceGeneration: ['home', 'sessions', 'archived'],
                streams: [{
                    fileRelPath: 'sessions/2026/07/27/rollout.jsonl',
                    physicalGeneration: '1:2:3',
                    endOffsetBytes: 123,
                    fingerprintOffsetBytes: 123,
                    contentFingerprint: 'b'.repeat(64),
                }],
            }),
        },
    ] as const)('does not send the anchored current Codex $direction cursor to a released daemon', async ({ direction, cursor }) => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            });
        const {
            machineExternalSessionTranscriptPage,
            machineExternalSessionTranscriptReadAfter,
        } = await import('./machineExternalSessions');

        const result = direction === 'forward'
            ? machineExternalSessionTranscriptReadAfter({
                machineId: 'machine-1',
                agentId: 'codex',
                remoteSessionId: 'vendor-session-1',
                source: directSource,
                cursor,
            })
            : machineExternalSessionTranscriptPage({
                machineId: 'machine-1',
                agentId: 'codex',
                remoteSessionId: 'vendor-session-1',
                source: directSource,
                direction: 'older',
                cursor,
            });

        await expect(result).rejects.toMatchObject({
            code: 'external_session_cursor_reset_required',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('never downgrades secure refresh to a transcript-bearing legacy RPC', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND),
        );
        const { machineExternalSessionTranscriptRefreshReadAfter } = await import('./machineExternalSessions');
        const binding = {
            v: 1 as const,
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            link: { generation: 'link-1', remoteSessionId: 'vendor-session-1' },
            source: {
                qualifiedIdentity: {
                    v: 1 as const,
                    agent: { pluginId: 'happier.codex', localId: 'codex' },
                    source: { kind: 'codexHome', contractVersion: 1 as const },
                },
                generation: 'source-1',
            },
            contributionGeneration: 'contribution-1',
            cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
        };
        const cursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';

        await expect(machineExternalSessionTranscriptRefreshReadAfter({
            v: 1,
            binding,
            cursor,
        })).rejects.toThrow('Method not found');

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'daemon.externalSessions.transcript.readAfter',
            payload: { v: 1, binding, cursor },
        }));
    });

    it('routes both takeover storage modes through the durable start RPC', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce(takeoverStartResponse)
            .mockResolvedValueOnce(takeoverStartResponse);
        const {
            machineExternalSessionTakeoverStart,
            machineExternalSessionTakeoverPersist,
        } = await import('./machineExternalSessions');

        const takeoverResult = await machineExternalSessionTakeoverStart({
            machineId: 'machine-1',
            request: externalLinkedTakeoverStartRequest,
        }, { serverId: 'server-a' });

        const persistResult = await machineExternalSessionTakeoverPersist({
            machineId: 'machine-1',
            request: takeoverStartRequest,
        }, { serverId: 'server-a' });

        expect(takeoverResult).toMatchObject({ ok: true });
        expect(persistResult).toMatchObject({
            ok: true,
            progress: { request: { targetStorageMode: 'persisted' } },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.takeover.start',
            payload: {
                request: externalLinkedTakeoverStartRequest,
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.takeover.start',
            payload: {
                request: takeoverStartRequest,
            },
        }));
    });

    it('sends only materialization intent to the daemon-owned start action', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce(materializeStartResponse);
        const { machineExternalSessionMaterializeStart } = await import('./machineExternalSessions');

        await expect(machineExternalSessionMaterializeStart({
            machineId: 'machine-1',
            request: materializeStartRequest,
        }, { serverId: 'server-a' })).resolves.toEqual(materializeStartResponse);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.materialize.start',
            payload: { request: materializeStartRequest },
        }));
        expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload)
            .not.toHaveProperty('request.source');
    });

    it('never downgrades either durable takeover mode to a released legacy action', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        const {
            machineExternalSessionTakeoverStart,
            machineExternalSessionTakeoverPersist,
        } = await import('./machineExternalSessions');

        await expect(machineExternalSessionTakeoverStart({
            machineId: 'machine-1',
            request: externalLinkedTakeoverStartRequest,
        })).resolves.toEqual({
            ok: false,
            error: {
                code: 'upgrade_required',
                message: 'Durable takeover requires a newer daemon.',
            },
        });
        await expect(machineExternalSessionTakeoverPersist({
            machineId: 'machine-1',
            request: takeoverStartRequest,
        })).resolves.toEqual({
            ok: false,
            error: {
                code: 'upgrade_required',
                message: 'Durable takeover requires a newer daemon.',
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.externalSessions.takeover.start',
            payload: { request: takeoverStartRequest },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it('routes public operation references without private claims and reports old daemons as upgrade-required', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce(takeoverStartResponse)
            .mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        const {
            machineExternalSessionOperationResume,
            machineExternalSessionOperationStatus,
        } = await import('./machineExternalSessions');
        const reference = {
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            operationId: 'operation-1',
            revision: 0,
        };

        await expect(machineExternalSessionOperationStatus(reference, {
            serverId: 'server-a',
        })).resolves.toMatchObject({
            ok: true,
            progress: { operationId: 'operation-1' },
        });
        await expect(machineExternalSessionOperationResume(reference, {
            serverId: 'server-a',
        })).resolves.toEqual({
            ok: false,
            error: {
                code: 'upgrade_required',
                message: 'External session operation controls require a newer daemon.',
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'daemon.externalSessions.operation.status.get',
            payload: {
                sessionId: 'happy-session-1',
                operationId: 'operation-1',
                revision: 0,
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.externalSessions.operation.resume',
            payload: {
                sessionId: 'happy-session-1',
                operationId: 'operation-1',
                revision: 0,
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it('routes external session RPCs to a replacement machine while preserving linked metadata identity', async () => {
        storageState.value = {
            machines: {
                'machine-old': {
                    id: 'machine-old',
                    active: false,
                    replacedByMachineId: 'machine-new',
                    replacedAt: 123,
                },
                'machine-new': {
                    id: 'machine-new',
                    active: true,
                },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(takeoverStartResponse);
        const { machineExternalSessionTakeoverPersist } = await import('./machineExternalSessions');

        const result = await machineExternalSessionTakeoverPersist({
            machineId: 'machine-old',
            request: takeoverStartRequest,
        }, { serverId: 'server-a' });

        expect(result).toMatchObject({ ok: true, progress: { operationId: 'operation-1' } });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-new',
            serverId: 'server-a',
            method: 'daemon.externalSessions.takeover.start',
            payload: {
                request: takeoverStartRequest,
            },
        }));
    });

    it('throws for malformed transcript page responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ nope: true });
        const { machineExternalSessionTranscriptPage } = await import('./machineExternalSessions');

        await expect(machineExternalSessionTranscriptPage({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
        })).rejects.toThrow('Unsupported response from machine RPC (daemon.externalSessions.transcript.page)');
    });
});
