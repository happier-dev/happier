import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeRow', () => ({
    ScmChangeRow: (props: any) => React.createElement('ScmChangeRow', props),
}));

describe('ChangedFilesList', () => {
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
        const { ChangedFilesList } = await import('./ChangedFilesList');
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ChangedFilesList
                    theme={{ colors: { surfaceHigh: '#111', divider: '#222', textLink: '#09f', textSecondary: '#999', text: '#fff', dark: false } } as any}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[file as any, directoryLike as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    onFilePress={vi.fn()}
                    rowDensity="compact"
                />
            );
        });

        const textContent = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });
        // Directory-like SCM entries should be ignored (they cannot be opened / diffed).
        expect(textContent).toContain('Repository changed files (1)');
        const rows = tree!.root.findAllByType('ScmChangeRow' as any);
        expect(rows).toHaveLength(1);
        expect(rows[0].props.density).toBe('compact');
    });

    it('supports injecting per-file actions for commit/stage flows', async () => {
        const { ChangedFilesList } = await import('./ChangedFilesList');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ChangedFilesList
                    theme={{ colors: { surfaceHigh: '#111', divider: '#222', textLink: '#09f', textSecondary: '#999', text: '#fff', dark: false } } as any}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[file as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    onFilePress={vi.fn()}
                    renderFileActions={(f) => React.createElement('Action', { path: f.fullPath })}
                />
            );
        });

        const rows = tree!.root.findAllByType('ScmChangeRow' as any);
        expect(rows).toHaveLength(1);

        const right = rows[0]!.props.leadingElement;
        let rightTree: renderer.ReactTestRenderer | null = null;
        act(() => {
            rightTree = renderer.create(right);
        });
        expect(rightTree!.root.findAllByType('Action' as any)).toHaveLength(1);
    });

    it('supports opening a pinned details tab via onFilePressPinned', async () => {
        const { ChangedFilesList } = await import('./ChangedFilesList');
        const onFilePressPinned = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ChangedFilesList
                    theme={{ colors: { surfaceHigh: '#111', divider: '#222', textLink: '#09f', textSecondary: '#999', text: '#fff', dark: false } } as any}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[file as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    onFilePress={vi.fn()}
                    onFilePressPinned={onFilePressPinned}
                />
            );
        });

        const row = tree!.root.findByType('ScmChangeRow' as any);
        expect(typeof row.props.onPressPinned).toBe('function');

        act(() => {
            row.props.onPressPinned();
        });

        expect(onFilePressPinned).toHaveBeenCalledTimes(1);
        expect(onFilePressPinned).toHaveBeenCalledWith(file);
    });

    it('renders session reliability warning when attribution is limited', async () => {
        const { ChangedFilesList } = await import('./ChangedFilesList');
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ChangedFilesList
                    theme={{ colors: { surfaceHigh: '#111', divider: '#222', textLink: '#09f', textSecondary: '#999', text: '#fff', dark: false } } as any}
                    changedFilesViewMode="session"
                    attributionReliability="limited"
                    allRepositoryChangedFiles={[file as any]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[file as any]}
                    suppressedInferredCount={1}
                    onFilePress={vi.fn()}
                />
            );
        });

        const textNodes = tree!.root.findAllByType('Text' as any);
        const messageExists = textNodes.some((node) =>
            String(node.props.children).includes('Reliability limited: multiple sessions are active for this repository')
        );
        expect(messageExists).toBe(true);
    });
});
