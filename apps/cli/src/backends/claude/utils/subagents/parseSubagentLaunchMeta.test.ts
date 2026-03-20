import { describe, expect, it } from 'vitest';

import { parseSubagentLaunchMeta } from './parseSubagentLaunchMeta';

describe('parseSubagentLaunchMeta', () => {
    it('parses a teammate launch envelope', () => {
        const parsed = parseSubagentLaunchMeta({
            happier: {
                kind: 'subagent_launch.v1',
                payload: {
                    kind: 'agent_team_member_create',
                    teamId: 'team_1',
                    memberLabel: 'alpha',
                    instructions: 'Investigate the test failures.',
                    runInBackground: true,
                },
            },
        });

        expect(parsed?.payload.kind).toBe('agent_team_member_create');
        expect(parsed?.payload.teamId).toBe('team_1');
        expect((parsed?.payload as any)?.memberLabel).toBe('alpha');
    });

    it('returns null for non-launch envelopes', () => {
        const parsed = parseSubagentLaunchMeta({
            happier: {
                kind: 'participant_message.v1',
                payload: {},
            },
        });

        expect(parsed).toBeNull();
    });
});
