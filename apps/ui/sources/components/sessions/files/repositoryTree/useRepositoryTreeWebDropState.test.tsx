import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS } from '@/components/sessions/files/repositoryTree/repositoryTreeDragAndDropConfig';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';


;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setExpandedPathsSpy = vi.fn();

installRepositoryTreeCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: createStorageStoreMock({
                setSessionRepositoryTreeExpandedPaths: setExpandedPathsSpy,
            }),
        });
    },
});

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

        await renderScreen(<Test />);

        act(() => {
            api!.onDropTargetChange({
                destinationDir: 'src',
                hoverPath: 'src',
                autoExpandDirectoryPath: 'src',
            });
        });

        await flushHookEffects({ cycles: 1, advanceTimersMs: REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS - 1 });

        expect(setExpandedPathsSpy).not.toHaveBeenCalled();

        await flushHookEffects({ cycles: 1, advanceTimersMs: 1 });

        expect(REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS).toBe(1_200);
        expect(setExpandedPathsSpy).toHaveBeenCalledWith('session-1', ['src']);
    });
});
