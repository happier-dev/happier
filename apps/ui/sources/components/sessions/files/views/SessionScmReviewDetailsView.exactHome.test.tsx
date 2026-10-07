import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
beforeAll(prepareSessionFilesViewTestkit);
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

function snapshotWithFile(path: string) {
    return fileViewSnapshot({ rootPath: '/tmp/repo', entries: [{
        path, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
    }], capabilities: { readDiffFile: true, writeCommit: true } });
}

describe('SessionScmReviewDetailsView (exact Home)', () => {
    it('reviews the working tree of the Home named by the route, not a same-id match', async () => {
        const routeSnapshot = snapshotWithFile('src/home-b.ts');
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: (request) =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: routeSnapshot } : undefined,
        });
        fixture.setSnapshot(routeSnapshot);
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { transferMachine } = await import('../sessionFileTransferTestkit');
        const otherHome = await upsertServerProfile({ serverUrl: 'https://scm-review-other.test' });
        const otherSession = createSessionFixture({
            ...fixture.session, serverId: otherHome.id, updatedAt: fixture.session.updatedAt + 1,
        });
        fixture.storage.setState((state) => ({
            machineListByServerId: { ...state.machineListByServerId, [otherHome.id]: [transferMachine({ id: 'm1', storageMode: 'plain' })] },
        }));
        fixture.storage.getState().applySessions([otherSession]);
        fixture.storage.getState().publishSessionProjectScmSnapshots([{
            sessionId: 's1', serverId: otherHome.id, snapshot: snapshotWithFile('src/home-a.ts'), status: null,
        }]);
        // Both scoped rows exist, while the id-keyed entity holds the other Home.
        const state = fixture.storage.getState();
        expect(state.sessions.s1?.serverId).toBe(otherHome.id);
        expect(state.sessionListRowsByServerId[fixture.home.id]?.s1).toBeTruthy();
        expect(state.sessionListRowsByServerId[otherHome.id]?.s1).toBeTruthy();
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const screen = await fixture.render(<SessionScmReviewDetailsView
            sessionId="s1" serverId={fixture.home.id} scopeId="session:s1"
        />);
        const review = screen.tree.root.findByType(ChangedFilesReview).props as React.ComponentProps<typeof ChangedFilesReview>;
        expect(review.allRepositoryChangedFiles.map(file => file.fullPath)).toEqual(['src/home-b.ts']);
        expect(review.snapshot).toMatchObject(routeSnapshot);
        expect(fixture.requests.filter(request => request.method === 'scm.status.snapshot')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ cwd: '/tmp/repo' }) }),
        ]);
    });
});
