import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS } from '@/components/sessions/files/repositoryTree/repositoryTreeDragAndDropConfig';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setExpandedPathsSpy = vi.fn();

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            setSessionRepositoryTreeExpandedPaths: setExpandedPathsSpy,
        }),
    },
}));

describe('useRepositoryTreeWebDropState', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setExpandedPathsSpy.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('auto-expands a hovered collapsed directory after the configured delay', async () => {
        const { useRepositoryTreeWebDropState } = await import('./useRepositoryTreeWebDropState');

        let api: ReturnType<typeof useRepositoryTreeWebDropState> | null = null;
        function Test() {
            api = useRepositoryTreeWebDropState({
                sessionId: 'session-1',
                enabled: true,
                expandedPaths: [],
            });
            return null;
        }

        await act(async () => {
            renderer.create(<Test />);
        });

        act(() => {
            api!.onDropTargetChange({
                destinationDir: 'src',
                hoverPath: 'src',
                autoExpandDirectoryPath: 'src',
            });
        });

        act(() => {
            vi.advanceTimersByTime(1_199);
        });

        expect(setExpandedPathsSpy).not.toHaveBeenCalled();

        act(() => {
            vi.advanceTimersByTime(1);
        });

        expect(REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS).toBe(1_200);
        expect(setExpandedPathsSpy).toHaveBeenCalledWith('session-1', ['src']);
    });
});
