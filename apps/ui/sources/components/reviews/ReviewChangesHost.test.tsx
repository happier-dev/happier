import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { buildScmFileReviewUnits, buildScmReviewScopeId } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { buildScmReviewedMarksKey } from '@happier-dev/protocol/scm/reviewedMarks';
import { decodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import type { ReviewRoundComparisonCaptureV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ScmComparisonCaptureInputSchema, type ScmComparisonCaptureOutput } from '@happier-dev/protocol/scm/diffSummary';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

it.each([undefined, 's1'])('starts a Walkthrough against the retained comparison in its captured host %s', async sessionId => {
    const comparisonId = 'c'.repeat(64);
    fixture = await createSessionFilesViewFixture({ rootPath: '/repo', sessionId,
        featureOverrides: { features: { execution: { runs: { enabled: true } } } },
        rpc: request => {
            if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return { protocolVersion: 1,
                capabilities: [{ id: 'tool.executionRuns', kind: 'tool', protocol: { version: 2, available: true,
                    features: { detachedScope: true, startAndWait: true, exactInputResults: true,
                        runScopedAgentBindings: true, secretReferenceOverlay: true } } }], checklists: {} };
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
                'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: {
                    backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
            } };
            if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) return {
                success: true, results: [], count: 0, bytes: 0,
                sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 },
            };
            if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE) return {
                success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Retained comparison unavailable',
            };
            return undefined;
        } });
    const { ReviewChangesHost } = await import('./ReviewChangesHost');
    const { getScmDiffSummaryState } = await import('@/sync/ops/scmDiffSummary/generate');
    const capture = { target: { kind: 'machine', machineId: 'm1' }, input: {
        cwd: '/repo', comparisonId, source: { kind: 'workingTree' }, ...(sessionId ? { sessionId } : {}),
    } } satisfies ReviewRoundComparisonCaptureV1;
    // A real SCM destination on this same Home/Machine must reach generation before the Review host is tested.
    const { SessionWalkthroughView } = await import('@/components/sessions/files/walkthrough/SessionWalkthroughView');
    const { ScmWalkthroughView } = await import('@/components/sessions/files/walkthrough/ScmWalkthroughView');
    const { useWorkspaceScmDiffSummaryBinding } = await import('@/components/projects/scm/useWorkspaceScmDiffSummaryBinding');
    const controlProps = { serverId: fixture.scope.serverId, comparison: { kind: 'workingTree', comparisonId: 'd'.repeat(64) },
        scopeLabel: 'Control comparison', layout: 'wide', renderBar: () => null,
        onShowFiles() {}, onOpenFile() {}, onOpenComposer() {} } as const;
    function WorkspaceControl() {
        const bound = useWorkspaceScmDiffSummaryBinding({ machineId: 'm1', rootPath: '/repo', serverId: fixture.scope.serverId,
            comparison: controlProps.comparison, output: 'walkthrough' });
        return <ScmWalkthroughView {...controlProps} bound={bound} displayMachineId="m1" />;
    }
    const control = await fixture.render(sessionId ? <SessionWalkthroughView {...controlProps} sessionId={sessionId} /> : <WorkspaceControl />);
    await vi.waitFor(() => expect(control.findByTestId('walkthrough-start')?.props.disabled, control.getTextContent()).toBe(false));
    await control.pressByTestIdAsync('walkthrough-start');
    await vi.waitFor(() => expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toHaveLength(1));
    await control.unmount();
    const screen = await fixture.render(<ReviewChangesHost reviewId="walkthrough-review" roundOrdinal={1}
        scope={{ serverId: fixture.scope.serverId, accountId: 'alice' }} capture={capture} comments={[]}
        view="walkthrough" onSelectView={() => {}} onOpenComment={() => {}} />);
    await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled, screen.getTextContent()).toBe(false));
    await screen.pressByTestIdAsync('walkthrough-start');
    await vi.waitFor(() => expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toHaveLength(2));
    const generated = fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)[1]!;
    expect(generated.targetId).toBe('m1');
    expect(generated.payload).toMatchObject({ cwd: '/repo', comparisonId, source: { kind: 'workingTree' }, outputs: ['walkthrough'] });
    if (sessionId) expect(generated.payload).toMatchObject({ sessionId });
    else expect(generated.payload).not.toHaveProperty('sessionId');
    await vi.waitFor(() => expect(Object.values(getScmDiffSummaryState().entriesByKey)
        .find(entry => entry.input.comparisonId === comparisonId))
        .toMatchObject({ status: 'failed', error: { code: 'DIFF_UNAVAILABLE' } }));
    await screen.unmount();
});


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

