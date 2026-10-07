import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let snapshot = fileViewSnapshot();
let snapshotError: { message: string; at: number; errorCode: string } | null = null;

beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    standardCleanup();
    snapshot = fileViewSnapshot({ rootPath: '/tmp/repo' });
    snapshotError = null;
    fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: (request) =>
        request.method === 'scm.status.snapshot'
            ? snapshotError ? { success: false, error: snapshotError.message, errorCode: snapshotError.errorCode } : { success: true, snapshot }
            : undefined,
    });
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

async function render() {
    fixture.setSnapshot(snapshot, snapshotError);
    const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
    return fixture.render(<SessionScmReviewDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" />);
}

describe('SessionScmReviewDetailsView (stale snapshot)', () => {
    it('surfaces a failing refresh while keeping the cached review visible', async () => {
        snapshotError = { message: 'RPC method not available', at: 1, errorCode: 'BACKEND_UNAVAILABLE' };
        const screen = await render();
        expect(screen.findHostByTestId('session-scm-review-stale')).not.toBeNull();
        expect(screen.findHostByTestId('session-scm-review-stale-diagnostic-BACKEND_UNAVAILABLE')).not.toBeNull();
        expect(screen.findHostByTestId('scm-review-list')).not.toBeNull();
        expect(screen.findHostByTestId('source-control-unavailable')).toBeNull();
        const before = fixture.requests.filter((request) => request.method === 'scm.status.snapshot').length;
        await screen.pressByTestIdAsync('session-scm-review-stale-action');
        await flushHookEffects({ cycles: 20 });
        const refreshes = fixture.requests.filter((request) => request.method === 'scm.status.snapshot');
        expect(refreshes.length).toBeGreaterThan(before);
        expect(refreshes.at(-1)).toEqual(expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ cwd: '/tmp/repo' }) }));
    });

    it('surfaces a failing refresh over a cached "not a repository" answer', async () => {
        snapshot = fileViewSnapshot({ rootPath: '/tmp/repo', isRepo: false });
        snapshotError = { message: 'RPC method not available', at: 1, errorCode: 'BACKEND_UNAVAILABLE' };
        const screen = await render();
        expect(screen.findHostByTestId('session-scm-review-stale')).not.toBeNull();
        const { t } = await import('@/text');
        expect(screen.getTextContent()).toContain(t('sessionGitPane.notRepository.title'));
    });

    it('stays quiet when the snapshot is current', async () => {
        const screen = await render();
        expect(screen.findHostByTestId('session-scm-review-stale')).toBeNull();
        expect(screen.findHostByTestId('scm-review-list')).not.toBeNull();
    });
});
