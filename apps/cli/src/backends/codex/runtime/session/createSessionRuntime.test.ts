import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { resolveSessionRollbackRuntimeFacet } from '@/agent/runtime/sessionLoop/sessionRollbackRpc';

const {
    createCodexAcpRuntimeMock,
    createCodexAppServerRuntimeMock,
    resolveCodexMcpServerSpawnMock,
    createCodexMcpClientMock,
} = vi.hoisted(() => ({
    createCodexAcpRuntimeMock: vi.fn(),
    createCodexAppServerRuntimeMock: vi.fn(),
    resolveCodexMcpServerSpawnMock: vi.fn(),
    createCodexMcpClientMock: vi.fn(),
}));

vi.mock('../../acp/runtime', () => ({
    createCodexAcpRuntime: (...args: unknown[]) => createCodexAcpRuntimeMock(...args),
}));

vi.mock('../../appServer/runtime', () => ({
    createCodexAppServerRuntime: (...args: unknown[]) => createCodexAppServerRuntimeMock(...args),
}));

vi.mock('../../mcp/resolveCodexMcpServerSpawn', () => ({
    resolveCodexMcpServerSpawn: (...args: unknown[]) => resolveCodexMcpServerSpawnMock(...args),
}));

vi.mock('../../mcp/sessionClient', () => ({
    CodexMcpClient: vi.fn().mockImplementation((...args: unknown[]) => createCodexMcpClientMock(...args)),
}));

import { createCodexSessionRuntime } from './createSessionRuntime';

beforeEach(() => {
    createCodexAcpRuntimeMock.mockReset();
    createCodexAppServerRuntimeMock.mockReset();
    resolveCodexMcpServerSpawnMock.mockReset();
    createCodexMcpClientMock.mockReset();
});

function requireCreateSessionRuntime(
    runtimePlan: ReturnType<typeof createCodexSessionRuntime>,
): NonNullable<ReturnType<typeof createCodexSessionRuntime>['config']['createSessionRuntime']> {
    if (!runtimePlan.config.createSessionRuntime) {
        throw new Error('expected createCodexSessionRuntime plan to expose createSessionRuntime');
    }
    return runtimePlan.config.createSessionRuntime;
}

function createFakeCodexAcpRuntime() {
    const startOrLoad = vi.fn(async (_options: { resumeId?: string | null; importHistory?: boolean } = {}) => 'acp-thread-1');
    const sendPrompt = vi.fn(async (_prompt: string) => undefined);
    const flushTurn = vi.fn(async () => undefined);
    const reset = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const setSessionMode = vi.fn(async (_modeId: string) => undefined);
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: string | number | boolean | null) => undefined);
    const setSessionModel = vi.fn(async (_modelId: string) => undefined);
    const steerPrompt = vi.fn(async (_prompt: string) => undefined);
    const runtime = {
        beginTurn: vi.fn(),
        startOrLoad,
        sendPrompt,
        flushTurn,
        reset,
        getSessionId: vi.fn(() => 'acp-thread-1'),
        cancel,
        setSessionMode,
        setSessionConfigOption,
        setSessionModel,
        supportsInFlightSteer: vi.fn(() => true),
        isTurnInFlight: vi.fn(() => false),
        steerPrompt,
        beginTurnLifecycle: vi.fn(() => undefined),
        startOrLoadSession: vi.fn(async (options?: { resumeId?: string | null; importHistory?: boolean }) => {
            await startOrLoad(options);
        }),
        sendTurnPrompt: vi.fn(async (prompt: string) => {
            await sendPrompt(prompt);
        }),
        steerInFlightTurn: vi.fn(async (prompt: string) => {
            await steerPrompt(prompt);
        }),
        waitForTurnCompletion: vi.fn(async () => {
            await flushTurn();
        }),
        subscribeRuntimeMessages: vi.fn(() => () => undefined),
        respondToPermission: vi.fn(async () => undefined),
        cancelTurn: vi.fn(async () => {
            await cancel();
        }),
        readSessionIdentity: vi.fn(() => ({
            sessionId: 'acp-thread-1',
        })),
        updateSessionRuntimeConfig: vi.fn(async (update: {
            modeId?: string | null;
            modelId?: string | null;
            configOption?: { id: string; value: string | number | boolean | null } | null;
        }) => {
            if (typeof update.modeId === 'string') {
                await setSessionMode(update.modeId);
            }
            if (typeof update.modelId === 'string') {
                await setSessionModel(update.modelId);
            }
            if (update.configOption) {
                await setSessionConfigOption(update.configOption.id, update.configOption.value);
            }
        }),
        resetOrDisposeRuntime: vi.fn(async () => {
            await reset();
        }),
        rollbackConversation: vi.fn(async () => ({
            ok: false as const,
            errorCode: 'unsupported_action',
            errorMessage: 'Session rollback is unavailable for Codex ACP sessions',
        })),
    };
    return runtime;
}

