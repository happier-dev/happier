import * as React from 'react';
import renderer from 'react-test-renderer';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).requestAnimationFrame ??= vi.fn(() => 0);
(globalThis as any).cancelAnimationFrame ??= vi.fn();

installSessionGitPaneCommonModuleMocks();
// The recycler depends on native layout; render its rows deterministically at that boundary.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ renderItems: true }).module;
});
vi.mock('@/components/workspaces/scm/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: (props: any) => React.createElement('SourceControlBranchSummary', props),
}));
vi.mock('@/components/sessions/sourceControl/commitSelection/ScmChangesSelectionHeaderRow', () => ({
    ScmChangesSelectionHeaderRow: (props: any) => React.createElement('ScmChangesSelectionHeaderRow', props),
}));
vi.mock('@/components/workspaces/scm/commitComposer/ScmCommitComposerCard', () => ({
    ScmCommitComposerCard: (props: any) => React.createElement('ScmCommitComposerCard', props),
}));
vi.mock('@/components/workspaces/scm/changes/ScmChangeRow', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/workspaces/scm/changes/ScmChangeRow')>(),
    ScmChangeRow: (props: any) => React.createElement('ScmChangeRow', props),
}));
vi.mock('@/components/ui/popover/Popover', () => ({
    Popover: () => null,
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

// Prepare the real component graph before any renderer is opened. A cold module transform is setup,
// not a row interaction, and timing out inside act leaves every following renderer unmounted.
await import('./SessionRightPanelGitCommitTab');

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
                    sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
                    sessionCheckpointOverlap="unknown"

                    allRepositoryChangedFiles={[{
                        ...groupedFile('src/file-0.ts'),
                    }] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}

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

        const flatList = screen.tree.findByType(VirtualizedList);
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
                    sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
                    sessionCheckpointOverlap="unknown"

                    allRepositoryChangedFiles={[{
                        ...groupedFile('src/file-0.ts'),
                    }] as any}
                    turnAttributedFiles={[] as any}
                    turnRepositoryOnlyFiles={[] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}

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

        const flatList = screen.tree.findByType(VirtualizedList);
        const headerScreen = await renderScreen(flatList.props.ListHeaderComponent);
        const menu = headerScreen.tree.findByType('DropdownMenu' as any);
        expect(menu.props.selectedId).toBe('repository');
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual([
            'repository',
            'turn',
            'session',
        ]);

        expect(headerScreen.findByTestId('session-rightpanel-git-view-mode-menu')).not.toBeNull();
        expect(headerScreen.findByTestId('session-rightpanel-git-open-review')).not.toBeNull();

        menu.props.onSelect('session');
        expect(onChangedFilesViewMode).toHaveBeenCalledWith('session');
    });

    it('renders repository changed files through the canonical virtualized list instead of a ScrollView', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const files = Array.from({ length: 200 }).map((_, idx) => ({
            ...groupedFile(`src/file-${idx}.ts`),
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
                    sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
                    sessionCheckpointOverlap="unknown"

                    allRepositoryChangedFiles={files as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}

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

        expect(() => tree.findByType(VirtualizedList)).not.toThrow();

        const flatList = tree.findByType(VirtualizedList);
        expect(tree.findByType(VirtualizedList).props.initialNumToRender).toBeLessThanOrEqual(12);
        expect(tree.findByType(VirtualizedList).props.maxToRenderPerBatch).toBeLessThanOrEqual(12);
    });

    it('renders session-scoped changed files through the canonical virtualized path', async () => {
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
                    sessionAttribution={{ confidence: 'session_possible', reason: 'checkpoint_overlap_observed' }}
                    sessionCheckpointOverlap="observed"

                    allRepositoryChangedFiles={files as any}
                    turnAttributedFiles={[] as any}
                    sessionAttributedFiles={files.map((file) => ({ file, content: { source: 'scm_checkpoint', confidence: 'exact' }, attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' }, checkpointOverlap: 'observed', evidence: [] })) as any}
                    repositoryOnlyFiles={[] as any}

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

        const flatList = screen.tree.findByType(VirtualizedList);
        expect(flatList.props.data[0]).toMatchObject({
            file: files[0],
            attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' },
        });
        const row = await renderScreen(flatList.props.renderItem({ item: flatList.props.data[0], index: 0 }));
        expect(row.findByTestId('changed-file-evidence-trigger')).not.toBeNull();
        expect(row.tree.findByType('ScmChangeRow' as any).props.accessibilityQualification).toContain(
            'changedFileEvidence.attribution.session_possible',
        );
        expect(flatList.props.data).toHaveLength(200);
        expect(screen.tree.findByType(VirtualizedList).props.initialNumToRender).toBeLessThanOrEqual(12);
        expect(screen.tree.findByType(VirtualizedList).props.maxToRenderPerBatch).toBeLessThanOrEqual(12);
        expect(screen.tree.findAllByType('ScrollView' as any)).toHaveLength(0);
    });

    it('keeps historical Session evidence visible without offering a commit selection action', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const historicalFile = {
            fileName: 'historical.ts', filePath: 'src', fullPath: 'src/historical.ts',
            status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 0,
        };
        const currentFile = {
            fileName: 'current.ts', filePath: 'src', fullPath: 'src/current.ts',
            status: 'modified', isIncluded: false, linesAdded: 2, linesRemoved: 0,
        };
        const renderFileActions = vi.fn(() => React.createElement('StageAction'));
        const onToggleSelectionForFile = vi.fn();

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
            sessionAttribution={{ confidence: 'session_possible', reason: 'checkpoint_overlap_observed' }}
            sessionCheckpointOverlap="observed"
            allRepositoryChangedFiles={[currentFile] as any}
            sessionAttributedFiles={[
                { file: historicalFile, turns: [], content: { source: 'scm_checkpoint', confidence: 'exact' }, attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' }, checkpointOverlap: 'observed', evidence: [] },
                { file: currentFile, turns: [], content: { source: 'scm_checkpoint', confidence: 'exact' }, attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' }, checkpointOverlap: 'observed', evidence: [] },
            ] as any}
            repositoryOnlyFiles={[]}
            repositorySelectedCount={0}
            onSelectAll={() => {}}
            onSelectNone={() => {}}
            disableSelectAll={true}
            disableSelectNone={true}
            onFilePress={() => {}}
            onFilePressPinned={() => {}}
            onToggleSelectionForFile={onToggleSelectionForFile}
            renderFileActions={renderFileActions}
            renderFileTrailingActions={() => null}
            commitDraftMessage=""
            onCommitDraftMessageChange={() => {}}
            onCommitFromMessage={() => {}}
            commitMessageGeneratorEnabled={false}
            onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
            scmStatusFiles={null}
            showCommitComposer={false}
        />);

        const list = screen.tree.findByType(VirtualizedList);
        const row = await renderScreen(list.props.renderItem({ item: list.props.data[0], index: 0 }));
        expect(row.findByTestId('changed-file-evidence-trigger')).not.toBeNull();
        expect(row.tree.findByType('ScmChangeRow' as any).props.leadingElement).toBeNull();
        expect(row.tree.findByType('ScmChangeRow' as any).props.onToggleSelection).toBeUndefined();
        expect(renderFileActions).not.toHaveBeenCalledWith(historicalFile);
        expect(onToggleSelectionForFile).not.toHaveBeenCalled();

        const currentRow = await renderScreen(list.props.renderItem({ item: list.props.data[1], index: 1 }));
        expect(currentRow.tree.findByType('ScmChangeRow' as any).props.leadingElement).not.toBeNull();
        expect(renderFileActions).toHaveBeenCalledWith(currentFile);
        currentRow.tree.findByType('ScmChangeRow' as any).props.onToggleSelection();
        expect(onToggleSelectionForFile).toHaveBeenCalledWith(currentFile);
    });

    it('explains unavailable checkpoint content without claiming there were no changes', async () => {
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
            changedFilesViewMode="turn_checkpoint"
            sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
            sessionCheckpointOverlap="unknown"
            allRepositoryChangedFiles={[]}
            turnCheckpointFiles={[]}
            turnCheckpointMetadata={{ version: 1, scopeId: 's1:/repo', baseRefSource: 'unavailable', contentConfidence: 'unavailable', attributionScope: 'unknown', receipts: [] }}
            sessionAttributedFiles={[]}
            repositoryOnlyFiles={[]}
            showTurnCheckpointViewToggle={true}
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

        expect(screen.getTextContent()).toContain('files.checkpointUnavailable');
        expect(screen.tree.findByType(VirtualizedList).props.ListEmptyComponent).toBeNull();
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
                    sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
                    sessionCheckpointOverlap="unknown"

                    allRepositoryChangedFiles={files as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}

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

        const flatList = screen.tree.findByType(VirtualizedList);
        const firstRow = (await renderScreen(flatList.props.renderItem({ item: files[0], index: 0 }))).tree.findByType('ScmChangeRow');
        const secondRow = (await renderScreen(flatList.props.renderItem({ item: files[1], index: 1 }))).tree.findByType('ScmChangeRow');

        expect(firstRow.props.statsColumnWidth).toBe(secondRow.props.statsColumnWidth);
        expect(firstRow.props.statsColumnWidth).toBeGreaterThan(38);
    });

    it('does not render selection summary above the changes list (keeps it near commit composer)', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const files = Array.from({ length: 3 }).map((_, idx) => ({
            ...groupedFile(`src/file-${idx}.ts`),
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
                    sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
                    sessionCheckpointOverlap="unknown"

                    allRepositoryChangedFiles={files as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}

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
                ...groupedFile('src/file-0.ts'),
            },
            {
                ...groupedFile('src/some-dir/'),
                status: 'added',
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
                    sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
                    sessionCheckpointOverlap="unknown"

                    allRepositoryChangedFiles={files as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}

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

        const flatList = tree.findByType(VirtualizedList);
        expect(Array.isArray(flatList.props.data)).toBe(true);
        expect(flatList.props.data).toHaveLength(1);
        expect(flatList.props.data[0].fullPath).toBe('src/file-0.ts');
    });

    it('keeps virtualized changed-file props stable when equivalent theme objects change', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const files = [
            {
                ...groupedFile('src/file-0.ts'),
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
            sessionAttribution: { confidence: 'unknown', reason: 'unavailable' },
        sessionCheckpointOverlap: 'unknown',
            allRepositoryChangedFiles: files as any,
            sessionAttributedFiles: [] as any,
            repositoryOnlyFiles: [] as any,

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
        const before = tree.root.findByType(VirtualizedList).props;

        await renderer.act(async () => {
            tree.update(<SessionRightPanelGitCommitTab {...props} theme={makeGitTheme()} />);
        });
        const after = tree.root.findByType(VirtualizedList).props;

        expect(after.keyExtractor).toBe(before.keyExtractor);
        expect(after.renderItem).toBe(before.renderItem);
        expect(after.contentContainerStyle).toBe(before.contentContainerStyle);
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
                ...groupedFile('src/file-0.ts'),
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
                        sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
                        sessionCheckpointOverlap="unknown"

                        allRepositoryChangedFiles={files as any}
                        sessionAttributedFiles={[] as any}
                        repositoryOnlyFiles={[] as any}

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
        const firstFlatListProps = screen.tree.findByType(VirtualizedList).props;
        expect(firstFlatListProps.extraData.renderFileActions).toBe(actionsA);

        await renderer.act(async () => {
            screen.pressByTestId('toggle-actions');
        });

        const nextFlatListProps = screen.tree.findByType(VirtualizedList).props;
        // `renderItem` MUST stay stable (perf), and `extraData` MUST change to a
        // new object carrying the new renderer — that is the documented FlatList
        // re-render signal that surfaces the "+" on already-rendered rows.
        expect(nextFlatListProps.renderItem).toBe(firstFlatListProps.renderItem);
        expect(nextFlatListProps.extraData).not.toBe(firstFlatListProps.extraData);
        expect(nextFlatListProps.extraData.renderFileActions).toBe(actionsB);
    });

    // Session-tabs lab G1 / GC.
    function groupedFile(fullPath: string): ScmFileStatus {
        const segments = fullPath.split('/');
        return {
            fileName: segments[segments.length - 1],
            filePath: segments.slice(0, -1).join('/'),
            fullPath,
            status: 'modified',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 0,
        };
    }

    async function renderGroupedCommitTab(extra: Record<string, unknown> = {}) {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const files = [groupedFile('AGENTS.md'), groupedFile('apps/ui/modal.tsx'), groupedFile('docs/notes.md')];
        const mine = files[1]!;
        const screen = await renderScreen(<SessionRightPanelGitCommitTab
            theme={makeGitTheme()}
            sessionId="s1"
            sessionPath="/workspace"
            backendLabel="Git"
            commitActionLabel="Commit"
            scmSnapshot={{ repo: { isRepo: true, rootPath: '/workspace/happier' } } as any}
            hasConflicts={false}
            scmOperationBusy={false}
            scmOperationStatus={null}
            hasGlobalOperationInFlight={false}
            inFlightScmOperation={null}
            commitAllowed={false}
            commitBlockedMessage={null}
            changedFilesViewMode="repository"
            sessionAttribution={{ confidence: 'unknown', reason: 'unavailable' }}
            sessionCheckpointOverlap="unknown"
            allRepositoryChangedFiles={files as any}
            sessionAttributedFiles={[{ file: mine, turns: ['t1'], content: {}, attribution: {}, checkpointOverlap: 'unknown', evidence: [] }] as any}
            repositoryOnlyFiles={[files[0], files[2]] as any}
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
            {...extra}
        />);
        const order = screen.tree.root.findAll((node: any) => (
            node.type === 'ScmChangeRow'
            || (typeof node.props?.testID === 'string' && typeof node.type === 'string'
                && node.props.testID.startsWith('scm-change-group:'))
        )).map((node: any) => (node.type === 'ScmChangeRow' ? node.props.file.fullPath : node.props.testID));
        return { screen, order };
    }

    it('groups All changes into this session first, then the rest of the repository', async () => {
        const { order } = await renderGroupedCommitTab();

        expect(order).toEqual([
            'scm-change-group:session',
            'apps/ui/modal.tsx',
            'scm-change-group:elsewhere',
            'AGENTS.md',
            'docs/notes.md',
        ]);
    });

    it('collapses a change group without changing selection or hiding the timeline', async () => {
        const toggleSelection = vi.fn();
        const { screen } = await renderGroupedCommitTab({ onToggleGroupSelection: toggleSelection, listFooter: <ViewForTest /> });
        await screen.pressByTestIdAsync('scm-change-group-collapse:elsewhere');
        const list = screen.tree.findByType(VirtualizedList);
        expect(list.props.data.filter((item: { fullPath?: string }) => item.fullPath).map((item: { fullPath: string }) => item.fullPath))
            .toEqual(['apps/ui/modal.tsx']);
        expect(toggleSelection).not.toHaveBeenCalled();
        expect(list.props.ListFooterComponent).toBeTruthy();
        await screen.pressByTestIdAsync('scm-change-group-collapse:elsewhere');
        expect(screen.tree.findByType(VirtualizedList).props.data).toHaveLength(5);
    });

    it('starts Elsewhere folded on a phone and lets the person expand it', async () => {
        const { screen } = await renderGroupedCommitTab({ phone: true });
        expect(screen.tree.findByType(VirtualizedList).props.data.filter((item: { fullPath?: string }) => item.fullPath)).toHaveLength(1);
        await screen.pressByTestIdAsync('scm-change-group-collapse:elsewhere');
        expect(screen.tree.findByType(VirtualizedList).props.data).toHaveLength(5);
    });

    it('folds both change groups for a landed operation without removing the timeline', async () => {
        const { screen } = await renderGroupedCommitTab({ completedOperationId: 'push-landed', listFooter: <ViewForTest /> });
        const list = screen.tree.findByType(VirtualizedList);
        expect(list.props.data.filter((item: { fullPath?: string }) => item.fullPath)).toHaveLength(0);
        expect(list.props.ListFooterComponent).toBeTruthy();
        await screen.pressByTestIdAsync('scm-change-group-collapse:session');
        expect(screen.tree.findByType(VirtualizedList).props.data.filter((item: { fullPath?: string }) => item.fullPath)).toHaveLength(1);
    });

    function ViewForTest() { return React.createElement('View', { testID: 'timeline-footer' }); }

    it('keeps conflicts out of commit selection and offers Open directly', async () => {
        const conflict = { ...groupedFile('src/conflict.ts'), status: 'conflicted' as const };
        const onFilePress = vi.fn();
        const renderFileActions = vi.fn(() => React.createElement('View', { testID: 'commit-select' }));
        const { screen } = await renderGroupedCommitTab({ allRepositoryChangedFiles: [conflict], sessionAttributedFiles: [], hasConflicts: true, renderFileActions, onFilePress });
        const row = screen.tree.findByType('ScmChangeRow');
        expect(row.props.leadingElement).toBeNull();
        expect(row.props.onToggleSelection).toBeUndefined();
        const action = await renderScreen(row.props.trailingElement);
        await action.pressByTestIdAsync('scm-conflict-open:src/conflict.ts');
        expect(onFilePress).toHaveBeenCalledWith(conflict);
        expect(renderFileActions).not.toHaveBeenCalled();
        expect(screen.findAllHostsByTestId('scm-change-group-select:conflicts')).toHaveLength(0);
    });

});
