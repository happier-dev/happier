import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { mergeTurnChangeSets } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import { createThemeFixture, renderScreen } from '@/dev/testkit';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import { ChangedFilesList } from './ChangedFilesList';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                select: (value: any) => value?.default ?? null,
            },
        });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'files.repositoryChangedFiles') return `Repository changed files (${String(params?.count ?? '')})`;
                if (key === 'files.latestTurnChanges') return `Latest turn changes (${String(params?.count ?? '')})`;
                if (key === 'files.latestTurnDescription') return 'Provider-backed changes from the most recent completed turn.';
                if (key === 'files.sessionAttributedChanges') return `Session-attributed changes (${String(params?.count ?? '')})`;
                if (key === 'files.otherRepositoryChanges') return `Other repository changes (${String(params?.count ?? '')})`;
                if (key === 'files.noLatestTurnChanges') return 'No latest-turn changes currently detected.';
                if (key === 'files.checkpointTurnChanges') return `Checkpoint changes (${String(params?.count ?? '')})`;
                if (key === 'files.checkpointUnavailable') return 'Checkpoint evidence is unavailable.';
                if (key === 'files.noCheckpointTurnChanges') return 'No checkpoint changes currently detected.';
                if (key === 'files.noSessionAttributedChanges') return 'No session-attributed changes currently detected.';
                return key;
            },
        });
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

async function changeRows(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAllByType(Reflect.get(ScmChangeRow, 'type') ?? ScmChangeRow);
}

