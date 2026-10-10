import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import type { AgentState } from '@happier-dev/session-core/state';
import { reducePublicShareTranscript } from './publicShareTranscript';

// Public layout-v1 metadata carries completion outcomes, without private arguments or answers.
const presentationAgentState: AgentState = {
    completedRequests: {
        question: { tool: 'AskUserQuestion', createdAt: 1, completedAt: 2, status: 'approved' },
    },
};

function textRow(seq: number, createdAt: number): NormalizedMessage {
    return {
        id: `row-${seq}`, localId: null, seq, createdAt, role: 'user', isSidechain: false,
        content: { type: 'text', text: `row ${seq}` },
    };
}

describe('public share transcript reduction', () => {
    it('defers historical completion facts and retains them when the terminal page adds no rows', () => {
        const acceptedHistory = [textRow(3, 20), textRow(2, 30)];
        const partial = reducePublicShareTranscript(acceptedHistory, presentationAgentState);
        expect(partial.messages.map((message) => message.seq)).toEqual([2, 3]);
        expect(acceptedHistory.map((message) => message.seq)).toEqual([3, 2]);

        const complete = reducePublicShareTranscript(acceptedHistory, presentationAgentState, true);
        expect(complete.messages.filter((message) => message.kind === 'tool-call')).toEqual([
            expect.objectContaining({ tool: expect.objectContaining({
                permission: expect.objectContaining({ id: 'question', status: 'approved' }),
                state: 'completed', result: 'Approved',
            }) }),
        ]);
        expect(complete.messages.filter((message) => message.kind === 'user-text').map((message) => message.seq))
            .toEqual([2, 3]);
    });

    it('retains metadata-only completion facts in a complete empty history', () => {
        expect(reducePublicShareTranscript([], presentationAgentState).messages).toEqual([]);
        expect(reducePublicShareTranscript([], presentationAgentState, false).messages).toEqual([]);
        expect(reducePublicShareTranscript([], presentationAgentState, true).messages).toEqual([
            expect.objectContaining({ tool: expect.objectContaining({
                permission: expect.objectContaining({ id: 'question', status: 'approved' }),
                result: 'Approved',
            }) }),
        ]);
    });

    it('retains real transcript answers instead of replacing them with public approval metadata', () => {
        const result: NormalizedMessage = {
            id: 'question-result', localId: null, seq: 3, createdAt: 100,
            role: 'agent', isSidechain: false,
            content: [{ type: 'tool-result', tool_use_id: 'question',
                content: { answers: { choice: 'actual answer' } }, is_error: false,
                uuid: 'result-uuid', parentUUID: null }],
        };
        const reduced = reducePublicShareTranscript([result], presentationAgentState, true);
        expect(reduced.messages).toEqual([
            expect.objectContaining({ tool: expect.objectContaining({
                permission: expect.objectContaining({ id: 'question', status: 'approved' }),
                state: 'completed', result: { answers: { choice: 'actual answer' } },
            }) }),
        ]);
    });
});
