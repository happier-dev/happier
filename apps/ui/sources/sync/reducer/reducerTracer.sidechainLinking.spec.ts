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
});
