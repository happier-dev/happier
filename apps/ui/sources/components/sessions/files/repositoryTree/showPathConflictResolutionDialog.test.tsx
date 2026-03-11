import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hideSpy = vi.fn();
const showSpy = vi.fn();

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#ddd',
                surface: '#111',
                surfaceHigh: '#222',
                text: '#fff',
                textLink: '#0af',
                textSecondary: '#999',
            },
        },
    }),
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        divider: '#ddd',
                        surface: '#111',
                        surfaceHigh: '#222',
                        text: '#fff',
                        textLink: '#0af',
                        textSecondary: '#999',
                    },
                })
                : value,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/modal', () => ({
    Modal: {
        show: (config: any) => showSpy(config),
        hide: (id: string) => hideSpy(id),
    },
}));

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
        await act(async () => {
            tree = renderer.create(
                React.createElement(modalConfig.component, {
                    ...(modalConfig.props ?? {}),
                    onClose: vi.fn(),
                })
            );
        });

        const skip = tree.root.find((node: any) => node.props?.testID === 'upload-conflicts-skip');
        await act(async () => {
            skip.props.onPress();
        });

        await expect(promise).resolves.toBe('skip');
        expect(hideSpy).toHaveBeenCalledWith('modal-1');
    });
});
