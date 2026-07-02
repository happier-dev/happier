import { describe, expect, it } from 'vitest';

import {
    formatClaudeAgentTeamCommandPrompt,
    formatClaudeAgentTeamLaunchPrompt,
    formatClaudeTeamRoutedPrompt,
    parseParticipantMessageMeta,
    parseSubagentCommandMeta,
    parseSubagentLaunchMeta,
    resolveClaudeStructuredUserMessageRouting,
} from './index.js';

describe('Claude Agent Teams routing leaf', () => {
    it('routes participant messages through the teammate prompt', () => {
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
        expect(resolved?.queuedText).toContain('Please sync with alpha.');
    });

    it('routes subagent launch metadata through the launch prompt', () => {
        const parsed = parseSubagentLaunchMeta({
            happier: {
                kind: 'subagent_launch.v1',
                payload: {
                    kind: 'agent_team_create',
                    teamId: 'qa-team',
                },
            },
        });

        expect(parsed?.payload.kind).toBe('agent_team_create');
        expect(parsed ? formatClaudeAgentTeamLaunchPrompt({ payload: parsed.payload }) : '').toContain('Create a new Agent Team');
    });

    it('routes subagent command metadata through the command prompt', () => {
        const parsed = parseSubagentCommandMeta({
            happier: {
                kind: 'subagent_command.v1',
                payload: {
                    kind: 'agent_team_delete',
                    teamId: 'qa-team',
                },
            },
        });

        expect(parsed?.payload.kind).toBe('agent_team_delete');
        expect(parsed ? formatClaudeAgentTeamCommandPrompt({ payload: parsed.payload }) : '').toContain('Delete the Agent Team');
    });

    it('parses and formats broadcast participant routing safely', () => {
        const parsed = parseParticipantMessageMeta({
            happier: {
                kind: 'participant_message.v1',
                payload: {
                    recipient: {
                        kind: 'agent_team_broadcast',
                        teamId: '../qa team',
                    },
                },
            },
        });

        expect(parsed?.recipient.kind).toBe('agent_team_broadcast');
        const prompt = formatClaudeTeamRoutedPrompt({
            originalText: 'hello team',
            recipient: parsed!.recipient,
        });
        expect(prompt).toContain('~/.claude/teams/team/config.json');
        expect(prompt).toContain('hello team');
    });

    it('returns null for unrelated structured metadata', () => {
        expect(resolveClaudeStructuredUserMessageRouting({
            text: 'hello',
            meta: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: {},
                },
            },
        })).toBeNull();
    });
});
