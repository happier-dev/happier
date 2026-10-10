import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getStorage } from '@/sync/domains/state/storage';
import { archiveSessionReports } from './confirmSessionArchive';
import type { SessionActionExecutionContext } from './sessionActionTypes';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});

afterEach(() => {
    getStorage().setState({ sessions: {}, sessionListRowsByServerId: {} });
});

describe('archiveSessionReports', () => {
    it('archives only unarchived direct reports in the lead Home, through the existing archive Action', async () => {
        const child = createSessionFixture({ id: 'child', serverId: 'home-a', reportsTo: { sessionId: 'lead' } });
        const otherHome = createSessionFixture({ id: 'other', serverId: 'home-b', reportsTo: { sessionId: 'lead' } });
        const unqualified = createSessionFixture({ id: 'unqualified', reportsTo: { sessionId: 'lead' } });
        const archived = createSessionFixture({ id: 'archived', serverId: 'home-a', reportsTo: { sessionId: 'lead' }, archivedAt: 4 });
        const grandchild = createSessionFixture({ id: 'grandchild', serverId: 'home-a', reportsTo: { sessionId: 'child' } });
        // The report was never opened: ordinary list hydration still has to make cascade reachable.
        getStorage().setState({ sessions: { otherHome, unqualified, archived, grandchild },
            sessionListRowsByServerId: { 'home-a': { child: buildSessionListRenderableFromSession(child) } } });
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
