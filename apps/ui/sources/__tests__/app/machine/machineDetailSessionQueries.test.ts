import { describe, expect, it } from 'vitest';

import { filterUserFacingMachineDetailSessions } from '@/app/(app)/machine/[id]/machineDetailSessionQueries';

describe('filterUserFacingMachineDetailSessions', () => {
    it('excludes a hidden machine-backed Voice History carrier while retaining a normal session', () => {
        const sessions = filterUserFacingMachineDetailSessions([
            {
                id: 'voice-history',
                metadata: {
                    machineId: 'machine-1',
                    systemSessionV1: {
                        v: 1,
                        key: 'voice_transcript_history',
                        hidden: true,
                    },
                },
            },
            {
                id: 'session-visible',
                metadata: {
                    machineId: 'machine-1',
                    summary: { text: 'Visible session' },
                },
            },
        ]);

        expect(sessions.map((session) => session.id)).toEqual(['session-visible']);
    });
});
