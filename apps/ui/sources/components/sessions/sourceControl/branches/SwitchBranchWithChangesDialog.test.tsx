import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installSourceControlBranchMenuCommonModuleMocks,
    resetSourceControlBranchMenuCommonModuleMockState,
    sourceControlBranchMenuModuleState,
} from './sourceControlBranchMenuTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSourceControlBranchMenuCommonModuleMocks();

beforeEach(() => {
    resetSourceControlBranchMenuCommonModuleMockState();
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
        let modalComponent: React.ComponentType<Record<string, unknown>> | null = null;
        let modalProps: Record<string, unknown> | null = null;
        sourceControlBranchMenuModuleState.modalShowSpy.mockImplementation((config) => {
            const modalConfig = config as {
                component: React.ComponentType<Record<string, unknown>>;
                props: Record<string, unknown>;
            };
            modalComponent = modalConfig.component;
            modalProps = modalConfig.props;
            return 'modal-id';
        });

        const promise = showSwitchBranchWithChangesDialog({
            currentBranch: 'main',
            targetBranch: 'feature/test',
        });

        expect(sourceControlBranchMenuModuleState.modalShowSpy).toHaveBeenCalledTimes(1);
        expect(modalComponent).not.toBeNull();

        if (!modalComponent || !modalProps) {
            throw new Error('Expected SwitchBranchWithChangesDialog modal component and props to be captured');
        }

        const CapturedModal: React.ComponentType<Record<string, unknown>> = modalComponent;
        const capturedProps: Record<string, unknown> = modalProps;

        const screenProps: Record<string, unknown> = {
            ...capturedProps,
            onClose: () => {},
        };

        const screen = await renderScreen(React.createElement(CapturedModal, screenProps));

        await screen.pressByTestIdAsync('switch-branch-bring-changes');

        await expect(promise).resolves.toBe('bring_changes');
    });
});
