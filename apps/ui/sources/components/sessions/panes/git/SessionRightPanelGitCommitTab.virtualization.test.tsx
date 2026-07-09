import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionGitPaneCommonModuleMocks();
vi.mock('@/components/workspaces/scm/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: (props: any) => React.createElement('SourceControlBranchSummary', props),
}));
vi.mock('@/components/sessions/sourceControl/commitSelection/ScmChangesSelectionHeaderRow', () => ({
    ScmChangesSelectionHeaderRow: (props: any) => React.createElement('ScmChangesSelectionHeaderRow', props),
}));
vi.mock('@/components/workspaces/scm/commitComposer/ScmCommitComposerCard', () => ({
    ScmCommitComposerCard: (props: any) => React.createElement('ScmCommitComposerCard', props),
}));
vi.mock('@/components/workspaces/scm/changes/ScmChangeRow', () => ({
    ScmChangeRow: (props: any) => React.createElement('ScmChangeRow', props),
    resolveScmChangeStatsColumnWidth: (files: readonly any[]) => {
        const maxLabelLength = files.reduce((maxLength, file) => {
            const added = Number.isFinite(file?.linesAdded) ? String(Math.max(0, Math.trunc(file.linesAdded))) : '0';
            const removed = Number.isFinite(file?.linesRemoved) ? String(Math.max(0, Math.trunc(file.linesRemoved))) : '0';
            return Math.max(maxLength, `+${added}/-${removed}`.length);
        }, 0);
        return Math.max(38, maxLabelLength * 7 + 4);
    },
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', async () => {
    const React = await import('react');
    return {
        DropdownMenu: (props: any) => React.createElement(
            'DropdownMenu',
            props,
            typeof props.trigger === 'function'
                ? props.trigger({
                    open: false,
                    toggle: vi.fn(),
                    openMenu: vi.fn(),
                    closeMenu: vi.fn(),
                    selectedItem: props.items.find((item: any) => item.id === props.selectedId) ?? null,
                })
                : props.trigger,
        ),
    };
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function makeGitTheme() {
    return {
        colors: {
            border: {
                default: '#ddd',
            },
            divider: '#ddd',
            surface: {
                base: '#fff',
                inset: '#f6f6f6',
            },
            surfaceHigh: '#f6f6f6',
            text: {
                primary: '#000',
                secondary: '#666',
            },
            textSecondary: '#666',
            success: '#0a0',
            warning: '#f90',
            textLink: '#09f',
        },
    };
}

describe('SessionRightPanelGitCommitTab (virtualization)', () => {
    it('hides changed-file view mode chips when only repository view is available', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const screen = await renderScreen(<SessionRightPanelGitCommitTab
                    theme={makeGitTheme()}
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
                    allRepositoryChangedFiles={[{
                        fullPath: 'src/file-0.ts',
                        path: 'src/file-0.ts',
                        kind: 'modified',
                        stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
                    }] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    showTurnViewToggle={false}
                    showSessionViewToggle={false}
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
                />);

        const flatList = screen.tree.findByType('FlatList' as any);
        const headerScreen = await renderScreen(flatList.props.ListHeaderComponent);
        const textContent = headerScreen.getTextContent();
        expect(textContent).not.toContain('files.toolbar.repositoryView');
        expect(textContent).not.toContain('files.toolbar.turnView');
        expect(textContent).not.toContain('files.toolbar.sessionView');

        const actionsRow = headerScreen.tree.findByProps({ testID: 'session-rightpanel-git-scope-actions-row' });
        expect(flattenStyle(actionsRow.props.style)).toMatchObject({
            alignItems: 'center',
        });
    });

    it('renders scoped changed-file view modes as a compact menu next to review', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const onChangedFilesViewMode = vi.fn();

        const screen = await renderScreen(<SessionRightPanelGitCommitTab
                    theme={makeGitTheme()}
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
                    allRepositoryChangedFiles={[{
                        fullPath: 'src/file-0.ts',
                        path: 'src/file-0.ts',
                        kind: 'modified',
                        stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
                    }] as any}
                    turnAttributedFiles={[] as any}
                    turnRepositoryOnlyFiles={[] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    showTurnViewToggle={true}
                    showSessionViewToggle={true}
                    onChangedFilesViewMode={onChangedFilesViewMode}
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
                    onOpenReviewAllChanges={() => {}}
                />);

        const flatList = screen.tree.findByType('FlatList' as any);
        const headerScreen = await renderScreen(flatList.props.ListHeaderComponent);
        const menu = headerScreen.tree.findByType('DropdownMenu' as any);
        expect(menu.props.selectedId).toBe('repository');
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual([
            'repository',
            'turn',
            'session',
        ]);

        const textContent = headerScreen.getTextContent();
        expect(textContent).toContain('files.repositoryChangedFiles');
        expect(textContent).not.toContain('files.toolbar.changedFiles');
        expect(textContent).toContain('files.toolbar.review');
        expect(textContent).not.toContain('files.toolbar.repositoryView');
        expect(textContent).not.toContain('files.toolbar.turnView');
        expect(textContent).not.toContain('files.toolbar.sessionView');

        menu.props.onSelect('session');
        expect(onChangedFilesViewMode).toHaveBeenCalledWith('session');
    });

    it('renders a FlatList for repository changed files to avoid huge ScrollView renders', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const files = Array.from({ length: 200 }).map((_, idx) => ({
            fullPath: `src/file-${idx}.ts`,
            path: `src/file-${idx}.ts`,
            kind: 'modified',
            stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
        }));

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SessionRightPanelGitCommitTab
                    theme={makeGitTheme()}
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
                    allRepositoryChangedFiles={files as any}
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
                />)).tree;

        expect(() => tree.findByType('FlatList' as any)).not.toThrow();

        const flatList = tree.findByType('FlatList' as any);
        expect(flatList.props.initialNumToRender).toBeLessThanOrEqual(12);
        expect(flatList.props.maxToRenderPerBatch).toBeLessThanOrEqual(12);
    });

    it('renders session-scoped changed files through the bounded FlatList path', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const files = Array.from({ length: 200 }).map((_, idx) => ({
            fileName: `session-file-${idx}.ts`,
            filePath: 'src',
            fullPath: `src/session-file-${idx}.ts`,
            status: 'modified',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 0,
        }));

        const screen = await renderScreen(<SessionRightPanelGitCommitTab
                    theme={makeGitTheme()}
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
                    changedFilesViewMode="session"
                    attributionReliability="high"
                    allRepositoryChangedFiles={files as any}
                    turnAttributedFiles={[] as any}
                    sessionAttributedFiles={files.map((file) => ({ file, confidence: 'high' })) as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    showSessionViewToggle={true}
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
                />);

        const flatList = screen.tree.findByType('FlatList' as any);
        expect(flatList.props.data).toHaveLength(200);
        expect(flatList.props.initialNumToRender).toBeLessThanOrEqual(12);
        expect(flatList.props.maxToRenderPerBatch).toBeLessThanOrEqual(12);
        expect(screen.tree.findAllByType('ScrollView' as any)).toHaveLength(0);
    });

    it('uses the largest visible virtualized change stats as a shared stats column width', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const files = [
            {
                fileName: 'small.ts',
                filePath: 'src',
                fullPath: 'src/small.ts',
                status: 'modified',
                isIncluded: false,
                linesAdded: 1,
                linesRemoved: 0,
            },
            {
                fileName: 'requestId.test.ts',
                filePath: 'src/middleware',
                fullPath: 'src/middleware/requestId.test.ts',
                status: 'modified',
                isIncluded: false,
                linesAdded: 146,
                linesRemoved: 10,
            },
        ];

        const screen = await renderScreen(<SessionRightPanelGitCommitTab
                    theme={makeGitTheme()}
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
                    allRepositoryChangedFiles={files as any}
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
                />);

        const flatList = screen.tree.findByType('FlatList' as any);
        const firstRow = flatList.props.renderItem({ item: files[0], index: 0 });
        const secondRow = flatList.props.renderItem({ item: files[1], index: 1 });

        expect(firstRow.props.statsColumnWidth).toBe(secondRow.props.statsColumnWidth);
        expect(firstRow.props.statsColumnWidth).toBeGreaterThan(38);
    });

    it('does not render selection summary above the changes list (keeps it near commit composer)', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const files = Array.from({ length: 3 }).map((_, idx) => ({
            fullPath: `src/file-${idx}.ts`,
            path: `src/file-${idx}.ts`,
            kind: 'modified',
            stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
        }));

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SessionRightPanelGitCommitTab
                    theme={makeGitTheme()}
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
                    changedFilesViewMode="session"
                    attributionReliability="high"
                    allRepositoryChangedFiles={files as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    repositorySelectedCount={2}
                    onSelectAll={() => {}}
                    onSelectNone={() => {}}
                    disableSelectAll={false}
                    disableSelectNone={false}
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
                />)).tree;

        expect(() => tree.findByType('ScmChangesSelectionHeaderRow' as any)).toThrow();
    });

    it('filters directory-like SCM entries from the repository changed files list', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const files = [
            {
                fullPath: 'src/file-0.ts',
                path: 'src/file-0.ts',
                kind: 'modified',
                stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
            },
            {
                fullPath: 'src/some-dir/',
                path: 'src/some-dir/',
                kind: 'added',
                stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
            },
        ];

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SessionRightPanelGitCommitTab
                    theme={makeGitTheme()}
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
                    allRepositoryChangedFiles={files as any}
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
                />)).tree;

        const flatList = tree.findByType('FlatList' as any);
        expect(Array.isArray(flatList.props.data)).toBe(true);
        expect(flatList.props.data).toHaveLength(1);
        expect(flatList.props.data[0].fullPath).toBe('src/file-0.ts');
    });

    it('keeps virtualized changed-file props stable when equivalent theme objects change', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const files = [
            {
                fullPath: 'src/file-0.ts',
                path: 'src/file-0.ts',
                kind: 'modified',
                stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
            },
        ];
        const props: React.ComponentProps<typeof SessionRightPanelGitCommitTab> = {
            theme: makeGitTheme(),
            sessionId: 's1',
            sessionPath: '/workspace',
            backendLabel: 'Git',
            commitActionLabel: 'Commit',
            scmSnapshot: null,
            hasConflicts: false,
            scmOperationBusy: false,
            scmOperationStatus: null,
            hasGlobalOperationInFlight: false,
            inFlightScmOperation: null,
            commitAllowed: false,
            commitBlockedMessage: null,
            changedFilesViewMode: 'repository',
            attributionReliability: 'high',
            allRepositoryChangedFiles: files as any,
            sessionAttributedFiles: [] as any,
            repositoryOnlyFiles: [] as any,
            suppressedInferredCount: 0,
            repositorySelectedCount: 0,
            onSelectAll: () => {},
            onSelectNone: () => {},
            disableSelectAll: true,
            disableSelectNone: true,
            onFilePress: () => {},
            onFilePressPinned: () => {},
            onToggleSelectionForFile: () => {},
            renderFileActions: () => null,
            renderFileTrailingActions: () => null,
            commitDraftMessage: '',
            onCommitDraftMessageChange: () => {},
            onCommitFromMessage: () => {},
            commitMessageGeneratorEnabled: false,
            onGenerateCommitMessageSuggestion: async () => ({ ok: true, message: '' }),
            scmStatusFiles: null,
            showCommitComposer: false,
        };

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(<SessionRightPanelGitCommitTab {...props} />);
        });
        const before = tree.root.findByType('FlatList' as any).props;

        await renderer.act(async () => {
            tree.update(<SessionRightPanelGitCommitTab {...props} theme={makeGitTheme()} />);
        });
        const after = tree.root.findByType('FlatList' as any).props;

        expect(after.keyExtractor).toBe(before.keyExtractor);
        expect(after.renderItem).toBe(before.renderItem);
        expect(after.contentContainerStyle).toBe(before.contentContainerStyle);
        expect(after.getItemLayout).toBe(before.getItemLayout);
        expect(after.extraData).toBe(before.extraData);
        expect(after.ListHeaderComponent).toBe(before.ListHeaderComponent);
    });

    it('flows a changed per-row action renderer into FlatList extraData so cached cells re-render', async () => {
        // Regression: entering "select files for commit" (or toggling a single
        // file's selection) changes `renderFileActions` identity, but the "+"
        // buttons only appeared after some *unrelated* state change flushed the
        // cached cells. Root cause: `renderItem` is intentionally stable (reads
        // from a ref for perf), so RN's FlatList only re-renders cells when `data`
        // or `extraData` change — and `extraData` omitted the per-row action
        // renderers. The fix threads them into `extraData`; this test locks that
        // signal (and that `renderItem` stays referentially stable).
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const files = [
            {
                fullPath: 'src/file-0.ts',
                path: 'src/file-0.ts',
                kind: 'modified',
                stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
            },
        ];
        const actionsA = () => null;
        const actionsB = () => null;

        function Wrapper() {
            const [useB, setUseB] = React.useState(false);
            return (
                <>
                    <SessionRightPanelGitCommitTab
                        theme={makeGitTheme()}
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
                        allRepositoryChangedFiles={files as any}
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
                        renderFileActions={useB ? actionsB : actionsA}
                        renderFileTrailingActions={() => null}
                        commitDraftMessage=""
                        onCommitDraftMessageChange={() => {}}
                        onCommitFromMessage={() => {}}
                        commitMessageGeneratorEnabled={false}
                        onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                        scmStatusFiles={null}
                        showCommitComposer={false}
                    />
                    {React.createElement('Pressable' as any, {
                        testID: 'toggle-actions',
                        onPress: () => setUseB(true),
                    })}
                </>
            );
        }

        const screen = await renderScreen(<Wrapper />);
        const firstFlatListProps = screen.tree.findByType('FlatList' as any).props;
        expect(firstFlatListProps.extraData.renderFileActions).toBe(actionsA);

        await renderer.act(async () => {
            screen.pressByTestId('toggle-actions');
        });

        const nextFlatListProps = screen.tree.findByType('FlatList' as any).props;
        // `renderItem` MUST stay stable (perf), and `extraData` MUST change to a
        // new object carrying the new renderer — that is the documented FlatList
        // re-render signal that surfaces the "+" on already-rendered rows.
        expect(nextFlatListProps.renderItem).toBe(firstFlatListProps.renderItem);
        expect(nextFlatListProps.extraData).not.toBe(firstFlatListProps.extraData);
        expect(nextFlatListProps.extraData.renderFileActions).toBe(actionsB);
    });
});
