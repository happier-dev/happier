import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPaneLazyLoader } from './SessionPaneLazyLoader';
import { createDeferred, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                                    View: (props: any) => React.createElement('View', props, props.children),
                                                                    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
                                                                    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
                                                                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SessionPaneLazyLoader', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('keeps loading while a slow pane module is still pending and renders once it resolves', async () => {
        const LoadedPane = () => React.createElement('LoadedPane');
        const deferred = createDeferred<React.ComponentType<Record<string, never>>>();
        const load = vi.fn(() => deferred.promise);

        const screen = await renderScreen(
            <SessionPaneLazyLoader
                testID="session-pane-loader"
                load={load}
                props={{}}
            />,
        );

        expect(screen.findByTestId('session-pane-loader')).toBeTruthy();
        expect(screen.getTextContent()).toContain('common.loading');
        expect(load).toHaveBeenCalledTimes(1);

        await act(async () => {
            deferred.resolve(LoadedPane);
        });

        expect(screen.findByType(LoadedPane)).toBeTruthy();
    });

    it('shows retry UI after a rejected load and recovers when the user retries', async () => {
        const LoadedPane = () => React.createElement('LoadedPane');
        const load = vi.fn()
            .mockRejectedValueOnce(new Error('module load failed'))
            .mockResolvedValueOnce(LoadedPane);

        const screen = await renderScreen(
            <SessionPaneLazyLoader
                testID="session-pane-loader"
                load={load}
                props={{}}
            />,
        );

        expect(screen.findByTestId('session-pane-loader-error')).toBeTruthy();
        expect(screen.getTextContent()).toContain('common.error');
        expect(screen.getTextContent()).toContain('common.retry');

        const retryButton = screen.findByProps({ accessibilityRole: 'button' });
        await pressTestInstanceAsync(retryButton, 'session-pane-loader retry button');

        expect(load).toHaveBeenCalledTimes(2);
        expect(screen.findByType(LoadedPane)).toBeTruthy();
    });
});
