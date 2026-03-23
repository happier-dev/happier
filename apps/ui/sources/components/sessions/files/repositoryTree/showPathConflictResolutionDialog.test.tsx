import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hideSpy = vi.fn();
const showSpy = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                                select: (value: any) => value?.web ?? value?.default ?? null,
                                            },
                                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (config: any) => showSpy(config),
            hide: (id: string) => hideSpy(id),
        },
    }).module;
});

describe('showPathConflictResolutionDialog', () => {
    it('hides the modal when the user picks a conflict strategy', async () => {
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

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(modalConfig.component, {
                    ...(modalConfig.props ?? {}),
                    onClose: vi.fn(),
                }))).tree;

        const skip = tree.find((node: any) => node.props?.testID === 'upload-conflicts-skip');
        await act(async () => {
            await pressTestInstanceAsync(skip);
        });

        await expect(promise).resolves.toBe('skip');
        expect(hideSpy).toHaveBeenCalledWith('modal-1');
    });
});
