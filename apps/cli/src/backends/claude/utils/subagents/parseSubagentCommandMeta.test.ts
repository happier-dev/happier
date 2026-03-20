import { describe, expect, it } from 'vitest';

import { parseSubagentCommandMeta } from './parseSubagentCommandMeta';

describe('parseSubagentCommandMeta', () => {
    it('parses a teammate delete envelope', () => {
        const parsed = parseSubagentCommandMeta({
            happier: {
                kind: 'subagent_command.v1',
                payload: {
                    kind: 'agent_team_member_delete',
                    teamId: 'team_1',
                    memberId: 'alpha@team_1',
                    memberLabel: 'alpha',
                },
            },
        });

        expect(parsed?.payload.kind).toBe('agent_team_member_delete');
        expect(parsed?.payload.teamId).toBe('team_1');
        expect((parsed?.payload as any)?.memberId).toBe('alpha@team_1');
    });

    it('returns null for non-command envelopes', () => {
        const parsed = parseSubagentCommandMeta({
            happier: {
                kind: 'subagent_launch.v1',
                payload: {},
            },
        });

        expect(parsed).toBeNull();
    });
});
