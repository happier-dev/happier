import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { SessionModelSelectionV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const sessionRpcWithServerAccountScopeMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const prepareAccountSettingsForDaemonSpawnIfNeededMock = vi.hoisted(() => vi.fn(async () => ({})));
const apiRequestMock = vi.hoisted(() => vi.fn());
const readAgentScopedPluginSettingsSnapshotMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@/agents/registry/agentScopedPluginSettings', () => ({
    readAgentScopedPluginSettingsSnapshot: readAgentScopedPluginSettingsSnapshotMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: sessionRpcWithServerScopeMock,
    sessionRpcWithServerAccountScope: sessionRpcWithServerAccountScopeMock,
}));

vi.mock('./sessionMachineTarget', async () => {
    const actual = await vi.importActual<typeof import('./sessionMachineTarget')>('./sessionMachineTarget');
    return {
        ...actual,
        readMachineTargetForSession: readMachineTargetForSessionMock,
        readMachineControlTargetForSession: readMachineTargetForSessionMock,
    };
});

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        request: apiRequestMock,
        machineRPC: vi.fn(),
        sessionRPC: vi.fn(),
    },
}));

vi.mock('./accountSettingsDaemonSpawnPreparation', async (importOriginal) => ({
    ...await importOriginal<typeof import('./accountSettingsDaemonSpawnPreparation')>(),
    prepareAccountSettingsForDaemonSpawnIfNeeded: prepareAccountSettingsForDaemonSpawnIfNeededMock,
    registerAccountSettingsDaemonSpawnPreparation: vi.fn(() => vi.fn()),
}));

const sessionsModulePromise = import('./sessions');

function makeResponse(opts: Readonly<{ ok: boolean; status?: number; json?: unknown; text?: string }>): Response {
    return {
        ok: opts.ok,
        status: opts.status ?? (opts.ok ? 200 : 500),
        json: async () => opts.json ?? {},
        text: async () => opts.text ?? '',
    } as Response;
}

