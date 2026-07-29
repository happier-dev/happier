import { describe, expect, it } from 'vitest';

import { AgentStateSchema } from '@/sync/domains/state/storageTypes';

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

    it('validates terminal pending handoff state shape', () => {
        const parsed = AgentStateSchema.safeParse({
            terminalControl: {
                pendingHandoffV1: {
                    v: 1,
                    status: 'deferred_until_terminal_turn_finishes',
                    pendingCount: 2,
                    updatedAtMs: 123,
                    interruptRequired: false,
                },
            },
        });

        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.terminalControl?.pendingHandoffV1?.status).toBe('deferred_until_terminal_turn_finishes');
    });

    it('rejects invalid terminal pending handoff status values', () => {
        const parsed = AgentStateSchema.safeParse({
            terminalControl: {
                pendingHandoffV1: {
                    v: 1,
                    status: 'not-a-real-status',
                    pendingCount: 2,
                    updatedAtMs: 123,
                },
            },
        });

        expect(parsed.success).toBe(false);
    });
});
