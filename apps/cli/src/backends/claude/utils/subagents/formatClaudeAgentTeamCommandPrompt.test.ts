import { describe, expect, it } from 'vitest';

import { formatClaudeAgentTeamCommandPrompt } from './formatClaudeAgentTeamCommandPrompt';

describe('formatClaudeAgentTeamCommandPrompt', () => {
    it('formats team deletion prompts', () => {
        const output = formatClaudeAgentTeamCommandPrompt({
            payload: {
                kind: 'agent_team_delete',
                teamId: 'qa-team',
            },
        });

        expect(output).toContain('Delete the Agent Team');
        expect(output).toContain('Team: qa-team');
    });

    it('formats teammate shutdown prompts', () => {
        const output = formatClaudeAgentTeamCommandPrompt({
            payload: {
                kind: 'agent_team_member_delete',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            },
        });

        expect(output).toContain('Shut down the specified teammate');
        expect(output).toContain('Team: qa-team');
        expect(output).toContain('Teammate: alpha (alpha@qa-team)');
    });
});
