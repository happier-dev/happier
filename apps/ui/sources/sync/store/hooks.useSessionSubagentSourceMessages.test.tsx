import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';
import { useSessionSubagentSourceMessages } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

const SESSION_ID = 's-subagent-source';
const initialStorageState = storage.getState();
const runInput = { runId: 'run_1', sidechainId: 'call_1', label: 'Audit' };

afterEach(() => {
    standardCleanup();
    clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
    storage.setState(initialStorageState, true);
});

function runningSubAgentRunMessage(result: unknown): ToolCallMessage {
    return createToolCallMessageFixture({
        id: 'message_call_1',
        localId: null,
        createdAt: 1_000,
        tool: {
            id: 'call_1',
            name: 'SubAgentRun',
            state: 'running',
            input: runInput,
            createdAt: 1_000,
            startedAt: 1_000,
            completedAt: null,
            description: null,
            result,
        },
    });
}

function seed(message: Message, subagentSourceVersion: number): void {
    const messagesById: Record<string, Message> = { [message.id]: message };
    storage.setState((state) => ({
        ...state,
        sessionMessages: {
            ...state.sessionMessages,
            [SESSION_ID]: createSessionMessagesFixture({
                messageIdsOldestFirst: [message.id],
                messagesById,
                messagesMap: messagesById,
                messagesVersion: subagentSourceVersion,
                subagentSourceVersion,
                isLoaded: true,
            }),
        },
    }));
}

