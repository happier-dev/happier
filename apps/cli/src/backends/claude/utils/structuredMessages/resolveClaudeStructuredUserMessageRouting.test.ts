import { describe, expect, it } from 'vitest';

import { resolveClaudeStructuredUserMessageRouting } from './resolveClaudeStructuredUserMessageRouting';

describe('resolveClaudeStructuredUserMessageRouting', () => {
    it('rewrites participant messages', () => {
        const resolved = resolveClaudeStructuredUserMessageRouting({
            text: 'Please sync with alpha.',
            meta: {
                happier: {
                    kind: 'participant_message.v1',
                    payload: {
                        recipient: {
                            kind: 'agent_team_member',
                            teamId: 'qa-team',
                            memberId: 'alpha@qa-team',
                            memberLabel: 'alpha',
                        },
                    },
                },
            },
        });

        expect(resolved?.kind).toBe('participant_message.v1');
        expect(resolved?.queuedText).toContain('Teammate: alpha (alpha@qa-team)');
    });

    it('rewrites subagent launch messages', () => {
        const resolved = resolveClaudeStructuredUserMessageRouting({
            text: 'ignored',
            meta: {
                happier: {
                    kind: 'subagent_launch.v1',
                    payload: {
                        kind: 'agent_team_create',
                        teamId: 'qa-team',
                    },
                },
            },
        });

        expect(resolved?.kind).toBe('subagent_launch.v1');
        expect(resolved?.queuedText).toContain('Create a new Agent Team');
    });

    it('rewrites subagent command messages', () => {
        const resolved = resolveClaudeStructuredUserMessageRouting({
            text: 'ignored',
            meta: {
                happier: {
                    kind: 'subagent_command.v1',
                    payload: {
                        kind: 'agent_team_delete',
                        teamId: 'qa-team',
                    },
                },
            },
        });

        expect(resolved?.kind).toBe('subagent_command.v1');
        expect(resolved?.queuedText).toContain('Delete the Agent Team');
    });

    it('returns null for unrelated metadata', () => {
        const resolved = resolveClaudeStructuredUserMessageRouting({
            text: 'hello',
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {},
                },
            },
        });

        expect(resolved).toBeNull();
    });
});
