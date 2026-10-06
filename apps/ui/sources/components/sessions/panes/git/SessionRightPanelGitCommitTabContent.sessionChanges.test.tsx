import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionMessagesFixture, createThemeFixture, createToolCallMessageFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { projectChangedFilesAsScmSnapshot, type ScmFileStatus } from '@/scm/scmStatusFiles';
import { installSessionPaneRuntimeTestHarness } from '../sessionPaneRuntimeTestHarness';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';
import type { SessionRightPanelGitCommitTabContentProps } from './SessionRightPanelGitCommitTabContent';
import type { SessionRightPanelGitCommitTabProps } from './SessionRightPanelGitCommitTab';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installSessionGitPaneCommonModuleMocks({ storage: async (original) => original() });
const runtime = installSessionPaneRuntimeTestHarness();

function file(fullPath: string): ScmFileStatus {
    const segments = fullPath.split('/');
    return { fullPath, fileName: segments.at(-1) ?? fullPath, filePath: segments.slice(0, -1).join('/'),
        status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 };
}

function snapshot(paths: readonly string[]) {
    return projectChangedFilesAsScmSnapshot(paths.map(file), { projectKey: 'test-project', rootPath: '/tmp/repo' });
}

function seedTurn(paths: readonly string[]) {
    const message = createToolCallMessageFixture({
        id: 'diff-turn-1', createdAt: 10,
        tool: {
            name: 'Diff', state: 'completed', createdAt: 10, startedAt: 10, completedAt: 11,
            description: null, result: { status: 'completed' },
            input: {
                files: paths.map((path) => ({ file_path: path, change_kind: 'modified',
                    oldText: 'before\n', newText: 'after\n',
                    unified_diff: 'diff --git a/' + path + ' b/' + path + '\n@@ -1 +1 @@\n-before\n+after\n' })),
                _happier: { v: 2, protocol: 'codex', provider: 'codex', rawToolName: 'CodexDiff',
                    canonicalToolName: 'Diff', sessionChangeScope: 'turn', turnId: 'turn_1', sessionId: 's1',
                    source: 'provider_native', confidence: 'exact', turnStatus: 'completed',
                    seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 } },
            },
        },
    });
    storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message }, isLoaded: true,
    }) } });
}

function props(overrides: Partial<SessionRightPanelGitCommitTabContentProps> = {}): SessionRightPanelGitCommitTabContentProps {
    return {
        theme: createThemeFixture(), sessionId: 's1', serverId: runtime.serverId, sessionPath: '/tmp/repo',
        scmSnapshot: snapshot(['src/a.ts']), workspaceTouchedPaths: [],
        commitSelectionPaths: [], commitSelectionPatches: [], scmCommitStrategy: 'atomic', scmWriteEnabled: true,
        inFlightScmOperation: null, hasGlobalOperationInFlight: false, scmOperationBusy: false,
        scmOperationStatus: null, backendLabel: 'Git', commitActionLabel: 'Commit', hasConflicts: false,
        commitAllowedForComposer: true, commitBlockedMessageForComposer: null, commitWriteEnabled: true,
        commitSelectionUiEnabled: false, commitDraftMessage: '', onCommitDraftMessageChange: vi.fn(),
        onCommitFromMessage: vi.fn(), commitMessageGeneratorEnabled: false,
        onGenerateCommitMessageSuggestion: async () => ({ ok: true, message: '' }),
        onOpenFilesSidebar: vi.fn(), onOpenReviewAllChanges: vi.fn(), onOpenStashDetails: vi.fn(),
        openFileInDetails: vi.fn(), openFileInDetailsPinned: vi.fn(), ...overrides,
    };
}

async function mount(overrides: Partial<SessionRightPanelGitCommitTabContentProps> = {}) {
    const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');
    const { SessionRightPanelGitCommitTab } = await import('./SessionRightPanelGitCommitTab');
    const input = props(overrides);
    const screen = await renderScreen(<SessionRightPanelGitCommitTabContent {...input} />, { wrapper: runtime.Wrapper });
    const tab = () => screen.findByType(SessionRightPanelGitCommitTab).props as SessionRightPanelGitCommitTabProps;
    const scope = async (mode: 'repository' | 'turn' | 'selected') => {
        await act(async () => { tab().onChangedFilesViewMode?.(mode); });
    };
    return { screen, tab, scope, input, SessionRightPanelGitCommitTabContent };
}

