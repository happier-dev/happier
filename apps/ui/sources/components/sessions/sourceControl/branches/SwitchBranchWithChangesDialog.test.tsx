import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalShowMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Pressable: 'Pressable',
                    Platform: {
                        OS: 'web',
                        select: (value: any) => value?.default ?? null,
                    },
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: modalShowMock,
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, vars?: any) => (vars ? `${key}:${JSON.stringify(vars)}` : key) });
});

describe('SwitchBranchWithChangesDialog', () => {
    it('resolves stash_on_current_branch when selecting leave-changes', async () => {
        const onResolve = vi.fn();
        const { SwitchBranchWithChangesDialog } = await import('./SwitchBranchWithChangesDialog');

        const screen = await renderScreen(<SwitchBranchWithChangesDialog
                    currentBranch="main"
                    targetBranch="feature/test"
                    onResolve={onResolve}
                    onClose={() => {}}
                />);

        await screen.pressByTestIdAsync('switch-branch-leave-changes');

        expect(onResolve).toHaveBeenCalledWith('stash_on_current_branch');
    });

    it('resolves bring_changes when selecting bring-changes', async () => {
        const onResolve = vi.fn();
        const { SwitchBranchWithChangesDialog } = await import('./SwitchBranchWithChangesDialog');

        const screen = await renderScreen(<SwitchBranchWithChangesDialog
                    currentBranch="main"
                    targetBranch="feature/test"
                    onResolve={onResolve}
                    onClose={() => {}}
                />);

        await screen.pressByTestIdAsync('switch-branch-bring-changes');

        expect(onResolve).toHaveBeenCalledWith('bring_changes');
    });

    it('resolves cancel when pressing cancel', async () => {
        const onResolve = vi.fn();
        const { SwitchBranchWithChangesDialog } = await import('./SwitchBranchWithChangesDialog');

        const screen = await renderScreen(<SwitchBranchWithChangesDialog
                    currentBranch="main"
                    targetBranch="feature/test"
                    onResolve={onResolve}
                    onClose={() => {}}
                />);

        await screen.pressByTestIdAsync('switch-branch-cancel');

        expect(onResolve).toHaveBeenCalledWith('cancel');
    });

    it('showSwitchBranchWithChangesDialog resolves with the selected choice', async () => {
        const { showSwitchBranchWithChangesDialog } = await import('./SwitchBranchWithChangesDialog');

        // Capture the modal component so we can render it and trigger presses.
        let modalComponent: any = null;
        let modalProps: any = null;
        modalShowMock.mockImplementation((config: any) => {
            modalComponent = config.component;
            modalProps = config.props;
            return 'modal-id';
        });

        const promise = showSwitchBranchWithChangesDialog({
            currentBranch: 'main',
            targetBranch: 'feature/test',
        });

        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(modalComponent).not.toBeNull();

        const screen = await renderScreen(React.createElement(modalComponent, { ...modalProps, onClose: () => {} }));

        await screen.pressByTestIdAsync('switch-branch-bring-changes');

        await expect(promise).resolves.toBe('bring_changes');
    });
});
