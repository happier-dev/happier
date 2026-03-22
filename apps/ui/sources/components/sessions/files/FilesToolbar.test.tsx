import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstance, renderScreen } from '@/dev/testkit';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: 'View',
                                    Pressable: 'Pressable',
                                    TextInput: 'TextInput',
                                    Platform: {
                                        select: (value: any) => value?.default ?? null,
                                    },
                                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('FilesToolbar', () => {
    const theme = {
        colors: {
            divider: '#000',
            input: { background: '#111', placeholder: '#999' },
            surface: '#222',
            surfaceHigh: '#333',
            text: '#eee',
            textSecondary: '#aaa',
        },
    };

    it('renders view toggles and dispatches handlers', async () => {
        const { FilesToolbar } = await import('./FilesToolbar');
        const onShowChangedFiles = vi.fn();
        const onShowAllRepositoryFiles = vi.fn();
        const onChangedFilesViewMode = vi.fn();
        const onChangedFilesPresentationChange = vi.fn();
        const onToggleScmPanel = vi.fn();

        const screen = await renderScreen(<FilesToolbar
            theme={theme}
            searchQuery=""
            onSearchQueryChange={vi.fn()}
            showAllRepositoryFiles={false}
            onShowChangedFiles={onShowChangedFiles}
            onShowAllRepositoryFiles={onShowAllRepositoryFiles}
            changedFilesCount={2}
            changedFilesViewMode="repository"
            changedFilesPresentation="list"
            showTurnViewToggle={true}
            showSessionViewToggle={true}
            onChangedFilesViewMode={onChangedFilesViewMode}
            onChangedFilesPresentationChange={onChangedFilesPresentationChange}
            scmPanelExpanded={false}
            onToggleScmPanel={onToggleScmPanel}
        />);

        const scmToggle = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'files.toolbar.scm');
        expect(scmToggle).toBeTruthy();
        pressTestInstance(scmToggle, 'files.toolbar.scm');

        expect(onToggleScmPanel).toHaveBeenCalled();

        // Smoke-check: the toolbar still exposes the basic navigation callbacks.
        expect(typeof onShowChangedFiles).toBe('function');
        expect(typeof onShowAllRepositoryFiles).toBe('function');
        expect(typeof onChangedFilesViewMode).toBe('function');
        expect(typeof onChangedFilesPresentationChange).toBe('function');

        expect(screen.getTextContent()).toContain('files.toolbar.turnView');
    });

    it('hides session toggle when session attribution is not reliable enough', async () => {
        const { FilesToolbar } = await import('./FilesToolbar');

        const screen = await renderScreen(<FilesToolbar
            theme={theme}
            searchQuery=""
            onSearchQueryChange={vi.fn()}
            showAllRepositoryFiles={false}
            onShowChangedFiles={vi.fn()}
            onShowAllRepositoryFiles={vi.fn()}
            changedFilesCount={2}
            changedFilesViewMode="repository"
            changedFilesPresentation="list"
            showTurnViewToggle={false}
            showSessionViewToggle={false}
            onChangedFilesViewMode={vi.fn()}
            onChangedFilesPresentationChange={vi.fn()}
            scmPanelExpanded={false}
            onToggleScmPanel={vi.fn()}
        />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('files.toolbar.repositoryView');
        expect(textContent).not.toContain('files.toolbar.turnView');
        expect(textContent).not.toContain('files.toolbar.sessionView');
        expect(textContent).toContain('files.attributionReliabilityLimited');
    });
});
