import { describe, expect, it } from 'vitest';

import { resolveSubagentStructuredSend } from './resolveSubagentStructuredSend';

describe('resolveSubagentStructuredSend', () => {
    it('builds launch meta envelopes with a display text', () => {
        const resolved = resolveSubagentStructuredSend({
            envelopeKind: 'subagent_launch.v1',
            payload: {
                kind: 'agent_team_create',
                teamId: 'qa-team',
                description: 'Coordinate QA work.',
            },
        });

        expect(resolved.displayText).toBe('Create team qa-team');
        expect(resolved.metaOverrides).toMatchObject({
            happier: {
                kind: 'subagent_launch.v1',
                payload: {
                    kind: 'agent_team_create',
                    teamId: 'qa-team',
                },
            },
        });
    });

    it('builds command meta envelopes with a teammate label when available', () => {
        const resolved = resolveSubagentStructuredSend({
            envelopeKind: 'subagent_command.v1',
            payload: {
                kind: 'agent_team_member_delete',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            },
        });

        expect(resolved.displayText).toBe('Shutdown teammate alpha · qa-team');
        expect(resolved.metaOverrides).toMatchObject({
            happier: {
                kind: 'subagent_command.v1',
                payload: {
                    kind: 'agent_team_member_delete',
                    memberId: 'alpha@qa-team',
                },
            },
        });
    });
});
