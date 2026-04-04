import * as React from 'react';

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref: React.Ref<unknown>) =>
            React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('WorkspaceWorktreeListSection', () => {
    it('filters worktrees by the search query and keeps the active worktree selected', async () => {
        const onSelectRootPath = vi.fn();
        const { WorkspaceWorktreeListSection } = await import('./WorkspaceWorktreeListSection');

        const screen = await renderScreen(
            <WorkspaceWorktreeListSection
                worktrees={[
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                    { path: '/repo/.worktrees/fix-crash', branch: 'fix/crash', isCurrent: false },
                ]}
                selectedRootPath="/repo/.worktrees/feature-auth"
                onSelectRootPath={onSelectRootPath}
            />,
        );

        const searchInput = screen.tree.findByProps({ testID: 'workspace-worktrees-search-input' });
        await act(async () => {
            searchInput.props.onChangeText('feature');
        });

        expect(screen.tree.findByProps({ testID: 'workspace-worktree-row:/repo/.worktrees/feature-auth' })).toBeTruthy();
        expect(screen.tree.findAllByProps({ testID: 'workspace-worktree-row:/repo/.worktrees/fix-crash' })).toHaveLength(0);

        const selectedRow = screen.tree.findByProps({ testID: 'workspace-worktree-row:/repo/.worktrees/feature-auth' });
        expect(selectedRow.props.selected).toBe(true);
    });

    it('calls onSelectRootPath when a worktree row is pressed', async () => {
        const onSelectRootPath = vi.fn();
        const { WorkspaceWorktreeListSection } = await import('./WorkspaceWorktreeListSection');

        const screen = await renderScreen(
            <WorkspaceWorktreeListSection
                worktrees={[
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                ]}
                selectedRootPath="/repo"
                onSelectRootPath={onSelectRootPath}
            />,
        );

        const targetRow = screen.tree.findByProps({ testID: 'workspace-worktree-row:/repo/.worktrees/feature-auth' });
        await act(async () => {
            targetRow.props.onPress();
        });

        expect(onSelectRootPath).toHaveBeenCalledWith('/repo/.worktrees/feature-auth');
    });
});
