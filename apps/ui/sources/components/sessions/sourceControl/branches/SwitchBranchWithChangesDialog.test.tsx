import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalShowMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            surface: '#fff',
            surfaceHigh: '#f6f6f6',
            text: '#000',
            textSecondary: '#666',
            textLink: '#09f',
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme, {}) : input) },
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/modal', () => ({
    Modal: {
        show: modalShowMock,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, vars?: any) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

describe('SwitchBranchWithChangesDialog', () => {
    it('resolves stash_on_current_branch when selecting leave-changes', async () => {
        const onResolve = vi.fn();
        const { SwitchBranchWithChangesDialog } = await import('./SwitchBranchWithChangesDialog');

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <SwitchBranchWithChangesDialog
                    currentBranch="main"
                    targetBranch="feature/test"
                    onResolve={onResolve}
                    onClose={() => {}}
                />
            );
        });

        const leave = tree.root.findByProps({ testID: 'switch-branch-leave-changes' });
        act(() => {
            leave.props.onPress();
        });

        expect(onResolve).toHaveBeenCalledWith('stash_on_current_branch');
    });

    it('resolves bring_changes when selecting bring-changes', async () => {
        const onResolve = vi.fn();
        const { SwitchBranchWithChangesDialog } = await import('./SwitchBranchWithChangesDialog');

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <SwitchBranchWithChangesDialog
                    currentBranch="main"
                    targetBranch="feature/test"
                    onResolve={onResolve}
                    onClose={() => {}}
                />
            );
        });

        const bring = tree.root.findByProps({ testID: 'switch-branch-bring-changes' });
        act(() => {
            bring.props.onPress();
        });

        expect(onResolve).toHaveBeenCalledWith('bring_changes');
    });

    it('resolves cancel when pressing cancel', async () => {
        const onResolve = vi.fn();
        const { SwitchBranchWithChangesDialog } = await import('./SwitchBranchWithChangesDialog');

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <SwitchBranchWithChangesDialog
                    currentBranch="main"
                    targetBranch="feature/test"
                    onResolve={onResolve}
                    onClose={() => {}}
                />
            );
        });

        const cancel = tree.root.findByProps({ testID: 'switch-branch-cancel' });
        act(() => {
            cancel.props.onPress();
        });

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

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(modalComponent, { ...modalProps, onClose: () => {} }));
        });

        const bring = tree.root.findByProps({ testID: 'switch-branch-bring-changes' });
        act(() => {
            bring.props.onPress();
        });

        await expect(promise).resolves.toBe('bring_changes');
    });
});
