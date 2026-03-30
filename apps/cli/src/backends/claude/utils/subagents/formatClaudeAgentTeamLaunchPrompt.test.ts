import { describe, expect, it } from 'vitest';

import { formatClaudeAgentTeamLaunchPrompt } from './formatClaudeAgentTeamLaunchPrompt';

describe('formatClaudeAgentTeamLaunchPrompt', () => {
    it('formats team creation prompts', () => {
        const output = formatClaudeAgentTeamLaunchPrompt({
            payload: {
                kind: 'agent_team_create',
                teamId: 'qa-team',
                description: 'Coordinate the QA wave.',
            },
        });

        expect(output).toContain('Create a new Agent Team');
        expect(output).toContain('Team: qa-team');
        expect(output).toContain('Coordinate the QA wave.');
    });

    it('formats teammate spawn prompts and preserves background intent', () => {
        const output = formatClaudeAgentTeamLaunchPrompt({
            payload: {
                kind: 'agent_team_member_create',
                teamId: 'qa-team',
                memberLabel: 'alpha',
                instructions: 'Validate the rerun flow.',
                runInBackground: true,
            },
        });

        expect(output).toContain('Launch a new teammate');
        expect(output).toContain('Team: qa-team');
        expect(output).toContain('Teammate label: alpha');
        expect(output).toContain('Run in background: yes');
        expect(output).toContain('Validate the rerun flow.');
    });
});
