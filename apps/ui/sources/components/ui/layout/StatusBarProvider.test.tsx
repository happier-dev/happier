import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const statusBarTestState = vi.hoisted(() => ({
    platformOS: 'android' as 'android' | 'ios',
    lastStatusBarProps: null as Record<string, unknown> | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return statusBarTestState.platformOS;
            },
            select: (options: Record<string, unknown>) =>
                options?.[statusBarTestState.platformOS] ?? options?.default,
        },
    });
});

vi.mock('expo-status-bar', () => ({
    StatusBar: (props: Record<string, unknown>) => {
        statusBarTestState.lastStatusBarProps = props;
        return React.createElement('StatusBar', props);
    },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('StatusBarProvider', () => {
    beforeEach(() => {
        vi.resetModules();
        statusBarTestState.platformOS = 'android';
        statusBarTestState.lastStatusBarProps = null;
    });

    it('disables animated status bar updates on Android', async () => {
        const { StatusBarProvider } = await import('./StatusBarProvider');

        await renderScreen(<StatusBarProvider />);

        expect(statusBarTestState.lastStatusBarProps?.animated).toBe(false);
    });

    it('keeps animated status bar updates on iOS', async () => {
        statusBarTestState.platformOS = 'ios';
        const { StatusBarProvider } = await import('./StatusBarProvider');

        await renderScreen(<StatusBarProvider />);

        expect(statusBarTestState.lastStatusBarProps?.animated).toBe(true);
    });
});
