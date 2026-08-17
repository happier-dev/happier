import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionState = vi.hoisted(() => ({ current: null as any }));
const sourceMessagesState = vi.hoisted(() => ({ current: [] as readonly any[] }));
const transcriptState = vi.hoisted(() => ({ current: [] as readonly any[] }));
const reducerStateHolder = vi.hoisted(() => ({
    current: { sidechains: new Map(), permissions: new Map() } as any,
}));
const useSessionMessagesSpy = vi.hoisted(() => vi.fn());
const useSessionMessagesReducerStateSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useSession: () => sessionState.current,
        useSessionSubagentSourceMessages: () => sourceMessagesState.current,
        useSessionMessages: () => {
            useSessionMessagesSpy();
            return { messages: transcriptState.current, isLoaded: true };
        },
        useSessionMessagesReducerState: () => {
            useSessionMessagesReducerStateSpy();
            return reducerStateHolder.current;
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/session/useSessionRunningExecutionRuns', () => ({
    useSessionRunningExecutionRuns: () => [],
}));

vi.mock('@/components/sessions/model/useExternalSessionRuntime', () => ({
    useExternalSessionRuntime: () => ({ externalSessionLink: null, status: null, refreshNow: async () => null }),
}));

function toolCallMessage(overrides: Readonly<{
    id: string;
    toolId: string;
    state: 'running' | 'completed';
    createdAt: number;
}>): Message {
    return {
        kind: 'tool-call',
        id: overrides.id,
        localId: null,
        createdAt: overrides.createdAt,
        tool: {
            id: overrides.toolId,
            name: 'Task',
            state: overrides.state,
            input: { description: 'Audit the auth flow' },
            createdAt: overrides.createdAt,
            startedAt: overrides.createdAt,
            completedAt: overrides.state === 'completed' ? overrides.createdAt + 10 : null,
            description: null,
        },
        children: [],
    } as unknown as Message;
}

function sessionWithHeadline(updatedAt: number, status: 'running' | 'succeeded' = 'running') {
    return {
        id: 's1',
        metadata: {
            flavor: 'claude',
            sessionAgentActivityHeadlineV1: {
                v: 1,
                backendId: 'claude',
                updatedAt,
                activeEntries: status === 'running'
                    ? [{
                        entryId: 'workflow_agent:wf_1:toolu_1',
                        kind: 'workflow_agent',
                        title: 'Audit the auth flow',
                        status: 'running',
                        updatedAt,
                    }]
                    : [],
                ...(status === 'succeeded'
                    ? {
                        recentEntries: [{
                            entryId: 'workflow_agent:wf_1:toolu_1',
                            kind: 'workflow_agent',
                            title: 'Audit the auth flow',
                            status: 'succeeded',
                            updatedAt,
                        }],
                    }
                    : {}),
            },
        },
    } as any;
}

beforeEach(() => {
    sessionState.current = null;
    sourceMessagesState.current = [];
    transcriptState.current = [];
    reducerStateHolder.current = { sidechains: new Map(), permissions: new Map() };
    useSessionMessagesSpy.mockClear();
    useSessionMessagesReducerStateSpy.mockClear();
});

describe('useSessionAgentActivity — the narrow width', () => {
    it('does not subscribe to the transcript, while the roster width does', async () => {
        sessionState.current = sessionWithHeadline(4_000);

        const { useSessionAgentActivity, useSessionAgentActivityRoster } =
            await import('./useSessionAgentActivity');

        await renderHook(() => useSessionAgentActivity({ sessionId: 's1' }));
        // The whole reason two widths exist: a host that only needs a number must not re-render on
        // every streamed token.
        expect(useSessionMessagesSpy).not.toHaveBeenCalled();
        expect(useSessionMessagesReducerStateSpy).not.toHaveBeenCalled();

        await renderHook(() => useSessionAgentActivityRoster({ sessionId: 's1' }));
        expect(useSessionMessagesSpy).toHaveBeenCalled();
        expect(useSessionMessagesReducerStateSpy).toHaveBeenCalled();
    });

    it('names the agents a cold-opened session has before any transcript has arrived', async () => {
        sessionState.current = sessionWithHeadline(4_000);
        sourceMessagesState.current = [];

        const { useSessionAgentActivity } = await import('./useSessionAgentActivity');
        const hook = await renderHook(() => useSessionAgentActivity({ sessionId: 's1' }));

        const state = hook.getCurrent();
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]).toMatchObject({
            id: 'workflow_agent:wf_1:toolu_1',
            provenance: 'headline',
            detailState: 'unloaded',
        });
        // The header glyph and the pane badge read this: a cold open used to report zero.
        expect(state.counts).toEqual({ live: 1, total: 1 });
    });

    it('joins the locally derived row to its headline entry and reports one unit of work', async () => {
        sessionState.current = sessionWithHeadline(4_000);
        sourceMessagesState.current = [toolCallMessage({
            id: 'msg-1',
            toolId: 'toolu_1',
            state: 'running',
            createdAt: 1_000,
        })];

        const { useSessionAgentActivity } = await import('./useSessionAgentActivity');
        const hook = await renderHook(() => useSessionAgentActivity({ sessionId: 's1' }));

        const state = hook.getCurrent();
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]).toMatchObject({
            id: 'workflow_agent:wf_1:toolu_1',
            provenance: 'merged',
            detailState: 'loaded',
        });
        expect(state.counts.live).toBe(1);
    });

    it('keeps every row referentially identical when only the evidence instant advances', async () => {
        sessionState.current = sessionWithHeadline(4_000);
        sourceMessagesState.current = [toolCallMessage({
            id: 'msg-1',
            toolId: 'toolu_1',
            state: 'running',
            createdAt: 1_000,
        })];

        const { useSessionAgentActivity } = await import('./useSessionAgentActivity');
        const hook = await renderHook(() => useSessionAgentActivity({ sessionId: 's1' }));
        const before = hook.getCurrent();
        expect(before.evidenceAtMsById.get('workflow_agent:wf_1:toolu_1')).toBe(4_000);

        // A fresh observation about the same, unchanged work: the headline republishes with a newer
        // instant and nothing else different.
        sessionState.current = sessionWithHeadline(9_000);
        await hook.rerender();
        const after = hook.getCurrent();

        // Freshness advanced...
        expect(after.evidenceAtMsById.get('workflow_agent:wf_1:toolu_1')).toBe(9_000);
        // ...and not one row was rebuilt. Folding the instant into the row would fail here, which
        // is exactly the co-memoization defect the separate index exists to prevent.
        expect(after.entries).toHaveLength(before.entries.length);
        for (let index = 0; index < before.entries.length; index += 1) {
            expect(after.entries[index]).toBe(before.entries[index]);
        }
    });

    it('lets the headline retire a row the transcript still reports as running', async () => {
        sessionState.current = sessionWithHeadline(9_000, 'succeeded');
        sourceMessagesState.current = [toolCallMessage({
            id: 'msg-1',
            toolId: 'toolu_1',
            state: 'running',
            createdAt: 1_000,
        })];

        const { useSessionAgentActivity } = await import('./useSessionAgentActivity');
        const hook = await renderHook(() => useSessionAgentActivity({ sessionId: 's1' }));

        const state = hook.getCurrent();
        expect(state.entries[0]?.status).toBe('succeeded');
        expect(state.counts.live).toBe(0);
        // The disagreement is counted rather than quietly reconciled.
        expect(state.diagnostics.statusDivergenceCount).toBe(1);
    });
});
