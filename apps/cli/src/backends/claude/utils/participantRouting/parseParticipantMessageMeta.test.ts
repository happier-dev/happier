import { describe, expect, it } from 'vitest';

import { parseParticipantMessageMeta } from './parseParticipantMessageMeta';

describe('parseParticipantMessageMeta', () => {
    it('parses agent team member recipient from happier meta envelope', () => {
        const parsed = parseParticipantMessageMeta({
            happier: {
                kind: 'participant_message.v1',
                payload: {
                    recipient: {
                        kind: 'agent_team_member',
                        teamId: 'team_1',
                        memberId: 'agent_1',
                    },
                },
            },
        });
        expect(parsed?.recipient.kind).toBe('agent_team_member');
        expect((parsed as any)?.recipient.teamId).toBe('team_1');
        expect((parsed as any)?.recipient.memberId).toBe('agent_1');
    });

    it('returns null for non-participant meta envelopes', () => {
        const parsed = parseParticipantMessageMeta({
            happier: { kind: 'review_comments.v1', payload: {} },
        });
        expect(parsed).toBeNull();
    });

    it('returns null for execution_run recipients', () => {
        const parsed = parseParticipantMessageMeta({
            happier: {
                kind: 'participant_message.v1',
                payload: {
                    recipient: {
                        kind: 'execution_run',
                        runId: 'run_1',
                    },
                },
            },
        });
        expect(parsed).toBeNull();
    });
});
