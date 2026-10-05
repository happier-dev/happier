import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { useWorkspaceRepositoryTreeWebDropState } from './useWorkspaceRepositoryTreeWebDropState';

describe('repository file-drop semantic feedback', () => {
    it('does not rerender the tree owner for another frame over the same directory', async () => {
        let renders = 0;
        const expandedPaths = ['src'];
        const onExpandedPathsChange = () => {};
        const hook = await renderHook(() => {
            renders += 1;
            return useWorkspaceRepositoryTreeWebDropState({ enabled: true, expandedPaths, onExpandedPathsChange });
        });
        const target = { destinationDir: 'src', hoverPath: 'src', autoExpandDirectoryPath: null };
        await act(async () => hook.getCurrent().onDropTargetChange(target));
        const afterFirstFrame = renders;
        await act(async () => hook.getCurrent().onDropTargetChange({ ...target }));
        expect(renders).toBe(afterFirstFrame);
    });
});
