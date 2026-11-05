import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// iOS speaks through the platform announcement API, so each polite result is one observable call.
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const base = await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' });
    return { ...base, AccessibilityInfo: { ...base.AccessibilityInfo, announceForAccessibility: announceForAccessibilityMock } };
});
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const { RegistryShelfAddControl } = await import('./RegistryShelf');
const { CorePluginUiPresentationScope } = await import('@/components/plugins/surfaces/CorePluginUiPresentationScope');

function control(state: 'available' | 'adding' | 'added' | 'failed') {
    // Core installs the shared UI environment (motion, accessibility) at its root.
    return React.createElement(CorePluginUiPresentationScope, null, React.createElement(RegistryShelfAddControl, {
        state,
        title: 'Linear',
        addLabel: 'Add',
        addedLabel: 'Added',
        failedLabel: 'Try again',
        onAdd: () => {},
        testID: 'shelf.linear',
    }));
}

describe('RegistryShelfAddControl acknowledgement', () => {
    it('announces one polite result for its own add, and stays silent on mount, refresh and failure', async () => {
        announceForAccessibilityMock.mockClear();
        // Already in the library when the shelf mounts: settled, not news.
        const settled = await renderScreen(control('added'));
        expect(settled.findByTestId('shelf.linear.added')).not.toBeNull();
        expect(announceForAccessibilityMock).not.toHaveBeenCalled();

        const screen = await renderScreen(control('available'));
        await screen.update(control('adding'));
        await screen.update(control('failed'));
        expect(announceForAccessibilityMock).not.toHaveBeenCalled();

        await screen.update(control('adding'));
        await screen.update(control('added'));
        expect(screen.findByTestId('shelf.linear.added')).not.toBeNull();
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith('Linear, Added');

        // A refresh that re-renders the same settled result does not replay it.
        await screen.update(control('added'));
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
    });
});
