import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachineFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ renderItemLimit: 25 });
await prepareSessionFilesViewTestkit();
const { ProjectGitSurface } = await import('./ProjectGitSurface');
const { ProjectPageCatalogProvider, useProjectPageCatalog } = await import('@/components/projects/navigation/useProjectPageCatalog');
const { ProjectPhoneHead } = await import('@/components/projects/shell/ProjectShellHeaderHost');
const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
const { ProjectBuiltinWidgetBody } = await import('@/components/projects/widgets/ProjectBuiltinWidgetBody');
const { useResolvedRepoWorktreeSelection } = await import('@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection');

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

function ContextFacts() {
    const { context } = useProjectPageCatalog();
    return React.createElement('ProjectContextFacts', { branch: context.target?.branch, checkout: context.target?.checkout?.id });
}

function SelectionFacts(props: Readonly<{ serverId: string; rootPath: string; requestedRootPath?: string; requestedWorktreeId?: string }>) {
    const scope = React.useMemo(() => ({ serverId: props.serverId, machineId: 'm1', rootPath: props.rootPath }),
        [props.serverId, props.rootPath]);
    const selection = useResolvedRepoWorktreeSelection({ scope,
        defaultRootPath: props.rootPath, requestedRootPath: props.requestedRootPath ?? props.rootPath,
        requestedWorktreeId: props.requestedWorktreeId, refreshOnMount: true });
    return React.createElement('WorktreeSelectionFacts', selection);
}

// The phone head's launchers; its Machine chip is the header's checkout read under test.
const PHONE_HEAD_LAUNCHERS = { testIdPrefix: 'project-header', showWorktreesButton: false } as const;

