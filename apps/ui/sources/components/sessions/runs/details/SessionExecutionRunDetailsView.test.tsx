import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionExecutionRunDetailsCommonModuleMocks } from './sessionExecutionRunDetailsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const getRunSpy = vi.fn<(sessionId: string, request: { runId: string }) => Promise<any>>(async (_sessionId, _request) => ({
    run: {
        runId: 'run_1',
        callId: 'toolu_1',
        sidechainId: 'toolu_1',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        runClass: 'bounded',
        ioMode: 'streaming',
        status: 'running',
        startedAtMs: 1,
    },
}));

const executionRunInfoCardSpy = vi.fn();
const messageDetailsSpy = vi.fn();
const sessionMessagesState = vi.hoisted(() => ({
    isLoaded: true,
    messages: [
        {
            id: 'tool-msg-1',
            kind: 'tool-call',
            localId: null,
            tool: {
                id: 'toolu_1',
                name: 'SubAgentRun',
                state: 'running',
                input: {
                    runId: 'run_1',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    intent: 'review',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    permissionMode: 'read-only',
                    retentionPolicy: 'ephemeral',
                    label: 'Reviewer A',
                },
                result: {
                    runId: 'run_1',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    intent: 'review',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    permissionMode: 'read-only',
                    retentionPolicy: 'ephemeral',
                    status: 'succeeded',
                    sidechainId: 'toolu_1',
                    callId: 'toolu_1',
                },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
            },
            children: [],
            createdAt: 1,
        },
    ] as any[],
}));

function createExecutionRunGetResponse(overrides?: Record<string, unknown>) {
    return {
        run: {
            runId: 'run_1',
            callId: 'toolu_1',
            sidechainId: 'toolu_1',
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            runClass: 'bounded',
            ioMode: 'streaming',
            status: 'running',
            startedAtMs: 1,
            ...overrides,
        },
    };
}

installSessionExecutionRunDetailsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({ sessions: { s1: { metadata: { machineId: 'm1' } } } }),
            },
            useSession: () => ({ id: 's1', metadata: { flavor: 'codex' }, accessLevel: 'edit', canApprovePermissions: true }),
            useSessionMessages: () => ({ messages: sessionMessagesState.messages, isLoaded: sessionMessagesState.isLoaded }),
            useResolvedSessionMessageRouteId: () => 'tool-msg-1',
            useMessage: () => sessionMessagesState.messages[0] ?? null,
        });
    },
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunGet: (sessionId: string, request: { runId: string }) => getRunSpy(sessionId, request),
    sessionExecutionRunSend: vi.fn(async () => ({ ok: true })),
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
    isExecutionRunNotRunningSendError: (result: unknown) => {
        if (!result || typeof result !== 'object' || (result as any).ok !== false) return false;
        const errorCode = typeof (result as any).errorCode === 'string' ? String((result as any).errorCode).trim().toLowerCase() : '';
        if (errorCode === 'execution_run_not_allowed' || errorCode === 'execution_run_not_running') {
            const error = typeof (result as any).error === 'string' ? String((result as any).error).trim().toLowerCase() : '';
            return error.includes('not running') || error.includes('already finished');
        }
        return false;
    },
}));

vi.mock('@/sync/ops/machineExecutionRuns', () => ({
    machineExecutionRunsList: vi.fn(async () => ({ ok: true, runs: [] })),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => null,
}));

vi.mock('@/components/sessions/runs/details/SessionExecutionRunInfoCard', () => ({
    SessionExecutionRunInfoCard: (props: any) => {
        executionRunInfoCardSpy(props);
        return React.createElement('SessionExecutionRunInfoCard', props);
    },
}));

