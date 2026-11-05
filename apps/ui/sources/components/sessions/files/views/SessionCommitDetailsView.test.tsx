import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import type { DiffFilesListViewProps } from '@/components/ui/code/diff/DiffFilesListView';
import {
    createSessionFilesViewFixture, fileViewSnapshot,
    installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit,
} from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web', emitViewability: false });
// Static fixture dependencies also consume the OS port; install it before their graph loads.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const commitSha = 'abc';
const commitEntry = {
    sha: 'abc1234def5678', shortSha: 'abc1234', authorName: 'Leeroy Brun',
    authorEmail: 'leeroy@example.test', timestamp: 1_790_000_000,
    subject: 'Key the settings modal by route, not window width',
    body: 'Resizing the window remounted SettingsModal because its key included the width.',
};
const diffResponse = vi.fn();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let screen: Awaited<ReturnType<typeof fixture.render>>;

function commitDiff(count = 1): string {
    return Array.from({ length: count }, (_, index) => {
        const path = `src/f${index}.ts`;
        return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
            '@@ -1 +1 @@', `-v${index}`, `+v${index + 1}`, ''].join('\n');
    }).join('\n');
}

// Collect the real store and executor before interaction deadlines begin.
await prepareSessionFilesViewTestkit();
beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
    diffResponse.mockReset().mockResolvedValue({ success: true, diff: commitDiff() });
    fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
        if (request.method === RPC_METHODS.SCM_DIFF_COMMIT) return diffResponse(request);
        if (request.method === RPC_METHODS.SCM_LOG_LIST) return { success: true, queryApplied: true, entries: [commitEntry] };
        return undefined;
    } });
    fixture.setSnapshot(fileViewSnapshot({ rootPath: '/repo' }));
    fixture.storage.getState().applySettingsLocal({
        wrapLinesInDiffs: true, showLineNumbers: true,
        scmReviewMaxFiles: 1, scmReviewMaxChangedLines: 2000,
        scmReviewPrefetchAheadCountWeb: 1, scmReviewPrefetchBehindCountWeb: 1,
        scmReviewPrefetchDebounceMs: 0,
    });
    fixture.storage.setState({ isDataReady: true });
});
afterEach(async () => {
    standardCleanup();
    await fixture?.dispose();
    browser?.restore();
});

function diffRequests() {
    return fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_COMMIT);
}

async function renderCommitDetailsView() {
    const { SessionCommitDetailsView } = await import('./SessionCommitDetailsView');
    screen = await fixture.render(<SessionCommitDetailsView serverId={fixture.scope.serverId} sessionId={fixture.session.id} sha={commitSha} />);
    await vi.waitFor(() => expect(screen.findHostByTestId('scm-commit-details-loading')).toBeNull());
    return screen;
}

async function diffListProps(): Promise<DiffFilesListViewProps> {
    const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
    return screen.tree.root.findByType(DiffFilesListView).props;
}

async function expectWebControls() {
    expect(screen.findHostByTestId('diff-presentation:unified')).not.toBeNull();
    expect(screen.findHostByTestId('diff-presentation:split')).not.toBeNull();
    expect(screen.findHostByTestId('code-wrap-lines-toggle')).not.toBeNull();
}

async function reportVisibleFile(index: number) {
    const props = await diffListProps();
    await act(async () => props.onViewableItemsChanged?.({ viewableItems: [{ index }] }));
    await flushHookEffects({ cycles: 2 });
}

