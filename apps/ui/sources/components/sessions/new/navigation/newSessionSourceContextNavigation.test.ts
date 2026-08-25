import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';

import { buildNewSessionSourceContextNavigation } from './newSessionSourceContextNavigation';

describe('buildNewSessionSourceContextNavigation', () => {
    it('routes every source-context seed into a fresh exact draft identity', () => {
        const route = buildNewSessionSourceContextNavigation({
            session: createSessionFixture({ id: 'source-session' }),
            sourceSessionId: 'source-session',
            forkPoint: { type: 'latest' },
            serverId: 'server-a',
            machineId: 'machine-a',
            createDraftId: () => '4a506d8a-85bd-4c42-a662-6f502f3acc45',
        });

        expect(route.params.draftId).toBe('4a506d8a-85bd-4c42-a662-6f502f3acc45');
    });
});
