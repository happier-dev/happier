import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionModelSelectionV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MetadataSchema } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const prepareAccountSettingsForDaemonSpawnIfNeededMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: sessionRpcWithServerScopeMock,
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

describe('sessions ops server-scoped routing', () => {
    const initialStorageState = storage.getInitialState();
    const providerModelSelection = SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: 1,
        ref: {
            agentTargetKey: 'backend:claude',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
        },
    });
    const nativeModelSelection = SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: 1,
        ref: {
            agentTargetKey: 'backend:claude',
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
        readMachineTargetForSessionMock.mockReset();
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockReset();
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockResolvedValue({});
        readMachineTargetForSessionMock.mockReturnValue(null);
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

    it('owns the resume lifecycle marker across successful spawn and clears it on eager validation failure', async () => {
        const markSessionResumingSpy = vi.spyOn(storage.getState(), 'markSessionResuming');
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
            expect(clearSessionResumingSpy).toHaveBeenCalledWith('session-invalid');
        } finally {
            markSessionResumingSpy.mockRestore();
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
        expect(call.timeoutMs).toBe(5 * 60_000);
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
                agent: 'claude',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'claude',
                    sourceKind: 'built_in',
                },
                replay: expect.objectContaining({ summaryRunner, maxSeedChars: 12_345 }),
            }),
        }));
    });

    it('routes configured ACP continue-with-replay through server-scoped machine rpc with canonical backendTarget only', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-3' });
        const { continueSessionWithReplay } = await sessionsModulePromise;

        const result = await continueSessionWithReplay({
            machineId: 'machine-1',
            directory: '/tmp',
            agent: 'customAcp',
            backendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
                sourceKind: 'configured',
            },
            approvedNewDirectoryCreation: true,
            replay: {
                previousSessionId: 'sess-prev',
                strategy: 'recent_messages',
                recentMessagesCount: 2,
            },
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ type: 'success', sessionId: 'sess-3' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'session.continueWithReplay',
            serverId: 'server-b',
            payload: expect.objectContaining({
                backendTarget: {
                    kind: 'backend',
                    backendId: 'review-bot',
                    configuredBackendId: 'review-bot',
                    sourceKind: 'configured',
                },
            }),
        }));
        expect(machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            payload: expect.not.objectContaining({
                agent: 'customAcp',
            }),
        }));
    });

    it('prefers the replacement-aware previous session target for continue-with-replay', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-4' });
        readMachineTargetForSessionMock.mockReturnValueOnce({
            machineId: 'replacement-machine',
            basePath: '/replacement/worktree',
        });
        const { continueSessionWithReplay } = await sessionsModulePromise;

        const result = await continueSessionWithReplay({
            machineId: 'replaced-machine',
            directory: '/stale/worktree',
            agent: 'claude',
            replay: {
                previousSessionId: 'sess-prev',
            },
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ type: 'success', sessionId: 'sess-4' });
        expect(readMachineTargetForSessionMock).toHaveBeenCalledWith('sess-prev');
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'replacement-machine',
            method: 'session.continueWithReplay',
            serverId: 'server-b',
            payload: expect.objectContaining({
                directory: '/replacement/worktree',
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
            timeoutMs: 5 * 60_000,
            onIssued: expect.any(Function),
            payload: expect.objectContaining({ replaySummaryRunner, replayMaxSeedChars: 55_000 }),
        }));
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
