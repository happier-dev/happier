import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../typesRaw';
import { createTracer, traceMessages } from './reducerTracer';

function buildTaskMessage(): NormalizedMessage {
    return {
        id: 'task1',
        localId: null,
        createdAt: 1000,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id: 'tool1',
            name: 'Task',
            input: { prompt: 'Search for files' },
            description: null,
            uuid: 'task-uuid',
            parentUUID: null,
        }],
    };
}

function buildSidechainRoot(prompt = 'Search for files'): NormalizedMessage {
    return {
        id: 'sidechain1',
        localId: null,
        createdAt: 2000,
        role: 'agent',
        isSidechain: true,
        content: [{
            type: 'sidechain',
            uuid: 'sidechain-uuid',
            prompt,
        }],
    };
}

describe('reducerTracer sidechain linking', () => {
    it('uses explicit sidechainId from providers when available', () => {
        const state = createTracer();
        const sidechainRoot = buildSidechainRoot('Unrelated prompt') as any;
        sidechainRoot.sidechainId = 'tool_task_123';

        const traced = traceMessages(state, [sidechainRoot]);
        expect(traced).toHaveLength(1);
        expect(traced[0].sidechainId).toBe('tool_task_123');
    });

    it('treats meta.sidechainId as an explicit sidechainId', () => {
        const state = createTracer();
        const msg: NormalizedMessage = {
            id: 'msg_meta_sc_1',
            localId: null,
            createdAt: 2100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'text',
                text: 'subagent output',
                uuid: 'meta-sc-uuid',
                parentUUID: null,
            }],
            meta: { sidechainId: 'tool_task_meta_1' } as any,
        };

        const traced = traceMessages(state, [msg]);
        expect(traced).toHaveLength(1);
        expect(traced[0].sidechainId).toBe('tool_task_meta_1');
    });

    it('assigns sidechainId to sidechain root messages using Task prompt mapping', () => {
        const state = createTracer();
        traceMessages(state, [buildTaskMessage()]);

        const traced = traceMessages(state, [buildSidechainRoot()]);

        expect(traced).toHaveLength(1);
        expect(traced[0].sidechainId).toBe('tool1');
        expect(state.uuidToSidechainId.get('sidechain-uuid')).toBe('tool1');
    });

    it('propagates sidechainId through parent relationships', () => {
        const state = createTracer();
        traceMessages(state, [buildTaskMessage(), buildSidechainRoot()]);

        const sidechainChild: NormalizedMessage = {
            id: 'child1',
            localId: null,
            createdAt: 3000,
            role: 'agent',
            isSidechain: true,
            content: [{
                type: 'text',
                text: 'Searching...',
                uuid: 'child-uuid',
                parentUUID: 'sidechain-uuid',
            }],
        };

        const traced = traceMessages(state, [sidechainChild]);

        expect(traced).toHaveLength(1);
        expect(traced[0].sidechainId).toBe('tool1');
        expect(state.uuidToSidechainId.get('child-uuid')).toBe('tool1');
    });

    it('falls back to parent-based propagation when sidechain flag is missing', () => {
        const state = createTracer();
        traceMessages(state, [buildTaskMessage(), buildSidechainRoot()]);

        const childWithoutFlag: NormalizedMessage = {
            id: 'child2',
            localId: null,
            createdAt: 3001,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'text',
                text: 'still sidechain',
                uuid: 'child-uuid-2',
                parentUUID: 'sidechain-uuid',
            }],
        };

        const traced = traceMessages(state, [childWithoutFlag]);
        expect(traced).toHaveLength(1);
        // IMPORTANT: parentUUID alone is not authoritative for sidechains. If the provider does not
        // explicitly mark the message as a sidechain (or include a sidechainId), we must treat it
        // as a main-timeline message to avoid folding main transcript messages into sub-agent threads.
        expect(traced[0].sidechainId).toBeUndefined();
        expect(state.uuidToSidechainId.get('child-uuid-2')).toBeUndefined();
    });

    it('buffers sidechain roots until Task prompt mapping exists (prevents main transcript leakage)', () => {
        const state = createTracer();

        // Sidechain root arrives before the Task tool-call (out-of-order delivery).
        const tracedBeforeTask = traceMessages(state, [buildSidechainRoot()]);
        expect(tracedBeforeTask).toHaveLength(0);

        // Once the Task tool-call arrives, the buffered root can be linked by prompt.
        const tracedAfterTask = traceMessages(state, [buildTaskMessage()]);
        expect(tracedAfterTask.map((m) => m.id).sort()).toEqual(['sidechain1', 'task1']);
        const root = tracedAfterTask.find((m) => m.id === 'sidechain1');
        expect(root?.sidechainId).toBe('tool1');
        expect(state.uuidToSidechainId.get('sidechain-uuid')).toBe('tool1');
    });
});
