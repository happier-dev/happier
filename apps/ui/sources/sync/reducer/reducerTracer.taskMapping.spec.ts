import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../typesRaw';
import { createTracer, traceMessages } from './reducerTracer';

describe('reducerTracer task mapping', () => {
    it('creates an initial empty tracer state', () => {
        const state = createTracer();
        expect(state.taskTools.size).toBe(0);
        expect(state.promptToTaskId.size).toBe(0);
        expect(state.uuidToSidechainId.size).toBe(0);
        expect(state.orphanMessages.size).toBe(0);
        expect(state.processedIds.size).toBe(0);
    });

    it('returns non-sidechain messages immediately', () => {
        const state = createTracer();
        const messages: NormalizedMessage[] = [
            {
                id: 'msg1',
                localId: null,
                createdAt: 1000,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: 'Hello' },
            },
            {
                id: 'msg2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: 'Hi there', uuid: 'uuid1', parentUUID: null }],
            },
        ];

        const traced = traceMessages(state, messages);

        expect(traced).toHaveLength(2);
        expect(traced[0].sidechainId).toBeUndefined();
        expect(traced[1].sidechainId).toBeUndefined();
        expect(state.processedIds.size).toBe(2);
    });

    it('treats explicit sidechainId as authoritative even when isSidechain is false', () => {
        const state = createTracer();
        const messages: NormalizedMessage[] = [
            {
                id: 'msg-sidechain-explicit',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                sidechainId: 'tool_task_1',
                content: [{ type: 'text', text: 'child', uuid: 'uuid-child', parentUUID: null }],
            },
        ];

        const traced = traceMessages(state, messages);

        expect(traced).toHaveLength(1);
        expect(traced[0].sidechainId).toBe('tool_task_1');
        expect(state.uuidToSidechainId.get('uuid-child')).toBe('tool_task_1');
    });

    it('tracks Task tool calls by prompt and tool id', () => {
        const state = createTracer();
        const messages: NormalizedMessage[] = [
            {
                id: 'msg1',
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
                    uuid: 'uuid1',
                    parentUUID: null,
                }],
            },
        ];

        traceMessages(state, messages);

        expect(state.taskTools.size).toBe(1);
        expect(state.taskTools.get('msg1')).toEqual({
            toolCallId: 'tool1',
            prompt: 'Search for files',
        });
        expect(state.promptToTaskId.get('Search for files')).toBe('tool1');
    });

    it('falls back to message.id for Task tool calls without content.id', () => {
        const state = createTracer();
        const messages: NormalizedMessage[] = [
            {
                id: 'msg1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: null,
                        name: 'Task',
                        input: { prompt: 'Search for files' },
                        description: null,
                        uuid: 'uuid1',
                        parentUUID: null,
                    } as any,
                ],
            },
        ];

        traceMessages(state, messages);

        expect(state.taskTools.get('msg1')).toEqual({
            toolCallId: 'msg1',
            prompt: 'Search for files',
        });
        expect(state.promptToTaskId.get('Search for files')).toBe('msg1');
    });

    it('skips messages that were already processed', () => {
        const state = createTracer();
        const message: NormalizedMessage = {
            id: 'msg1',
            localId: null,
            createdAt: 1000,
            role: 'user',
            isSidechain: false,
            content: { type: 'text', text: 'Hello' },
        };

        const traced1 = traceMessages(state, [message]);
        expect(traced1).toHaveLength(1);

        const traced2 = traceMessages(state, [message]);
        expect(traced2).toHaveLength(0);
    });
});