describe('sessions ops server-scoped routing', () => {
    const initialStorageState = storage.getInitialState();
    const providerModelSelection = SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: 1,
        ref: {
            agentTargetKey: 'agent:happier.agent.claude/claude',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
        },
    });
    const nativeModelSelection = SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: 1,
        ref: {
            agentTargetKey: 'agent:happier.agent.claude/claude',
            providerConnectionId: null,
            modelId: 'native-model',
        },
    });

    beforeEach(() => {
        storage.setState({
            ...initialStorageState,
            sessions: {
                ...initialStorageState.sessions,
                'session-1': createSessionFixture({ id: 'session-1' }),
                'session-success': createSessionFixture({ id: 'session-success' }),
                'session-native': createSessionFixture({ id: 'session-native' }),
                'sess-parent': createSessionFixture({ id: 'sess-parent' }),
            },
        }, true);
        machineRpcWithServerScopeMock.mockReset();
        sessionRpcWithServerScopeMock.mockReset();
        sessionRpcWithServerAccountScopeMock.mockReset();
        readMachineTargetForSessionMock.mockReset();
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockReset();
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockResolvedValue({});
        readMachineTargetForSessionMock.mockReturnValue(null);
        apiRequestMock.mockReset();
        readAgentScopedPluginSettingsSnapshotMock.mockReset();
        readAgentScopedPluginSettingsSnapshotMock.mockResolvedValue(null);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('restores an archived session before issuing its resume spawn', async () => {
        const lifecycle: string[] = [];
        storage.setState((state) => ({
            sessions: {
                ...state.sessions,
                'session-1': createSessionFixture({ id: 'session-1', archivedAt: 123 }),
            },
        }));
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `header.${btoa(JSON.stringify({ sub: 'resume-account' }))}.signature`,
        });
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const isUnarchive = String(input).endsWith('/v2/sessions/session-1/unarchive');
            if (isUnarchive) lifecycle.push('unarchive');
            return new Response(JSON.stringify(isUnarchive
                ? { success: true, archivedAt: null }
                : createRootLayoutFeaturesResponse()), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        machineRpcWithServerScopeMock.mockImplementationOnce(async () => {
            lifecycle.push('resume');
            return { type: 'success', sessionId: 'session-1' };
        });
        const { resumeSession } = await sessionsModulePromise;

        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        });

        expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v2/sessions/session-1/unarchive'), expect.objectContaining({ method: 'POST' }));
        expect(lifecycle).toEqual(['unarchive', 'resume']);
    });

    it('does not issue a resume spawn when restoring an archived session fails', async () => {
        storage.setState((state) => ({
            sessions: {
                ...state.sessions,
                'session-1': createSessionFixture({ id: 'session-1', archivedAt: 123 }),
            },
        }));
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `header.${btoa(JSON.stringify({ sub: 'resume-account' }))}.signature`,
        });
        const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/v2/sessions/session-1/unarchive')
            ? new Response('Forbidden', { status: 403 })
            : new Response(JSON.stringify(createRootLayoutFeaturesResponse()), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const { resumeSession } = await sessionsModulePromise;

        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        });

        expect(result).toMatchObject({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'Forbidden',
        });
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v2/sessions/session-1/unarchive'), expect.objectContaining({ method: 'POST' }));
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('does not unarchive an already-unarchived session before resuming it', async () => {
        storage.setState((state) => ({
            sessions: {
                ...state.sessions,
                'session-1': createSessionFixture({ id: 'session-1', archivedAt: null }),
            },
        }));
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });
        const { resumeSession } = await sessionsModulePromise;

        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        });

        expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(apiRequestMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('waits for nonce-correlated runtime readiness before completing a guarded resume', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                type: 'success',
                sessionId: 'session-1',
                spawnNonce: 'execution-run-host-op-1',
                sessionIdStatus: 'pending',
            })
            .mockResolvedValueOnce({ status: 'success', sessionId: 'session-1' });
        const { resumeSession } = await sessionsModulePromise;

        await expect(resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            spawnNonce: 'execution-run-host-op-1',
            waitForReady: true,
        })).resolves.toEqual({ type: 'success', sessionId: 'session-1' });

        expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload).toMatchObject({
            type: 'resume-session',
            sessionId: 'session-1',
            spawnNonce: 'execution-run-host-op-1',
        });
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]).toMatchObject({
            method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
            payload: { spawnNonce: 'execution-run-host-op-1' },
        });
    });

    it('uses one current-only Provider-safe RPC so an older daemon refuses resume before side effects', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );
        const markSessionResumingSpy = vi.spyOn(storage.getState(), 'markSessionResuming');
        const clearSessionResumingSpy = vi.spyOn(storage.getState(), 'clearSessionResuming');
        try {
            const { resumeSession } = await sessionsModulePromise;
            const result = await resumeSession({
                sessionId: 'session-provider',
                machineId: 'machine-1',
                directory: '/tmp',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                modelSelection: providerModelSelection,
                serverId: 'server-b',
            });

            expect(result).toMatchObject({ type: 'error' });
            expect(markSessionResumingSpy).toHaveBeenCalledWith('session-provider');
            expect(clearSessionResumingSpy).toHaveBeenCalledWith('session-provider');
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
                method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
                serverId: 'server-b',
            }));
        } finally {
            markSessionResumingSpy.mockRestore();
            clearSessionResumingSpy.mockRestore();
        }
    });

    it('maps a missing current-only daemon method to Provider resume unavailability', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not found'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );

        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelSelection: providerModelSelection,
            serverId: 'server-b',
        });

        expect(result).toMatchObject({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        });
        expect(storage.getState().sessions['session-1']?.resumingAt).toBeNull();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
            serverId: 'server-b',
        }));
    });

    it.each([
        ['no model selection', undefined],
        ['a native model selection', nativeModelSelection],
    ])('uses the legacy-compatible resume RPC for %s', async (_label, modelSelection) => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-native' });

        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-native',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            ...(modelSelection ? { modelSelection } : {}),
            serverId: 'server-b',
        });

        expect(result).toMatchObject({ type: 'success', sessionId: 'session-native' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
        }));
    });

    it('fails closed when an existing-session resume has no hydrated metadata to prove native intent', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-not-hydrated',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        });

        expect(result).toMatchObject({ type: 'error' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        }));
    });

    it('resumes a Provider-bound session through the atomic Provider-safe RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-provider' });

        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-provider',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelSelection: providerModelSelection,
            serverId: 'server-b',
            preferScopedMachineRpc: true,
        });

        expect(result).toMatchObject({ type: 'success', sessionId: 'session-provider' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
            serverId: 'server-b',
            preferScoped: true,
        }));
    });

    it('refuses an implicit Provider-bound resume from persisted binding metadata', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'session-provider': createSessionFixture({
                    id: 'session-provider',
                    metadata: MetadataSchema.parse({
                        path: '/tmp',
                        host: 'machine-1',
                        machineId: 'machine-1',
                        providerBindingV1: {
                            v: 1,
                            connectionId: 'pc_work',
                            contributionKey: 'plugin/p',
                            connectionRevision: 1,
                            protocol: 'openai-responses',
                            materialization: 'engineConfig',
                            adapterBindingKey: 'p_pc_work',
                            compatibilityFingerprint: 'compatibility:v1:work',
                            bindingSecurityFingerprint: 'binding-security:v1:work',
                            displaySnapshot: {
                                providerName: 'Provider',
                                connectionName: 'Work',
                                connectionRole: 'named',
                                connectionDisplayNameMode: 'custom',
                            },
                        },
                    }),
                }),
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { resumeSession } = await sessionsModulePromise;
        const result = await resumeSession({
            sessionId: 'session-provider',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        });

        expect(result).toMatchObject({ type: 'error' });
        expect(storage.getState().sessions['session-provider']?.resumingAt).toBeNull();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        }));
    });

    it('does not probe for an implicit persisted native model selection on resume', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'session-native': createSessionFixture({
                    id: 'session-native',
                    metadata: MetadataSchema.parse({
                        path: '/tmp',
                        host: 'machine-1',
                        machineId: 'machine-1',
                        modelSelectionIntentV1: {
                            v: 1,
                            updatedAt: 1,
                            selection: nativeModelSelection.ref,
                        },
                    }),
                }),
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-native' });

        const { resumeSession } = await sessionsModulePromise;
        await expect(resumeSession({
            sessionId: 'session-native',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        })).resolves.toMatchObject({ type: 'success', sessionId: 'session-native' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
        }));
    });

    it('keeps a persisted Provider binding fail-closed when resume explicitly selects a native model', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'session-provider': createSessionFixture({
                    id: 'session-provider',
                    metadata: MetadataSchema.parse({
                        path: '/tmp',
                        host: 'machine-1',
                        providerBindingV1: {
                            v: 1,
                            connectionId: 'pc_work',
                            contributionKey: 'plugin/p',
                            connectionRevision: 1,
                            protocol: 'openai-responses',
                            materialization: 'engineConfig',
                            adapterBindingKey: 'p_pc_work',
                            compatibilityFingerprint: 'compatibility:v1:work',
                            bindingSecurityFingerprint: 'binding-security:v1:work',
                            displaySnapshot: {
                                providerName: 'Provider',
                                connectionName: 'Work',
                                connectionRole: 'named',
                                connectionDisplayNameMode: 'custom',
                            },
                        },
                    }),
                }),
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { resumeSession } = await sessionsModulePromise;
        await expect(resumeSession({
            sessionId: 'session-provider',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelSelection: nativeModelSelection,
            serverId: 'server-b',
        })).resolves.toMatchObject({ type: 'error' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        }));
    });

    it('treats malformed-but-present persisted Provider binding metadata as requiring proof', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'session-malformed-binding': createSessionFixture({
                    id: 'session-malformed-binding',
                    metadata: MetadataSchema.parse({
                        path: '/tmp',
                        host: 'machine-1',
                        providerBindingV1: { v: 1, connectionId: 'pc_work' },
                    }),
                }),
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { resumeSession } = await sessionsModulePromise;
        await expect(resumeSession({
            sessionId: 'session-malformed-binding',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        })).resolves.toMatchObject({ type: 'error' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        }));
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

    it('checks an active session runtime without presenting the session as resuming', async () => {
        storage.setState((state) => ({
            sessions: {
                ...state.sessions,
                'session-1': createSessionFixture({ id: 'session-1', active: true }),
            },
        }));
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });
        const markSessionResumingSpy = vi.spyOn(storage.getState(), 'markSessionResuming');
        const armSessionResumingFallbackSpy = vi.spyOn(storage.getState(), 'armSessionResumingFallback');
        const clearSessionResumingSpy = vi.spyOn(storage.getState(), 'clearSessionResuming');
        try {
            const { ensureSessionRuntimeForPendingInput } = await sessionsModulePromise;

            const result = await ensureSessionRuntimeForPendingInput({
                sessionId: 'session-1',
                machineId: 'machine-1',
                directory: '/tmp',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            });

            expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
            expect(markSessionResumingSpy).not.toHaveBeenCalled();
            expect(armSessionResumingFallbackSpy).not.toHaveBeenCalled();
            expect(clearSessionResumingSpy).not.toHaveBeenCalled();
        } finally {
            markSessionResumingSpy.mockRestore();
            armSessionResumingFallbackSpy.mockRestore();
            clearSessionResumingSpy.mockRestore();
        }
    });

    it('fences an exact Account runtime ensure and never consults the same-id active Session owner', async () => {
        let current = true;
        const retireListeners = new Set<() => void>();
        const accountLifetime = {
            scope: { serverId: 'server-b', accountId: 'account-b' },
            isCurrent: () => current,
            onRetire: (listener: () => void) => {
                retireListeners.add(listener);
                return { dispose: () => retireListeners.delete(listener) };
            },
        };
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-a', basePath: '/home-a' });
        machineRpcWithServerScopeMock.mockImplementationOnce(async (params) => {
            current = false;
            for (const listener of retireListeners) listener();
            params.onIssued?.();
            return { type: 'success', sessionId: 'session-1' };
        });
        const markSessionResumingSpy = vi.spyOn(storage.getState(), 'markSessionResuming');
        try {
            const { ensureSessionRuntimeForPendingInput } = await sessionsModulePromise;

            await expect(ensureSessionRuntimeForPendingInput({
                sessionId: 'session-1',
                machineId: 'machine-b',
                directory: '/home-b',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                serverId: 'server-b',
                accountLifetime,
            })).resolves.toMatchObject({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            });

            expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
                machineId: 'machine-b',
                serverId: 'server-b',
                accountId: 'account-b',
                preferScoped: true,
                signal: expect.any(AbortSignal),
                onIssued: expect.any(Function),
            }));
            expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
            expect(prepareAccountSettingsForDaemonSpawnIfNeededMock).not.toHaveBeenCalled();
            expect(markSessionResumingSpy).not.toHaveBeenCalled();
        } finally {
            markSessionResumingSpy.mockRestore();
        }
    });

    it('uses the captured exact Account scope for a control switch and rejects replacement before issuance', async () => {
        let current = true;
        const accountLifetime = {
            scope: { serverId: 'server-b', accountId: 'account-b' },
            isCurrent: () => current,
            onRetire: () => ({ dispose() {} }),
        };
        sessionRpcWithServerAccountScopeMock.mockImplementationOnce(async (params) => {
            current = false;
            params.onIssued?.();
            return true;
        });
        const { sessionSwitch } = await sessionsModulePromise;

        await expect(sessionSwitch('session-1', 'remote', {
            serverId: 'server-b',
            accountLifetime,
        })).rejects.toMatchObject({ code: 'session_account_scope_retired' });

        expect(sessionRpcWithServerAccountScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            scope: accountLifetime.scope,
            method: 'switch',
            onIssued: expect.any(Function),
        }));
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('presents a runtime ensure as resuming when the session is known inactive', async () => {
        storage.setState((state) => ({
            sessions: {
                ...state.sessions,
                'session-1': createSessionFixture({ id: 'session-1', active: false }),
            },
        }));
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });
        const markSessionResumingSpy = vi.spyOn(storage.getState(), 'markSessionResuming');
        const armSessionResumingFallbackSpy = vi.spyOn(storage.getState(), 'armSessionResumingFallback');
        try {
            const { ensureSessionRuntimeForPendingInput } = await sessionsModulePromise;

            const result = await ensureSessionRuntimeForPendingInput({
                sessionId: 'session-1',
                machineId: 'machine-1',
                directory: '/tmp',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            });

            expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
            expect(markSessionResumingSpy).toHaveBeenCalledWith('session-1');
            expect(armSessionResumingFallbackSpy).toHaveBeenCalledWith('session-1');
        } finally {
            markSessionResumingSpy.mockRestore();
            armSessionResumingFallbackSpy.mockRestore();
        }
    });

    it('owns the resume lifecycle marker across successful spawn and clears it on eager validation failure', async () => {
        const markSessionResumingSpy = vi.spyOn(storage.getState(), 'markSessionResuming');
        const armSessionResumingFallbackSpy = vi.spyOn(storage.getState(), 'armSessionResumingFallback');
        const clearSessionResumingSpy = vi.spyOn(storage.getState(), 'clearSessionResuming');
        try {
            machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
            const { resumeSession } = await sessionsModulePromise;

            const success = await resumeSession({
                sessionId: 'session-success',
                machineId: 'machine-1',
                directory: '/tmp',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                serverId: 'server-b',
            } as any);

            expect(success.type).toBe('success');
            expect(markSessionResumingSpy).toHaveBeenCalledWith('session-success');
            expect(armSessionResumingFallbackSpy).toHaveBeenCalledWith('session-success');
            expect(clearSessionResumingSpy).not.toHaveBeenCalledWith('session-success');

            const invalid = await resumeSession({
                sessionId: 'session-invalid',
                machineId: '',
                directory: '',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                serverId: 'server-b',
            } as any);

            expect(invalid.type).toBe('error');
            expect(markSessionResumingSpy).toHaveBeenCalledWith('session-invalid');
            expect(armSessionResumingFallbackSpy).not.toHaveBeenCalledWith('session-invalid');
            expect(clearSessionResumingSpy).toHaveBeenCalledWith('session-invalid');
        } finally {
            markSessionResumingSpy.mockRestore();
            armSessionResumingFallbackSpy.mockRestore();
            clearSessionResumingSpy.mockRestore();
        }
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

    it('includes prepared account settings version hints in resume spawn requests', async () => {
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockResolvedValueOnce({ accountSettingsVersionHint: 23 });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                accountSettingsVersionHint: 23,
            }),
        }));
    });

    it('does not resume-spawn when account settings scope changes during preparation', async () => {
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockRejectedValueOnce(
            new Error('Account settings scope changed while preparing session spawn'),
        );
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
        expect(result.errorCode).toBe('ACCOUNT_SCOPE_CHANGED');
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
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

    it('passes connectedServices and freshness through resumeSession when requested', async () => {
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
            connectedServicesUpdatedAt: 3456,
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                connectedServices: expect.any(Object),
                connectedServicesUpdatedAt: 3456,
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

   it('passes the canonical Agent target through resumeSession', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await sessionsModulePromise;
        await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'example.external', localId: 'reviewer' },
            },
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'example.external', localId: 'reviewer' },
                },
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
            backendTarget: {
                kind: 'backend',
                backendId: 'custom-kiro',
                configuredBackendId: 'custom-kiro',
                sourceKind: 'configured',
            },
            serverId: 'server-b',
        } as any);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro',
                    configuredBackendId: 'custom-kiro',
                    sourceKind: 'configured',
                },
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

   it('omits fork requestId for older daemons and preserves it for the first supporting daemon', async () => {
        const setDaemonVersion = (version: string) => {
            storage.setState((state) => ({
                profileScope: { serverId: 'server-a', accountId: 'account-a' },
                machines: {
                    ...state.machines,
                    'machine-1': { id: 'machine-1', daemonState: { cliVersion: version } } as any,
                },
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-b': [{ id: 'machine-1', daemonState: { cliVersion: version } } as any],
                },
            }));
        };
        const { forkSession } = await sessionsModulePromise;

        setDaemonVersion('0.2.0');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, childSessionId: 'child-old' });
        await forkSession({
            machineId: 'machine-1',
            parentSessionId: 'sess-parent',
            forkPoint: { type: 'latest' },
            serverId: 'server-b',
            requestId: 'retryable-replay-attempt',
        });
        expect((machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any).payload)
            .not.toHaveProperty('requestId');

        setDaemonVersion('0.2.10-dev.41');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, childSessionId: 'child-new' });
        await forkSession({
            machineId: 'machine-1',
            parentSessionId: 'sess-parent',
            forkPoint: { type: 'latest' },
            serverId: 'server-b',
            requestId: 'retryable-replay-attempt',
        });
        expect((machineRpcWithServerScopeMock.mock.calls[1]?.[0] as any).payload)
            .toHaveProperty('requestId', 'retryable-replay-attempt');
    });

    it('uses one current-only Provider-safe RPC so an older daemon refuses fork before side effects', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'sess-parent-provider': createSessionFixture({
                    id: 'sess-parent-provider',
                    metadata: MetadataSchema.parse({
                        path: '/tmp',
                        host: 'machine-1',
                        machineId: 'machine-1',
                        providerBindingV1: {
                            v: 1,
                            connectionId: 'pc_work',
                            contributionKey: 'plugin/p',
                            connectionRevision: 1,
                            protocol: 'openai-responses',
                            materialization: 'engineConfig',
                            adapterBindingKey: 'p_pc_work',
                            compatibilityFingerprint: 'compatibility:v1:work',
                            bindingSecurityFingerprint: 'binding-security:v1:work',
                            displaySnapshot: {
                                providerName: 'Provider',
                                connectionName: 'Work',
                                connectionRole: 'named',
                                connectionDisplayNameMode: 'custom',
                            },
                        },
                    }),
                }),
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { forkSession } = await sessionsModulePromise;
        const result = await forkSession({
            machineId: 'machine-1',
            parentSessionId: 'sess-parent-provider',
            forkPoint: { type: 'seq', upToSeqInclusive: 12 },
            serverId: 'server-b',
        });

        expect(result).toMatchObject({ ok: false });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            method: RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
            serverId: 'server-b',
            onIssued: expect.any(Function),
        }));
    });

    it('maps a missing current-only daemon method to Provider fork unavailability', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'sess-parent-provider': createSessionFixture({
                    id: 'sess-parent-provider',
                    metadata: MetadataSchema.parse({
                        path: '/tmp',
                        host: 'machine-1',
                        machineId: 'machine-1',
                        modelSelectionIntentV1: {
                            v: 1,
                            updatedAt: 1,
                            selection: providerModelSelection.ref,
                        },
                    }),
                }),
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not found'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );

        const { forkSession } = await sessionsModulePromise;
        const result = await forkSession({
            machineId: 'machine-1',
            parentSessionId: 'sess-parent-provider',
            forkPoint: { type: 'latest' },
            serverId: 'server-b',
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
            serverId: 'server-b',
        }));
    });

    it('routes checkpoint code rollback through session-scoped RPC with requested server id', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'applied',
            changedPaths: ['tracked.txt'],
            skippedPaths: [],
            receipts: ['checkpoint.rollback_applied'],
            diagnostics: [],
        });
        const { rollbackSessionCheckpointCode } = await sessionsModulePromise;
        const request = {
            v: 1,
            sessionId: 'sess-parent',
            turnId: 'turn-1',
            cwd: '/repo',
            codeMode: 'conversation_and_code_without_stash',
            backupMode: 'happier_checkpoint_only',
            expectedStartRef: 'refs/happier/checkpoints/c2Vzcy1wYXJlbnQ/turn-start/turn-1',
            expectedFinalRef: 'refs/happier/checkpoints/c2Vzcy1wYXJlbnQ/turn-final/turn-1',
        } as const;

        const result = await rollbackSessionCheckpointCode({
            request,
            serverId: 'server-b',
        });

        expect(result.status).toBe('applied');
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-parent',
            serverId: 'server-b',
            method: 'session.checkpointCodeRollback',
            payload: request,
        }));
    });

    it('resumes an inactive session before retrying an exact rollback until the host RPC is registered', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'sess-inactive-grok': createSessionFixture({
                    id: 'sess-inactive-grok',
                    active: false,
                    seq: 9,
                    metadata: MetadataSchema.parse({
                        path: '/tmp/project',
                        host: 'machine-1',
                        machineId: 'machine-1',
                        flavor: 'grok',
                        grokSessionId: 'grok-session-1',
                    }),
                }),
            },
        });
        readMachineTargetForSessionMock.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/tmp/project',
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            type: 'success',
            sessionId: 'sess-inactive-grok',
        });
        sessionRpcWithServerScopeMock
            .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }))
            .mockResolvedValueOnce({
                ok: false,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                errorMessage: 'Runtime rollback facet is still starting',
            })
            .mockResolvedValueOnce({
                ok: true,
                target: { type: 'before_user_message', userMessageSeq: 7 },
            });

        const { rollbackSessionConversation } = await sessionsModulePromise;
        const result = await rollbackSessionConversation({
            sessionId: 'sess-inactive-grok',
            serverId: 'server-b',
            target: { type: 'before_user_message', userMessageSeq: 7 },
        });

        expect(result).toEqual({
            ok: true,
            target: { type: 'before_user_message', userMessageSeq: 7 },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-b',
            payload: expect.objectContaining({
                type: 'resume-session',
                sessionId: 'sess-inactive-grok',
                directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'grok', sourceKind: 'built_in' },
                resume: 'grok-session-1',
                initialTranscriptAfterSeq: 9,
            }),
        }));
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledTimes(3);
        expect(readAgentScopedPluginSettingsSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({
            agentId: expect.any(String),
            machineId: 'machine-1',
            serverId: 'server-b',
        }));
        expect(sessionRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            sessionId: 'sess-inactive-grok',
            serverId: 'server-b',
            method: 'session.rollback',
            payload: {
                v: 1,
                target: { type: 'before_user_message', userMessageSeq: 7 },
            },
        }));
    });

    it('does not retry an exact rollback when transport failure leaves the outcome unknown', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'sess-inactive-grok': createSessionFixture({
                    id: 'sess-inactive-grok',
                    active: false,
                    seq: 9,
                    metadata: MetadataSchema.parse({
                        path: '/tmp/project',
                        host: 'machine-1',
                        machineId: 'machine-1',
                        flavor: 'grok',
                        grokSessionId: 'grok-session-1',
                    }),
                }),
            },
        });
        readMachineTargetForSessionMock.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/tmp/project',
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            type: 'success',
            sessionId: 'sess-inactive-grok',
        });
        const ambiguousFailure = new Error('Rollback acknowledgement timed out after dispatch');
        ambiguousFailure.name = 'ServerFetchWriteTimeoutError';
        sessionRpcWithServerScopeMock.mockRejectedValueOnce(ambiguousFailure);

        const { rollbackSessionConversation } = await sessionsModulePromise;
        const result = await rollbackSessionConversation({
            sessionId: 'sess-inactive-grok',
            serverId: 'server-b',
            target: { type: 'before_user_message', userMessageSeq: 7 },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: 'Rollback acknowledgement timed out after dispatch',
        });
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry an exact rollback after a parsed non-method runtime failure', async () => {
        storage.setState({
            sessions: {
                ...storage.getState().sessions,
                'sess-inactive-grok': createSessionFixture({
                    id: 'sess-inactive-grok',
                    active: false,
                    seq: 9,
                    metadata: MetadataSchema.parse({
                        path: '/tmp/project',
                        host: 'machine-1',
                        machineId: 'machine-1',
                        flavor: 'grok',
                        grokSessionId: 'grok-session-1',
                    }),
                }),
            },
        });
        readMachineTargetForSessionMock.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/tmp/project',
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            type: 'success',
            sessionId: 'sess-inactive-grok',
        });
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_runtime_failure',
            errorMessage: 'Provider rejected rollback',
        });

        const { rollbackSessionConversation } = await sessionsModulePromise;
        const result = await rollbackSessionConversation({
            sessionId: 'sess-inactive-grok',
            serverId: 'server-b',
            target: { type: 'before_user_message', userMessageSeq: 7 },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'provider_runtime_failure',
            errorMessage: 'Provider rejected rollback',
        });
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
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

});