it.each([undefined, 'cmwnalobm00h105mc6nucsgo7'])('keeps saved gutter comments and Viewed marks in the captured Session namespace %s', async comparisonSessionId => {
    // Retained QA Review f8c93a92 captured a working tree inside this Session namespace.
    const comparison = ScmComparisonSchema.parse({ id: '46dae58ca4a04ab832497525f9b8ece106f331bde36322d8ed070e7161c8b1f8', source: { kind: 'workingTree', area: 'pending' },
        repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
            path: 'total.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            occurrences: [{ id: 'total-change', alias: 'total-change', path: 'total.ts', position: 0,
                before: { startLine: 2, lineCount: 1 }, after: { startLine: 2, lineCount: 1 } }],
            evidence: { state: 'available', unifiedDiff: '@@ -1,3 +1,3 @@\n export function total(prices: number[]) {\n-  return prices.reduce((sum, price) => sum + price, 0);\n+  return prices.reduce((sum, price) => sum - price, 0);\n }\n' },
        }] } });
    const kv = createAccountKvHttpFixture();
    const marksKey = buildScmReviewedMarksKey(buildScmReviewScopeId({ repositoryRootPath: '/repo', source: comparison.source }));
    fixture = await createSessionFilesViewFixture({ rootPath: '/repo', sessionId: comparisonSessionId, rpc: request => {
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) {
            const input = ScmComparisonCaptureInputSchema.parse(request.payload);
            // The retained evidence owner never searches another Session's shelf.
            return input.sessionId === comparisonSessionId ? { success: true, comparison,
                metadata: { sourceKey: comparison.id, source: comparison.source } }
                : { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'The captured comparison is unavailable in this namespace.' };
        }
        return undefined;
    }, request: kv.handleFetch });
    const { ReviewChangesHost } = await import('./ReviewChangesHost');
    const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
    const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
    const { ReviewCommentCard } = await import('./ReviewCommentCard');
    const comment = buildReviewCommentFixture({ id: 'saved-gutter', reviewId: 'gutter-review', roundOrdinal: 1,
        author: { kind: 'user', userId: 'alice' }, anchor: { kind: 'line', filePath: 'total.ts', line: 2, side: 'after' },
        body: 'Preserve addition: subtraction returns a negative total.', snapshot: { kind: 'none', capturedAt: 1 } });
    const props = { reviewId: 'gutter-review', roundOrdinal: 1, scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
        capture: { target: { kind: 'machine', machineId: 'm1' }, input: { cwd: '/repo', comparisonId: comparison.id,
            source: comparison.source, ...(comparisonSessionId ? { sessionId: comparisonSessionId } : {}) } } satisfies ReviewRoundComparisonCaptureV1,
        comments: [comment], view: 'files', onSelectView() {}, onOpenComment() {} } as const;
    const screen = await fixture.render(<ReviewChangesHost {...props} />);
    await vi.waitFor(() => expect(screen.findAllByType(WorkspaceScmReviewBody)).toHaveLength(1));
    await act(async () => screen.findByType(WorkspaceScmReviewBody)
        .findAll(node => typeof node.props.onLayout === 'function')[0]?.props.onLayout({ nativeEvent: { layout: { width: 900, height: 360 } } }));
    await vi.waitFor(() => expect(screen.findAllByType(DiffViewer)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Preserve addition: subtraction returns a negative total.'));
    expect(screen.findAllByType(ReviewCommentCard).map(card => card.props.comment.id)).toEqual(['saved-gutter']);
    const lines = screen.findByType(DiffViewer).props.precomputedLines;
    const renderAfterLine = screen.findByType(DiffViewer).props.renderAfterLine;
    expect(renderAfterLine(lines.find((line: { kind: string }) => line.kind === 'remove'))).toBeNull();
    expect(renderAfterLine(lines.find((line: { kind: string }) => line.kind === 'add'))).not.toBeNull();
    await screen.pressByTestIdAsync('diff-file-menu:total.ts');
    await vi.waitFor(() => expect(screen.findByTestId('diff-file-viewed')).not.toBeNull());
    const viewedControl = screen.findByTestId('diff-file-viewed');
    if (!viewedControl) throw new Error('The file menu must expose its Viewed control');
    expect(viewedControl.props.disabled).not.toBe(true);
    await screen.pressByTestIdAsync('diff-file-viewed');
    const expectedKeys = buildScmFileReviewUnits(comparison.inventory.files[0]!).map(unit => unit.key);
    await vi.waitFor(() => expect(decodeBase64StoredJsonContentEnvelope(kv.read(marksKey)?.value ?? ''))
        .toMatchObject({ t: 'plain', v: { reviewedChangeKeys: expectedKeys } }));
    await screen.pressByTestIdAsync('diff-file-menu:total.ts');
    await screen.pressByTestIdAsync('diff-file-viewed');
    await vi.waitFor(() => expect(decodeBase64StoredJsonContentEnvelope(kv.read(marksKey)?.value ?? ''))
        .toMatchObject({ t: 'plain', v: { reviewedChangeKeys: [] } }));
    await screen.update(fixture.wrap(<ReviewChangesHost {...props} comments={[{ ...comment, body: '', flags: { redacted: true } }]} />));
    expect(screen.getTextContent()).not.toContain('Preserve addition: subtraction returns a negative total.');
    await screen.unmount();
});
