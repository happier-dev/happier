import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('./sessionMachineTarget', async () => {
    const actual = await vi.importActual<typeof import('./sessionMachineTarget')>('./sessionMachineTarget');
    return {
        ...actual,
        readMachineTargetForSession: readMachineTargetForSessionMock,
    };
});

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: vi.fn(),
        sessionRPC: vi.fn(),
    },
}));

const sessionsModulePromise = import('./sessions');

describe('sessions ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockReturnValue(null);
    });

    it('routes resume session spawn through server-scoped rpc with requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ type: 'success', sessionId: 'sess-1' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            serverId: 'server-b',
        }));
    });

    it('passes transcriptStorage through resumeSession when requested', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            transcriptStorage: 'direct',
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                transcriptStorage: 'direct',
            }),
        }));
    });

    it('passes attachMetadataIdentityPolicy through resumeSession when requested', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
            }),
        }));
    });

    it('passes connectedServices through resumeSession when requested', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        profileId: 'profile-1',
                    },
                },
            },
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                connectedServices: expect.any(Object),
            }),
        }));
    });

    it('omits connectedServices for resumeSession when it is null', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            connectedServices: null,
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        const call = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as { payload?: unknown } | undefined;
        expect(call && typeof call === 'object').toBe(true);
        expect(call?.payload && typeof call.payload === 'object').toBe(true);
        expect(call?.payload as Record<string, unknown>).not.toHaveProperty('connectedServices');
    });

    it('passes codexBackendMode through resumeSession when requested', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                codexBackendMode: 'appServer',
            }),
        }));
    });

    it('passes configured ACP backend backend targets through resumeSession when requested', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
            }),
        }));
    });

    it('prefers reachable machine target from session for resumeSession', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success' });
        readMachineTargetForSessionMock.mockReturnValueOnce({ machineId: 'reachable-machine', basePath: '/base' });
        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'stale-machine',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ type: 'success' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'reachable-machine',
            method: 'spawn-happy-session',
            serverId: 'server-b',
            payload: expect.objectContaining({
                directory: '/base',
            }),
        }));
    });

    it('uses the requested machine target for resumeSession when explicitly requested', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success' });
        readMachineTargetForSessionMock.mockReturnValueOnce({ machineId: 'reachable-machine', basePath: '/base' });
        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'requested-machine',
            directory: '/requested-path',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
            preferRequestedMachineTarget: true,
        } as any);

        expect(result).toEqual({ type: 'success' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'requested-machine',
            method: 'spawn-happy-session',
            serverId: 'server-b',
            payload: expect.objectContaining({
                directory: '/requested-path',
            }),
        }));
    });

    it('uses an extended RPC timeout for resumeSession', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        } as any);

        expect(result.type).toBe('success');
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        const call = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any;
        expect(call).toMatchObject({ timeoutMs: expect.any(Number) });
        expect(call.timeoutMs).toBeGreaterThanOrEqual(90_000);
    });

    it('forwards preferScopedMachineRpc for resumeSession when requested', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
            preferScopedMachineRpc: true,
        } as any);

        expect(result).toEqual({ type: 'success', sessionId: 'sess-1' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            serverId: 'server-b',
            preferScoped: true,
        }));
    });

    it('maps socket ack timeouts to SESSION_WEBHOOK_TIMEOUT for resumeSession', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('operation has timed out'));
        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        } as any);

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected an error result');
        expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT);
        expect(typeof result.errorMessage).toBe('string');
        expect(result.errorMessage.length).toBeGreaterThan(0);
    });

    it('routes continue-with-replay through server-scoped machine rpc with requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-2' });
        const { continueSessionWithReplay } = await sessionsModulePromise;
        const summaryRunner = {
            v: 1,
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'default',
            permissionMode: 'no_tools',
        } as const;

        const result = await continueSessionWithReplay({
            machineId: 'machine-1',
            directory: '/tmp',
            agent: 'claude',
            approvedNewDirectoryCreation: true,
            replay: {
                previousSessionId: 'sess-prev',
                strategy: 'summary_plus_recent',
                recentMessagesCount: 2,
                maxSeedChars: 12_345,
                summaryRunner,
            },
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ type: 'success', sessionId: 'sess-2' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'session.continueWithReplay',
            serverId: 'server-b',
            payload: expect.objectContaining({
                replay: expect.objectContaining({ summaryRunner, maxSeedChars: 12_345 }),
            }),
        }));
    });

    it('routes session fork through server-scoped machine rpc with requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess-child' });
        const { forkSession } = await sessionsModulePromise;
        const replaySummaryRunner = {
            v: 1,
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'default',
            permissionMode: 'no_tools',
        } as const;

        const result = await forkSession({
            machineId: 'machine-1',
            parentSessionId: 'sess-parent',
            forkPoint: { type: 'seq', upToSeqInclusive: 12 },
            replaySummaryRunner,
            replayMaxSeedChars: 55_000,
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ ok: true, childSessionId: 'sess-child' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'session.fork',
            serverId: 'server-b',
            payload: expect.objectContaining({ replaySummaryRunner, replayMaxSeedChars: 55_000 }),
        }));
    });

    it('prefers reachable machine target from parent session for forkSession', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess-child' });
        readMachineTargetForSessionMock.mockReturnValueOnce({ machineId: 'reachable-machine', basePath: '/tmp' });
        const { forkSession } = await sessionsModulePromise;
        const result = await forkSession({
            machineId: 'stale-machine',
            parentSessionId: 'sess-parent',
            forkPoint: { type: 'latest' },
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ ok: true, childSessionId: 'sess-child' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'reachable-machine',
            method: 'session.fork',
            serverId: 'server-b',
        }));
    });

    it('maps RPC method-not-available to DAEMON_RPC_UNAVAILABLE for forkSession', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        const { forkSession } = await sessionsModulePromise;
        const result = await forkSession({
            machineId: 'machine-1',
            parentSessionId: 'sess-parent',
            forkPoint: { type: 'latest' },
            serverId: 'server-b',
        } as any);

        expect(result.ok).toBe(false);
        expect((result as any).errorCode).toBe('DAEMON_RPC_UNAVAILABLE');
    });

    it('maps RPC method-not-available to DAEMON_RPC_UNAVAILABLE for resumeSession', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        } as any);

        expect(result.type).toBe('error');
        expect((result as any).errorCode).toBe('DAEMON_RPC_UNAVAILABLE');
    });

    it('maps RPC method-not-available to DAEMON_RPC_UNAVAILABLE for continueSessionWithReplay', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        const { continueSessionWithReplay } = await sessionsModulePromise;
        const result = await continueSessionWithReplay({
            machineId: 'machine-1',
            directory: '/tmp',
            agent: 'claude',
            approvedNewDirectoryCreation: true,
            replay: { previousSessionId: 'sess-prev' },
            serverId: 'server-b',
        } as any);

        expect(result.type).toBe('error');
        expect((result as any).errorCode).toBe('DAEMON_RPC_UNAVAILABLE');
    });
});
