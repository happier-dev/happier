import { beforeEach, describe, expect, it, vi } from 'vitest';

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
            providerId: 'codex',
            source: directSource,
            limit: 20,
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, candidates: [], nextCursor: null });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.candidates.list',
            payload: expect.objectContaining({
                providerId: 'codex',
                limit: 20,
            }),
        }));
    });

    it('routes direct session linking hints through server-scoped machine rpc', async () => {
        const runtimeDescriptor = {
            v: 1 as const,
            providerId: 'codex' as const,
            provider: {
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
            providerId: 'codex',
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
                providerId: 'codex',
                remoteSessionId: 'vendor-session-1',
                titleHint: 'Existing Codex Session',
                directoryHint: '/tmp/worktree',
                codexBackendMode: 'appServer',
                runtimeDescriptorV1: runtimeDescriptor,
                source: directSource,
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
            providerId: 'codex',
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

    it('routes direct session background follow policy updates through server-scoped machine rpc', async () => {
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
            providerId: 'codex',
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
            method: 'daemon.externalSessions.followPolicy.set',
            payload: {
                machineId: 'machine-1',
                sessionId: 'happy-session-1',
                providerId: 'codex',
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
            providerId: 'codex',
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

    it('routes direct session takeover+persist through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: true,
                sessionId: 'happy-session-1',
                targetRuntimeMode: 'terminal',
                storageMode: 'external-linked',
                converted: false,
            })
            .mockResolvedValueOnce({
            ok: true,
            sessionId: 'happy-session-1',
            targetRuntimeMode: 'terminal',
            storageMode: 'persisted',
            converted: true,
        });
        const { machineExternalSessionTakeover, machineExternalSessionTakeoverPersist } = await import('./machineExternalSessions');

        const takeoverResult = await machineExternalSessionTakeover({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            forceStop: false,
        }, { serverId: 'server-a' });

        const persistResult = await machineExternalSessionTakeoverPersist({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            forceStop: true,
        }, { serverId: 'server-a' });

        expect(takeoverResult).toMatchObject({ ok: true, sessionId: 'happy-session-1' });
        expect(persistResult).toMatchObject({ ok: true, converted: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.takeover',
            payload: {
                machineId: 'machine-1',
                linkedSessionId: 'happy-session-1',
                targetRuntimeMode: 'terminal',
                storageMode: 'external-linked',
                forceStop: false,
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.externalSessions.takeover',
            payload: {
                machineId: 'machine-1',
                linkedSessionId: 'happy-session-1',
                targetRuntimeMode: 'terminal',
                storageMode: 'persisted',
                forceStop: true,
            },
        }));
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
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            sessionId: 'happy-session-1',
            targetRuntimeMode: 'terminal',
            storageMode: 'persisted',
            converted: true,
        });
        const { machineExternalSessionTakeoverPersist } = await import('./machineExternalSessions');

        const result = await machineExternalSessionTakeoverPersist({
            machineId: 'machine-old',
            sessionId: 'happy-session-1',
            forceStop: true,
        }, { serverId: 'server-a' });

        expect(result).toMatchObject({ ok: true, converted: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-new',
            serverId: 'server-a',
            method: 'daemon.externalSessions.takeover',
            payload: {
                machineId: 'machine-old',
                linkedSessionId: 'happy-session-1',
                targetRuntimeMode: 'terminal',
                storageMode: 'persisted',
                forceStop: true,
            },
        }));
    });

    it('throws for malformed transcript page responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ nope: true });
        const { machineExternalSessionTranscriptPage } = await import('./machineExternalSessions');

        await expect(machineExternalSessionTranscriptPage({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
        })).rejects.toThrow('Unsupported response from machine RPC (daemon.externalSessions.transcript.page)');
    });
});
