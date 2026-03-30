import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


const actEnvironmentGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('Switch.web', () => {
    const previousActEnvironment = actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT;

    beforeEach(() => {
        actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    });

    it('exposes aria-checked for web switch semantics', async () => {
        const { Switch } = await import('./Switch.web');
        const screen = await renderScreen(<Switch
                    value
                    onValueChange={() => {}}
                    testID="settings-toggle"
                />);

        const pressable = screen.findByTestId('settings-toggle');
        if (!pressable) {
            throw new Error('Expected switch pressable to render');
        }
        expect(pressable.props.accessibilityRole).toBe('switch');
        expect(pressable.props['aria-checked']).toBe(true);
    });
});