describe('Project Changes status demand through its page entry', () => {
    it('does not acquire status to resolve an already-known default checkout', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/default', rpc: request => {
            if (request.method !== 'scm.status.snapshot') return undefined;
            return { success: true, snapshot: { ...fileViewSnapshot({ rootPath: '/default' }), detail: 'summary' } };
        } });
        fixture.storage.setState({ sessions: {} });
        const screen = await fixture.render(<>
            <SelectionFacts serverId={fixture.home.id} rootPath="/default" />
            <SelectionFacts serverId={fixture.home.id} rootPath="/default" />
        </>);
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        await act(async () => { await scmStatusSync.getWorkspaceSync({ serverId: fixture.home.id, machineId: 'm1', rootPath: '/default' }).awaitQueue(); });
        expect(fixture.requests.filter(request => request.method === 'scm.status.snapshot')).toHaveLength(0);
        expect(screen.findAllByType('WorktreeSelectionFacts').map(node => node.props.resolvedRootPath)).toEqual(['/default', '/default']);
    });

    it.each([
        { requestedRootPath: '/worktrees/missing', requestedWorktreeId: undefined },
        { requestedRootPath: '/worktrees', requestedWorktreeId: 'missing-worktree' },
    ])('still resolves an explicit worktree selection through summary: $requestedRootPath / $requestedWorktreeId', async selection => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/worktrees', rpc: request => {
            if (request.method !== 'scm.status.snapshot') return undefined;
            return { success: true, snapshot: { ...fileViewSnapshot({ rootPath: '/worktrees' }), detail: 'summary' } };
        } });
        fixture.storage.setState({ sessions: {} });
        const screen = await fixture.render(<SelectionFacts serverId={fixture.home.id} rootPath="/worktrees" {...selection} />);
        await flushHookEffects({ cycles: 20 });
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        await act(async () => { await scmStatusSync.getWorkspaceSync({ serverId: fixture.home.id, machineId: 'm1', rootPath: '/worktrees' }).awaitQueue(); });
        const reads = fixture.requests.filter(request => request.method === 'scm.status.snapshot');
        expect(reads).toHaveLength(1);
        expect(reads[0]!.payload).toMatchObject({ detail: 'summary' });
        expect(screen.findByType('WorktreeSelectionFacts').props).toMatchObject({ resolvedRootPath: '/worktrees', didRecoverMissingWorktree: true });
    });

    it.each(['project_about', 'project_checkouts'] as const)('%s consumes repository facts without retaining full-list demand', async id => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/summary', rpc: request => {
            if (request.method !== 'scm.status.snapshot') return undefined;
            const snapshot = fileViewSnapshot({ rootPath: '/summary' });
            return { success: true, snapshot: { ...snapshot, detail: 'summary' } };
        } });
        fixture.storage.setState({ sessions: {} });
        const checkout = { id: 'summary', serverId: fixture.home.id, machineId: 'm1', rootPath: '/summary', createdAtMs: 1 };
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [checkout] });
        await fixture.render(<ProjectBuiltinWidgetBody id={id} checkout={checkout} workspace={{ ...checkout, workspaceId: checkout.id }} testID={id} />);
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        await act(async () => { await scmStatusSync.invalidateFromUserAndAwait(checkout); });
        const reads = fixture.requests.filter(request => request.method === 'scm.status.snapshot');
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(request => (request.payload as { detail?: string }).detail === 'summary'),
            'facts-only widget and navigation consumers must not override a Changes viewport with full inventory demand').toBe(true);
    });

    it('keeps route selectors, catalog and header bounded by the viewport, then delivers another page on scroll', async () => {
        const totalFiles = 60_221;
        const entry = { previousPath: null, kind: 'modified' as const, includeStatus: '', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false } };
        const entries = Array.from({ length: totalFiles }, (_, index) => ({ ...entry, path: `src/file-${index}.ts` }));
        const replyBytes: number[] = [];
        fixture = await createSessionFilesViewFixture({ rootPath: '/viewport',
            machine: createMachineFixture({ id: 'm1', operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { scmStatusSnapshotPaging: { protocolVersions: [1] } } }),
            rpc: request => {
                if (request.method !== 'scm.status.snapshot') return undefined;
                const input = request.payload as { entriesPage?: { limit: number; cursor?: number } };
                const cursor = input.entriesPage?.cursor ?? 0;
                const limit = input.entriesPage?.limit ?? totalFiles;
                const snapshot = fileViewSnapshot({ rootPath: '/viewport', entries: entries.slice(cursor, cursor + limit) });
                const reply = { success: true, snapshot: { ...snapshot,
                    branch: { ...snapshot.branch, head: 'feature/viewport' },
                    summary: { changedFiles: totalFiles, includedAdded: 0, includedRemoved: 0, pendingAdded: totalFiles, pendingRemoved: totalFiles },
                    totals: { ...snapshot.totals, pendingFiles: totalFiles, pendingAdded: totalFiles, pendingRemoved: totalFiles },
                    entriesPage: { totalFiles, nextCursor: cursor + limit < totalFiles ? cursor + limit : null } } };
                replyBytes.push(new TextEncoder().encode(JSON.stringify(reply)).byteLength);
                return reply;
            } });
        fixture.storage.setState({ sessions: {} });
        const workspaceRef = { id: 'viewport', serverId: fixture.home.id, machineId: 'm1', rootPath: '/viewport', projectKey: 'viewport-project', createdAtMs: 1 };
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [workspaceRef] });
        const noop = () => {};
        const screen = await fixture.render(<>
            {/* Both production Project entry layers resolve this same checkout selection. */}
            <SelectionFacts serverId={fixture.home.id} rootPath="/viewport" />
            <SelectionFacts serverId={fixture.home.id} rootPath="/viewport" />
            <ProjectPageCatalogProvider workspaceRef={workspaceRef} activeRootPath="/viewport"
                scopeId="project:viewport" selection={{ kind: 'builtin', page: 'changes' }}>
            <ContextFacts />
            <ProjectPhoneHead launchers={PHONE_HEAD_LAUNCHERS} workspaceRef={workspaceRef} activeRootPath="/viewport"
                selection={{ kind: 'builtin', page: 'changes' }} onSelectRootPath={noop} />
            <ProjectGitSurface scopeId="project:viewport" serverId={fixture.home.id} machineId="m1" rootPath="/viewport"
                onOpenFile={noop} onOpenFilePinned={noop} onOpenReviewAllChanges={noop} onOpenStashDetails={noop}
                onOpenCommit={noop} onSelectWorkspacePath={noop} onRequestCreateWorktreeFromAnotherBranch={noop} onRevealInFilesTree={noop} />
        </ProjectPageCatalogProvider></>);
        const reads = () => fixture.requests.filter(request => request.method === 'scm.status.snapshot');
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        await act(async () => { await scmStatusSync.getWorkspaceSync(workspaceRef).awaitQueue(); });
        expect(reads(), 'Project context and chrome must not acquire the inventory before viewport measurement').toHaveLength(0);
        const viewport = screen.findByType(WorkspaceScmReviewBody).find(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
        await act(async () => viewport.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 480 } } }));
        await flushHookEffects({ cycles: 20 });
        expect(reads()).toHaveLength(1);
        const { resolveScmChangeCompactRowHeight } = await import('@/components/workspaces/scm/changes/ScmChangeRow');
        const limit = Math.ceil(480 / resolveScmChangeCompactRowHeight(true));
        expect(reads()[0]!.payload).toMatchObject({ entriesPage: { limit } });
        expect(screen.findByType(ChangedFilesReview).props.allRepositoryChangedFiles).toHaveLength(limit);
        expect(screen.findByType(WorkspaceScmReviewBody).props.fileCount).toBe(totalFiles);
        expect(screen.tree.root.findByType('ProjectContextFacts').props).toMatchObject({ branch: 'feature/viewport', checkout: 'viewport' });
        const fullReplyBytes = new TextEncoder().encode(JSON.stringify(fileViewSnapshot({ rootPath: '/viewport', entries }))).byteLength;
        expect(replyBytes[0]).toBeLessThan(fullReplyBytes);
        await act(async () => screen.findByType(DiffFilesListView).props.onScroll({ nativeEvent: {
            contentOffset: { x: 0, y: 480 }, layoutMeasurement: { width: 1200, height: 480 }, contentSize: { width: 1200, height: 960 },
        } }));
        await flushHookEffects({ cycles: 20 });
        expect(reads()).toHaveLength(2);
        expect(reads()[1]!.payload).toMatchObject({ entriesPage: { limit, cursor: limit } });
        expect(screen.findByType(ChangedFilesReview).props.allRepositoryChangedFiles).toHaveLength(limit * 2);
        console.info('Project entry paging', { totalFiles, limit, replyBytes, fullReplyBytes });
    });
});
