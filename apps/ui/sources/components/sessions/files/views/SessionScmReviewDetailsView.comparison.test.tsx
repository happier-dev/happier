import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, createStorageStoreMock, renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

const pollingSpy = vi.hoisted(() => vi.fn());
const SNAPSHOT = vi.hoisted(() => ({
    fetchedAt: 1,
    projectKey: 'm1:/repo',
    repo: { isRepo: true, rootPath: '/tmp/repo', backendId: 'git', mode: '.git' },
    capabilities: { readLog: true },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    stashCount: 0,
    hasConflicts: false,
    entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
}));


const mockSession = {
    id: 'session-1',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: false,
    activeAt: 0,
    metadata: { path: '/tmp/repo', host: '' },
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 0,
} satisfies Session;

installSessionFilesViewCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            storage: createStorageStoreMock({}),
            useSession: (_id: string) => mockSession,
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionProjectScmSnapshot: () => SNAPSHOT,
            useSessionProjectScmSnapshotError: () => null,
            useWorkspaceScmTouchedPathsForSession: () => [],
            useSessionProjectScmOperationLog: () => [],
            useProjectForSession: () => null,
            useProjectSessions: () => [],
            useSetting: () => 25,
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

const openDetailsTab = vi.hoisted(() => vi.fn());
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openDetailsTab,
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: () => ({
        sessionAttribution: { confidence: 'unknown', reason: 'unavailable' },
        sessionCheckpointOverlap: 'unknown',
        allRepositoryChangedFiles: [],
        turnAttributedFiles: [],
        turnRepositoryOnlyFiles: [],
        sessionAttributedFiles: [],
        repositoryOnlyFiles: [],

        showTurnViewToggle: true,
        showSessionViewToggle: true,
    }),
}));

const derivedCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet', () => ({
    useDerivedSessionChangeSet: (...args: unknown[]) => (derivedCalls.push(args), {
        latestTurnId: 'turn_1',
        sessionLatestTurnId: 'turn_2',
        turnChangeSets: [],
        latestTurnChangeSet: null,
        latestTurnScopedChangeSet: null,
        sessionChangeSet: null,
        latestTurnDiffByPath: null,
        providerDiffByPath: null,
    }),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromAutoRefresh: vi.fn(),
        invalidateFromAutoRefreshAndAwait: vi.fn(),
        invalidateFromMutationAndAwait: vi.fn(),
        invalidateFromUser: vi.fn(),
    },
}));

vi.mock('@/scm/diffCache/useScmDiffCacheLimits', () => ({
    useScmDiffCacheLimits: () => {},
}));

vi.mock('@/scm/refresh/useScmAdaptivePolling', () => ({
    useScmAdaptivePolling: pollingSpy,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));
vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/workspaces/scm/review/ChangedFilesReview', () => ({
    ChangedFilesReview: (props: Record<string, unknown>) => React.createElement('ChangedFilesReview', props),
}));
vi.mock('@/components/sessions/files/comparison/ScmComparisonScopePicker', () => ({
    ScmComparisonScopePicker: (props: Record<string, unknown>) => React.createElement('ScmComparisonScopePicker', props),
}));


describe('SessionScmReviewDetailsView (comparison)', () => {
    it('shows the turn a link names and switches scope by updating the same destination', async () => {
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        derivedCalls.length = 0;
        openDetailsTab.mockClear();
        const screen = await renderScreen(<SessionScmReviewDetailsView
            sessionId="s1"
            serverId="home-a"
            scopeId="session:s1"
            target={{ comparison: { kind: 'turnCheckpoint', turnId: 'turn_1' }, view: 'files' }}
        />);
        expect(derivedCalls.at(-1)?.[2]).toEqual({ presentedTurnId: 'turn_1' });
        const review = screen.findByType('ChangedFilesReview' as never);
        expect(review.props.changedFilesViewMode).toBe('turn');
        const chrome = review.props.comparisonChrome as { renderBarLeading: (coverage: unknown) => React.ReactElement };
        // The bar leads with the Files | Walkthrough switch, then the scope picker, over one comparison.
        const leading = chrome.renderBarLeading({ fileCount: 4, added: 1, removed: 0, linesKnown: true });
        const parts = React.Children.toArray((leading.props as { children: React.ReactNode }).children) as React.ReactElement[];
        const viewSwitch = parts.find((part) => Array.isArray((part.props as { views?: unknown }).views))!;
        const picker = parts.find((part) => Array.isArray((part.props as { options?: unknown }).options))!;
        const props = picker.props as { current: unknown; currentLabel: string; onSelect: (comparison: unknown) => void; options: Array<{ comparison: unknown }> };
        expect(props.current).toEqual({ kind: 'turnCheckpoint', turnId: 'turn_1' });
        // The named earlier turn is not the latest one; the picker still lists where you are and the latest turn.
        expect(props.options.map((option) => option.comparison)).toEqual(expect.arrayContaining([
            { kind: 'workingTree' },
            { kind: 'session' },
            { kind: 'turnCheckpoint', turnId: 'turn_2' },
            { kind: 'turnCheckpoint', turnId: 'turn_1' },
        ]));
        props.onSelect({ kind: 'session' });
        expect(openDetailsTab).toHaveBeenLastCalledWith(
            expect.objectContaining({ key: 'scmReview:working', resource: expect.objectContaining({ comparison: { kind: 'session' }, view: 'files' }) }),
            { intent: 'pinned' },
        );
        // Walkthrough is the same destination and comparison in another view: the tab updates in place.
        (viewSwitch.props as { onSelect: (view: string) => void }).onSelect('walkthrough');
        expect(openDetailsTab).toHaveBeenLastCalledWith(
            expect.objectContaining({ key: 'scmReview:working', resource: expect.objectContaining({ comparison: { kind: 'turnCheckpoint', turnId: 'turn_1' }, view: 'walkthrough' }) }),
            { intent: 'pinned' },
        );
    }, 120_000);

    it('says it cannot show a comparison it cannot read yet, instead of showing another one', async () => {
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        openDetailsTab.mockClear();
        const screen = await renderScreen(<SessionScmReviewDetailsView
            sessionId="s1"
            scopeId="session:s1"
            target={{ comparison: { kind: 'turnCheckpoint' } }}
        />);
        expect(screen.findAllByType('ChangedFilesReview' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('scm-comparison-unsupported').length).toBeGreaterThan(0);
    }, 120_000);
});
