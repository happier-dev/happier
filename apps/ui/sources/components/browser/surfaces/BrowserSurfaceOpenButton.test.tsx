import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const featureState = vi.hoisted(() => ({
    browser: 'enabled',
    viewTargets: 'enabled',
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => ({
        state: featureId === 'browser.viewTargets'
            ? featureState.viewTargets
            : featureState.browser,
    }),
}));

describe('BrowserSurfaceOpenButton', () => {
    it('opens when browser surface features are enabled', async () => {
        const { BrowserSurfaceOpenButton } = await import('./BrowserSurfaceOpenButton');
        const onPress = vi.fn();
        featureState.browser = 'enabled';
        featureState.viewTargets = 'enabled';

        const screen = await renderScreen(
            <BrowserSurfaceOpenButton testID="browser-open" onPress={onPress} />,
        );

        expect(screen.findByTestId('browser-open')?.props.accessibilityState).toEqual({ disabled: false });

        await screen.pressByTestIdAsync('browser-open');

        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('is discoverable but disabled when browser view targets are not enabled', async () => {
        const { BrowserSurfaceOpenButton } = await import('./BrowserSurfaceOpenButton');
        const onPress = vi.fn();
        featureState.browser = 'enabled';
        featureState.viewTargets = 'disabled';

        const screen = await renderScreen(
            <BrowserSurfaceOpenButton testID="browser-open" onPress={onPress} />,
        );

        const button = screen.findByTestId('browser-open');
        expect(button?.props.accessibilityState).toEqual({ disabled: true });
        expect(button?.props.accessibilityLabel).toBe('browserSurface.openDisabledA11y');

        await screen.pressByTestIdAsync('browser-open');

        expect(onPress).not.toHaveBeenCalled();
    });

    it('routes the disabled hint through the owner-copy mapper and never renders a raw internal code', async () => {
        const { BrowserSurfaceOpenButton } = await import('./BrowserSurfaceOpenButton');

        // browser feature off → the hint must carry product copy, not the raw `browser_disabled` code.
        featureState.browser = 'disabled';
        featureState.viewTargets = 'enabled';
        const browserOffScreen = await renderScreen(
            <BrowserSurfaceOpenButton testID="browser-open" onPress={vi.fn()} />,
        );
        const browserOffHint = browserOffScreen.findByTestId('browser-open')?.props.accessibilityHint as string;
        expect(browserOffHint).not.toContain('browser_disabled');
        expect(browserOffHint).not.toContain('disabled:');
        expect(browserOffHint).toBe('browserShell.unavailable.surface.disabled');

        // view-targets off → product copy for the view-targets surface state, not the raw token.
        featureState.browser = 'enabled';
        featureState.viewTargets = 'disabled';
        const viewTargetsOffScreen = await renderScreen(
            <BrowserSurfaceOpenButton testID="browser-open" onPress={vi.fn()} />,
        );
        const viewTargetsOffHint = viewTargetsOffScreen.findByTestId('browser-open')?.props.accessibilityHint as string;
        expect(viewTargetsOffHint).not.toContain('view_targets_disabled');
        expect(viewTargetsOffHint).toBe('browserShell.unavailable.surface.viewTargetsDisabled');
    });
});
