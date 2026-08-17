import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('PluginReactNativeUnavailable crash-reset feedback', () => {
    it('renders the daemon-owned request, projection wait, and failure states with distinct safe card semantics', async () => {
        const { PluginReactNativeUnavailable } = await import('./PluginReactNativeUnavailable');
        const onReset = () => {};

        const requested = await renderScreen(
            <PluginReactNativeUnavailable resetStatus="reset_requested" onReset={onReset} />,
        );
        expect(requested.getTextContent()).toContain(t('pluginReactNative.reset.requested.title'));
        expect(requested.getTextContent()).toContain(t('pluginReactNative.reset.requested.reason'));
        expect(requested.getTextContent()).not.toContain('reset_requested');
        expect(requested.findByTestId('plugin-rn-ui-unavailable-loading-spinner')).toBeTruthy();
        expect(requested.findByTestId('plugin-rn-ui-unavailable')?.props.accessibilityLiveRegion).toBe('polite');
        expect(requested.findByTestId('plugin-rn-ui-unavailable-action')).toBeNull();

        const awaitingProjection = await renderScreen(
            <PluginReactNativeUnavailable resetStatus="awaiting_new_projection" onReset={onReset} />,
        );
        expect(awaitingProjection.getTextContent()).toContain(t('pluginReactNative.reset.awaitingProjection.title'));
        expect(awaitingProjection.getTextContent()).toContain(t('pluginReactNative.reset.awaitingProjection.reason'));
        expect(awaitingProjection.getTextContent()).not.toContain('awaiting_new_projection');
        expect(awaitingProjection.findByTestId('plugin-rn-ui-unavailable-loading-spinner')).toBeTruthy();
        expect(awaitingProjection.findByTestId('plugin-rn-ui-unavailable')?.props.accessibilityLiveRegion).toBe('polite');
        expect(awaitingProjection.findByTestId('plugin-rn-ui-unavailable-action')).toBeNull();

        const failed = await renderScreen(
            <PluginReactNativeUnavailable resetStatus="reset_failed" onReset={onReset} />,
        );
        expect(failed.getTextContent()).toContain(t('pluginReactNative.reset.failed.title'));
        expect(failed.getTextContent()).toContain(t('pluginReactNative.reset.failed.reason'));
        expect(failed.getTextContent()).not.toContain('reset_failed');
        expect(failed.findByTestId('plugin-rn-ui-unavailable-loading-spinner')).toBeNull();
        expect(failed.findByTestId('plugin-rn-ui-unavailable')?.props.accessibilityLiveRegion).toBe('assertive');
        expect(failed.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe(t('common.reset'));
    });
});
