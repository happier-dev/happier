import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';
import { useSessionSubagentSourceMessages } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import type { NormalizedMessage } from '@/sync/typesRaw';

const SESSION_ID = 's-subagent-source';
const initialStorageState = storage.getState();
const runInput = { runId: 'run_1', sidechainId: 'call_1', label: 'Audit' };

beforeEach(() => {
    // This Node harness has no browser storage for the native credential store's development fallback.
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK', 'false');
    // Exercise the real feature decision while keeping execution-run RPC polling out of these transcript tests.
    storage.getState().applySettingsLocal({ featureToggles: { 'execution.runs': false } });
});

afterEach(() => {
    standardCleanup();
    clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
    storage.setState(initialStorageState, true);
    vi.unstubAllEnvs();
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
    it('receives execution-run start announcements through the producer and source projection', async () => {
        const now = Date.now();
        const session = createSessionFixture({ id: SESSION_ID, active: true, activeAt: now });
        storage.getState().applyMessages(SESSION_ID, [{
            id: 'run-call', localId: null, createdAt: now, role: 'agent', isSidechain: false,
            content: [{
                type: 'tool-call', id: 'call_1', name: 'SubAgentRun', input: { runId: 'run_12345678' },
                description: null, uuid: 'run-call', parentUUID: null,
            }],
        }, {
            id: 'run-interrupted', localId: null, createdAt: now + 1, role: 'agent', isSidechain: false,
            content: [{
                type: 'tool-result', tool_use_id: 'call_1', content: { error: 'Request interrupted' },
                is_error: true, uuid: 'run-interrupted', parentUUID: 'run-call',
            }],
        }]);
        const hook = await renderHook(() => {
            const messages = useSessionSubagentSourceMessages(SESSION_ID);
            return {
                messages,
                ...useSessionSubagents({ sessionId: SESSION_ID, session, messages }),
            };
        });
        expect(hook.getCurrent().subagents).toMatchObject([{ id: 'execution_run:run_12345678', status: 'unknown' }]);

        await act(async () => {
            storage.getState().applyMessages(SESSION_ID, [{
                id: 'run-announcement', localId: null, createdAt: now + 2, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'Execution run started: run_12345678', uuid: 'run-announcement', parentUUID: null }],
            }]);
        });

        expect(hook.getCurrent().messages).toHaveLength(2);
        expect(hook.getCurrent().subagents).toMatchObject([{ id: 'execution_run:run_12345678', status: 'running' }]);
        await hook.unmount();
    });

    it('keeps derived participant collections stable when non-subagent text streams', async () => {
        const now = Date.now();
        const session = createSessionFixture({ id: SESSION_ID, active: true, activeAt: now });
        let inputReadCount = 0;
        let kindReadCount = 0;
        const input = { runId: 'run_1' };
        storage.getState().applyMessages(SESSION_ID, [{
            id: 'run-call', localId: null, createdAt: now, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'call_1', name: 'SubAgentRun', input, description: null, uuid: 'run-call', parentUUID: null }],
        }]);
        const published = storage.getState().sessionMessages[SESSION_ID];
        const toolCallMessage = published.messagesById[published.messageIdsOldestFirst[0]];
        if (toolCallMessage.kind !== 'tool-call') throw new Error('Expected published tool call');
        Object.defineProperty(toolCallMessage, 'kind', {
            get() {
                kindReadCount += 1;
                return 'tool-call' as const;
            },
        });
        Object.defineProperty(toolCallMessage.tool, 'input', {
            get() {
                inputReadCount += 1;
                return input;
            },
        });
        const hook = await renderHook(() => {
            const messages = useSessionSubagentSourceMessages(SESSION_ID);
            return {
                messages,
                ...useSessionSubagents({ sessionId: SESSION_ID, session, messages }),
            };
        });
        const first = hook.getCurrent();
        const initialSourceVersion = storage.getState().sessionMessages[SESSION_ID].subagentSourceVersion;
        const initialMessagesVersion = storage.getState().sessionMessages[SESSION_ID].messagesVersion;
        const readsAfterInitialRender = { input: inputReadCount, kind: kindReadCount };
        expect(inputReadCount).toBeGreaterThan(0);
        expect(kindReadCount).toBeGreaterThan(0);
        expect(first.subagents).toMatchObject([{ id: 'execution_run:run_1', status: 'running' }]);

        for (let token = 0; token < 16; token += 1) {
            await act(async () => {
                storage.getState().applyMessages(SESSION_ID, [{
                    id: `text-${token}`, localId: null, createdAt: now + token + 1, role: 'agent', isSidechain: false,
                    content: [{ type: 'text', text: `synthetic text ${token}`, uuid: `text-${token}`, parentUUID: null }],
                }]);
            });
        }
        const second = hook.getCurrent();
        expect(storage.getState().sessionMessages[SESSION_ID].messagesVersion).toBeGreaterThan(initialMessagesVersion);
        expect(storage.getState().sessionMessages[SESSION_ID].subagentSourceVersion).toBe(initialSourceVersion);
        expect(second.messages).toBe(first.messages);
        expect(second.subagents).toBe(first.subagents);
        expect(second.participantTargets).toBe(first.participantTargets);
        expect(second.sidechainIds).toBe(first.sidechainIds);
        expect({ input: inputReadCount, kind: kindReadCount }).toEqual(readsAfterInitialRender);
        await hook.unmount();
    });

    it('publishes a teammate shutdown when streamed child text completes without changing its identity', async () => {
        const call: NormalizedMessage = {
            id: 'agent-call', localId: null, createdAt: 1000, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'agent', name: 'Agent', input: { name: 'Beta', team_name: 'probe' }, description: null, uuid: 'agent-call', parentUUID: null }],
        };
        function textSnapshot(text: string, segmentState: 'streaming' | 'complete'): NormalizedMessage {
            return {
                id: 'shutdown', localId: 'shutdown', createdAt: 2000, role: 'agent', isSidechain: true, sidechainId: 'agent',
                meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'shutdown', segmentState, updatedAtMs: segmentState === 'complete' ? 3000 : 2000 } },
                content: [{ type: 'text', text, uuid: 'shutdown', parentUUID: null }],
            };
        }
        const session = createSessionFixture({ id: SESSION_ID, active: true, activeAt: Date.now(), metadata: { path: '/project', host: 'test', flavor: 'claude' } });
        storage.getState().applyMessages(SESSION_ID, [call, textSnapshot('{"type":"shutdown_approved","from":', 'streaming')]);
        const hook = await renderHook(() => {
            const messages = useSessionSubagentSourceMessages(SESSION_ID);
            return { messages, ...useSessionSubagents({ sessionId: SESSION_ID, session, messages }) };
        });
        expect(hook.getCurrent().subagents).toMatchObject([{ id: 'agent_team_member:probe:Beta@probe', status: 'running' }]);
        const firstRoot = hook.getCurrent().messages[0];
        if (firstRoot.kind !== 'tool-call') throw new Error('Expected Agent call');
        const firstChild = firstRoot.children[0];

        await act(async () => {
            storage.getState().applyMessages(SESSION_ID, [textSnapshot('{"type":"shutdown_approved","from":"Beta"}', 'complete')]);
        });

        expect(hook.getCurrent().subagents).toMatchObject([{ id: 'agent_team_member:probe:Beta@probe', status: 'terminated' }]);
        const nextRoot = hook.getCurrent().messages[0];
        if (nextRoot.kind !== 'tool-call') throw new Error('Expected Agent call');
        expect(nextRoot.children[0]).toMatchObject({ id: firstChild.id, createdAt: firstChild.createdAt, text: '{"type":"shutdown_approved","from":"Beta"}' });
        await hook.unmount();
    });

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

    it('derives a real roster without reading or serializing full tool payloads', async () => {
        let payloadReads = 0;
        const payload = {
            runId: 'run_1', status: 'running',
            get output() { payloadReads += 1; return 'synthetic output '.repeat(65_536); },
        };
        const message = runningSubAgentRunMessage(payload);
        message.tool = { ...message.tool, input: payload };
        const child = createToolCallMessageFixture({
            id: 'payload-tool',
            tool: { ...message.tool, id: 'payload-tool', name: 'Bash', state: 'completed' },
        });
        message.children = [child];
        const session = createSessionFixture({ id: SESSION_ID, active: true, activeAt: Date.now() });
        seed(message, 1);
        const hook = await renderHook(() => {
            const messages = useSessionSubagentSourceMessages(SESSION_ID);
            return { messages, ...useSessionSubagents({ sessionId: SESSION_ID, session, messages }) };
        });
        const first = hook.getCurrent();
        expect(first.subagents).toMatchObject([{ id: 'execution_run:run_1', status: 'running' }]);
        expect(payloadReads).toBe(0);
        await act(async () => {
            seed({ ...message, tool: { ...message.tool }, children: [{ ...child, tool: { ...child.tool } }] }, 2);
        });

        expect(payloadReads).toBe(0);
        expect(hook.getCurrent().messages).toBe(first.messages);
        expect(hook.getCurrent().subagents).toBe(first.subagents);
        await hook.unmount();
    });
});
