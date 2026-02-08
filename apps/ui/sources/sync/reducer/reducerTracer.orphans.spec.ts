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

function buildRootMessage(): NormalizedMessage {
    return {
        id: 'sidechain1',
        localId: null,
        createdAt: 2000,
        role: 'agent',
        isSidechain: true,
        content: [{
            type: 'sidechain',
            uuid: 'sidechain-uuid',
            prompt: 'Search for files',
        }],
    };
}

describe('reducerTracer orphan handling', () => {
    it('buffers orphan messages until parent arrives', () => {
        const state = createTracer();
        traceMessages(state, [buildTaskMessage()]);

        const orphan: NormalizedMessage = {
            id: 'orphan1',
            localId: null,
            createdAt: 3000,
            role: 'agent',
            isSidechain: true,
            content: [{
                type: 'text',
                text: 'Orphan message',
                uuid: 'orphan-uuid',
                parentUUID: 'sidechain-uuid',
            }],
        };

        let traced = traceMessages(state, [orphan]);
        expect(traced).toHaveLength(0);
        expect(state.orphanMessages.has('sidechain-uuid')).toBe(true);

        traced = traceMessages(state, [buildRootMessage()]);
        expect(traced).toHaveLength(2);
        expect(traced[0].id).toBe('sidechain1');
        expect(traced[0].sidechainId).toBe('tool1');
        expect(traced[1].id).toBe('orphan1');
        expect(traced[1].sidechainId).toBe('tool1');
        expect(state.orphanMessages.has('sidechain-uuid')).toBe(false);
    });

    it('processes recursively buffered orphan chains in order', () => {
        const state = createTracer();
        traceMessages(state, [buildTaskMessage()]);

        const orphan2: NormalizedMessage = {
            id: 'orphan2',
            localId: null,
            createdAt: 4000,
            role: 'agent',
            isSidechain: true,
            content: [{
                type: 'text',
                text: 'Second orphan',
                uuid: 'orphan2-uuid',
                parentUUID: 'orphan1-uuid',
            }],
        };

        const orphan1: NormalizedMessage = {
            id: 'orphan1',
            localId: null,
            createdAt: 3000,
            role: 'agent',
            isSidechain: true,
            content: [{
                type: 'text',
                text: 'First orphan',
                uuid: 'orphan1-uuid',
                parentUUID: 'sidechain-uuid',
            }],
        };

        traceMessages(state, [orphan2, orphan1]);
        expect(state.orphanMessages.has('orphan1-uuid')).toBe(true);
        expect(state.orphanMessages.has('sidechain-uuid')).toBe(true);

        const traced = traceMessages(state, [buildRootMessage()]);

        expect(traced).toHaveLength(3);
        expect(traced[0].id).toBe('sidechain1');
        expect(traced[1].id).toBe('orphan1');
        expect(traced[2].id).toBe('orphan2');
        expect(traced[0].sidechainId).toBe('tool1');
        expect(traced[1].sidechainId).toBe('tool1');
        expect(traced[2].sidechainId).toBe('tool1');
        expect(state.orphanMessages.size).toBe(0);
    });
});
