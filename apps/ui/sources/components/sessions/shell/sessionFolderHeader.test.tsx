import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { FolderGroupHeader } from './sessionFolderHeader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: 'DropdownMenu',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

function childTreeContainsType(root: ReactTestInstance, type: string): boolean {
    return root.children.some((child) => (
        typeof child === 'object'
        && child !== null
        && (
            child.type === type
            || childTreeContainsType(child, type)
        )
    ));
}

function flattenStyleValue(style: unknown, key: string): unknown {
    if (Array.isArray(style)) {
        return style.reduce<unknown>((value, entry) => {
            const next = flattenStyleValue(entry, key);
            return next === undefined ? value : next;
        }, undefined);
    }
    if (style && typeof style === 'object' && key in style) {
        return (style as Record<string, unknown>)[key];
    }
    return undefined;
}

describe('FolderGroupHeader', () => {
    it('starts first-level folders with the workspace child indentation', async () => {
        const screen = await renderScreen(
            <FolderGroupHeader
                item={{
                    type: 'header',
                    headerKind: 'folder',
                    folderId: 'folder-a',
                    parentFolderId: null,
                    title: 'Folder A',
                    depth: 0,
                    sessionCount: 0,
                    groupKey: 'folder:folder-a',
                }}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                onFocus={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        // The folder header row carries the depth indentation directly; there is
        // no row-local drop-target outline anymore (the single list-level
        // SessionListDropOverlay owns the drop indicator).
        const header = screen.findByTestId('session-folder-header-folder-a');
        expect(header).not.toBeNull();
        if (!header) throw new Error('expected folder header');
        expect(flattenStyleValue(header.parent?.props.style, 'paddingLeft')).toBe(20);
    });

    it('does not nest pressable controls inside another pressable on web', async () => {
        const screen = await renderScreen(
            <FolderGroupHeader
                item={{
                    type: 'header',
                    headerKind: 'folder',
                    folderId: 'folder-a',
                    parentFolderId: null,
                    title: 'Folder A',
                    depth: 0,
                    sessionCount: 0,
                    groupKey: 'folder:folder-a',
                }}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                onFocus={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        for (const pressable of screen.findAllByType('Pressable' as never)) {
            expect(childTreeContainsType(pressable, 'Pressable')).toBe(false);
        }
    });

    it('does not render a row-local drop-target outline (the list-level overlay owns it)', async () => {
        const screen = await renderScreen(
            <FolderGroupHeader
                item={{
                    type: 'header',
                    headerKind: 'folder',
                    folderId: 'folder-a',
                    parentFolderId: null,
                    title: 'Folder A',
                    depth: 0,
                    sessionCount: 0,
                    groupKey: 'folder:folder-a',
                }}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                onFocus={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        // The per-row drop-target outline has been removed: the single
        // SessionListDropOverlay is the only thing that draws a drop indicator.
        expect(screen.findByTestId('session-folder-drop-target-folder-a')).toBeNull();
    });

    it('exposes move menu and accessibility actions for keyboard and assistive input', async () => {
        const onMove = vi.fn();
        const onMoveUp = vi.fn();
        const onMoveDown = vi.fn();
        const onMoveToWorkspaceRoot = vi.fn();
        const screen = await renderScreen(
            <FolderGroupHeader
                item={{
                    type: 'header',
                    headerKind: 'folder',
                    folderId: 'folder-a',
                    parentFolderId: null,
                    title: 'Folder A',
                    depth: 0,
                    sessionCount: 0,
                    groupKey: 'folder:folder-a',
                }}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                onFocus={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
                onMove={onMove}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
                onMoveToWorkspaceRoot={onMoveToWorkspaceRoot}
            />,
        );

        const menu = screen.root.findByType('DropdownMenu' as never);
        const moveItem = menu.props.items.find((item: any) => item.id === 'move');
        expect(moveItem.disabled).toBe(false);

        await act(async () => {
            menu.props.onSelect('move');
        });
        expect(onMove).toHaveBeenCalledTimes(1);
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'move-up', disabled: undefined }),
            expect.objectContaining({ id: 'move-down', disabled: undefined }),
        ]));
        await act(async () => {
            await menu.props.onSelect('move-up');
            await menu.props.onSelect('move-down');
        });
        expect(onMoveUp).toHaveBeenCalledOnce();
        expect(onMoveDown).toHaveBeenCalledOnce();

        const header = screen.findByTestId('session-folder-header-folder-a');
        expect(header?.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveToFolder' }),
            expect.objectContaining({ name: 'moveToWorkspaceRoot' }),
        ]));
    });
});
