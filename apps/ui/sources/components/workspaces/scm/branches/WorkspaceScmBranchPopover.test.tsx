import * as React from 'react';
import { act } from 'react-test-renderer';

import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
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

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: Record<string, unknown> & { children?: ((args: { maxHeight: number; maxWidth: number }) => React.ReactNode) | React.ReactNode; open?: boolean }) =>
        React.createElement(
            'Popover',
            props,
            props.open && typeof props.children === 'function'
                ? props.children({ maxHeight: 480, maxWidth: 420 })
                : null,
        ),
}));

describe('WorkspaceScmBranchPopover', () => {
    it('renders the results list inside a scroll view and does not rely on close-on-anchor press', async () => {
        const { WorkspaceScmBranchPopover } = await import('./WorkspaceScmBranchPopover');

        const screen = await renderScreen(
            <WorkspaceScmBranchPopover
                open
                onOpenChange={vi.fn()}
                currentBranch="main"
                branchItems={Array.from({ length: 20 }, (_, index) => ({
                    id: `branch:feature-${index}`,
                    title: `feature-${index}`,
                }))}
                worktreeItems={[]}
                onSelectItem={vi.fn()}
            />,
        );

        const popover = screen.tree.findByType('Popover' as never);
        expect(popover.props.closeOnAnchorPress).not.toBe(true);

        const scrollView = screen.tree.findByProps({ testID: 'workspace-scm-branch-popover-scroll' } as never);
        expect(scrollView).toBeTruthy();
    });

    it('routes the create branch row to the create callback', async () => {
        const { WorkspaceScmBranchPopover } = await import('./WorkspaceScmBranchPopover');
        const onCreateBranch = vi.fn();
        const onSelectItem = vi.fn();

        const screen = await renderScreen(
            <WorkspaceScmBranchPopover
                open
                onOpenChange={vi.fn()}
                currentBranch="main"
                branchItems={[]}
                worktreeItems={[]}
                onSelectItem={onSelectItem}
                onCreateBranch={onCreateBranch}
            />,
        );

        const search = screen.tree.findByProps({ testID: 'workspace-scm-branch-popover-search' } as never);
        act(() => {
            search.props.onChangeText('feature/new');
        });

        const createRow = screen.tree.findByProps({ testID: 'dropdown-option-__create__' } as never);
        act(() => {
            createRow.props.onPress();
        });

        expect(onCreateBranch).toHaveBeenCalledWith('feature/new');
        expect(onSelectItem).not.toHaveBeenCalled();
    });
    it('scrolls a long branch list to the branch the keyboard moves to', async () => {
        const { WorkspaceScmBranchPopover } = await import('./WorkspaceScmBranchPopover');
        const scrollTo = vi.fn();
        const branchItems = Array.from({ length: 300 }, (_, index) => ({ id: `branch:feature-${index}`, title: `feature-${index}` }));
        const screen = await renderScreen(
            <WorkspaceScmBranchPopover open onOpenChange={vi.fn()} currentBranch="feature-0" branchItems={branchItems} worktreeItems={[]} onSelectItem={vi.fn()} />,
            { createNodeMock: (node) => node.props?.testID === 'workspace-scm-branch-popover-scroll' ? { scrollTo } : null },
        );
        const scroller = screen.tree.findByProps({ testID: 'workspace-scm-branch-popover-scroll' } as never);
        await act(async () => {
            scroller.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 360 } } });
            scroller.props.onContentSizeChange(320, 300 * 36);
        });
        const search = screen.tree.findByProps({ testID: 'workspace-scm-branch-popover-search' } as never);
        await act(async () => { search.props.onKeyPress({ nativeEvent: { key: 'End' } }); });
        // The last branch is mounted wherever the window is; once it reports where it sits, the list scrolls to it.
        const last = screen.tree.findByProps({ testID: 'dropdown-option-branch_feature-299:scroll-frame' } as never);
        await act(async () => { last.props.onLayout({ nativeEvent: { layout: { y: 299 * 36, height: 36 } } }); });
        expect(scrollTo).toHaveBeenCalled();
    });
});