describe('ChangedFilesList', () => {
    const testTheme = createThemeFixture();

    const file = {
        fileName: 'a.ts',
        filePath: 'src',
        fullPath: 'src/a.ts',
        status: 'modified',
        isIncluded: false,
        linesAdded: 1,
        linesRemoved: 1,
    } as const;
    const directoryLike = {
        fileName: 'src/some-dir/',
        filePath: 'src/some-dir/',
        fullPath: 'src/some-dir/',
        status: 'added',
        isIncluded: false,
        linesAdded: 0,
        linesRemoved: 0,
    } as const;

    it('renders repository view heading and rows', async () => {
        const screen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="repository"

                    allRepositoryChangedFiles={[file as any, directoryLike as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}

                    onFilePress={vi.fn()}
                    rowDensity="compact"
                />);

        // Directory-like SCM entries should be ignored (they cannot be opened / diffed).
        expect(screen.getTextContent()).toContain('Repository changed files (1)');
        const rows = await changeRows(screen);
        expect(rows).toHaveLength(1);
        expect(rows[0].props.density).toBe('compact');
    });

    it('uses the largest visible change stats as a shared stats column width', async () => {
        const largeStatsFile = {
            ...file,
            fileName: 'requestId.test.ts',
            fullPath: 'src/middleware/requestId.test.ts',
            linesAdded: 146,
            linesRemoved: 10,
        } as const;

        const smallScreen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="repository"

                    allRepositoryChangedFiles={[file as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}

                    onFilePress={vi.fn()}
                />);
        const mixedScreen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="repository"

                    allRepositoryChangedFiles={[file as any, largeStatsFile as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}

                    onFilePress={vi.fn()}
                />);

        const smallWidth = (await changeRows(smallScreen))[0]!.props.statsColumnWidth;
        const mixedWidths = (await changeRows(mixedScreen)).map((row) => row.props.statsColumnWidth);

        expect(new Set(mixedWidths).size).toBe(1);
        expect(mixedWidths[0]).toBeGreaterThan(smallWidth);
    });

    it('supports injecting per-file actions for commit/stage flows', async () => {

        const screen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="repository"

                    allRepositoryChangedFiles={[file as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}

                    onFilePress={vi.fn()}
                    renderFileActions={(f) => React.createElement('Action', { path: f.fullPath })}
                />);

        const rows = await changeRows(screen);
        expect(rows).toHaveLength(1);

        expect(screen.findAllByType('Action')).toHaveLength(1);
    });

    it('supports opening a pinned details tab via onFilePressPinned', async () => {
        const onFilePressPinned = vi.fn();

        const screen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="repository"

                    allRepositoryChangedFiles={[file as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}

                    onFilePress={vi.fn()}
                    onFilePressPinned={onFilePressPinned}
                />);

        const row = (await changeRows(screen))[0]!;
        expect(typeof row.props.onPressPinned).toBe('function');

        act(() => {
            row.props.onPressPinned();
        });

        expect(onFilePressPinned).toHaveBeenCalledTimes(1);
        expect(onFilePressPinned).toHaveBeenCalledWith(file);
    });

    it('keeps uncertain Session attribution visible without inferring active peers', async () => {
        const screen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="session"

                    allRepositoryChangedFiles={[file as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[file as any]}

                    onFilePress={vi.fn()}
                />);

        expect(screen.getTextContent()).not.toContain('Reliability limited: multiple sessions are active for this repository');
        expect(screen.getTextContent()).toContain('No session-attributed changes currently detected.');
    });

    it('renders latest-turn copy and rows when turn view is selected', async () => {
        const repositoryOnlyFile = {
            ...file,
            fileName: 'b.ts',
            fullPath: 'src/b.ts',
        } as const;
        const screen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="turn"

                    allRepositoryChangedFiles={[file as any, repositoryOnlyFile as any]}
                    turnAttributedFiles={[{ file: file as any, turns: ['turn-1'], content: { source: 'provider_native', confidence: 'exact' }, attribution: { confidence: 'session_exact', reason: 'provider_correlated' }, checkpointOverlap: 'unknown', evidence: [] }]}
                    turnRepositoryOnlyFiles={[repositoryOnlyFile as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}

                    onFilePress={vi.fn()}
                />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('Latest turn changes (1)');
        expect(textContent).toContain('Provider-backed changes from the most recent completed turn.');
        expect(textContent).not.toContain('Other repository changes (1)');
        expect(textContent).not.toContain('Reliability limited: multiple sessions are active for this repository');

        const rows = await changeRows(screen);
        expect(rows).toHaveLength(1);
    });

    it('does not render checkpoint empty copy when checkpoint evidence is unavailable', async () => {
        const screen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="turn_checkpoint"

                    allRepositoryChangedFiles={[]}
                    turnCheckpointFiles={[]}
                    turnCheckpointMetadata={{
                        version: 1,
                        scopeId: 's1:/repo',
                        baseRefSource: 'unavailable',
                        contentConfidence: 'unavailable',
                        attributionScope: 'unknown',
                        receipts: [],
                    }}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}

                    onFilePress={vi.fn()}
                />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('Checkpoint evidence is unavailable.');
        expect(textContent).not.toContain('No checkpoint changes currently detected.');
    });

    it('keeps session view scoped to session-attributed files', async () => {
        const sessionFile = {
            ...file,
            fullPath: 'src/session.ts',
            fileName: 'session.ts',
        } as const;
        const repositoryOnlyFile = {
            ...file,
            fullPath: 'src/repo-only.ts',
            fileName: 'repo-only.ts',
        } as const;
        const screen = await renderScreen(<ChangedFilesList
                    theme={testTheme as any}
                    changedFilesViewMode="session"

                    allRepositoryChangedFiles={[sessionFile as any, repositoryOnlyFile as any]}
                    sessionAttributedFiles={[{ file: sessionFile as any, turns: ['turn-1'], content: { source: 'provider_native', confidence: 'exact' }, attribution: { confidence: 'session_exact', reason: 'provider_correlated' }, checkpointOverlap: 'unknown', evidence: [] }]}
                    repositoryOnlyFiles={[repositoryOnlyFile as any]}

                    onFilePress={vi.fn()}
                />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('Session-attributed changes (1)');
        expect(textContent).not.toContain('Other repository changes (1)');

        const rows = await changeRows(screen);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.file?.fullPath).toBe('src/session.ts');
        expect(rows[0]?.props.accessibilityQualification).toContain('changedFileEvidence.content.exact');
        expect(rows[0]?.props.accessibilityQualification).toContain('changedFileEvidence.attribution.session_exact');
        expect(screen.findByTestId('changed-file-evidence-trigger')).not.toBeNull();
    });

    it('retains edit-to-rename turn lineage through the hook into a mounted evidence disclosure without exposing ids', async () => {
        const { ChangedFileEvidenceDisclosure } = await import('@/components/workspaces/scm/changes/ChangedFileEvidenceDisclosure');
        const sessionChangeSet = mergeTurnChangeSets({
            sessionId: 's1',
            turns: [
                {
                    sessionId: 's1',
                    turnId: 'private-turn-edit',
                    seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
                    status: 'completed',
                    provider: 'codex',
                    derivedAt: 1,
                    files: [{
                        filePath: 'src/old.ts',
                        changeKind: 'modified',
                        source: 'provider_native',
                        confidence: 'exact',
                        provider: 'codex',
                    }],
                },
                {
                    sessionId: 's1',
                    turnId: 'private-turn-rename',
                    seqRange: { startSeqInclusive: 3, endSeqInclusive: 4 },
                    status: 'completed',
                    provider: 'codex',
                    derivedAt: 2,
                    files: [{
                        filePath: 'src/new.ts',
                        previousFilePath: 'src/old.ts',
                        changeKind: 'renamed',
                        source: 'provider_native',
                        confidence: 'exact',
                        provider: 'codex',
                    }],
                },
            ],
        });

        function MountedChangedFiles() {
            const changed = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: {
                    projectKey: 'm:/repo',
                    fetchedAt: 1,
                    repo: { isRepo: true, rootPath: '/repo' },
                    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                    stashCount: 0,
                    hasConflicts: false,
                    entries: [{
                        path: 'src/new.ts',
                        previousPath: 'src/old.ts',
                        kind: 'renamed',
                        includeStatus: '.',
                        pendingStatus: 'R',
                        hasIncludedDelta: false,
                        hasPendingDelta: true,
                        stats: {
                            includedAdded: 0,
                            includedRemoved: 0,
                            pendingAdded: 1,
                            pendingRemoved: 1,
                            isBinary: false,
                        },
                    }],
                    totals: {
                        includedFiles: 0,
                        pendingFiles: 1,
                        untrackedFiles: 0,
                        includedAdded: 0,
                        includedRemoved: 0,
                        pendingAdded: 1,
                        pendingRemoved: 1,
                    },
                },
                searchQuery: '',
                showAllRepositoryFiles: false,
                sessionChangeSet,
            });
            return <ChangedFilesList
                theme={testTheme as any}
                changedFilesViewMode="session"
                allRepositoryChangedFiles={changed.allRepositoryChangedFiles}
                sessionAttributedFiles={changed.sessionAttributedFiles}
                repositoryOnlyFiles={changed.repositoryOnlyFiles}
                onFilePress={vi.fn()}
            />;
        }

        const screen = await renderScreen(<MountedChangedFiles />);
        const disclosure = screen.tree.findByType(ChangedFileEvidenceDisclosure);
        expect(disclosure.props.entry.turns).toEqual(['private-turn-edit', 'private-turn-rename']);
        expect(screen.getTextContent()).not.toContain('private-turn-edit');
        expect(screen.getTextContent()).not.toContain('private-turn-rename');
    });
});