describe('SessionRightPanelGitCommitTabContent', () => {
    it('opens on All changes with this Home’s canonical latest-turn evidence', async () => {
        seedTurn(['src/a.ts']);
        const { screen, tab } = await mount();
        expect(tab().changedFilesViewMode).toBe('repository');
        expect(tab().showTurnViewToggle).toBe(true);
        expect(tab().turnAttributedFiles?.map((entry) => entry.file.fullPath)).toEqual(['src/a.ts']);
        expect(screen.getTextContent()).toContain('a.ts');
    });

    it('falls back to repository view when no provider changes can be displayed in a scoped view', async () => {
        seedTurn([]);
        const { tab, scope } = await mount();
        await scope('turn');
        expect(tab().showTurnViewToggle).toBe(false);
        expect(tab().changedFilesViewMode).toBe('repository');
    });

    it('does not attribute another Home’s retained transcript to this pane', async () => {
        seedTurn(['src/a.ts']);
        storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: 'another-home' }) } });
        const { tab } = await mount();
        expect(tab().showTurnViewToggle).toBe(false);
        expect(tab().turnAttributedFiles).toEqual([]);
        expect(tab().changedFilesViewMode).toBe('repository');
    });

    it('stays on All changes when turn evidence arrives after the first render, and honours a chosen scope', async () => {
        const { tab, scope } = await mount({ scmSnapshot: snapshot(['src/late.ts']) });
        expect(tab().changedFilesViewMode).toBe('repository');
        await act(async () => { seedTurn(['src/late.ts']); });
        expect(tab().changedFilesViewMode).toBe('repository');
        expect(tab().showTurnViewToggle).toBe(true);
        await scope('turn');
        expect(tab().changedFilesViewMode).toBe('turn');
    });

    it('keeps repository view selected after the user explicitly switches away from a scoped view', async () => {
        seedTurn(['src/a.ts']);
        const { tab, scope } = await mount();
        await scope('turn');
        expect(tab().changedFilesViewMode).toBe('turn');
        await scope('repository');
        expect(tab().changedFilesViewMode).toBe('repository');
    });

    it('shows every row its commit checkbox as soon as commit selection is available', async () => {
        const { screen, tab } = await mount({ commitSelectionUiEnabled: true });
        expect(tab().selectionModeActive).toBe(true);
        expect(screen.findHostByTestId('scm-commit-selection-toggle-src_a.ts')).toBeTruthy();
    });

    it('exposes selected commit files as a selectable changed-files scope', async () => {
        const { tab, scope } = await mount({ scmSnapshot: snapshot(['src/selected.ts', 'src/unselected.ts']),
            commitSelectionPaths: ['src/selected.ts'], commitSelectionUiEnabled: true });
        expect(tab().showSelectedViewToggle).toBe(true);
        expect(tab().selectedRepositoryChangedFiles?.map((entry) => entry.fullPath)).toEqual(['src/selected.ts']);
        await scope('selected');
        expect(tab().changedFilesViewMode).toBe('selected');
    });

    it('counts and selects only visible repository files, excluding collapsed directory entries', async () => {
        const { tab } = await mount({ scmSnapshot: snapshot(['src/visible.ts', 'src/generated/']),
            commitSelectionPaths: ['src/visible.ts', 'src/generated/'], commitSelectionUiEnabled: true });
        expect(tab().allRepositoryChangedFiles.map((entry) => entry.fullPath)).toEqual(['src/visible.ts']);
        expect(tab().repositorySelectedCount).toBe(1);
        expect(tab().selectedRepositoryChangedFiles?.map((entry) => entry.fullPath)).toEqual(['src/visible.ts']);
    });

    it('selects all files from the current scoped view, excluding historical evidence and directories', async () => {
        seedTurn(['src/turn.ts', 'src/historical.ts', 'src/generated/']);
        const { tab, scope } = await mount({ scmSnapshot: snapshot(['src/turn.ts', 'src/repository.ts', 'src/generated/']),
            commitSelectionUiEnabled: true });
        await scope('turn');
        expect(tab().changedFilesViewMode).toBe('turn');
        await act(async () => { tab().onSelectAll?.(); });
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1', runtime.serverId)).toEqual(['src/turn.ts']);
    });

    it('hides leading changed-file action buttons when write operations are disabled', async () => {
        const { screen, tab } = await mount({ scmWriteEnabled: false, commitSelectionUiEnabled: true });
        expect(tab().renderFileActions?.(file('src/a.ts'))).toBeNull();
        expect(screen.findHostByTestId('scm-commit-selection-toggle-src_a.ts')).toBeNull();
    });

    it('keeps file-open callbacks stable and usable when the mounted commit tab becomes inactive', async () => {
        const openFileInDetails = vi.fn();
        const openFileInDetailsPinned = vi.fn();
        const { screen, tab, input, SessionRightPanelGitCommitTabContent } = await mount({ active: true, openFileInDetails, openFileInDetailsPinned });
        const first = tab();
        await screen.update(<SessionRightPanelGitCommitTabContent {...input} active={false} />);
        const next = tab();
        expect(next.onFilePress).toBe(first.onFilePress);
        expect(next.onFilePressPinned).toBe(first.onFilePressPinned);
        next.onFilePress(file('src/a.ts'));
        next.onFilePressPinned?.(file('src/a.ts'));
        expect(openFileInDetails).toHaveBeenCalledWith('src/a.ts');
        expect(openFileInDetailsPinned).toHaveBeenCalledWith('src/a.ts');
    });
});
