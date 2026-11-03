import { describe, expect, it } from 'vitest';
import { CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY } from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';

import { AgentStateSchema } from "./agentState.js";
import { listPendingRequests } from '../pending/listPendingRequests.js';

describe('AgentStateSchema', () => {
    it('reads optional startup progress and ignores unknown progress without discarding Session state', () => {
        const state = { controlledByUser: false, workStatus: 'waiting_for_startup_lock' };
        expect(AgentStateSchema.parse(JSON.stringify(state))).toMatchObject(state);
        expect(AgentStateSchema.parse({ controlledByUser: false, workStatus: 'future_progress' }))
            .toMatchObject({ controlledByUser: false, workStatus: null });
        expect(AgentStateSchema.parse({ controlledByUser: false })).not.toHaveProperty('workStatus');
    });
    it('retains the host question mode and its one current handler across a stored read', () => {
        const request = { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [] }, createdAt: 1,
            questionV1: { mode: 'continue', assumption: 'Use revision 3', lasting: true },
            currentHandler: { kind: 'person' } };
        expect(AgentStateSchema.parse(JSON.stringify({ requests: { question: request } })).requests?.question)
            .toMatchObject(request);
        expect(listPendingRequests({ sessionId: 'worker', active: false,
            agentState: AgentStateSchema.parse({ requests: { question: request } }),
            actionConfirmations: null, presentationCompletedRequests: null, projected: null,
        }, [])).toMatchObject([{ questionV1: request.questionV1, currentHandler: request.currentHandler }]);
        expect(AgentStateSchema.safeParse({ requests: { question: { ...request,
            currentHandler: { kind: 'session', sessionId: '' } } } }).success).toBe(false);
        expect(AgentStateSchema.safeParse({ requests: { question: { ...request,
            currentHandler: { kind: 'person', sessionId: 'unproven-manager' } } } }).success).toBe(false);
        expect(AgentStateSchema.safeParse({ requests: { question: { ...request,
            questionV1: { ...request.questionV1, targetAccountId: 'other' } } } }).success).toBe(false);
    });
    it('accepts absent and present protocol-owned current Session presentation state', () => {
        expect(AgentStateSchema.safeParse({}).success).toBe(true);
        expect(AgentStateSchema.parse({
            [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: {
                v: 1,
                hostNonce: 'host-nonce',
                revision: 0,
                statuses: [],
                widgets: [],
            },
        })).toMatchObject({
            [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: {
                v: 1,
                hostNonce: 'host-nonce',
                revision: 0,
            },
        });
    });

    it('retains witnessed completion identity and client category without inventing historical facts', () => {
        const parsed = AgentStateSchema.parse({ completedRequests: {
            current: { tool: 'Write', arguments: {}, createdAt: 100, completedAt: 200,
                status: 'approved', turnId: 'turn-1', answeringClientCategory: 'ios' },
            historical: { tool: 'Read', arguments: {}, createdAt: 50, completedAt: 60, status: 'approved' },
            malformed: { tool: 'Read', arguments: {}, createdAt: 50, completedAt: 60, status: 'approved', answeringClientCategory: 'account-user' },
        } });
        expect(parsed.completedRequests?.current).toMatchObject({
            turnId: 'turn-1', createdAt: 100, completedAt: 200, answeringClientCategory: 'ios',
        });
        expect(parsed.completedRequests?.historical).not.toHaveProperty('turnId');
        expect(parsed.completedRequests?.historical).not.toHaveProperty('answeringClientCategory');
        expect(parsed.completedRequests?.malformed.answeringClientCategory).toBeUndefined();
    });

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
