import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { reviewReviewersForEngineIdsV1 } from '@happier-dev/protocol/reviews/reviewStart';
import * as React from 'react';
import tweetnacl from 'tweetnacl';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createPlainMachineRowFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm';
import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol/capabilities';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ renderItemLimit: 25 });
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
await prepareSessionFilesViewTestkit();
const CHANGED_ENTRIES = [{ path: 'src/a.ts', previousPath: null, kind: 'modified' as const, includeStatus: '', pendingStatus: 'M',
    hasIncludedDelta: false, hasPendingDelta: true, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false } }];
const { WorkspaceScmReviewDetailsView } = await import('./WorkspaceScmReviewDetailsView');
const { t } = await import('@/text');
afterEach(async () => {
    standardCleanup();
    if (fixture) {
        const { retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
        retireScmDiffSummaryScope({ serverId: fixture.home.id, accountId: 'alice' });
        await fixture.dispose();
    }
});

async function measureReview(screen: Awaited<ReturnType<typeof fixture.render>>) {
    const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
    const body = screen.findByType(WorkspaceScmReviewBody);
    const viewport = body.find(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
    await act(async () => viewport.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 480 } } }));
    await flushHookEffects({ cycles: 10 });
}

async function renderMeasuredReview(element: React.ReactElement) {
    const screen = await fixture.render(element);
    await measureReview(screen);
    return screen;
}

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
    const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:project-anchor"
        serverId={fixture.home.id} machineId="m1" rootPath="/repo" />);
    await flushHookEffects({ cycles: 20 });
    return { screen, grants, scope };
}

// The phone head's launchers; its Machine chip is the header's checkout read under test.
const PHONE_HEAD_LAUNCHERS = { testIdPrefix: 'project-header', showWorktreesButton: false } as const;

