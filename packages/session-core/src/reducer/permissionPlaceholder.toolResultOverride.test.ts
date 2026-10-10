import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from "./reducer.js";
import type { NormalizedMessage } from "../raw/index.js";
import type { AgentState } from '../state/index.js';

describe('Permission placeholder should not override real tool output', () => {
    it('defers historical completed questions until their surrounding history is loaded', () => {
        const state = createReducer();
        const agentState: AgentState = {
            requests: {},
            completedRequests: {
                historicalQuestion: {
                    tool: 'AskUserQuestion',
                    arguments: { questions: [] },
                    createdAt: 100,
                    completedAt: 200,
                    status: 'approved',
                    answers: { choice: 'yes' },
                },
            },
        };
        const textRow = (seq: number, createdAt: number): NormalizedMessage => ({
            id: `row-${seq}`, localId: null, seq, createdAt,
            role: 'agent', isSidechain: false,
            content: [{ type: 'text', text: 'Transcript content', uuid: `text-${seq}`, parentUUID: null }],
        });

        expect(reducer(state, [], agentState).messages).toEqual([]);
        const coldPage = Array.from({ length: 12 }, (_, index) => textRow(151 + index, 1000 + index));
        expect(reducer(state, coldPage, agentState).messages.every((message) => message.kind !== 'tool-call')).toBe(true);
        expect(reducer(state, [], agentState).messages).toEqual([]);

        const olderPage = Array.from({ length: 150 }, (_, index) => textRow(index + 1, index + 1));
        const loaded = reducer(state, olderPage, agentState);
        const question = loaded.messages.find((message) => message.kind === 'tool-call');
        expect(question).toMatchObject({ createdAt: 100, tool: { result: { answers: { choice: 'yes' } } } });
        expect(reducer(state, [], agentState).messages).toEqual([]);
    });

    it('does not count an older pending placeholder as loaded transcript history', () => {
        const state = createReducer();
        reducer(state, [], { requests: { pendingQuestion: {
            tool: 'AskUserQuestion', arguments: { questions: [] }, createdAt: 1,
        } } });
        const agentState: AgentState = {
            completedRequests: { historicalQuestion: {
                tool: 'AskUserQuestion', arguments: { questions: [] }, createdAt: 100,
                completedAt: 200, status: 'approved', answers: { choice: 'yes' },
            } },
        };
        const coldPage: NormalizedMessage[] = [{
            id: 'recent-transcript', localId: null, seq: 151, createdAt: 1000,
            role: 'agent', isSidechain: false,
            content: [{ type: 'text', text: 'Recent transcript', uuid: 'recent-text', parentUUID: null }],
        }];
        expect(reducer(state, coldPage, agentState).messages.every((message) => message.kind !== 'tool-call')).toBe(true);
        expect(state.toolIdToMessageId.has('pendingQuestion')).toBe(true);
        expect(state.toolIdToMessageId.has('historicalQuestion')).toBe(false);
    });

    it('keeps pending questions visible before history loads and completes the same row', () => {
        const state = createReducer();
        const request = { tool: 'AskUserQuestion', arguments: { questions: [] }, createdAt: 100 };
        const pending = reducer(state, [], { requests: { question: request }, completedRequests: {} });
        expect(pending.messages).toHaveLength(1);
        const completed = reducer(state, [], {
            requests: {},
            completedRequests: { question: { ...request, status: 'approved', completedAt: 200, answers: { choice: 'yes' } } },
        });
        expect(completed.messages).toHaveLength(1);
        expect(completed.messages[0]).toMatchObject({ id: pending.messages[0]?.id, tool: { state: 'completed', result: { answers: { choice: 'yes' } } } });
    });

    it('retains completed AgentState-only answers when the entire transcript has been loaded', () => {
        const state = createReducer();
        const agentState: AgentState = {
            completedRequests: { question: {
                tool: 'AskUserQuestion', arguments: { questions: [] }, createdAt: 100,
                completedAt: 200, status: 'approved', answers: { choice: 'yes' },
            } },
        };
        expect(reducer(state, [], agentState).messages).toEqual([]);
        const loaded = reducer(state, [], agentState, [], { mainHistoryStartLoaded: true });
        expect(loaded.messages).toHaveLength(1);
        expect(loaded.messages[0]).toMatchObject({ tool: { result: { answers: { choice: 'yes' } } } });
    });

    it('updates an approved permission-only tool message when a tool-result arrives later (even without tool-call)', () => {
        const state = createReducer();

        const messages: NormalizedMessage[] = [
            {
                id: 'msg-tool-result',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool2',
                    content: { stdout: 'REAL_OUTPUT', exit_code: 0 },
                    is_error: false,
                    uuid: 'uuid-tool2',
                    parentUUID: null,
                }],
            },
        ];

        const agentState: AgentState = {
            requests: {},
            completedRequests: {
                tool2: {
                    tool: 'Write',
                    arguments: { file_path: '/tmp/a.txt', content: 'hello' },
                    status: 'approved',
                    createdAt: 1000,
                    completedAt: 1100,
                },
            },
        };

        const result = reducer(state, messages, agentState);
        const toolMsg = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.permission?.id === 'tool2');
        expect(toolMsg).toBeTruthy();
        expect(toolMsg?.kind).toBe('tool-call');
        if (toolMsg?.kind !== 'tool-call') return;

        expect(toolMsg.tool?.state).toBe('completed');
        expect(toolMsg.tool?.result).toMatchObject({ stdout: 'REAL_OUTPUT', exit_code: 0 });
    });
});

