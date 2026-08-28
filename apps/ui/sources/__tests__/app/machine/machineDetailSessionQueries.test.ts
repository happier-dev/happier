import { describe, expect, it } from 'vitest';

import { filterUserFacingMachineDetailSessions } from '@/app/(app)/machine/[id]/machineDetailSessionQueries';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

describe('filterUserFacingMachineDetailSessions', () => {
    it('excludes a hidden machine-backed Voice History carrier while retaining a normal session', () => {
        const sessions = filterUserFacingMachineDetailSessions([
            createSessionFixture({
                id: 'voice-history',
                metadata: {
                    host: 'machine.local',
                    path: '/workspace',
                    machineId: 'machine-1',
                    systemSessionV1: {
                        v: 1,
                        key: 'voice_transcript_history',
                        hidden: true,
                    },
                },
            }),
            createSessionFixture({
                id: 'session-visible',
                metadata: {
                    host: 'machine.local',
                    path: '/workspace',
                    machineId: 'machine-1',
                    summary: { text: 'Visible session', updatedAt: 1 },
                },
            }),
        ]);

        expect(sessions.map((session) => session.id)).toEqual(['session-visible']);
    });
});