describe('session resume and fork routing (real scoped transport)', () => {
    let boundary: Awaited<ReturnType<typeof import('@/dev/testkit/harness/sessionOpsNetworkBoundary').installSessionOpsNetworkBoundary>>;
    let realStorage: typeof import('@/sync/domains/state/storage').storage;
    let fixtures: typeof import('@/dev/testkit/fixtures/sessionFixtures');
    let machineFixtures: typeof import('@/dev/testkit/fixtures/machineFixtures');
    let metadata: typeof import('@happier-dev/session-core/state');

    beforeAll(async () => {
        vi.doUnmock('@/sync/domains/state/storage');
        vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId');
        vi.doUnmock('@/agents/registry/agentScopedPluginSettings');
        vi.doUnmock('./sessionMachineTarget');
        vi.doUnmock('./accountSettingsDaemonSpawnPreparation');
        vi.doUnmock('../api/session/apiSocket');
        vi.resetModules();
        const { installSessionOpsNetworkBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
        boundary = await installSessionOpsNetworkBoundary();
        realStorage = (await import('@/sync/domains/state/storage')).storage;
        fixtures = await import('@/dev/testkit/fixtures/sessionFixtures');
        machineFixtures = await import('@/dev/testkit/fixtures/machineFixtures');
        metadata = await import('@happier-dev/session-core/state');
    });

    beforeEach(() => {
        realStorage.setState(realStorage.getInitialState(), true);
        boundary.resetRequests();
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS', '');
        // Observe the ACK budget without elapsed wall time; network promises and timers stay real.
        vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
        for (const sessionId of Object.keys(realStorage.getState().sessions)) {
            realStorage.getState().clearSessionResuming(sessionId);
        }
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    afterAll(() => boundary?.dispose());

    async function installNativeSession(sessionId: string, serverId: string) {
        realStorage.setState({
            sessions: { [sessionId]: fixtures.createSessionFixture({
                id: sessionId, serverId,
                metadata: metadata.MetadataSchema.parse({ path: '/tmp', host: 'host.local', machineId: 'machine-1' }),
            }) },
            machines: { 'machine-1': machineFixtures.createMachineFixture() },
            machineListByServerId: { [serverId]: [machineFixtures.createMachineFixture()] },
        });
    }

    it('preserves the Agent-owned Codex runtime descriptor in the legacy-compatible resume RPC', async () => {
        const home = await boundary.addHome('https://resume-descriptor.example.test', 'descriptor-account');
        await installNativeSession('session-1', home.id);
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'success', sessionId: 'session-1' });
        const { resumeSession } = await import('./sessions');
        const runtimeDescriptorV1 = { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } as const;

        await expect(resumeSession({
            sessionId: 'session-1', machineId: 'machine-1', directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            runtimeDescriptorV1, serverId: home.id,
        })).resolves.toEqual({ type: 'success', sessionId: 'session-1' });

        expect(boundary.requests).toEqual([expect.objectContaining({
            serverUrl: home.serverUrl, token: home.token, targetId: 'machine-1',
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: {
                type: 'resume-session', sessionId: 'session-1', directory: '/tmp',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                runtimeDescriptorV1,
            },
        })]);
    });

    it('keeps the shared spawn operation budget through the resume RPC transport', async () => {
        const home = await boundary.addHome('https://resume-budget.example.test', 'budget-account');
        await installNativeSession('session-1', home.id);
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'success', sessionId: 'session-1' });
        const { resumeSession } = await import('./sessions');
        const { DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS } = await import('@happier-dev/protocol');
        const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');

        await expect(resumeSession({
            sessionId: 'session-1', machineId: 'machine-1', directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, serverId: home.id,
        })).resolves.toEqual({ type: 'success', sessionId: 'session-1' });

        expect(boundary.requests).toEqual([expect.objectContaining({
            serverUrl: home.serverUrl, token: home.token, method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            timeoutMs: DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS + DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
        })]);
    });

    it('routes session fork through server-scoped machine rpc with requested server id', async () => {
        const home = await boundary.addHome('https://fork-requested.example.test', 'fork-account');
        await installNativeSession('sess-parent', home.id);
        boundary.respond(RPC_METHODS.SESSION_FORK, { ok: true, childSessionId: 'sess-child' });
        const { forkSession } = await import('./sessions');
        const { DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS } = await import('@happier-dev/protocol');
        const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');
        const replaySummaryRunner = {
            v: 1, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'default', permissionMode: 'no_tools',
        } as const;

        await expect(forkSession({
            machineId: 'machine-1', parentSessionId: 'sess-parent',
            forkPoint: { type: 'seq', upToSeqInclusive: 12 },
            replaySummaryRunner, replayMaxSeedChars: 55_000, serverId: home.id,
        })).resolves.toEqual({ ok: true, childSessionId: 'sess-child' });

        expect(boundary.requests).toEqual([expect.objectContaining({
            serverUrl: home.serverUrl, token: home.token, targetId: 'machine-1', method: RPC_METHODS.SESSION_FORK,
            timeoutMs: DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS + DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
            payload: expect.objectContaining({
                parentSessionId: 'sess-parent', forkPoint: { type: 'seq', upToSeqInclusive: 12 },
                replaySummaryRunner, replayMaxSeedChars: 55_000,
            }),
        })]);
    });

    it('denies an exact Account resume before issuing RPC with another Account credential', async () => {
        const home = await boundary.addHome('https://resume-account.example.test', 'replacement-account');
        const { ensureSessionRuntimeForPendingInput } = await import('./sessions');
        const accountLifetime = {
            scope: { serverId: home.id, accountId: 'incumbent-account' },
            isCurrent: () => true,
            onRetire: () => ({ dispose() {} }),
        };

        await expect(ensureSessionRuntimeForPendingInput({
            sessionId: 'session-1', machineId: 'machine-1', directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            serverId: home.id, accountLifetime,
        })).resolves.toMatchObject({
            type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: expect.stringContaining(accountLifetime.scope.accountId),
        });
        expect(boundary.credentialRequests).toEqual([{ serverUrl: home.serverUrl, serverId: home.id }]);
        expect(boundary.requests).toEqual([]);
        expect(boundary.httpRequests).toEqual([]);
    });
});