describe('useSessionSubagentSourceMessages', () => {
    it('reuses unchanged nested text and run payload projections across source arrivals', async () => {
        let textReads = 0;
        let runFieldReads = 0;
        const announcement: Message = {
            kind: 'agent-text', id: 'announcement', localId: null, createdAt: 1,
            get text() { textReads += 1; return 'Execution run started run_12345678'; },
        };
        const run = runningSubAgentRunMessage({
            get runId() { runFieldReads += 1; return 'run_1'; },
            status: 'running',
        });
        run.tool = { ...run.tool, input: {} };
        const root = createToolCallMessageFixture({ id: 'root', children: [announcement, run] });
        seed(root, 1);
        const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID));
        expect(textReads).toBeGreaterThan(0);
        expect(runFieldReads).toBeGreaterThan(0);
        textReads = 0;
        runFieldReads = 0;

        for (let version = 2; version <= 5; version += 1) {
            await act(async () => {
                storage.getState().applyMessages(SESSION_ID, [{
                    id: `new-${version}`, localId: null, createdAt: 2000 + version, role: 'agent', isSidechain: false,
                    content: [{ type: 'tool-call', id: `call-${version}`, name: 'Task', input: { prompt: 'Review' }, description: null, uuid: `new-${version}`, parentUUID: null }],
                }]);
            });
            expect(hook.getCurrent()).toHaveLength(version);
            expect(hook.getCurrent().find((message) => message.id === root.id)).toBe(root);
        }
        expect(storage.getState().sessionMessages[SESSION_ID].subagentSourceVersion).toBeGreaterThan(1);
        expect({ textReads, runFieldReads }).toEqual({ textReads: 0, runFieldReads: 0 });
        await hook.unmount();
    });

    it('observes nested in-place permission changes even when every message reference is unchanged', async () => {
        const child = runningSubAgentRunMessage(null);
        child.tool.permission = { id: 'permission-1', status: 'pending' };
        const root = createToolCallMessageFixture({ id: 'root', children: [child] });
        seed(root, 1);
        const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID));
        const first = hook.getCurrent();
        await act(async () => {
            child.tool.permission!.status = 'approved';
            seed(root, 2);
        });
        expect(hook.getCurrent()).not.toBe(first);
        expect(hook.getCurrent()[0]).toMatchObject({ children: [{ tool: { permission: { status: 'approved' } } }] });
        await hook.unmount();
    });

    it('keeps the projection identity when only prose inside a running run result changes', async () => {
        const previousState = storage.getState();
        try {
            seed(runningSubAgentRunMessage('the reviewer noted status: "failed" in the old build'), 1);

            const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();
            expect(first).toHaveLength(1);

            await act(async () => {
                // The reducer republishes the message while preserving unchanged input references.
                seed(runningSubAgentRunMessage('the reviewer noted status: "succeeded" in the old build'), 2);
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('rebuilds the projection when the run manager reports a different structured status', async () => {
        const previousState = storage.getState();
        try {
            seed(runningSubAgentRunMessage({ runId: 'run_1', status: 'running' }), 1);

            const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();
            expect(first).toHaveLength(1);

            await act(async () => {
                seed(runningSubAgentRunMessage({ runId: 'run_1', status: 'timeout' }), 2);
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).not.toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('publishes ordinary running tool results even when their length and status are unchanged', async () => {
        const firstMessage = runningSubAgentRunMessage({ agentId: 'child-a' });
        firstMessage.tool = { ...firstMessage.tool, name: 'Task' };
        seed(firstMessage, 1);
        const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID));
        const first = hook.getCurrent();
        const nextMessage = { ...firstMessage, tool: { ...firstMessage.tool, result: { agentId: 'child-b' } } };

        await act(async () => { seed(nextMessage, 2); });

        expect(hook.getCurrent()).not.toBe(first);
        expect(hook.getCurrent()[0]).toBe(nextMessage);
        await hook.unmount();
    });

    it.each([
        { runId: 'run_2' },
        { label: 'Review' },
        { sidechainId: 'other-chain' },
        { backendTarget: { kind: 'configuredAcpBackend', backendId: 'reviewer' } },
        { intent: 'review' },
        { permissionMode: 'read-only' },
        { retentionPolicy: 'ephemeral' },
        { runClass: 'long-lived' },
        { ioMode: 'interactive' },
        { launchOrigin: { kind: 'external', source: 'mcp' } },
    ])('publishes changed running execution-run fields: %j', async (changedFields) => {
        const firstMessage = runningSubAgentRunMessage({ runId: 'run_1', status: 'running' });
        firstMessage.tool = { ...firstMessage.tool, input: {} };
        seed(firstMessage, 1);
        const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID));
        const first = hook.getCurrent();
        const nextMessage = { ...firstMessage, tool: { ...firstMessage.tool, result: { runId: 'run_1', status: 'running', ...changedFields } } };

        await act(async () => { seed(nextMessage, 2); });

        expect(hook.getCurrent()).not.toBe(first);
        expect(hook.getCurrent()[0]).toBe(nextMessage);
        await hook.unmount();
    });

    it('detects permission status changes when the reducer shares the permission object', async () => {
        const permission = { id: 'permission-1', status: 'pending' as const };
        const message = runningSubAgentRunMessage(null);
        message.tool = { ...message.tool, permission };
        seed(message, 1);
        const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID));
        const first = hook.getCurrent();

        await act(async () => {
            message.tool.permission!.status = 'approved';
            seed({ ...message, tool: { ...message.tool } }, 2);
        });

        expect(hook.getCurrent()).not.toBe(first);
        expect(hook.getCurrent()[0]).toMatchObject({ tool: { permission: { status: 'approved' } } });
        await hook.unmount();
    });

    it('publishes nested tool updates even when ancestor fields and every timestamp are unchanged', async () => {
        const leaf = createToolCallMessageFixture({ id: 'leaf' });
        const child = createToolCallMessageFixture({ id: 'child', children: [leaf] });
        const message = runningSubAgentRunMessage(null);
        message.children = [child];
        seed(message, 1);
        const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID));
        const first = hook.getCurrent();
        const nextLeaf = { ...leaf, tool: { ...leaf.tool, result: { content: 'updated' } } };
        const nextMessage = { ...message, children: [{ ...child, children: [nextLeaf] }] };

        await act(async () => { seed(nextMessage, 2); });

        expect(hook.getCurrent()).not.toBe(first);
        expect(hook.getCurrent()[0]).toBe(nextMessage);
        await hook.unmount();
    });

    it('compares payload references without reading or serializing their content', async () => {
        let payloadReads = 0;
        const payload = {
            get output() { payloadReads += 1; return 'synthetic output '.repeat(65_536); },
        };
        const message = createToolCallMessageFixture({
            tool: { ...runningSubAgentRunMessage(null).tool, name: 'Bash', state: 'completed', input: payload, result: payload },
        });
        seed(message, 1);
        const hook = await renderHook(() => useSessionSubagentSourceMessages(SESSION_ID));
        const first = hook.getCurrent();
        await act(async () => { seed({ ...message, tool: { ...message.tool } }, 2); });

        expect(payloadReads).toBe(0);
        expect(hook.getCurrent()).toBe(first);
        await hook.unmount();
    });
});
