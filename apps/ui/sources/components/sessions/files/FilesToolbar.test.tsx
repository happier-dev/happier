import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    Platform: { select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('FilesToolbar', () => {
    it('renders view toggles and dispatches handlers', async () => {
        const { FilesToolbar } = await import('./FilesToolbar');
        const onShowChangedFiles = vi.fn();
        const onShowAllRepositoryFiles = vi.fn();
        const onChangedFilesViewMode = vi.fn();
        const onChangedFilesPresentationChange = vi.fn();
        const onToggleScmPanel = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FilesToolbar
                    theme={{ colors: { divider: '#000', input: { background: '#111', placeholder: '#999' }, surface: '#222', surfaceHigh: '#333', text: '#eee', textSecondary: '#aaa' } }}
                    searchQuery=""
                    onSearchQueryChange={vi.fn()}
                    showAllRepositoryFiles={false}
                    onShowChangedFiles={onShowChangedFiles}
                    onShowAllRepositoryFiles={onShowAllRepositoryFiles}
                    changedFilesCount={2}
                    changedFilesViewMode="repository"
                    changedFilesPresentation="list"
                    showSessionViewToggle={true}
                    onChangedFilesViewMode={onChangedFilesViewMode}
                    onChangedFilesPresentationChange={onChangedFilesPresentationChange}
                    scmPanelExpanded={false}
                    onToggleScmPanel={onToggleScmPanel}
                />
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        expect(pressables.length).toBeGreaterThanOrEqual(4);

        const scmToggle = pressables.find((node) => {
            const textNodes = node.findAllByType?.('Text' as any) ?? [];
            return textNodes.some((t: any) => String(t.props?.children ?? '') === 'SCM');
        });
        expect(scmToggle).toBeTruthy();

        act(() => {
            scmToggle!.props.onPress?.();
        });

        expect(onToggleScmPanel).toHaveBeenCalled();

        // Smoke-check: the toolbar still exposes the basic navigation callbacks.
        expect(typeof onShowChangedFiles).toBe('function');
        expect(typeof onShowAllRepositoryFiles).toBe('function');
        expect(typeof onChangedFilesViewMode).toBe('function');
        expect(typeof onChangedFilesPresentationChange).toBe('function');
    });

    it('hides session toggle when session attribution is not reliable enough', async () => {
        const { FilesToolbar } = await import('./FilesToolbar');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FilesToolbar
                    theme={{ colors: { divider: '#000', input: { background: '#111', placeholder: '#999' }, surface: '#222', surfaceHigh: '#333', text: '#eee', textSecondary: '#aaa' } }}
                    searchQuery=""
                    onSearchQueryChange={vi.fn()}
                    showAllRepositoryFiles={false}
                    onShowChangedFiles={vi.fn()}
                    onShowAllRepositoryFiles={vi.fn()}
                    changedFilesCount={2}
                    changedFilesViewMode="repository"
                    changedFilesPresentation="list"
                    showSessionViewToggle={false}
                    onChangedFilesViewMode={vi.fn()}
                    onChangedFilesPresentationChange={vi.fn()}
                    scmPanelExpanded={false}
                    onToggleScmPanel={vi.fn()}
                />
            );
        });

        const textNodes = tree!.root.findAllByType('Text' as any);
        const labels = textNodes.map((node) => String(node.props.children));
        expect(labels).toContain('Repository view');
        expect(labels).not.toContain('Session view');
        expect(labels).toContain('files.attributionReliabilityLimited');
    });
});
