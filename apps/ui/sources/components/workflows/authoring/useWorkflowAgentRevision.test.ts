import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { useWorkflowAgentRevision } from './useWorkflowAgentRevision';

const sessionId = 'revision-session';
const definitionId = '00000000-0000-4000-8000-000000000005';
const otherDefinitionId = '00000000-0000-4000-8000-000000000006';
const name = `mcp__happier__${getActionSpec('workflow.definition.update').bindings?.mcpToolName}`;
const definition = createWorkflowDefinitionFixture();
const previousState = storage.getState();

function text(id: string, seq: number): NormalizedMessage {
    return { id, seq, role: 'user', content: { type: 'text', text: id }, localId: null, createdAt: seq, isSidechain: false };
}

function call(id: string, seq: number): NormalizedMessage {
    return { id: `${id}-call`, seq, role: 'agent', localId: null, createdAt: seq, isSidechain: false,
        content: [{ type: 'tool-call', id, name, input: {}, description: null, uuid: id, parentUUID: null }] };
}

function receipt(id: string, seq: number, bodyVersion: number, savedDefinitionId = definitionId) {
    const result = JSON.stringify({ definitionId: savedDefinitionId, definition, access: 'owner',
        revision: { headerVersion: 1, bodyVersion }, metadata: { title: `Saved ${bodyVersion}` } });
    const message: NormalizedMessage = { id: `${id}-result`, seq, role: 'agent', localId: null, createdAt: seq, isSidechain: false,
        content: [{ type: 'tool-result', tool_use_id: id, content: result, is_error: false, uuid: `${id}-result`, parentUUID: null }] };
    return { result, message };
}

beforeEach(() => {
    storage.setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, seq: 0 }) }, sessionMessages: {} });
});
afterEach(async () => {
    await standardCleanup();
    vi.restoreAllMocks();
    storage.setState(previousState);
});

