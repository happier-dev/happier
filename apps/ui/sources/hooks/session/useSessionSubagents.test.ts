import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { renderHookAndCollectValues } from '@/hooks/server/serverFeatureHookHarness.testHelpers';
import { getStorage } from '@/sync/domains/state/storage';
import type { DirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import type { UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { useSessionSubagents } from './useSessionSubagents';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();
const directSessionRuntimeState = {
    directSessionLink: null as DirectSessionLink | null,
    status: null as UseDirectSessionRuntimeResult['status'],
    refreshNow: vi.fn(async () => null),
};
const directSessionRuntimeParams: unknown[] = [];
const runningExecutionRunsState = vi.hoisted(() => ({ current: [] as readonly any[] }));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/session/useSessionRunningExecutionRuns', () => ({
    useSessionRunningExecutionRuns: () => runningExecutionRunsState.current,
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: (params: unknown) => {
        directSessionRuntimeParams.push(params);
        return directSessionRuntimeState;
    },
}));

beforeEach(() => {
    getStorage().setState(initialStorageState, true);
    directSessionRuntimeState.directSessionLink = null;
    directSessionRuntimeState.status = null;
    directSessionRuntimeParams.length = 0;
    runningExecutionRunsState.current = [];
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
        directSessionRuntimeState.directSessionLink = {
            v: 1,
            providerId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-session-1',
            source: { kind: 'claudeConfig' },
        };
        directSessionRuntimeState.status = {
            ok: true,
            machineOnline: true,
            runnerActive: false,
            activity: 'unknown',
            canTakeOverDirect: false,
            canTakeOverPersist: false,
            canForceStop: false,
        };

        const now = Date.now();
        const seen = await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                        directSessionV1: directSessionRuntimeState.directSessionLink,
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

    it('disables internal direct-session runtime polling when the caller supplies runtime state', async () => {
        const suppliedRuntime = {
            directSessionLink: null,
            status: null,
            refreshNow: vi.fn(async () => null),
        };

        await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages: [],
                directSessionRuntime: suppliedRuntime,
            }),
        );

        expect(directSessionRuntimeParams).toContainEqual(expect.objectContaining({
            sessionId: 'session-1',
            enabled: false,
        }));
    });

    it('keeps derived participant collections stable when only volatile session fields change', async () => {
        const messages: readonly any[] = [];
        const hook = await renderHook((sessionSeq: number) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    seq: sessionSeq,
                    updatedAt: sessionSeq,
                    thinkingAt: sessionSeq,
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages,
                directSessionRuntime: directSessionRuntimeState,
            }), {
                initialProps: 1,
            });

        const first = hook.getCurrent();
        await hook.rerender(2);
        const second = hook.getCurrent();

        expect(second.subagents).toBe(first.subagents);
        expect(second.participantTargets).toBe(first.participantTargets);
        expect(second.sidechainIds).toBe(first.sidechainIds);
        await hook.unmount();
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
                directSessionRuntime: directSessionRuntimeState,
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
                directSessionRuntime: directSessionRuntimeState,
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

    it('does not rescan unchanged message prefixes when non-subagent text streams', async () => {
        const now = Date.now();
        let kindReadCount = 0;
        const toolCallMessage: any = {
            get kind() {
                kindReadCount += 1;
                return 'tool-call';
            },
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
                directSessionRuntime: directSessionRuntimeState,
            }), {
                initialProps: baseMessages,
            });

        const readsAfterInitialRender = kindReadCount;
        await hook.rerender([
            toolCallMessage,
            {
                ...baseMessages[1],
                text: 'partial response is still streaming',
            },
        ]);

        expect(kindReadCount).toBe(readsAfterInitialRender);
        await hook.unmount();
    });

    it('does not rescan subagent messages when equivalent running execution-run polls arrive', async () => {
        const now = Date.now();
        let inputReadCount = 0;
        const messages: readonly any[] = [{
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
                directSessionRuntime: directSessionRuntimeState,
            }), {
                initialProps: 1,
            });

        const readsAfterInitialRender = inputReadCount;
        runningExecutionRunsState.current = [{
            runId: 'run_1',
            status: 'running',
        }];
        await hook.rerender(2);

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
                directSessionRuntime: directSessionRuntimeState,
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

    it('restores provider-native completion-only tasks after reload without registering a child sidechain or recipient', async () => {
        const now = Date.now();
        const createReloadedMessages = (): readonly any[] => [{
            kind: 'tool-call',
            id: 'message-cursor-task',
            localId: 'stable-local-id',
            createdAt: now,
            tool: {
                id: 'opaque-cursor-task-id',
                name: 'SubAgent',
                state: 'completed',
                input: {
                    operation: 'run',
                    description: 'Inspect the integration',
                    _happier: {
                        v: 2,
                        protocol: 'acp',
                        provider: 'cursor',
                        rawToolName: 'Task',
                        canonicalToolName: 'SubAgent',
                        nativeSubagent: {
                            v: 1,
                            lifecycle: 'completion_only',
                            type: 'explore',
                        },
                    },
                },
                createdAt: now,
                startedAt: now,
                completedAt: now + 1,
                description: null,
            },
            children: [],
        }];
        const hook = await renderHook((messages: readonly any[]) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: { flavor: 'cursor' },
                } as any,
                messages,
                directSessionRuntime: directSessionRuntimeState,
            }), {
                initialProps: createReloadedMessages(),
            });

        expect(hook.getCurrent()).toMatchObject({
            subagents: [{
                id: 'subagent_sidechain:opaque-cursor-task-id',
                status: 'succeeded',
                transcript: {
                    toolMessageRouteId: 'local:stable-local-id',
                    toolId: 'opaque-cursor-task-id',
                },
                recipient: null,
            }],
            participantTargets: [],
            sidechainIds: [],
        });

        await hook.rerender(createReloadedMessages());
        expect(hook.getCurrent().subagents).toHaveLength(1);
        expect(hook.getCurrent().sidechainIds).toEqual([]);
        await hook.unmount();
    });

    it('keeps the object identity of subagents a recompute did not change', async () => {
        const now = Date.now();
        const buildRunMessage = (runId: string, state: 'running' | 'completed'): any => ({
            kind: 'tool-call',
            id: `tool-call-${runId}-${state}`,
            localId: null,
            createdAt: now,
            tool: {
                id: `toolu_${runId}`,
                name: 'SubAgentRun',
                state,
                input: { runId, label: runId },
                ...(state === 'completed' ? { result: { runId, ok: true } } : {}),
                createdAt: now,
                startedAt: now,
                completedAt: state === 'completed' ? now + 1 : null,
                description: null,
            },
            children: [],
        });

        const firstRunMessage = buildRunMessage('run_1', 'running');
        const hook = await renderHook((messages: readonly any[]) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: { flavor: 'claude' },
                } as any,
                messages,
                directSessionRuntime: directSessionRuntimeState,
            }), {
                initialProps: [firstRunMessage, buildRunMessage('run_2', 'running')] as readonly any[],
            });

        const before = hook.getCurrent().subagents;
        expect(before.map((subagent) => subagent.id))
            .toEqual(['execution_run:run_1', 'execution_run:run_2']);
        expect(before[1]?.status).toBe('running');

        // Only run_2 moves. run_1's row is byte-identical, so a memoized row must not re-render.
        await hook.rerender([firstRunMessage, buildRunMessage('run_2', 'completed')]);

        const after = hook.getCurrent().subagents;
        expect(after).not.toBe(before);
        expect(after[1]?.status).toBe('succeeded');
        expect(after[1]).not.toBe(before[1]);
        expect(after[0]).toBe(before[0]);

        await hook.unmount();
    });
});
