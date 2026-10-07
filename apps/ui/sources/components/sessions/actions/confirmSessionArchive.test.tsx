import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getStorage } from '@/sync/domains/state/storage';
import { archiveSessionReports } from './confirmSessionArchive';
import type { SessionActionExecutionContext } from './sessionActionTypes';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});

afterEach(() => {
    getStorage().setState({ sessions: {} });
});

describe('archiveSessionReports', () => {
    it('archives only unarchived direct reports in the lead Home, through the existing archive Action', async () => {
        const child = createSessionFixture({ id: 'child', serverId: 'home-a', reportsTo: { sessionId: 'lead' } });
        const otherHome = createSessionFixture({ id: 'other', serverId: 'home-b', reportsTo: { sessionId: 'lead' } });
        const unqualified = createSessionFixture({ id: 'unqualified', reportsTo: { sessionId: 'lead' } });
        const archived = createSessionFixture({ id: 'archived', serverId: 'home-a', reportsTo: { sessionId: 'lead' }, archivedAt: 4 });
        const grandchild = createSessionFixture({ id: 'grandchild', serverId: 'home-a', reportsTo: { sessionId: 'child' } });
        getStorage().setState({ sessions: { child, otherHome, unqualified, archived, grandchild } });
        const archivedAddresses: Array<{ sessionId: string; serverId: string | null | undefined }> = [];
        const context: SessionActionExecutionContext = {
            operations: {
                archiveSession: async (sessionId, options) => {
                    archivedAddresses.push({ sessionId, serverId: options?.serverId });
                    return { success: true };
                },
                clearSessionVisibleWhenInactive: () => {},
            },
        };
        await archiveSessionReports({ leadSessionId: 'lead', serverId: 'home-a', context });
        expect(archivedAddresses).toEqual([{ sessionId: 'child', serverId: 'home-a' }]);
        archivedAddresses.length = 0;
        await archiveSessionReports({ leadSessionId: 'lead', serverId: null, context });
        expect(archivedAddresses).toEqual([]);
    });
});