describe('Workflow Agent revision observation', () => {
    it('does no unchanged receipt admission or publication for ordinary arrivals in a large transcript', async () => {
        storage.getState().applyMessages(sessionId, Array.from({ length: 3_000 }, (_, index) => text(`history-${index}`, index + 1)));
        expect(storage.getState().sessions[sessionId]?.seq).toBe(3_000);
        const hook = await renderHook(() => useWorkflowAgentRevision(sessionId, definitionId, 'original'));
        const parsed = vi.spyOn(JSON, 'parse');
        const results = new Set<string>();
        for (let index = 0; index < 20; index += 1) {
            const id = `write-${index}`;
            const saved = receipt(id, 3_002 + index * 2, index + 1);
            results.add(saved.result);
            await act(async () => { storage.getState().applyMessages(sessionId, [call(id, 3_001 + index * 2), saved.message]); });
        }
        expect(hook.getCurrent()?.revision.bodyVersion).toBe(20);
        const admitted = hook.getCurrent();
        const publication = vi.fn();
        hook.subscribe(publication);
        parsed.mockClear();
        for (let index = 0; index < 8; index += 1) {
            await act(async () => { storage.getState().applyMessages(sessionId, [text(`ordinary-${index}`, 3_050 + index)]); });
        }
        expect(parsed.mock.calls.filter(([value]) => results.has(value))).toHaveLength(0);
        expect(publication).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toBe(admitted);

        const next = receipt('real-change', 3_061, 21);
        await act(async () => { storage.getState().applyMessages(sessionId, [call('real-change', 3_060), next.message]); });
        expect(hook.getCurrent()?.revision.bodyVersion).toBe(21);
        expect(parsed.mock.calls.filter(([value]) => value === next.result)).toHaveLength(1);
        expect(publication).toHaveBeenCalledTimes(1);
    });

    it('preserves opening in-flight completion, excludes delayed history and retires the source', async () => {
        storage.getState().applyMessages(sessionId, [call('in-flight', 1), text('opening-watermark', 100)]);
        expect(storage.getState().sessions[sessionId]?.seq).toBe(100);
        const hook = await renderHook(({ source }) => useWorkflowAgentRevision(sessionId, definitionId, source), {
            initialProps: { source: 'original' },
        });
        const old = receipt('delayed-history', 50, 99);
        await act(async () => { storage.getState().applyMessages(sessionId, [call('delayed-history', 49), old.message]); });
        expect(hook.getCurrent()).toBeNull();
        const completion = receipt('in-flight', 101, 2);
        await act(async () => { storage.getState().applyMessages(sessionId, [completion.message]); });
        expect(hook.getCurrent()?.revision.bodyVersion).toBe(2);

        await hook.rerender({ source: 'copied-source' });
        expect(hook.getCurrent()).toBeNull();
        await act(async () => { storage.getState().applyMessages(sessionId, [text('unrelated', 102)]); });
        expect(hook.getCurrent()).toBeNull();
        const foreign = receipt('foreign-definition', 104, 200, otherDefinitionId);
        await act(async () => { storage.getState().applyMessages(sessionId, [call('foreign-definition', 103), foreign.message]); });
        expect(hook.getCurrent()).toBeNull();
        const next = receipt('new-source', 106, 3);
        await act(async () => { storage.getState().applyMessages(sessionId, [call('new-source', 105), next.message]); });
        expect(hook.getCurrent()?.revision.bodyVersion).toBe(3);
        await act(async () => storage.getState().resetSessionMessages(sessionId));
        expect(hook.getCurrent()).toBeNull();
        await act(async () => { storage.getState().applyMessages(sessionId, [call('after-reset', 107), receipt('after-reset', 108, 4).message]); });
        expect(hook.getCurrent()?.revision.bodyVersion).toBe(4);
        await act(async () => storage.getState().evictSessionMessages(sessionId));
        expect(hook.getCurrent()).toBeNull();
    });

    it('does not re-admit a completed nested receipt when a sibling changes its parent row', async () => {
        const parent = call('parent', 1);
        if (parent.role !== 'agent' || parent.content[0]?.type !== 'tool-call') throw new Error('Expected the parent tool');
        parent.content[0].name = 'Task';
        parent.content[0].input = { prompt: 'Revise the workflow', run_in_background: true };
        const root: NormalizedMessage = { id: 'sidechain-root', seq: 2, localId: null, createdAt: 2,
            role: 'agent', isSidechain: true, sidechainId: 'parent',
            content: [{ type: 'sidechain', uuid: 'sidechain-root', prompt: 'Revise the workflow' }] };
        const nested = call('nested', 3);
        if (nested.role !== 'agent' || nested.content[0]?.type !== 'tool-call') throw new Error('Expected the nested tool');
        nested.isSidechain = true;
        nested.sidechainId = 'parent';
        nested.content[0].parentUUID = 'sidechain-root';
        storage.getState().applyMessages(sessionId, [parent, root, nested, text('opening-watermark', 100)]);
        expect(storage.getState().sessions[sessionId]?.seq).toBe(100);
        const hook = await renderHook(() => useWorkflowAgentRevision(sessionId, definitionId, 'nested-source'));
        const saved = receipt('nested', 101, 2);
        saved.message.isSidechain = true;
        saved.message.sidechainId = 'parent';
        if (saved.message.role !== 'agent' || saved.message.content[0]?.type !== 'tool-result') throw new Error('Expected the nested result');
        saved.message.content[0].parentUUID = 'nested';
        await act(async () => { storage.getState().applyMessages(sessionId, [saved.message]); });
        expect(hook.getCurrent()?.revision.bodyVersion).toBe(2);
        const admitted = hook.getCurrent();
        const parentBefore = Object.values(storage.getState().sessionMessages[sessionId]!.messagesById)
            .find(message => message.kind === 'tool-call');
        const parsed = vi.spyOn(JSON, 'parse');
        const publication = vi.fn();
        hook.subscribe(publication);
        await act(async () => { storage.getState().applyMessages(sessionId, [{
            id: 'sidechain-text', seq: 102, localId: null, createdAt: 102, role: 'agent',
            isSidechain: true, sidechainId: 'parent',
            content: [{ type: 'text', text: 'Ordinary sibling text', uuid: 'sidechain-text', parentUUID: 'sidechain-root' }],
        }]); });
        const parentAfter = Object.values(storage.getState().sessionMessages[sessionId]!.messagesById)
            .find(message => message.kind === 'tool-call');
        // Prove the real sidechain reducer rebuilt the containing row.
        expect(parentAfter).not.toBe(parentBefore);
        expect(parsed.mock.calls.filter(([value]) => value === saved.result)).toHaveLength(0);
        expect(publication).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toBe(admitted);
    });

    it('admits a completed receipt when its committed sequence first crosses the opening watermark', async () => {
        const pendingCall = call('sequence-upgrade', 1);
        const saved = receipt('sequence-upgrade', 2, 2);
        delete pendingCall.seq;
        delete saved.message.seq;
        storage.getState().applyMessages(sessionId, [pendingCall, saved.message, text('opening-watermark', 100)]);
        expect(storage.getState().sessions[sessionId]?.seq).toBe(100);
        const hook = await renderHook(() => useWorkflowAgentRevision(sessionId, definitionId, 'sequence-source'));
        expect(hook.getCurrent()).toBeNull();
        const committedCall = { ...call('sequence-upgrade', 101), id: 'committed-call-row' };
        await act(async () => { storage.getState().applyMessages(sessionId, [committedCall]); });
        const committed = Object.values(storage.getState().sessionMessages[sessionId]!.messagesById)
            .find(message => message.kind === 'tool-call' && message.tool.id === 'sequence-upgrade');
        // The reducer can add the committed seq without changing the saved receipt.
        expect(committed).toMatchObject({ seq: 101, tool: { state: 'completed', result: saved.result } });
        expect(hook.getCurrent()?.revision.bodyVersion).toBe(2);
    });
});
