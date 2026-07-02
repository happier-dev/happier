import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstance, renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { installSessionFilesCommonModuleMocks } from './sessionFilesTestHelpers';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionFilesCommonModuleMocks();

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

describe('FilesToolbar', () => {
    const theme = createThemeFixture();

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

        const viewModeMenu = screen.tree.findByType('DropdownMenu' as any);
        expect(viewModeMenu.props.selectedId).toBe('repository');
        expect(viewModeMenu.props.items.map((item: { id: string }) => item.id)).toEqual([
            'repository',
            'turn',
            'session',
        ]);
        viewModeMenu.props.onSelect('turn');
        expect(onChangedFilesViewMode).toHaveBeenCalledWith('turn');

        // Smoke-check: the toolbar still exposes the basic navigation callbacks.
        expect(typeof onShowChangedFiles).toBe('function');
        expect(typeof onShowAllRepositoryFiles).toBe('function');
        expect(typeof onChangedFilesViewMode).toBe('function');
        expect(typeof onChangedFilesPresentationChange).toBe('function');

        expect(screen.getTextContent()).toContain('files.toolbar.view');
    });

    it('hides scoped view controls when no scoped views are available', async () => {
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
        expect(textContent).not.toContain('files.toolbar.repositoryView');
        expect(textContent).not.toContain('files.toolbar.turnView');
        expect(textContent).not.toContain('files.toolbar.sessionView');
        expect(screen.tree.findAllByType('DropdownMenu' as any)).toHaveLength(0);
        expect(textContent).toContain('files.attributionReliabilityLimited');
    });
});
