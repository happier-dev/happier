import * as React from 'react';
import renderer, { type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionGitPaneCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'files.toolbar.changedFiles') return 'Changed files';
                if (key === 'files.toolbar.review') return 'Review';
                if (key === 'files.latestTurnChanges') return `Latest turn changes (${String(params?.count ?? '')})`;
                if (key === 'files.latestTurnDescription') return 'Provider-backed changes from the most recent completed turn.';
                if (key === 'files.sessionAttributedChanges') return `Session-attributed changes (${String(params?.count ?? '')})`;
                if (key === 'files.selectedForCommitChanges') return `Selected for commit (${String(params?.count ?? '')})`;
                if (key === 'files.attributionReliabilityHigh') return 'Best effort attribution. Repository view remains the source of truth.';
                return key;
            },
        });
    },
});
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

function makeScmFile(path: string, isIncluded = false) {
    const segments = path.split('/');
    return {
        fileName: segments.at(-1) ?? path,
        filePath: segments.slice(0, -1).join('/'),
        fullPath: path,
        status: 'modified',
        isIncluded,
        linesAdded: 1,
        linesRemoved: 0,
    };
}

function textFromInstance(instance: ReactTestInstance): string {
    const chunks: string[] = [];
    const visit = (node: ReactTestInstance | string | number) => {
        if (typeof node === 'string' || typeof node === 'number') {
            chunks.push(String(node));
            return;
        }
        for (const child of node.children) {
            visit(child as ReactTestInstance | string | number);
        }
    };
    visit(instance);
    return chunks.join('');
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('SessionRightPanelGitCommitTab (virtualization)', () => {
    it('hides changed-file view mode chips when only repository view is available', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');

        const screen = await renderScreen(<SessionRightPanelGitCommitTab
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f' } }}
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
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f' } }}
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
        expect(textContent).toContain('Changed files');
        expect(textContent).toContain('1');
        expect(textContent).not.toContain('files.toolbar.view');
        expect(textContent).toContain('Review');
        expect(textContent).not.toContain('files.toolbar.repositoryView');
        expect(textContent).not.toContain('files.toolbar.turnView');
        expect(textContent).not.toContain('files.toolbar.sessionView');

        menu.props.onSelect('session');
        expect(onChangedFilesViewMode).toHaveBeenCalledWith('session');
    });

    it('uses the active scoped change title as the selector label without duplicating the list heading', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const files = [
            {
                fullPath: 'src/file-0.ts',
                path: 'src/file-0.ts',
                kind: 'modified',
                stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
            },
            {
                fullPath: 'src/file-1.ts',
                path: 'src/file-1.ts',
                kind: 'modified',
                stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
            },
        ];

        const screen = await renderScreen(<SessionRightPanelGitCommitTab
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f' } }}
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
                    changedFilesViewMode="turn"
                    attributionReliability="high"
                    allRepositoryChangedFiles={files as any}
                    turnAttributedFiles={files.map((file) => ({ file, confidence: 'high' })) as any}
                    turnRepositoryOnlyFiles={[] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    showTurnViewToggle={true}
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
                    onOpenReviewAllChanges={() => {}}
                />);

        const textContent = screen.getTextContent();
        const titleMatches = textContent.match(/Latest turn changes \(2\)/g) ?? [];

        expect(titleMatches).toHaveLength(1);
        expect(textContent).toContain('Provider-backed changes from the most recent completed turn.');
        expect(textContent).not.toContain('Changed files');
        expect(textContent).not.toContain('files.toolbar.view');
        expect(textContent).toContain('Review');

        const actionsRow = screen.tree.findByProps({ testID: 'session-rightpanel-git-scope-actions-row' });
        expect(textFromInstance(actionsRow)).toContain('Latest turn changes (2)');
        expect(textFromInstance(actionsRow)).toContain('Review');
        expect(textFromInstance(actionsRow)).not.toContain('Provider-backed changes from the most recent completed turn.');

        const description = screen.tree.findByProps({ testID: 'session-rightpanel-git-scope-description' });
        expect(textFromInstance(description)).toContain('Provider-backed changes from the most recent completed turn.');
    });

    it('offers a selected-for-commit scope and renders only selected changed files', async () => {
        const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
        const onChangedFilesViewMode = vi.fn();
        const files = [
            makeScmFile('src/selected-a.ts'),
            makeScmFile('src/unselected.ts'),
            makeScmFile('src/selected-b.ts'),
        ];

        const screen = await renderScreen(<SessionRightPanelGitCommitTab
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f' } }}
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
                    changedFilesViewMode="selected"
                    attributionReliability="high"
                    allRepositoryChangedFiles={files as any}
                    selectedRepositoryChangedFiles={[files[0], files[2]] as any}
                    sessionAttributedFiles={[] as any}
                    repositoryOnlyFiles={[] as any}
                    suppressedInferredCount={0}
                    showTurnViewToggle={false}
                    showSessionViewToggle={false}
                    onChangedFilesViewMode={onChangedFilesViewMode}
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
                    onOpenReviewAllChanges={() => {}}
                />);

        const flatList = screen.tree.findByType('FlatList' as any);
        expect(flatList.props.data.map((file: { fullPath: string }) => file.fullPath)).toEqual([
            'src/selected-a.ts',
            'src/selected-b.ts',
        ]);

        const headerScreen = await renderScreen(flatList.props.ListHeaderComponent);
        const menu = headerScreen.tree.findByType('DropdownMenu' as any);
        expect(menu.props.selectedId).toBe('selected');
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual([
            'repository',
            'selected',
        ]);
        expect(headerScreen.getTextContent()).toContain('Selected for commit (2)');

        menu.props.onSelect('repository');
        expect(onChangedFilesViewMode).toHaveBeenCalledWith('repository');
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
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f' } }}
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
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f' } }}
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
                    theme={{ colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f6f6f6', text: '#000', textSecondary: '#666', success: '#0a0', warning: '#f90', textLink: '#09f' } }}
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
});