vi.mock('@/components/sessions/transcript/details/SessionMessageDetailsView', () => ({
    SessionMessageDetailsView: (props: any) => {
        messageDetailsSpy(props);
        return React.createElement('SessionMessageDetailsView', props);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: ({ ...props }: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/ui/layout/ConstrainedScreenContent', () => ({
    ConstrainedScreenContent: ({ children, ...props }: any) => React.createElement('ConstrainedScreenContent', props, children),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(async () => 'loaded'),
        loadOlderMessages: vi.fn(async () => ({
            loaded: 1,
            hasMore: false,
            status: 'loaded',
        })),
        loadOlderSidechainMessages: vi.fn(async () => ({
            loaded: 0,
            hasMore: false,
            status: 'loaded',
        })),
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

vi.mock('@/sync/domains/messages/messageRouteIds', () => ({
    buildToolCallMessageRouteId: ({ toolId }: { toolId: string | null }) => (toolId ? `tool:${toolId}` : ''),
}));

describe('SessionExecutionRunDetailsView', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        getRunSpy.mockReset();
        getRunSpy.mockImplementation(async () => createExecutionRunGetResponse());
        executionRunInfoCardSpy.mockClear();
        messageDetailsSpy.mockClear();
        sessionMessagesState.isLoaded = true;
        sessionMessagesState.messages = [
            {
                id: 'tool-msg-1',
                kind: 'tool-call',
                localId: null,
                tool: {
                    id: 'toolu_1',
                    name: 'SubAgentRun',
                    state: 'running',
                    input: {
                        runId: 'run_1',
                        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                        intent: 'review',
                        runClass: 'bounded',
                        ioMode: 'streaming',
                        permissionMode: 'read-only',
                        retentionPolicy: 'ephemeral',
                        label: 'Reviewer A',
                    },
                    result: {
                        runId: 'run_1',
                        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                        intent: 'review',
                        runClass: 'bounded',
                        ioMode: 'streaming',
                        permissionMode: 'read-only',
                        retentionPolicy: 'ephemeral',
                        status: 'succeeded',
                        sidechainId: 'toolu_1',
                        callId: 'toolu_1',
                    },
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 2,
                    description: null,
                },
                children: [],
                createdAt: 1,
            },
        ];
    });

    afterEach(async () => {
        if (!tree) return;
        await act(async () => {
            tree?.unmount();
        });
        tree = null;
    });

    it('renders transcript details alongside the execution-run info card when the run has a transcript tool route', async () => {
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                />);
        tree = screen.tree;

        expect(tree).toBeTruthy();
        expect(executionRunInfoCardSpy).toHaveBeenCalledWith(expect.objectContaining({
            run: expect.objectContaining({
                runId: 'run_1',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            }),
        }));
        expect(messageDetailsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            message: expect.objectContaining({
                id: 'tool-msg-1',
                kind: 'tool-call',
            }),
        }));
        expect(messageDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('presentation');
    });

    it('skips the execution-run info card when embedded under the subagent details header', async () => {
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');
        executionRunInfoCardSpy.mockClear();
        messageDetailsSpy.mockClear();

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                    showInfoCard={false}
                />);
        tree = screen.tree;

        expect(tree).toBeTruthy();
        expect(executionRunInfoCardSpy).not.toHaveBeenCalled();
        expect(messageDetailsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
        }));
        expect(messageDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('presentation');
    });

    it('hides the legacy inline send composer when embedded under the shared subagent composer', async () => {
        getRunSpy.mockResolvedValueOnce({
            run: {
                runId: 'run_1',
                callId: 'toolu_1',
                sidechainId: 'toolu_1',
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                runClass: 'long_lived',
                ioMode: 'streaming',
                status: 'running',
                startedAtMs: 1,
            },
        });
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                    showSendComposer={false}
                />);
        tree = screen.tree;

        expect(tree).toBeTruthy();
        expect(screen.findByTestId('session-run-details-send-input')).toBeNull();
        expect(screen.findByTestId('session-run-details-send')).toBeNull();
    });

    it('clears the inline send composer after a successful send on supported running runs', async () => {
        const sessionExecutionRuns = await import('@/sync/ops/sessionExecutionRuns');
        const sendSpy = vi.mocked(sessionExecutionRuns.sessionExecutionRunSend);
        sendSpy.mockResolvedValueOnce({ ok: true });
        getRunSpy.mockResolvedValueOnce(createExecutionRunGetResponse());
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                />);
        tree = screen.tree;

        await act(async () => {
            screen.changeTextByTestId('session-run-details-send-input', 'follow up');
        });
        expect(screen.findByTestId('session-run-details-send')).toBeTruthy();

        await act(async () => {
            await screen.pressByTestIdAsync('session-run-details-send');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(sendSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ runId: 'run_1', message: 'follow up' }));
        expect(screen.findByTestId('session-run-details-send-input')?.props.value).toBe('');
    });

    it('reloads and hides the inline send composer when a bounded run is no longer in flight', async () => {
        const sessionExecutionRuns = await import('@/sync/ops/sessionExecutionRuns');
        const sendSpy = vi.mocked(sessionExecutionRuns.sessionExecutionRunSend);
        sendSpy.mockResolvedValueOnce({
            ok: false,
            error: 'Not in flight',
            errorCode: 'execution_run_not_allowed',
        });
        getRunSpy
            .mockResolvedValueOnce(createExecutionRunGetResponse({ turnInFlight: true }))
            .mockResolvedValueOnce(createExecutionRunGetResponse({ turnInFlight: false }));
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                />);
        tree = screen.tree;

        await act(async () => {
            screen.changeTextByTestId('session-run-details-send-input', 'follow up');
        });
        expect(screen.findByTestId('session-run-details-send')).toBeTruthy();

        await act(async () => {
            await screen.pressByTestIdAsync('session-run-details-send');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(sendSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ runId: 'run_1', message: 'follow up' }));
        await vi.waitFor(() => {
            expect(screen.findByTestId('session-run-details-send')).toBeNull();
        });
        expect(screen.findByTestId('session-run-details-send')).toBeNull();
    });

    it('falls back to the persisted transcript when execution.run.get no longer finds the run', async () => {
        getRunSpy.mockResolvedValueOnce({
            ok: false,
            error: 'Not found',
            errorCode: 'execution_run_not_found',
        });
        sessionMessagesState.messages = [
            {
                ...sessionMessagesState.messages[0],
                tool: {
                    ...sessionMessagesState.messages[0]!.tool,
                    state: 'completed',
                    result: {
                        ...sessionMessagesState.messages[0]!.tool.result,
                        status: 'succeeded',
                        permissionMode: 'read-only',
                    },
                },
            },
        ];
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                />);
        tree = screen.tree;

        expect(tree).toBeTruthy();
        expect(executionRunInfoCardSpy).toHaveBeenCalledWith(expect.objectContaining({
            run: expect.objectContaining({
                runId: 'run_1',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                status: 'succeeded',
                permissionMode: 'read-only',
            }),
        }));
        expect(messageDetailsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            message: expect.objectContaining({
                id: 'tool-msg-1',
                kind: 'tool-call',
            }),
        }));
        expect(messageDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('presentation');
    });

    it('hides the transcript composer when the run is no longer sendable', async () => {
        getRunSpy.mockResolvedValueOnce(createExecutionRunGetResponse({
            status: 'succeeded',
            turnInFlight: false,
        }));
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                />);
        tree = screen.tree;

        expect(messageDetailsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            showComposer: false,
        }));
        expect(messageDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('presentation');
    });

    it('loads main transcript messages before failing closed on execution.run.get not-found responses', async () => {
        getRunSpy.mockResolvedValueOnce({
            ok: false,
            error: 'Not found',
            errorCode: 'execution_run_not_found',
        });
        sessionMessagesState.isLoaded = false;
        sessionMessagesState.messages = [];
        const { sync } = await import('@/sync/sync');
        const loadOlderMessagesSpy = vi.mocked(sync.loadOlderMessages);
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                />);
        tree = screen.tree;

        expect(loadOlderMessagesSpy).toHaveBeenCalledWith('s1');
    });

    it('falls back to daemon execution-run markers when session execution.run.get is unavailable', async () => {
        getRunSpy.mockResolvedValueOnce({
            ok: false,
            error: 'RPC method not available',
            errorCode: 'RPC_METHOD_NOT_AVAILABLE',
        });
        const machineExecutionRuns = await import('@/sync/ops/machineExecutionRuns');
        vi.mocked(machineExecutionRuns.machineExecutionRunsList).mockResolvedValueOnce({
            ok: true,
            runs: [{
                happyHomeDir: '/tmp/happier',
                pid: 123,
                happySessionId: 's1',
                runId: 'run_1',
                callId: 'toolu_1',
                sidechainId: 'toolu_1',
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                runClass: 'bounded',
                ioMode: 'streaming',
                retentionPolicy: 'ephemeral',
                status: 'running',
                startedAtMs: 1,
                updatedAtMs: 2,
            }],
        });
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                />);
        tree = screen.tree;

        expect(executionRunInfoCardSpy).toHaveBeenCalledWith(expect.objectContaining({
            run: expect.objectContaining({
                runId: 'run_1',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                status: 'running',
            }),
        }));
        expect(messageDetailsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            message: expect.objectContaining({
                id: 'tool-msg-1',
                kind: 'tool-call',
            }),
        }));
        expect(messageDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('presentation');
        expect(screen.findByTestId('session-run-details-send-input')).toBeNull();
    });

    it('does not expose mutable run controls when only transcript fallback state is available', async () => {
        getRunSpy.mockResolvedValueOnce({
            ok: false,
            error: 'RPC method not available',
            errorCode: 'RPC_METHOD_NOT_AVAILABLE',
        });
        sessionMessagesState.messages = [
            {
                ...sessionMessagesState.messages[0],
                tool: {
                    ...sessionMessagesState.messages[0]!.tool,
                    state: 'running',
                    result: {
                        ...sessionMessagesState.messages[0]!.tool.result,
                        status: 'running',
                        permissionMode: 'read-only',
                    },
                },
            },
        ];
        const { SessionExecutionRunDetailsView } = await import('./SessionExecutionRunDetailsView');

        const screen = await renderScreen(<SessionExecutionRunDetailsView
                    sessionId="s1"
                    runId="run_1"
                    presentation="panel"
                />);
        tree = screen.tree;

        expect(tree).toBeTruthy();
        expect(screen.findByTestId('session-run-details-send-input')).toBeNull();
        expect(screen.findByTestId('session-run-details-stop')).toBeNull();
    });

});