function createFakeCodexAppServerRuntime() {
    const startOrLoad = vi.fn(async (_options: { resumeId?: string; importHistory?: boolean; existingSessionId?: string } = {}) => undefined);
    const sendPrompt = vi.fn(async (_prompt: string) => undefined);
    const flushTurn = vi.fn(async () => undefined);
    const reset = vi.fn(async () => undefined);
    const getSessionId = vi.fn(() => 'thread-app-server');
    const cancel = vi.fn(async () => undefined);
    const setSessionMode = vi.fn(async (_modeId: string) => undefined);
    const setSessionConfigOption = vi.fn(async (_configId: string, _value: string | number | boolean | null) => undefined);
    const setSessionModel = vi.fn(async (_modelId: string) => undefined);
    const steerPrompt = vi.fn(async (_prompt: string) => undefined);
    const runtime = {
        beginTurn: vi.fn(),
        startOrLoad,
        sendPrompt,
        flushTurn,
        reset,
        getSessionId,
        cancel,
        setSessionMode,
        setSessionConfigOption,
        setSessionModel,
        shouldResumeAfterPermissionModeChange: vi.fn(() => false),
        supportsInFlightSteer: vi.fn(() => false),
        isTurnInFlight: vi.fn(() => false),
        steerPrompt,
        rollbackConversation: vi.fn(async () => ({
            ok: true as const,
            target: { type: 'latest_turn' as const },
            threadId: 'thread-app-server',
        })),
    };
    return {
        ...runtime,
        beginTurnLifecycle: () => {
            runtime.beginTurn();
        },
        startOrLoadSession: async (options?: { resumeId?: string | null; importHistory?: boolean }) => {
            await runtime.startOrLoad({
                ...(typeof options?.resumeId === 'string' ? { resumeId: options.resumeId } : {}),
                ...(typeof options?.importHistory === 'boolean' ? { importHistory: options.importHistory } : {}),
            });
        },
        sendTurnPrompt: async (prompt: string) => {
            await runtime.sendPrompt(prompt);
        },
        steerInFlightTurn: async (prompt: string) => {
            await runtime.steerPrompt(prompt);
        },
        waitForTurnCompletion: async () => {
            await runtime.flushTurn();
        },
        subscribeRuntimeMessages: () => () => undefined,
        respondToPermission: async () => undefined,
        cancelTurn: async () => {
            await runtime.cancel();
        },
        readSessionIdentity: () => ({
            sessionId: runtime.getSessionId(),
        }),
        updateSessionRuntimeConfig: async (update: {
            modeId?: string | null;
            modelId?: string | null;
            configOption?: { id: string; value: string | number | boolean | null } | null;
        }) => {
            if (typeof update.modeId === 'string') {
                await runtime.setSessionMode(update.modeId);
            }
            if (typeof update.modelId === 'string') {
                await runtime.setSessionModel(update.modelId);
            }
            if (update.configOption) {
                await runtime.setSessionConfigOption(update.configOption.id, update.configOption.value);
            }
        },
        resetOrDisposeRuntime: async () => {
            await runtime.reset();
        },
    };
}

function createFakeCodexMcpClient() {
    let activeSessionId: string | null = null;
    let handler: ((message: unknown) => void) | null = null;
    return {
        setPermissionHandler: vi.fn(),
        setHandler: vi.fn((nextHandler: (message: unknown) => void) => {
            handler = nextHandler;
        }),
        hasActiveSession: vi.fn(() => activeSessionId !== null),
        connect: vi.fn(async () => undefined),
        startSession: vi.fn(async () => {
            activeSessionId = 'mcp-thread-1';
            handler?.({ type: 'session.started' });
            return { ok: true };
        }),
        continueSession: vi.fn(async () => ({ ok: true })),
        getSessionId: vi.fn(() => activeSessionId),
        forceCloseSession: vi.fn(async () => {
            activeSessionId = null;
        }),
        clearSession: vi.fn(() => {
            activeSessionId = null;
        }),
    };
}

