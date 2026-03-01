import { describe, expect, it } from 'vitest';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import { formatClaudeTeamRoutedPrompt } from './formatClaudeTeamRoutedPrompt';

describe('formatClaudeTeamRoutedPrompt', () => {
    it('formats a teammate-routed prompt', () => {
        const recipient: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'agent_1',
            memberLabel: 'Alice',
        };
        const out = formatClaudeTeamRoutedPrompt({
            originalText: 'hello there',
            recipient,
        });
        expect(out).toContain('team_1');
        expect(out).toContain('agent_1');
        expect(out).toContain('hello there');
    });

    it('formats a broadcast-routed prompt', () => {
        const recipient: ParticipantRecipientV1 = {
            kind: 'agent_team_broadcast',
            teamId: 'team_1',
        };
        const out = formatClaudeTeamRoutedPrompt({
            originalText: 'ping all',
            recipient,
        });
        expect(out).toContain('team_1');
        expect(out).toContain('ping all');
        expect(out).toContain('If broadcast is unavailable');
        expect(out).toContain('~/.claude/teams/team_1/config.json');
    });
});
