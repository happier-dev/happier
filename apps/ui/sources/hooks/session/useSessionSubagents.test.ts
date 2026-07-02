import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { renderHookAndCollectValues } from '@/hooks/server/serverFeatureHookHarness.testHelpers';
import { getStorage } from '@/sync/domains/state/storage';
import { useSessionSubagents } from './useSessionSubagents';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();
const externalSessionRuntimeState = {
    externalSessionLink: null as null | {
        v: 1;
        providerId: string;
        machineId: string;
        remoteSessionId: string;
        source: 'provider';
    },
    status: null as null | { runnerActive?: boolean },
    refreshNow: vi.fn(async () => null),
};
const runningExecutionRunsState = { current: [] as readonly any[] };
const useSessionRunningExecutionRunsSpy = vi.fn<(...args: any[]) => any>(() => runningExecutionRunsState.current);
const useExternalSessionRuntimeSpy = vi.fn<(...args: any[]) => any>(() => externalSessionRuntimeState);

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/session/useSessionRunningExecutionRuns', () => ({
    useSessionRunningExecutionRuns: (...args: any[]) => useSessionRunningExecutionRunsSpy(...args),
}));

vi.mock('@/components/sessions/model/useExternalSessionRuntime', () => ({
    useExternalSessionRuntime: (...args: any[]) => useExternalSessionRuntimeSpy(...args),
}));

beforeEach(() => {
    getStorage().setState(initialStorageState, true);
    externalSessionRuntimeState.externalSessionLink = null;
    externalSessionRuntimeState.status = null;
    runningExecutionRunsState.current = [];
    useSessionRunningExecutionRunsSpy.mockClear();
    useExternalSessionRuntimeSpy.mockClear();
});