describe('createCodexSessionRuntime', () => {
    it('defaults to ACP when the Codex ACP experiment is enabled and no explicit mode is provided', async () => {
        const previousExperimentalCodexAcp = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
        process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';

        try {
            const nativeRuntime = createFakeCodexAcpRuntime();
            createCodexAcpRuntimeMock.mockReturnValue(nativeRuntime);

            const runtimePlan = createCodexSessionRuntime({
                credentials: { token: 't' },
                startedBy: 'terminal',
                directory: '/tmp/codex',
            });

            await requireCreateSessionRuntime(runtimePlan)({
                directory: '/tmp/codex',
                metadata: {
                    path: '/tmp/codex',
                    host: 'local',
                    homeDir: '/tmp/home',
                    happyHomeDir: '/tmp/happy-home',
                    happyLibDir: '/tmp/happy-lib',
                    happyToolsDir: '/tmp/happy-tools',
                } satisfies Metadata,
                machineId: 'machine-1',
                session: {
                    getMetadataSnapshot: () => null,
                } as any,
                transcriptSession: {} as any,
                messageBuffer: {} as any,
                mcpServers: {},
                permissionHandler: {} as any,
                getPermissionMode: () => 'default',
                setThinking: vi.fn(),
                memoryRecallGuidanceEnabled: false,
            });

            expect(createCodexAcpRuntimeMock).toHaveBeenCalledTimes(1);
            expect(createCodexAppServerRuntimeMock).not.toHaveBeenCalled();
        } finally {
            if (typeof previousExperimentalCodexAcp === 'string') {
                process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = previousExperimentalCodexAcp;
            } else {
                delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
            }
        }
    });

    it('keeps account-settings runtime mode ahead of ambient ACP env defaults', async () => {
        const previousExperimentalCodexAcp = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
        process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';

        try {
            const nativeRuntime = createFakeCodexAppServerRuntime();
            createCodexAppServerRuntimeMock.mockReturnValue(nativeRuntime);
            const runtimePlan = createCodexSessionRuntime({
                credentials: { token: 't' },
                startedBy: 'terminal',
                directory: '/tmp/codex',
                accountSettingsContext: {
                    settings: {
                        codexBackendMode: 'appServer',
                    },
                } as any,
            });

            expect(createCodexAcpRuntimeMock).not.toHaveBeenCalled();
            await requireCreateSessionRuntime(runtimePlan)({
                directory: '/tmp/codex',
                metadata: {
                    path: '/tmp/codex',
                    host: 'local',
                    homeDir: '/tmp/home',
                    happyHomeDir: '/tmp/happy-home',
                    happyLibDir: '/tmp/happy-lib',
                    happyToolsDir: '/tmp/happy-tools',
                } satisfies Metadata,
                machineId: 'machine-1',
                session: {
                    getMetadataSnapshot: () => null,
                } as any,
                transcriptSession: {} as any,
                messageBuffer: {} as any,
                mcpServers: {},
                permissionHandler: {} as any,
                getPermissionMode: () => 'default',
                setThinking: vi.fn(),
                memoryRecallGuidanceEnabled: false,
            });
            expect(createCodexAppServerRuntimeMock).toHaveBeenCalledTimes(1);
            expect(createCodexAcpRuntimeMock).not.toHaveBeenCalled();
        } finally {
            if (typeof previousExperimentalCodexAcp === 'string') {
                process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = previousExperimentalCodexAcp;
            } else {
                delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
            }
        }
    });

    it('returns a host-owned lifecycle plan instead of a self-running Codex wrapper', async () => {
        const runtime = createCodexSessionRuntime({
            credentials: { token: 't' },
            startedBy: 'terminal',
            directory: '/tmp/codex',
        });

        expect(runtime).toEqual(expect.objectContaining({
            kind: 'hostSessionRuntimePlan',
            providerId: 'codex',
            opts: expect.objectContaining({
                credentials: { token: 't' },
                startedBy: 'terminal',
                directory: '/tmp/codex',
            }),
            config: expect.objectContaining({
                agentMessageType: 'codex',
                createSessionRuntime: expect.any(Function),
            }),
        }));
        expect(runtime).not.toHaveProperty('run');
    });

    it('keeps the app-server rollback facet on the host-owned session plan runtime', async () => {
        const nativeRuntime = createFakeCodexAppServerRuntime();
        createCodexAppServerRuntimeMock.mockReturnValue(nativeRuntime);

        const runtimePlan = createCodexSessionRuntime({
            credentials: { token: 't' },
            startedBy: 'terminal',
            directory: '/tmp/codex',
            codexBackendMode: 'appServer',
        });

        const createdRuntime = await requireCreateSessionRuntime(runtimePlan)({
            directory: '/tmp/codex',
            metadata: {
                path: '/tmp/codex',
                host: 'local',
                homeDir: '/tmp/home',
                happyHomeDir: '/tmp/happy-home',
                happyLibDir: '/tmp/happy-lib',
                happyToolsDir: '/tmp/happy-tools',
            } satisfies Metadata,
            machineId: 'machine-1',
            session: {
                getMetadataSnapshot: () => null,
            } as any,
            transcriptSession: {} as any,
            messageBuffer: {} as any,
            mcpServers: {},
            permissionHandler: {} as any,
            getPermissionMode: () => 'default',
            setThinking: vi.fn(),
            memoryRecallGuidanceEnabled: false,
        });

        expect(createCodexAppServerRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/tmp/codex',
        }));
        expect(createdRuntime).toBeDefined();
        expect(createdRuntime && typeof createdRuntime === 'object' && 'operations' in createdRuntime && 'nativeRuntime' in createdRuntime).toBe(true);
        if (!createdRuntime || typeof createdRuntime !== 'object' || !('operations' in createdRuntime) || !('nativeRuntime' in createdRuntime)) {
            throw new Error('expected Codex app-server runtime plan to return wrapped operations + native runtime');
        }
        expect(createdRuntime.nativeRuntime).toBeDefined();
        expect(createdRuntime.operations).toEqual(expect.any(Object));
        expect(createdRuntime.nativeRuntime).toEqual(expect.objectContaining({
            rollbackConversation: nativeRuntime.rollbackConversation,
        }));

        const rollbackFacet = resolveSessionRollbackRuntimeFacet(createdRuntime.nativeRuntime ?? null);
        expect(rollbackFacet).not.toBeNull();
        await expect(rollbackFacet?.rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toEqual({
            ok: true,
            target: { type: 'latest_turn' },
            threadId: 'thread-app-server',
        });
        expect(nativeRuntime.rollbackConversation).toHaveBeenCalledWith({ v: 1, target: { type: 'latest_turn' } });
    });

    it('returns the ACP runtime itself as the RuntimeTurnOperations owner', async () => {
        const nativeRuntime = createFakeCodexAcpRuntime();
        createCodexAcpRuntimeMock.mockReturnValue(nativeRuntime);

        const runtimePlan = createCodexSessionRuntime({
            credentials: { token: 't' },
            startedBy: 'terminal',
            directory: '/tmp/codex',
            codexBackendMode: 'acp',
        });

        const createdRuntime = await requireCreateSessionRuntime(runtimePlan)({
            directory: '/tmp/codex',
            metadata: {
                path: '/tmp/codex',
                host: 'local',
                homeDir: '/tmp/home',
                happyHomeDir: '/tmp/happy-home',
                happyLibDir: '/tmp/happy-lib',
                happyToolsDir: '/tmp/happy-tools',
            } satisfies Metadata,
            machineId: 'machine-1',
            session: {
                sessionId: 'happy-session-1',
                getMetadataSnapshot: () => null,
            } as any,
            transcriptSession: {} as any,
            messageBuffer: {} as any,
            mcpServers: {},
            permissionHandler: {} as any,
            getPermissionMode: () => 'default',
            setThinking: vi.fn(),
            memoryRecallGuidanceEnabled: false,
        });

        if (!createdRuntime || typeof createdRuntime !== 'object' || !('operations' in createdRuntime) || !('nativeRuntime' in createdRuntime)) {
            throw new Error('expected Codex ACP runtime plan to return wrapped operations + native runtime');
        }

        expect(createdRuntime.operations).toBe(createdRuntime.nativeRuntime);
        expect(createdRuntime.operations).toBe(nativeRuntime);
        await createdRuntime.operations.startOrLoadSession({ resumeId: 'resume-1', importHistory: false });
        await createdRuntime.operations.sendTurnPrompt('hello');
        await createdRuntime.operations.steerInFlightTurn('steer');
        await createdRuntime.operations.waitForTurnCompletion();
        await createdRuntime.operations.updateSessionRuntimeConfig({
            modeId: 'plan',
            modelId: 'gpt-5.4',
            configOption: { id: 'effort', value: 'high' },
        });
        await createdRuntime.operations.cancelTurn();
        await createdRuntime.operations.resetOrDisposeRuntime();

        expect(nativeRuntime.startOrLoadSession).toHaveBeenCalledWith({ resumeId: 'resume-1', importHistory: false });
        expect(nativeRuntime.sendTurnPrompt).toHaveBeenCalledWith('hello');
        expect(nativeRuntime.steerInFlightTurn).toHaveBeenCalledWith('steer');
        expect(nativeRuntime.waitForTurnCompletion).toHaveBeenCalledTimes(1);
        expect(nativeRuntime.updateSessionRuntimeConfig).toHaveBeenCalledWith({
            modeId: 'plan',
            modelId: 'gpt-5.4',
            configOption: { id: 'effort', value: 'high' },
        });
        expect(nativeRuntime.cancelTurn).toHaveBeenCalledTimes(1);
        expect(nativeRuntime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    });

    it('returns the app-server runtime itself as the non-ACP RuntimeTurnOperations owner', async () => {
        const nativeRuntime = createFakeCodexAppServerRuntime();
        createCodexAppServerRuntimeMock.mockReturnValue(nativeRuntime);

        const runtimePlan = createCodexSessionRuntime({
            credentials: { token: 't' },
            startedBy: 'terminal',
            directory: '/tmp/codex',
            codexBackendMode: 'appServer',
        });

        const createdRuntime = await requireCreateSessionRuntime(runtimePlan)({
            directory: '/tmp/codex',
            metadata: {
                path: '/tmp/codex',
                host: 'local',
                homeDir: '/tmp/home',
                happyHomeDir: '/tmp/happy-home',
                happyLibDir: '/tmp/happy-lib',
                happyToolsDir: '/tmp/happy-tools',
            } satisfies Metadata,
            machineId: 'machine-1',
            session: {
                getMetadataSnapshot: () => null,
            } as any,
            transcriptSession: {} as any,
            messageBuffer: {} as any,
            mcpServers: {},
            permissionHandler: {} as any,
            getPermissionMode: () => 'default',
            setThinking: vi.fn(),
            memoryRecallGuidanceEnabled: false,
        });

        if (!createdRuntime || typeof createdRuntime !== 'object' || !('operations' in createdRuntime) || !('nativeRuntime' in createdRuntime)) {
            throw new Error('expected Codex app-server runtime plan to return wrapped operations + native runtime');
        }

        expect(createdRuntime.operations).toBe(createdRuntime.nativeRuntime);
        expect(typeof createdRuntime.operations.beginTurnLifecycle).toBe('function');
        expect(typeof createdRuntime.operations.startOrLoadSession).toBe('function');
        expect(typeof createdRuntime.operations.sendTurnPrompt).toBe('function');
        expect(typeof createdRuntime.operations.waitForTurnCompletion).toBe('function');
        expect(typeof createdRuntime.operations.updateSessionRuntimeConfig).toBe('function');
        expect(typeof createdRuntime.operations.readSessionIdentity).toBe('function');

        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.startOrLoadSession({ resumeId: 'resume-1' });
        await createdRuntime.operations.sendTurnPrompt('hello');
        await createdRuntime.operations.waitForTurnCompletion();
        await createdRuntime.operations.updateSessionRuntimeConfig({
            modeId: 'plan',
            modelId: 'gpt-5.4',
            configOption: { id: 'effort', value: 'high' },
        });
        expect(createdRuntime.operations.readSessionIdentity()).toEqual({ sessionId: 'thread-app-server' });
        await createdRuntime.operations.cancelTurn();
        await createdRuntime.operations.resetOrDisposeRuntime();

        expect(nativeRuntime.beginTurn).toHaveBeenCalledTimes(1);
        expect(nativeRuntime.startOrLoad).toHaveBeenCalledWith({ resumeId: 'resume-1' });
        expect(nativeRuntime.sendPrompt).toHaveBeenCalledWith('hello');
        expect(nativeRuntime.flushTurn).toHaveBeenCalledTimes(1);
        expect(nativeRuntime.setSessionMode).toHaveBeenCalledWith('plan');
        expect(nativeRuntime.setSessionModel).toHaveBeenCalledWith('gpt-5.4');
        expect(nativeRuntime.setSessionConfigOption).toHaveBeenCalledWith('effort', 'high');
        expect(nativeRuntime.cancel).toHaveBeenCalledTimes(1);
        expect(nativeRuntime.reset).toHaveBeenCalledTimes(1);
    });

    it('passes the requested directory to the Codex app-server runtime', async () => {
        const nativeRuntime = createFakeCodexAppServerRuntime();
        createCodexAppServerRuntimeMock.mockReturnValue(nativeRuntime);

        const runtimePlan = createCodexSessionRuntime({
            credentials: { token: 't' },
            startedBy: 'terminal',
            directory: '/tmp/original-codex-dir',
            codexBackendMode: 'appServer',
        });

        await requireCreateSessionRuntime(runtimePlan)({
            directory: '/tmp/requested-codex-dir',
            metadata: {
                path: '/tmp/metadata-codex-dir',
                host: 'local',
                homeDir: '/tmp/home',
                happyHomeDir: '/tmp/happy-home',
                happyLibDir: '/tmp/happy-lib',
                happyToolsDir: '/tmp/happy-tools',
            } satisfies Metadata,
            machineId: 'machine-1',
            session: {
                getMetadataSnapshot: () => null,
            } as any,
            transcriptSession: {} as any,
            messageBuffer: {} as any,
            mcpServers: {},
            permissionHandler: {} as any,
            getPermissionMode: () => 'default',
            setThinking: vi.fn(),
            memoryRecallGuidanceEnabled: false,
        });

        expect(createCodexAppServerRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/tmp/requested-codex-dir',
        }));
    });

    it('returns the MCP runtime itself as the non-ACP RuntimeTurnOperations owner', async () => {
        const fakeClient = createFakeCodexMcpClient();
        resolveCodexMcpServerSpawnMock.mockResolvedValue({
            mode: 'stdio',
            command: ['codex', 'mcp'],
        });
        createCodexMcpClientMock.mockReturnValue(fakeClient);

        const runtimePlan = createCodexSessionRuntime({
            credentials: { token: 't' },
            startedBy: 'terminal',
            directory: '/tmp/codex',
            codexBackendMode: 'mcp',
        });

        const createdRuntime = await requireCreateSessionRuntime(runtimePlan)({
            directory: '/tmp/codex',
            metadata: {
                path: '/tmp/codex',
                host: 'local',
                homeDir: '/tmp/home',
                happyHomeDir: '/tmp/happy-home',
                happyLibDir: '/tmp/happy-lib',
                happyToolsDir: '/tmp/happy-tools',
            } satisfies Metadata,
            machineId: 'machine-1',
            session: {
                sendCodexMessage: vi.fn(),
                getMetadataSnapshot: () => null,
            } as any,
            transcriptSession: {} as any,
            messageBuffer: {} as any,
            mcpServers: {},
            permissionHandler: {} as any,
            getPermissionMode: () => 'default',
            setThinking: vi.fn(),
            memoryRecallGuidanceEnabled: false,
        });

        if (!createdRuntime || typeof createdRuntime !== 'object' || !('operations' in createdRuntime) || !('nativeRuntime' in createdRuntime)) {
            throw new Error('expected Codex MCP runtime plan to return wrapped operations + native runtime');
        }

        expect(createdRuntime.operations).toBe(createdRuntime.nativeRuntime);
        expect(typeof createdRuntime.operations.beginTurnLifecycle).toBe('function');
        expect(typeof createdRuntime.operations.startOrLoadSession).toBe('function');
        expect(typeof createdRuntime.operations.sendTurnPrompt).toBe('function');
        expect(typeof createdRuntime.operations.waitForTurnCompletion).toBe('function');
        expect(typeof createdRuntime.operations.updateSessionRuntimeConfig).toBe('function');
        expect(typeof createdRuntime.operations.readSessionIdentity).toBe('function');

        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.startOrLoadSession();
        await createdRuntime.operations.sendTurnPrompt('hello');
        await createdRuntime.operations.updateSessionRuntimeConfig({ modelId: 'gpt-5.4-mini' });
        expect(createdRuntime.operations.readSessionIdentity()).toEqual({ sessionId: 'mcp-thread-1' });
        await createdRuntime.operations.cancelTurn();
        await createdRuntime.operations.resetOrDisposeRuntime();

        expect(fakeClient.connect).toHaveBeenCalledTimes(1);
        expect(fakeClient.startSession).toHaveBeenCalledTimes(1);
        expect(fakeClient.getSessionId).toHaveBeenCalled();
        expect(fakeClient.forceCloseSession).toHaveBeenCalledTimes(1);
        expect(fakeClient.clearSession).toHaveBeenCalled();
    });
});