describe('SessionCommitDetailsView', () => {
    it('retries a failed commit diff without leaving the details pane', async () => {
        diffResponse.mockResolvedValueOnce({ success: false, error: 'Temporary failure' });
        await renderCommitDetailsView();
        expect(screen.findHostByTestId('scm-commit-details-error')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Temporary failure');
        await screen.pressByTestIdAsync('scm-commit-details-error-details-toggle');
        expect(screen.getTextContent()).toContain('Temporary failure');
        await screen.pressByTestIdAsync('scm-commit-details-error-action');
        await vi.waitFor(() => expect(screen.findHostByTestId('scm-commit-details-error')).toBeNull());
        expect(diffRequests()).toHaveLength(2);
        expect((await diffListProps()).files).toHaveLength(1);
    });

    it('reads as the commit itself: its subject, author, short SHA and message', async () => {
        await renderCommitDetailsView();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(commitEntry.subject));
        expect(screen.getTextContent()).toContain(commitEntry.authorName);
        expect(screen.getTextContent()).toContain(commitEntry.shortSha);
        expect(screen.getTextContent()).toContain('remounted SettingsModal');
        expect(fixture.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            targetId: fixture.scope.machineId, method: RPC_METHODS.SCM_LOG_LIST,
            payload: expect.objectContaining({ cwd: '/repo', query: commitSha }),
        })]));
    });

    it('renders the diff file list using virtualization', async () => {
        await renderCommitDetailsView();
        const { VirtualizedList } = await import('@/components/ui/lists/virtualized/VirtualizedList');
        expect(diffRequests()).toHaveLength(1);
        expect((await diffListProps()).virtualizeFileList).toBe(true);
        expect(screen.tree.root.findAllByType(VirtualizedList)).toHaveLength(1);
        await expectWebControls();
    });

    it('tracks the first visible file as the large-review expansion anchor', async () => {
        diffResponse.mockResolvedValueOnce({ success: true, diff: commitDiff(3) });
        fixture.storage.getState().applySettingsLocal({ scmReviewPrefetchAheadCountWeb: 0, scmReviewPrefetchBehindCountWeb: 0 });
        await renderCommitDetailsView();
        const initial = await diffListProps();
        expect(initial.files).toHaveLength(3);
        expect([...initial.expandedKeys]).toEqual([initial.files[0]!.key]);
        await reportVisibleFile(1);
        expect([...(await diffListProps()).expandedKeys]).toEqual([initial.files[1]!.key]);
        await expectWebControls();
    });

    it('does not refetch the diff when the session object identity changes', async () => {
        await renderCommitDetailsView();
        expect(diffRequests()).toHaveLength(1);
        await act(async () => fixture.storage.getState().applySessions([{ ...fixture.session, updatedAt: fixture.session.updatedAt + 1 }]));
        const { SessionCommitDetailsView } = await import('./SessionCommitDetailsView');
        // Preserve the public renderer's SafeArea wrapper and the app providers.
        await screen.update(fixture.wrap(<SessionCommitDetailsView serverId={fixture.scope.serverId} sessionId={fixture.session.id} sha={commitSha} />));
        expect(diffRequests()).toHaveLength(1);
        expect((await diffListProps()).files).toHaveLength(1);
    });

    it('keeps rendering the loaded diff if session metadata temporarily becomes unavailable', async () => {
        await renderCommitDetailsView();
        const initialFiles = (await diffListProps()).files;
        await act(async () => fixture.storage.setState(state => ({
            sessions: { ...state.sessions, [fixture.session.id]: { ...state.sessions[fixture.session.id]!, metadata: null } },
        })));
        await flushHookEffects({ cycles: 2 });
        expect(diffRequests()).toHaveLength(1);
        expect((await diffListProps()).files).toBe(initialFiles);
        await expectWebControls();
    });

    it('does not refetch the diff when sessions storage readiness toggles after the diff loads', async () => {
        await renderCommitDetailsView();
        const initialFiles = (await diffListProps()).files;
        await act(async () => fixture.storage.setState({ isDataReady: false }));
        expect((await diffListProps()).files).toBe(initialFiles);
        await act(async () => fixture.storage.setState({ isDataReady: true }));
        expect(diffRequests()).toHaveLength(1);
        expect((await diffListProps()).files).toBe(initialFiles);
    });

    it('enables review comments rendering for inline diffs when the feature is enabled', async () => {
        fixture.storage.getState().applySettingsLocal({ featureToggles: {
            ...fixture.storage.getState().settings.featureToggles, 'files.reviewComments': true,
        } });
        await renderCommitDetailsView();
        const { DiffReviewCommentsViewer } = await import('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer');
        expect(screen.tree.root.findAllByType(DiffReviewCommentsViewer)).toHaveLength(1);
    });

    it('starts large commits with the initial bounded prefetch window expanded', async () => {
        diffResponse.mockResolvedValueOnce({ success: true, diff: commitDiff(4) });
        await renderCommitDetailsView();
        const props = await diffListProps();
        expect([...props.expandedKeys]).toEqual(props.files.slice(0, 3).map(file => file.key));
        expect(props.onViewableItemsChanged).toEqual(expect.any(Function));
    });

    it('tracks the bounded prefetch window around the first visible file', async () => {
        diffResponse.mockResolvedValueOnce({ success: true, diff: commitDiff(8) });
        fixture.storage.getState().applySettingsLocal({ scmReviewPrefetchAheadCountWeb: 1, scmReviewPrefetchBehindCountWeb: 2 });
        await renderCommitDetailsView();
        const initial = await diffListProps();
        expect(initial.files).toHaveLength(8);
        await reportVisibleFile(5);
        expect([...(await diffListProps()).expandedKeys]).toEqual(initial.files.slice(3, 7).map(file => file.key));
    });
});