describe('useSessionSubagents', () => {
    it('returns an empty subagent model without crashing when execution runs are disabled', async () => {
        const seen = await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: null,
                messages: [],
            }),
        );

        expect(seen.at(-1)).toEqual({
            subagents: [],
            participantTargets: [],
            sidechainIds: [],
        });
    });

    it('downgrades execution-run send and stop capabilities for linked direct sessions that are not locally controlled', async () => {
        externalSessionRuntimeState.externalSessionLink = {
            v: 1,
            providerId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-session-1',
            source: 'provider',
        };
        externalSessionRuntimeState.status = { runnerActive: false };

        const now = Date.now();
        const seen = await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                        externalSessionV1: externalSessionRuntimeState.externalSessionLink,
                    },
                } as any,
                messages: [{
                    kind: 'tool-call',
                    id: 'tool-call-1',
                    localId: null,
                    createdAt: now,
                    tool: {
                        id: 'toolu_run_1',
                        name: 'SubAgentRun',
                        state: 'running',
                        input: { runId: 'run_1' },
                        createdAt: now,
                        startedAt: now,
                        completedAt: null,
                        description: null,
                    },
                    children: [],
                }],
            }),
        );

        expect(seen.at(-1)).toEqual({
            subagents: [expect.objectContaining({
                id: 'execution_run:run_1',
                capabilities: expect.objectContaining({
                    canSend: false,
                    canStop: false,
                }),
            })],
            participantTargets: [],
            sidechainIds: ['toolu_run_1'],
        });
    });

    it('normalizes session ids before delegating to subagent child hooks', async () => {
        const seen = await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: '  session-1  ',
                session: {
                    id: 'session-1',
                    metadata: null,
                } as any,
                messages: [],
            }),
        );

        expect(useSessionRunningExecutionRunsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            enabled: expect.any(Boolean),
        }));
        expect(useExternalSessionRuntimeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            metadata: null,
        }));
        expect(seen.at(-1)).toEqual({
            subagents: [],
            participantTargets: [],
            sidechainIds: [],
        });
    });

    it('does not enable an internal direct-session runtime when one is already provided', async () => {
        const providedRuntime = {
            externalSessionLink: {
                v: 1,
                providerId: 'claude',
                machineId: 'machine-1',
                remoteSessionId: 'remote-session-1',
                source: 'provider',
            },
            status: { runnerActive: true },
            refreshNow: vi.fn(async () => null),
            sessionServerId: 'server-1',
        };

        await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                        externalSessionV1: providedRuntime.externalSessionLink,
                    },
                } as any,
                messages: [],
                externalSessionRuntime: providedRuntime as any,
            }),
        );

        expect(useExternalSessionRuntimeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            enabled: false,
        }));
    });

    it('keeps derived participant collections stable when non-subagent text streams', async () => {
        const now = Date.now();
        const baseMessages: readonly any[] = [{
            kind: 'tool-call',
            id: 'tool-call-1',
            localId: null,
            createdAt: now,
            tool: {
                id: 'toolu_run_1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_1' },
                createdAt: now,
                startedAt: now,
                completedAt: null,
                description: null,
            },
            children: [],
        }, {
            kind: 'agent-text',
            id: 'agent-text-1',
            localId: null,
            createdAt: now + 1,
            text: 'partial',
            children: [],
        }];
        const hook = await renderHook((messages: readonly any[]) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages,
                externalSessionRuntime: externalSessionRuntimeState as any,
            }), {
                initialProps: baseMessages,
            });

        const first = hook.getCurrent();
        await hook.rerender([
            baseMessages[0],
            {
                ...baseMessages[1],
                text: 'partial response is still streaming',
            },
        ]);
        const second = hook.getCurrent();

        expect(second.subagents).toBe(first.subagents);
        expect(second.participantTargets).toBe(first.participantTargets);
        expect(second.sidechainIds).toBe(first.sidechainIds);
        await hook.unmount();
    });

    it('does not rescan unchanged tool-call payloads when non-subagent text streams', async () => {
        const now = Date.now();
        let inputReadCount = 0;
        const toolCallMessage: any = {
            kind: 'tool-call',
            id: 'tool-call-1',
            localId: null,
            createdAt: now,
            tool: {
                id: 'toolu_run_1',
                name: 'SubAgentRun',
                state: 'running',
                get input() {
                    inputReadCount += 1;
                    return { runId: 'run_1' };
                },
                createdAt: now,
                startedAt: now,
                completedAt: null,
                description: null,
            },
            children: [],
        };
        const baseMessages: readonly any[] = [toolCallMessage, {
            kind: 'agent-text',
            id: 'agent-text-1',
            localId: null,
            createdAt: now + 1,
            text: 'partial',
            children: [],
        }];
        const hook = await renderHook((messages: readonly any[]) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages,
                externalSessionRuntime: externalSessionRuntimeState as any,
            }), {
                initialProps: baseMessages,
            });

        const readsAfterInitialRender = inputReadCount;
        await hook.rerender([
            toolCallMessage,
            {
                ...baseMessages[1],
                text: 'partial response is still streaming',
            },
        ]);

        expect(inputReadCount).toBe(readsAfterInitialRender);
        await hook.unmount();
    });

    it('keeps participant target collections stable when equivalent running execution-run polls arrive', async () => {
        const now = Date.now();
        const messages: readonly any[] = [{
            kind: 'tool-call',
            id: 'tool-call-1',
            localId: null,
            createdAt: now,
            tool: {
                id: 'toolu_run_1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_1' },
                createdAt: now,
                startedAt: now,
                completedAt: null,
                description: null,
            },
            children: [],
        }];
        runningExecutionRunsState.current = [{
            runId: 'run_1',
            status: 'running',
        }];

        const hook = await renderHook((tick: number) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages,
                externalSessionRuntime: externalSessionRuntimeState as any,
            }), {
                initialProps: 1,
            });

        const first = hook.getCurrent();
        runningExecutionRunsState.current = [{
            runId: 'run_1',
            status: 'running',
        }];
        await hook.rerender(2);
        const second = hook.getCurrent();

        expect(second.participantTargets).toBe(first.participantTargets);
        expect(second.sidechainIds).toBe(first.sidechainIds);
        await hook.unmount();
    });
});