describe('WorkspaceScmReviewDetailsView', () => {
    it.each(['walkthrough', 'commits'] as const)('reads summary facts for live %s without listing checkout files', async (view) => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/summary', rpc: request => request.method === 'scm.status.snapshot'
            ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/summary', entries: CHANGED_ENTRIES }) } : undefined });
        fixture.storage.setState({ sessions: {} });
        const screen = await fixture.render(<WorkspaceScmReviewDetailsView scopeId={`project:summary-${view}`}
            machineId="m1" serverId={fixture.home.id} rootPath="/summary" view={view} />);
        const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
        expect(screen.findByType(WorkspaceScmReviewBody).props.view).toBe(view);
        expect(fixture.requests.filter(request => request.method === 'scm.status.snapshot').map(request => request.payload))
            .toEqual([expect.objectContaining({ detail: 'summary' })]);
    });
    it('lets the presented Changes viewport own the first status read and pages only after scrolling', async () => {
        const totalFiles = 60_221;
        const entries = Array.from({ length: totalFiles }, (_, index) => ({ ...CHANGED_ENTRIES[0]!, path: `src/file-${index}.ts` }));
        fixture = await createSessionFilesViewFixture({ rootPath: '/viewport',
            machine: createMachineFixture({ id: 'm1', operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { scmStatusSnapshotPaging: { protocolVersions: [1] } } }),
            rpc: request => {
            if (request.method !== 'scm.status.snapshot') return undefined;
            const input = request.payload as { entriesPage?: { limit: number; cursor?: number; path?: string } };
            const cursor = input.entriesPage?.cursor ?? 0;
            const limit = input.entriesPage?.limit ?? totalFiles;
            const snapshot = fileViewSnapshot({ rootPath: '/viewport', entries: input.entriesPage?.path
                ? entries.filter(entry => entry.path === input.entriesPage?.path) : entries.slice(cursor, cursor + limit) });
            return { success: true, snapshot: { ...snapshot,
                summary: { changedFiles: totalFiles, includedAdded: 0, includedRemoved: 0, pendingAdded: totalFiles, pendingRemoved: totalFiles },
                totals: { ...snapshot.totals, pendingFiles: totalFiles, pendingAdded: totalFiles, pendingRemoved: totalFiles },
                entriesPage: { totalFiles, nextCursor: cursor + limit < totalFiles ? cursor + limit : null } } };
        } });
        fixture.storage.setState({ sessions: {} });
        const { ProjectPhoneHead } = await import('@/components/projects/shell/ProjectShellHeaderHost');
        const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        const workspaceRef: WorkspaceRefV1 = { id: 'viewport', serverId: fixture.home.id, machineId: 'm1', rootPath: '/viewport', createdAtMs: 1 };
        const screen = await fixture.render(<>
            <ProjectPhoneHead launchers={PHONE_HEAD_LAUNCHERS} workspaceRef={workspaceRef} activeRootPath="/viewport"
                selection={{ kind: 'builtin', page: 'changes' }} onSelectRootPath={() => {}} />
            <WorkspaceScmReviewDetailsView scopeId="project:viewport" machineId="m1" serverId={fixture.home.id} rootPath="/viewport" />
        </>);
        const reads = () => fixture.requests.filter(request => request.method === 'scm.status.snapshot');
        await flushHookEffects({ cycles: 10 });
        expect(reads(), 'the header observes Changes; no status is read before its geometry').toHaveLength(0);
        const body = screen.findByType(WorkspaceScmReviewBody);
        const viewport = body.find(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
        await act(async () => viewport.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 480 } } }));
        await flushHookEffects({ cycles: 10 });
        expect(reads()).toHaveLength(1);
        const firstInput = reads()[0]!.payload as { entriesPage: { limit: number; cursor?: number } };
        const { resolveScmChangeCompactRowHeight } = await import('@/components/workspaces/scm/changes/ScmChangeRow');
        expect(firstInput.entriesPage.limit).toBe(Math.ceil(480 / resolveScmChangeCompactRowHeight(true)));
        expect(firstInput.entriesPage.limit).toBeLessThan(totalFiles);
        const review = () => screen.findByType(ChangedFilesReview).props;
        expect(review().allRepositoryChangedFiles).toHaveLength(firstInput.entriesPage.limit);
        expect(screen.findByType(WorkspaceScmReviewBody).props.fileCount).toBe(totalFiles);
        const scroll = async (y: number) => {
            await act(async () => screen.findByType(DiffFilesListView).props.onScroll({ nativeEvent: {
                contentOffset: { x: 0, y }, layoutMeasurement: { width: 1200, height: 480 }, contentSize: { width: 1200, height: 960 },
            } }));
            await flushHookEffects({ cycles: 10 });
        };
        await scroll(0);
        expect(reads()).toHaveLength(1);
        await scroll(480);
        expect(reads()).toHaveLength(2);
        expect(reads()[1]!.payload).toMatchObject({ entriesPage: { limit: firstInput.entriesPage.limit, cursor: firstInput.entriesPage.limit } });
        expect(review().allRepositoryChangedFiles).toHaveLength(firstInput.entriesPage.limit * 2);
        expect(new Set(review().allRepositoryChangedFiles.map((file: { fullPath: string }) => file.fullPath)).size).toBe(firstInput.entriesPage.limit * 2);
        const { requestActiveReviewFile } = await import('@/components/workspaces/scm/review/activeReviewFile');
        const lastPath = entries.at(-1)!.path;
        await act(async () => { requestActiveReviewFile(review().activeReviewFile.key, lastPath); });
        await flushHookEffects({ cycles: 10 });
        expect(reads()).toHaveLength(3);
        expect(reads()[2]!.payload).toMatchObject({ entriesPage: { path: lastPath } });
        expect(review().allRepositoryChangedFiles.some((file: { fullPath: string }) => file.fullPath === lastPath)).toBe(true);
        expect(review().allRepositoryChangedFiles).toHaveLength(firstInput.entriesPage.limit * 2 + 1);
        await screen.pressByTestIdAsync('scm-review-load-more');
        await flushHookEffects({ cycles: 10 });
        expect(reads()).toHaveLength(4);
        expect(reads()[3]!.payload).toMatchObject({ entriesPage: { limit: firstInput.entriesPage.limit, cursor: firstInput.entriesPage.limit * 2 } });
        expect(review().allRepositoryChangedFiles).toHaveLength(firstInput.entriesPage.limit * 3 + 1);
    });
    it('keeps hidden Changes quiet and accepts an older daemon full-list response when shown', async () => {
        const entries = ['a.ts', 'b.ts', 'c.ts'].map(path => ({ ...CHANGED_ENTRIES[0]!, path }));
        fixture = await createSessionFilesViewFixture({ rootPath: '/legacy', rpc: request => request.method === 'scm.status.snapshot'
            ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/legacy', entries }) } : undefined });
        fixture.storage.setState({ sessions: {} });
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { ProjectPhoneHead } = await import('@/components/projects/shell/ProjectShellHeaderHost');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const workspaceRef: WorkspaceRefV1 = { id: 'legacy', serverId: fixture.home.id, machineId: 'm1', rootPath: '/legacy', createdAtMs: 1 };
        let setPresented!: React.Dispatch<React.SetStateAction<boolean>>;
        function Host() {
            const [active, setActive] = React.useState(false);
            setPresented = setActive;
            return <PluginSurfaceFocusEligibilityProvider active={active}>
                <ProjectPhoneHead launchers={PHONE_HEAD_LAUNCHERS} workspaceRef={workspaceRef} activeRootPath="/legacy"
                    selection={{ kind: 'builtin', page: 'changes' }} onSelectRootPath={() => {}} />
                <WorkspaceScmReviewDetailsView scopeId="project:legacy" machineId="m1" serverId={fixture.home.id} rootPath="/legacy" />
            </PluginSurfaceFocusEligibilityProvider>;
        }
        const screen = await renderMeasuredReview(<Host />);
        const reads = () => fixture.requests.filter(request => request.method === 'scm.status.snapshot');
        expect(reads()).toHaveLength(0);
        await act(async () => setPresented(true));
        await flushHookEffects({ cycles: 10 });
        expect(reads()).toHaveLength(1);
        expect(reads()[0]!.payload).not.toHaveProperty('entriesPage');
        expect(screen.findByType(ChangedFilesReview).props.allRepositoryChangedFiles).toHaveLength(entries.length);
        expect(screen.findByTestId('scm-review-load-more')).toBeNull();
    });
    it('cold-opens a pinned Machine reading with one saved evidence read and no duplicate capture', async () => {
        const { ScmDiffSummaryResultSchema } = await import('@happier-dev/protocol/scm');
        const source = { kind: 'workingTree' as const };
        const id = 'c'.repeat(64);
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'machine-saved-result', revision: 1, canUndo: false,
            output: { success: true, resultId: 'machine-saved-result', revision: 1, sourceKey: id,
                metadata: { sourceKey: id, source }, comparison: { id, source, repository: { rootPath: '/repo' }, endpoints: {},
                    inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'pending' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) };
            if (request.method === 'scm.diffSummary.result.list') return { success: true, count: 1, bytes: 1,
                results: [{ cwd: '/repo', resultId: result.resultId, revision: 1, comparisonId: id, source, bytes: 1, updatedAtMs: 1 }] };
            if (request.method === 'scm.diffSummary.result.read') return { success: true, result };
            if (request.method === 'scm.diffSummary.capture') return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Duplicate capture' };
            return undefined;
        } });
        fixture.storage.setState({ sessions: {} });
        const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:cold-reading"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo"
            comparison={{ ...source, comparisonId: id }} view="walkthrough" />);
        const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
        await vi.waitFor(() => expect(screen.findByType(WorkspaceScmReviewBody).props.fileCount).toBe(0));
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.result.read').length).toBe(1);
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture').length).toBe(0);
        expect(fixture.requests.filter(request => request.method === 'scm.status.snapshot').map(request => request.payload))
            .toEqual([expect.objectContaining({ detail: 'summary' })]);
    });
    it('does no Review render work for 20 unrelated File drafts and still publishes its own state in a 300-file review', async () => {
        const entries = Array.from({ length: 300 }, (_, index) => ({ ...CHANGED_ENTRIES[0]!, path: `src/file-${index}.ts` }));
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo', entries }) };
            if (request.method === 'scm.diff.file') return { success: true, diff: '@@ -1 +1 @@\n-old\n+new\n' };
            return undefined;
        } });
        fixture.storage.setState({ sessions: {} });
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
        const { SESSION_DETAILS_SCM_REVIEW_TAB_KEY } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
        const onOpenFile = vi.fn();
        const onOpenFilePinned = vi.fn();
        let pane!: ReturnType<typeof useAppPaneScope>;
        let reviewCommits = 0;
        function Control() { pane = useAppPaneScope('project:draft-cost'); return null; }
        const screen = await renderMeasuredReview(<><Control /><React.Profiler id="review" onRender={() => { reviewCommits += 1; }}>
            <WorkspaceScmReviewDetailsView scopeId="project:draft-cost"
                machineId="m1" serverId={fixture.home.id} rootPath="/repo"
                onOpenFile={onOpenFile} onOpenFilePinned={onOpenFilePinned} />
        </React.Profiler></>);
        await act(async () => pane.openDetailsTab({ key: 'file:a', kind: 'file', title: 'a.ts',
            resource: { kind: 'file', path: 'src/a.ts' } }, { intent: 'preview', present: false }));
        await flushHookEffects({ cycles: 20 });
        const model = () => screen.tree.root.findByType(ChangedFilesReview).props;
        expect(model().allRepositoryChangedFiles).toHaveLength(300);
        const initial = model();
        reviewCommits = 0;
        let publications = 0;
        let previous = initial;
        for (let index = 0; index < 20; index += 1) {
            await act(async () => {
                pane.patchDetailsTabState('file:a', { accountId: 'alice', isEditingFile: true,
                    editorOriginalHash: 'base-hash', editorText: `draft ${index}` }, { persist: false });
                if (index === 0) pane.pinDetailsTab('file:a', { persist: false });
            });
            const next = model();
            if (next.turnAttributedFiles !== previous.turnAttributedFiles
                || next.turnRepositoryOnlyFiles !== previous.turnRepositoryOnlyFiles
                || next.sessionAttributedFiles !== previous.sessionAttributedFiles
                || next.hunkReview?.onOutOfDate !== previous.hunkReview?.onOutOfDate) publications += 1;
            previous = next;
        }
        expect(publications).toBe(0);
        expect(reviewCommits).toBe(0);
        expect(model().allRepositoryChangedFiles).toBe(initial.allRepositoryChangedFiles);
        await act(async () => pane.patchDetailsTabState(SESSION_DETAILS_SCM_REVIEW_TAB_KEY, {
            workspaceReviewHost: JSON.stringify([fixture.home.id, 'm1', '/repo']),
            workspaceReviewRouteKey: JSON.stringify([undefined, undefined, undefined, undefined]),
            workspaceReviewTarget: { comparison: { kind: 'workingTree' }, view: 'files', explain: true },
        }));
        expect(reviewCommits).toBeGreaterThan(0);
        expect(screen.findByType(WorkspaceScmReviewBody).props.explain).toBe(true);
        expect(model().onFilePress).toBe(initial.onFilePress);
        expect(model().onFilePressPinned).toBe(initial.onFilePressPinned);
        model().onFilePress(model().allRepositoryChangedFiles[0]);
        const onFilePressPinned = model().onFilePressPinned;
        expect(onFilePressPinned).toBeDefined();
        onFilePressPinned!(model().allRepositoryChangedFiles[1]);
        expect(onOpenFile).toHaveBeenCalledWith('src/file-0.ts');
        expect(onOpenFilePinned).toHaveBeenCalledWith('src/file-1.ts');
    });
    it('keeps comparison chrome stable when file callbacks change and publishes changed host content', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo', entries: CHANGED_ENTRIES }) } : undefined });
        fixture.storage.setState({ sessions: {} });
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const props = { scopeId: 'project:chrome-cost', machineId: 'm1', serverId: fixture.home.id, rootPath: '/repo' };
        let setOpen!: React.Dispatch<React.SetStateAction<(path: string) => void>>;
        let setHostSwitch!: React.Dispatch<React.SetStateAction<React.ReactNode>>;
        function Host() {
            const [open, updateOpen] = React.useState<(path: string) => void>(() => () => {});
            const [hostSwitch, updateHostSwitch] = React.useState<React.ReactNode>(null);
            setOpen = updateOpen;
            setHostSwitch = updateHostSwitch;
            return <WorkspaceScmReviewDetailsView {...props} onOpenFile={open} hostSwitch={hostSwitch} />;
        }
        const screen = await renderMeasuredReview(<Host />);
        await flushHookEffects({ cycles: 20 });
        const model = () => screen.tree.root.findByType(ChangedFilesReview).props;
        const initialChrome = model().comparisonChrome;
        const open = vi.fn();
        await act(async () => setOpen(() => open));
        expect(model().comparisonChrome).toBe(initialChrome);
        model().onFilePress(model().allRepositoryChangedFiles[0]);
        expect(open).toHaveBeenCalledWith(CHANGED_ENTRIES[0]!.path);
        await act(async () => setHostSwitch(<React.Fragment>Changed host mode</React.Fragment>));
        expect(model().comparisonChrome).not.toBe(initialChrome);
        expect(screen.getTextContent()).toContain('Changed host mode');
    });
    it('offers Start review at the actual workspace comparison without opening a Session', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo', entries: CHANGED_ENTRIES }) } : undefined });
        fixture.storage.setState({ sessions: {} });
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        let pane!: ReturnType<typeof useAppPaneScope>;
        function Control() { pane = useAppPaneScope('project:wr'); return null; }
        const screen = await renderMeasuredReview(<><Control /><WorkspaceScmReviewDetailsView scopeId="project:wr"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo" /></>);
        await screen.pressByTestIdAsync('scm-comparison-start-review');
        expect(pane.scopeState).not.toBeNull();
        const opened = pane.scopeState!.details?.tabs.find(tab => tab.kind === 'executionRunLauncher');
        expect(opened).toBeDefined();
        expect(opened?.resource).toMatchObject({ kind: 'executionRunLauncher', intent: 'review', workspace: { machineId: 'm1', cwd: '/repo' },
            comparisonReview: { cwd: '/repo', comparison: { kind: 'workingTree' }, defaultWalkthrough: false } });
        expect(opened?.resource).toHaveProperty('sessionId', null);
        expect(fixture.requests.some(request => request.targetId === 's1')).toBe(false);
    });
    it('offers no review or commit proposal for a checkout with no changes', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) } : undefined });
        fixture.storage.setState({ sessions: {} });
        const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:wr-empty"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo" />);
        await flushHookEffects({ cycles: 20 });
        expect(screen.findByTestId('scm-comparison-bar')).toBeTruthy();
        expect(screen.findByTestId('scm-comparison-start-review')).toBeNull();
        expect(screen.findByTestId('scm-comparison-propose-commits')).toBeNull();
    });
    it('captures separately authorized Session evidence with Session qualification on its admitted Machine', async () => {
        const captured = { id: 'session-evidence', source: { kind: 'session' as const, sessionId: 's1' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete' as const, files: [], reasons: [] } };
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) };
            if (request.method === 'scm.diffSummary.capture') return ScmComparisonCaptureOutputSchema.parse({
                success: true, comparison: captured, metadata: { source: captured.source, sourceKey: captured.id } });
            return undefined;
        } });
        await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:wr"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo"
            evidenceSessionId="s1" comparison={{ kind: 'session' }} />);
        await flushHookEffects({ cycles: 20 });
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ cwd: '/repo', sessionId: 's1', source: captured.source }) }),
        ]);
    });
    it('starts a no-Session review using captured Machine evidence and the canonical detached Action', async () => {
        const inventoryRequests: unknown[] = [];
        const startRequests: unknown[] = [];
        const captured = { id: 'detached-evidence', source: { kind: 'workingTree' as const }, repository: { rootPath: '/repo' },
            endpoints: {}, inventory: { state: 'complete' as const, files: [], reasons: [] } };
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', serverUrl: 'https://workspace-review-details.test',
            credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, serverIdentityId: 'srv_workspace_review_details',
            machine: createMachineFixture({ id: 'm1', kind: 'persistent', storageMode: 'plain', revokedAt: null, replacedByMachineId: null,
                installationPublicKey: Buffer.from(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5)).publicKey).toString('base64'),
                installationId: 'test-installation', access: createPlainMachineRowFixture({ id: 'm1', accountId: 'alice' }).access }), rpc: request => {
            if (request.method === 'scm.diffSummary.capture') return ScmComparisonCaptureOutputSchema.parse({
                success: true, comparison: captured, metadata: { source: captured.source, sourceKey: captured.id } });
            if (request.method === 'capabilities.describe') return { protocolVersion: 1,
                capabilities: [{ id: 'tool.executionRuns', kind: 'tool', protocol: { version: 2, available: true,
                    features: { detachedScope: true, startAndWait: true, exactInputResults: true,
                        runScopedAgentBindings: true, secretReferenceOverlay: true } } }], checklists: {} } satisfies CapabilitiesDescribeResponse;
            if (request.method === 'capabilities.detect') return { protocolVersion: 1, results: { 'tool.executionRuns': {
                ok: true, checkedAt: 1, data: { protocolVersion: 2, backends: { claude: { available: true, intents: ['review'] } },
                    features: { detachedScope: true, startAndWait: true, runScopedAgentBindings: true, secretReferenceOverlay: true } } } } };
            return undefined;
        }, request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                content: { t: 'plain', v: { v: 1, definitions: [] } } }));
            if (path === bindExternalActionExecutionAuthorizationHttpPathV1('execution.run.start') || path === '/v1/actions/execution.run.start') {
                const body: unknown = JSON.parse(String(init?.body));
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body && typeof body === 'object' && 'envelope' in body ? body.envelope : body);
                if (path === bindExternalActionExecutionAuthorizationHttpPathV1('execution.run.start')) return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
                    v: 1, token: 'home-start-authorization', binding: { accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 },
                        serverIdentityId: 'srv_workspace_review_details', machineId: 'm1', installationId: 'test-installation', custodianAccountId: 'alice',
                        accountEncryptionMode: 'plain', actionId: 'execution.run.start', requestId: envelope.requestId, target: envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
                }));
                expect(body).toHaveProperty('executionAuthorization.requesterAccountContext');
                startRequests.push(envelope);
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'execution.run.start', requestId: envelope.requestId,
                    execution: { ok: true, result: ExecutionRunStartResponseSchema.parse({ runId: 'review-1', callId: 'call-1', sidechainId: 'sidechain-1' }) } }));
            }
            if (path !== '/v1/actions/review.engines.list') return Response.json({}, { status: 404 });
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            inventoryRequests.push(envelope);
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'review.engines.list', requestId: envelope.requestId,
                execution: { ok: true, result: { sessionId: null, items: [{ engineId: 'claude', value: 'claude', label: 'Claude', enabled: true,
                    backendId: 'claude', capabilities: { structuredNarration: true }, launchModelId: 'account-review-model' }] } } }));
        },
        });
        fixture.storage.setState({ sessions: {} });
        const { startReviewOfComparison, listReviewEngines, projectReviewWalkthroughEngines } = await import('@/sync/ops/reviews/reviewWalkthrough');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { resolveReviewWalkthroughPlan } = await import('@/sync/domains/reviews/reviewWalkthroughPlan');
        const executor = createDefaultActionExecutor();
        const inventory = await listReviewEngines({ sessionId: null, machineId: 'm1', serverId: fixture.home.id });
        expect(inventory, JSON.stringify({ inventory, methods: fixture.requests.map(request => request.method) }))
            .toMatchObject({ ok: true, inventory: { items: expect.arrayContaining([expect.objectContaining({ engineId: 'claude', enabled: true, launchModelId: 'account-review-model' })]) } });
        expect(inventoryRequests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'm1' },
            input: expect.objectContaining({ sessionId: null, machineId: 'm1' }) })]);
        const outcome = await startReviewOfComparison({ sessionId: null, machineId: 'm1', serverId: fixture.home.id, cwd: '/repo',
            comparison: { kind: 'workingTree' }, instructions: 'Review the pending changes',
            plan: resolveReviewWalkthroughPlan({ engines: inventory.ok ? projectReviewWalkthroughEngines(inventory.inventory) : [],
                reviewers: reviewReviewersForEngineIdsV1(['claude']), walkthrough: false, narratorEngineId: null }),
            start: input => executor.execute('review.start', input, { serverId: fixture.home.id,
                externalActionTarget: { kind: 'machine', machineId: 'm1' }, executionRunTargetMachineId: 'm1' }),
        });
        expect(outcome, JSON.stringify({ outcome, methods: fixture.requests.map(request => request.method) }))
            .toMatchObject({ ok: true, comparisonId: captured.id, reviewRunIds: ['review-1'] });
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ cwd: '/repo', source: captured.source }) }),
        ]);
        expect(startRequests).toEqual([
            expect.objectContaining({ target: { kind: 'machine', machineId: 'm1' }, input: expect.objectContaining({ cwd: '/repo', intent: 'review', childSelection: 'agentDefault',
                intentInput: expect.objectContaining({ comparisonId: captured.id }) }) }),
        ]);
    });
    it('refuses Session evidence from another checkout without falling back to Machine capture', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/other' }) } : undefined });
        const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:other"
            machineId="m1" serverId={fixture.home.id} rootPath="/other" evidenceSessionId="s1" comparison={{ kind: 'session' }} />);
        await flushHookEffects({ cycles: 10 });
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture')).toEqual([]);
        expect(screen.findHostByTestId('source-control-unavailable')).toBeTruthy();
        expect(screen.findHostByTestId('scm-comparison-start-review')).toBeNull();
    });
    it('does not borrow a same-id Session carrier from another Home', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) } : undefined });
        fixture.storage.getState().applySessions([{ ...fixture.session, serverId: 'other-home' }]);
        const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:qualified"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo" evidenceSessionId="s1" comparison={{ kind: 'session' }} />);
        await flushHookEffects({ cycles: 10 });
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture')).toEqual([]);
        expect(screen.findHostByTestId('source-control-unavailable')).toBeTruthy();
        expect(screen.findHostByTestId('scm-comparison-start-review')).toBeNull();
    });
    it('keeps the shared comparison toolbar while the first checkout snapshot is loading', async () => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const snapshotRead = createDeferred<unknown>();
        fixture = await createSessionFilesViewFixture({ rootPath: '/loading', rpc: request =>
            request.method === 'scm.status.snapshot' ? snapshotRead.promise : undefined });
            const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:loading"
            machineId="m1" serverId={fixture.home.id} rootPath="/loading" />);
        expect(screen.findByTestId('scm-comparison-view:walkthrough')).not.toBeNull();
        snapshotRead.resolve({ success: true, snapshot: fileViewSnapshot({ rootPath: '/loading' }) });
        await flushHookEffects({ cycles: 10 });
        expect(screen.findByTestId('scm-comparison-view:walkthrough')).not.toBeNull();
    });
    it('explains live Files using an explicit Machine capture without starting an agent or borrowing a Session', async () => {
        const captured = { id: 'explicit-files', source: { kind: 'workingTree' as const }, repository: { rootPath: '/repo' },
            endpoints: {}, inventory: { state: 'complete' as const, files: [], reasons: [] } };
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo', entries: CHANGED_ENTRIES }) };
            if (request.method === 'scm.diffSummary.capture') return ScmComparisonCaptureOutputSchema.parse({
                success: true, comparison: captured, metadata: { source: captured.source, sourceKey: captured.id },
            });
            return undefined;
        } });
        fixture.storage.setState({ sessions: {} });
        const contexts: unknown[] = [];
            const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:workspace"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo" onExplain={input => contexts.push(input)} />);
        expect(contexts).toEqual([]);
        await screen.pressByTestIdAsync('scm-comparison-explain-with-agent-action');
        await flushHookEffects({ cycles: 10 });
        expect(contexts).toEqual([expect.objectContaining({ comparison: captured, result: null })]);
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ cwd: '/repo', source: { kind: 'workingTree' } }) }),
        ]);
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.generate' || request.targetId === 's1')).toEqual([]);
    });
    it('uses the exact checkout row for comments without requesting plugin grants', async () => {
        const { screen, grants, scope } = await mountWithRows('exact');
        expect(grants).toEqual([]);
        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        expect(screen.tree.root.findByType(ReviewCommentsSessionSurface).props).toMatchObject({
            workspaceId: 'exact-checkout', workspace: { machineId: 'm1', path: '/repo' },
            scope: { ...scope, serverId: resolveServerProfileScopeIdForIdentifier(scope.serverId) },
        });
    });

    it.each(['missing', 'ambiguous'] as const)('leaves checkout grants unavailable when the row is %s', async kind => {
        const { grants } = await mountWithRows(kind);
        expect(grants).toEqual([]);
    });
    it('says an empty comparison once: no count beside the scope, no offer to explain zero files', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) } : undefined });
        fixture.storage.setState({ sessions: {} });
        const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:workspace"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo" onExplain={() => {}} />);
        await vi.waitFor(() => expect(screen.findHostByTestId('changed-files-review-empty')).toBeTruthy());
        expect(screen.findHostByTestId('scm-comparison-explain-with-agent')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('scmComparison.fileCount', { count: 0 }));
        // The empty state says what the page is for, not only that it is empty.
        expect(screen.getTextContent()).toContain(t('files.noChangesPurpose'));
    });
    it('opens review comments from the Files menu instead of a row above the bar', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo', entries: CHANGED_ENTRIES }) } : undefined });
        fixture.storage.setState({ sessions: {} });
        fixture.storage.getState().applySettingsLocal({ featureToggles: { 'files.reviewComments': true } });
        const screen = await renderMeasuredReview(<WorkspaceScmReviewDetailsView scopeId="project:wr"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo" />);
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const commentsRow = () => (screen.tree.root.findByType(ChangedFilesReview).props as React.ComponentProps<typeof ChangedFilesReview>)
            .comparisonChrome?.menuSections?.find((section) => section.id === 'review-comments');
        await vi.waitFor(() => expect(commentsRow()?.items.map((item) => item.testID)).toEqual(['workspace-review-comments-menu']));
        // Nothing unresolved: no disclosure row of its own and no bar action until opened.
        expect(screen.findHostByTestId('workspace-review-comments')).toBeNull();
        expect(screen.findHostByTestId('workspace-review-comments-trigger')).toBeNull();
        await act(async () => { commentsRow()?.onSelect('toggle'); });
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-review-comments')).toBeTruthy());
        // Open, the bar carries the disclosure so the panel closes where it is.
        expect(screen.findHostByTestId('workspace-review-comments-trigger')).toBeTruthy();
        expect(screen.findHostByTestId('workspace-review-comments-header')).toBeNull();
        for (const view of ['walkthrough', 'commits'] as const) {
            await screen.update(fixture.wrap(<WorkspaceScmReviewDetailsView scopeId="project:wr"
                machineId="m1" serverId={fixture.home.id} rootPath="/repo" view={view} />));
            expect(screen.findHostByTestId('workspace-review-comments')).toBeNull();
            expect(screen.findHostByTestId('workspace-review-comments-trigger')).toBeNull();
        }
        await screen.update(fixture.wrap(<WorkspaceScmReviewDetailsView scopeId="project:wr"
            machineId="m1" serverId={fixture.home.id} rootPath="/repo" view="files" />));
        expect(screen.findHostByTestId('workspace-review-comments')).toBeTruthy();
        await screen.pressByTestIdAsync('workspace-review-comments-trigger');
        expect(screen.findHostByTestId('workspace-review-comments')).toBeNull();
    });
});
