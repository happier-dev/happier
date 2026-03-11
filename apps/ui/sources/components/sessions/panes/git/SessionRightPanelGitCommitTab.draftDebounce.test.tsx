import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    FlatList: 'FlatList',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    Platform: { select: (value: any) => value?.default ?? null, OS: 'web' },
    AppState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => {} }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/sessions/files/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: (props: any) => React.createElement('SourceControlBranchSummary', props),
}));

vi.mock('@/components/sessions/sourceControl/commitSelection/ScmChangesSelectionHeaderRow', () => ({
    ScmChangesSelectionHeaderRow: (props: any) => React.createElement('ScmChangesSelectionHeaderRow', props),
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

describe('SessionRightPanelGitCommitTab (draft debounce)', () => {
    it('debounces commit draft persistence so typing does not update pane state on every keystroke', async () => {
        vi.useFakeTimers();

        const onCommitDraftMessageChange = vi.fn();
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
                    scmSnapshot={null}
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
                    onCommitDraftMessageChange={onCommitDraftMessageChange}
                    onCommitFromMessage={() => {}}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    scmStatusFiles={null}
                    showCommitComposer={true}
                />
            );
        });

        const composer = tree.root.findByType('ScmCommitComposerCard' as any);

        await act(async () => {
            composer.props.onDraftMessageChange('h');
            composer.props.onDraftMessageChange('he');
            composer.props.onDraftMessageChange('hel');
        });

        expect(onCommitDraftMessageChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            vi.advanceTimersByTime(400);
            await Promise.resolve();
        });

        expect(onCommitDraftMessageChange).toHaveBeenCalledTimes(1);
        expect(onCommitDraftMessageChange).toHaveBeenCalledWith('hel');

        vi.useRealTimers();
    });
});
