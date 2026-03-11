import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stashListMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    View: 'View',
    FlatList: (props: any) => {
        const header = props.ListHeaderComponent ? React.createElement(React.Fragment, null, props.ListHeaderComponent) : null;
        const items = Array.isArray(props.data)
            ? props.data.map((item: any, index: number) => React.createElement(React.Fragment, { key: `item-${index}` }, props.renderItem?.({ item, index })))
            : null;

        return React.createElement('FlatList', props, header, items);
    },
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    Platform: { select: (value: any) => value?.default ?? null, OS: 'web' },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/sessions/files/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: (props: any) => React.createElement('SourceControlBranchSummary', props),
}));

vi.mock('@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard', () => ({
    ScmCommitComposerCard: (props: any) => React.createElement('ScmCommitComposerCard', props),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeRow', () => ({
    ScmChangeRow: (props: any) => React.createElement('ScmChangeRow', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
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
    ScrollEdgeFades: (props: any) => React.createElement('ScrollEdgeFades', props),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: (props: any) => React.createElement('ScrollEdgeIndicators', props),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmStashList: stashListMock,
}));

describe('SessionRightPanelGitCommitTab (stash summary)', () => {
    it('renders stash summary row immediately from the snapshot stash count before the live stash RPC resolves', async () => {
        stashListMock.mockImplementation(() => new Promise(() => {}));

        const onOpenStashDetails = vi.fn();
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRightPanelGitCommitTab
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f', danger: '#c00' } }}
                    sessionId="s1"
                    sessionPath="/workspace"
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    scmSnapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readStash: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 2,
                    } as any}
                    scmWriteEnabled={true}
                    hasConflicts={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    commitAllowed={false}
                    commitBlockedMessage={null}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    repositorySelectedCount={0}
                    onSelectAll={() => {}}
                    onSelectNone={() => {}}
                    disableSelectAll={true}
                    disableSelectNone={true}
                    onFilePress={() => {}}
                    onFilePressPinned={() => {}}
                    onToggleSelectionForFile={() => {}}
                    renderFileActions={() => null}
                    renderFileTrailingActions={() => null}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={() => {}}
                    onCommitFromMessage={() => {}}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    scmStatusFiles={null}
                    showCommitComposer={false}
                    onOpenStashDetails={onOpenStashDetails}
                />
            );
        });

        const row = tree.root.findByProps({ testID: 'scm-stash-summary-row' });
        const countText = tree.root.findAll(
            (node) => typeof node.props?.children === 'string' && node.props.children === '2',
        );

        act(() => {
            row.props.onPress();
        });

        expect(countText).not.toHaveLength(0);
        expect(onOpenStashDetails).toHaveBeenCalledTimes(1);
    });

    it('renders stash summary row when stash read is available even if write operations are disabled', async () => {
        stashListMock.mockResolvedValue({
            success: true,
            managedCount: 1,
            managedStashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main' }],
            totalCount: 1,
        });

        const onOpenStashDetails = vi.fn();
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRightPanelGitCommitTab
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f', danger: '#c00' } }}
                    sessionId="s1"
                    sessionPath="/workspace"
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    scmSnapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readStash: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    scmWriteEnabled={false}
                    hasConflicts={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    commitAllowed={false}
                    commitBlockedMessage={null}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    repositorySelectedCount={0}
                    onSelectAll={() => {}}
                    onSelectNone={() => {}}
                    disableSelectAll={true}
                    disableSelectNone={true}
                    onFilePress={() => {}}
                    onFilePressPinned={() => {}}
                    onToggleSelectionForFile={() => {}}
                    renderFileActions={() => null}
                    renderFileTrailingActions={() => null}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={() => {}}
                    onCommitFromMessage={() => {}}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    scmStatusFiles={null}
                    showCommitComposer={false}
                    onOpenStashDetails={onOpenStashDetails}
                />
            );
        });

        await act(async () => {});

        const row = tree.root.findByProps({ testID: 'scm-stash-summary-row' });
        act(() => {
            row.props.onPress();
        });

        expect(onOpenStashDetails).toHaveBeenCalledTimes(1);
    });

    it('renders stash summary row when managed stashes exist and opens details on press', async () => {
        stashListMock.mockResolvedValue({
            success: true,
            managedCount: 1,
            managedStashes: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'main' }],
            totalCount: 1,
        });

        const onOpenStashDetails = vi.fn();
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionRightPanelGitCommitTab
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f', danger: '#c00' } }}
                    sessionId="s1"
                    sessionPath="/workspace"
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    scmSnapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readStash: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    scmWriteEnabled={true}
                    hasConflicts={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    hasGlobalOperationInFlight={false}
                    inFlightScmOperation={null}
                    commitAllowed={false}
                    commitBlockedMessage={null}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    repositorySelectedCount={0}
                    onSelectAll={() => {}}
                    onSelectNone={() => {}}
                    disableSelectAll={true}
                    disableSelectNone={true}
                    onFilePress={() => {}}
                    onFilePressPinned={() => {}}
                    onToggleSelectionForFile={() => {}}
                    renderFileActions={() => null}
                    renderFileTrailingActions={() => null}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={() => {}}
                    onCommitFromMessage={() => {}}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    scmStatusFiles={null}
                    showCommitComposer={false}
                    onOpenStashDetails={onOpenStashDetails}
                />
            );
        });

        // allow stash list effect to resolve
        await act(async () => {});

        const row = tree.root.findByProps({ testID: 'scm-stash-summary-row' });
        act(() => {
            row.props.onPress();
        });

        expect(onOpenStashDetails).toHaveBeenCalledTimes(1);
    });
});
