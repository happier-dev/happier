import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ReviewRoundComparisonCaptureV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ScmComparisonCaptureOutput } from '@happier-dev/protocol/scm/diffSummary';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

it('reads only the opened pinned comparison, preserves its failure, and does no hidden Machine work', async () => {
    fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE
        ? { success: false, error: 'Captured comparison no longer available', errorCode: 'DIFF_UNAVAILABLE' } satisfies ScmComparisonCaptureOutput : undefined });
    const { ReviewChangesHost } = await import('./ReviewChangesHost');
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const capture = { target: { kind: 'machine', machineId: 'm1' }, input: { cwd: '/repo', comparisonId: 'a'.repeat(64), source: { kind: 'workingTree' } } } satisfies ReviewRoundComparisonCaptureV1;
    const props = { reviewId: 'review-1', roundOrdinal: 1, scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
        capture, comments: [], view: 'files', onSelectView() {}, onOpenComment() {} } as const;
    const screen = await fixture.render(<ReviewChangesHost {...props} active={false} />);
    const captures = () => fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE);
    expect(captures()).toHaveLength(0);
    await screen.update(fixture.wrap(<ReviewChangesHost {...props} />));
    const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
    // The native viewport boundary is measured by layout in the running app.
    const measureViewport = async () => await act(async () => {
        screen.findAllByType(WorkspaceScmReviewBody)[0]?.findAll(node => typeof node.props.onLayout === 'function')[0]
            ?.props.onLayout({ nativeEvent: { layout: { width: 900, height: 360 } } });
    });
    await vi.waitFor(() => expect(screen.findAllByType(WorkspaceScmReviewBody)).toHaveLength(1));
    await measureViewport();
    await vi.waitFor(() => expect(captures(), screen.findAllByType(SurfaceStateCard).map(card => card.props.title).join('; ')).toHaveLength(1));
    expect(captures()[0]?.payload).toMatchObject({ comparisonId: capture.input.comparisonId, cwd: '/repo', source: { kind: 'workingTree' } });
    await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(card => card.props.title === 'Captured comparison no longer available'),
        screen.findAllByType(SurfaceStateCard).map(card => card.props.title).join('; ')).toBe(true));
    expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toEqual([]);
    await screen.update(fixture.wrap(<PluginSurfaceFocusEligibilityProvider active={false} presentationActive={false}>
        <ReviewChangesHost {...props} roundOrdinal={2} capture={{ ...capture, input: { ...capture.input, comparisonId: 'b'.repeat(64) } }} />
    </PluginSurfaceFocusEligibilityProvider>));
    await flushHookEffects({ cycles: 20 });
    await measureViewport();
    await flushHookEffects({ cycles: 20 });
    expect(captures()).toHaveLength(1);
    await screen.unmount();
});

it('keeps sealed finding excerpts readable without a capture or Machine read', async () => {
    fixture = await createSessionFilesViewFixture({ machine: null });
    const { ReviewChangesHost } = await import('./ReviewChangesHost');
    const comment = buildReviewCommentFixture({ id: 'sealed-finding', snapshot: { kind: 'text', selectedLinesHash: 'sealed-lines', contextWindowHash: 'sealed-context', capturedAt: 1, fileLength: 1, source: 'workingTree', isUncommitted: false, isUntracked: false, beforeContext: [], selectedLines: ['sealed text remains readable'], afterContext: [], truncated: false, hasBidiControls: false, likelyMinified: false } });
    const screen = await fixture.render(<ReviewChangesHost reviewId="shared-review" roundOrdinal={2}
        scope={{ serverId: fixture.scope.serverId, accountId: 'alice' }} capture={null} comments={[comment]}
        view="files" onSelectView={() => {}} onOpenComment={() => {}} />);
    expect(screen.findHostByTestId('review-changes-sealed-excerpts')).not.toBeNull();
    expect(screen.getTextContent()).toContain('sealed text remains readable');
    expect(fixture.requests).toEqual([]);
    await screen.unmount();
});
