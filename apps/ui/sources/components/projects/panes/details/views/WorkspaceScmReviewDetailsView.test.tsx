import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
await prepareSessionFilesViewTestkit();
const { WorkspaceScmReviewDetailsView } = await import('./WorkspaceScmReviewDetailsView');
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

async function mountWithRows(kind: 'exact' | 'missing' | 'ambiguous') {
    const grants: unknown[] = [];
    const snapshot = fileViewSnapshot({ rootPath: '/repo' });
    fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
        request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined,
        request: (url, init) => {
            if (new URL(String(url)).pathname === '/v1/plugins/permissions/grants/list') {
                grants.push(JSON.parse(String(init?.body)));
                return Promise.resolve(Response.json({ grants: [], pendingRequests: [] }));
            }
            return Promise.resolve(Response.json({}, { status: 404 }));
        },
    });
    fixture.storage.setState({ sessions: {} });
    fixture.storage.getState().applySettingsLocal({ featureToggles: { 'files.reviewComments': true } });
    const scope = { serverId: fixture.home.id, accountId: 'alice' };
    const exact = { id: 'exact-checkout', serverId: fixture.home.id, machineId: 'm1', rootPath: '/repo', projectKey: 'project-anchor', createdAtMs: 1 };
    const refs: WorkspaceRefV1[] = kind === 'missing' ? [] : kind === 'ambiguous' ? [exact, { ...exact, id: 'duplicate' }] : [
        exact,
        { ...exact, id: 'other-checkout', rootPath: '/repo-other' },
        { ...exact, id: 'other-home', serverId: 'another-home' },
    ];
    applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: refs });
    const screen = await fixture.render(<WorkspaceScmReviewDetailsView scopeId="project:project-anchor"
        workspaceRefId="project-anchor" workspaceCacheKey="cache" serverId={fixture.home.id} machineId="m1" rootPath="/repo" />);
    await flushHookEffects({ cycles: 20 });
    return { screen, grants, scope };
}

describe('WorkspaceScmReviewDetailsView', () => {
    it('keeps the shared comparison toolbar while the first checkout snapshot is loading', async () => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const snapshotRead = createDeferred<unknown>();
        fixture = await createSessionFilesViewFixture({ rootPath: '/loading', rpc: request =>
            request.method === 'scm.status.snapshot' ? snapshotRead.promise : undefined });
            const screen = await fixture.render(<WorkspaceScmReviewDetailsView scopeId="project:loading" workspaceRefId="loading"
            workspaceCacheKey="loading" machineId="m1" serverId={fixture.home.id} rootPath="/loading" />);
        expect(screen.findByTestId('scm-comparison-view:walkthrough')).not.toBeNull();
        snapshotRead.resolve({ success: true, snapshot: fileViewSnapshot({ rootPath: '/loading' }) });
        await flushHookEffects({ cycles: 10 });
        expect(screen.findByTestId('scm-comparison-view:walkthrough')).not.toBeNull();
    });
    it('explains live Files using an explicit Machine capture without starting an agent or borrowing a Session', async () => {
        const captured = { id: 'explicit-files', source: { kind: 'workingTree' as const }, repository: { rootPath: '/repo' },
            endpoints: {}, inventory: { state: 'complete' as const, files: [], reasons: [] } };
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) };
            if (request.method === 'scm.diffSummary.capture') return ScmComparisonCaptureOutputSchema.parse({
                success: true, comparison: captured, metadata: { source: captured.source, sourceKey: captured.id },
            });
            return undefined;
        } });
        fixture.storage.setState({ sessions: {} });
        const contexts: unknown[] = [];
            const screen = await fixture.render(<WorkspaceScmReviewDetailsView scopeId="project:workspace" workspaceRefId="workspace"
            workspaceCacheKey="cache" machineId="m1" serverId={fixture.home.id} rootPath="/repo" onExplain={input => contexts.push(input)} />);
        expect(contexts).toEqual([]);
        await screen.pressByTestIdAsync('scm-comparison-explain-with-agent-action');
        await flushHookEffects({ cycles: 10 });
        expect(contexts).toEqual([expect.objectContaining({ comparison: captured, result: null })]);
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: { cwd: '/repo', source: { kind: 'workingTree' } } }),
        ]);
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.generate' || request.targetId === 's1')).toEqual([]);
    });
    it('uses the exact checkout row for grants, never the Project anchor or another Home', async () => {
        const { screen, grants, scope } = await mountWithRows('exact');
        expect(grants).toContainEqual(expect.objectContaining({ capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: 'exact-checkout' } }));
        expect(grants.every(value => JSON.stringify(value).includes('exact-checkout'))).toBe(true);
        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        expect(screen.tree.root.findByType(ReviewCommentsSessionSurface).props).toMatchObject({
            workspaceId: 'exact-checkout', workspace: { machineId: 'm1', path: '/repo' }, scope,
        });
    });

    it.each(['missing', 'ambiguous'] as const)('leaves checkout grants unavailable when the row is %s', async kind => {
        const { grants } = await mountWithRows(kind);
        expect(grants).toEqual([]);
    });
});
