import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS } from '@/components/workspaces/files/repositoryTree/repositoryTreeDragAndDropConfig';
import { useWorkspaceRepositoryTreeWebDropState } from './useWorkspaceRepositoryTreeWebDropState';

describe('canonical workspace file-drop state', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const target = { destinationDir: 'src', hoverPath: 'src', autoExpandDirectoryPath: 'src' };

    it('discloses the hovered directory after the existing delay and cancels when effects become unavailable', async () => {
        const hook = await renderHook((enabled: boolean) => {
            const [expandedPaths, onExpandedPathsChange] = React.useState<string[]>([]);
            const drop = useWorkspaceRepositoryTreeWebDropState({ enabled, expandedPaths, onExpandedPathsChange });
            return { expandedPaths, drop };
        }, { initialProps: true });
        await act(async () => hook.getCurrent().drop.onDropTargetChange(target));
        await act(async () => vi.advanceTimersByTimeAsync(REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS - 1));
        expect(hook.getCurrent().expandedPaths).toEqual([]);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(hook.getCurrent().expandedPaths).toEqual(['src']);
        await act(async () => hook.getCurrent().drop.onDropTargetChange({ destinationDir: 'other', hoverPath: 'other', autoExpandDirectoryPath: 'other' }));
        await hook.rerender(false);
        await act(async () => vi.advanceTimersByTimeAsync(REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS));
        expect(hook.getCurrent().expandedPaths).toEqual(['src']);
        expect(hook.getCurrent().drop.dropHoverPath).toBeNull();
    });

    it('keeps the drop API stable across unchanged parent rerenders', async () => {
        const hook = await renderHook(() => {
            const [expandedPaths, onExpandedPathsChange] = React.useState<string[]>([]);
            return useWorkspaceRepositoryTreeWebDropState({ enabled: true, expandedPaths, onExpandedPathsChange });
        });
        const first = hook.getCurrent();
        await hook.rerender();
        expect(hook.getCurrent()).toBe(first);
    });
});
