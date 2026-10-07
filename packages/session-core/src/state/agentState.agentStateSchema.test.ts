import { describe, expect, it } from 'vitest';

import { AgentStateSchema } from "./agentState.js";

describe('AgentStateSchema', () => {
    it('parses JSON strings for backward compatibility', () => {
        const parsed = AgentStateSchema.safeParse(JSON.stringify({ controlledByUser: true }));
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.controlledByUser).toBe(true);
    });

    it('accepts object values', () => {
        const parsed = AgentStateSchema.safeParse({ controlledByUser: true });
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.controlledByUser).toBe(true);
    });

    it('drops unknown stored fields while preserving completion evidence and opaque tool arguments', () => {
        const parsed = AgentStateSchema.parse(JSON.stringify({
            controlledByUser: true,
            futureState: { enabled: true },
            localControl: { attached: true, futureControl: true },
            completedRequests: {
                question: {
                    tool: 'AskUserQuestion', status: 'approved',
                    arguments: { futureToolArgument: { enabled: true } },
                    answers: { Question: 'Answer' },
                    structuredAnswersV1: { Question: ['Answer'] },
                    allowTools: ['Read'],
                    responseTarget: { kind: 'source_owned', futureSourceField: { enabled: true } },
                    futureCompletion: true,
                },
            },
        }));

        expect(parsed).not.toHaveProperty('futureState');
        expect(parsed.localControl).toEqual({ attached: true });
        expect(parsed.completedRequests?.question).toEqual({
            tool: 'AskUserQuestion', status: 'approved',
            arguments: { futureToolArgument: { enabled: true } },
            answers: { Question: 'Answer' }, structuredAnswersV1: { Question: ['Answer'] },
            allowTools: ['Read'],
            responseTarget: { kind: 'source_owned', futureSourceField: { enabled: true } },
        });
        expect(AgentStateSchema.safeParse({ controlledByUser: 'invalid', futureState: true }).success).toBe(false);
    });

    it('accepts a completed source-owned Claude dialog choice', () => {
        const parsed = AgentStateSchema.safeParse({
            requests: {},
            completedRequests: {
                claude_dialog_choice_1: {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    source: 'claude_unified_terminal_dialog_choice',
                    arguments: {
                        questions: [{
                            header: 'Claude needs attention',
                            question: 'Yes, I trust this folder',
                            options: [],
                            multiSelect: false,
                        }],
                    },
                    createdAt: 100,
                    completedAt: 200,
                    status: 'approved',
                    decision: 'allow',
                    answers: { 'Yes, I trust this folder': 'trust_once' },
                    dialogId: 'trust_folder',
                    dialogChoice: 'trust_once',
                },
            },
        });

        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.requests).toEqual({});
        expect(parsed.data.completedRequests?.claude_dialog_choice_1).toMatchObject({
            status: 'approved',
            source: 'claude_unified_terminal_dialog_choice',
            answers: { 'Yes, I trust this folder': 'trust_once' },
            dialogId: 'trust_folder',
            dialogChoice: 'trust_once',
        });
    });

});
