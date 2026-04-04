import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hideSpy = vi.fn();
const showSpy = vi.fn();

installRepositoryTreeCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (config: any) => showSpy(config),
                hide: (id: string) => hideSpy(id),
            },
        }).module;
    },
});

describe('showPathConflictResolutionDialog', () => {
    it('closes the modal when the user picks a conflict strategy', async () => {
        showSpy.mockReset();
        hideSpy.mockReset();
        showSpy.mockReturnValue('modal-1');

        const { showPathConflictResolutionDialog } = await import('./showPathConflictResolutionDialog');

        const promise = showPathConflictResolutionDialog({
            title: 'Conflict',
            body: 'Choose a strategy',
            allowSkip: true,
            testIdPrefix: 'upload-conflicts',
        });

        const modalConfig = showSpy.mock.calls[0]?.[0];
        expect(modalConfig).toBeDefined();

        const onClose = vi.fn();
        const screen = await renderScreen(React.createElement(modalConfig.component, {
            ...(modalConfig.props ?? {}),
            onClose,
        }));

        const skip = screen.findByTestId('upload-conflicts-skip');
        expect(skip).toBeTruthy();
        await screen.pressByTestIdAsync('upload-conflicts-skip');

        await expect(promise).resolves.toBe('skip');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
