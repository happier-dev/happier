import * as React from 'react';
import { Pressable } from 'react-native';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from '../components/newSessionComponentsTestHelpers';

installNewSessionComponentsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    },
});

function pickerOptions(onCancel: () => void) {
    return {
        headerShown: true,
        title: 'Select machine',
        headerLeft: () => <Pressable testID="picker-cancel" accessibilityRole="button" onPress={onCancel} />,
    };
}

describe('NewSessionPickerRouteScreen', () => {
    // The mocked module graph loads on first import; keep that cold load out of the per-test budget.
    beforeAll(async () => { await import('./NewSessionPickerRouteScreen'); }, 300_000);

    it('draws the declared bar on the web route drawer, so its Cancel closes the picker', async () => {
        const { NewSessionPickerRouteScreen } = await import('./NewSessionPickerRouteScreen');
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <NewSessionPickerRouteScreen options={pickerOptions(onCancel)}>{React.createElement('PickerList')}</NewSessionPickerRouteScreen>,
        );
        try {
            expect(screen.findByType('PickerList')).toBeTruthy();
            await screen.pressByTestIdAsync('picker-cancel');
            expect(onCancel).toHaveBeenCalledTimes(1);
        } finally {
            screen.unmount();
        }
    });

    it('leaves a forced-screen route to the navigator header', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const previous = storage.getState();
        storage.getState().applySettingsLocal({ newSessionPresentationModeV1: 'screen' });
        const { NewSessionPickerRouteScreen } = await import('./NewSessionPickerRouteScreen');
        const screen = await renderScreen(
            <NewSessionPickerRouteScreen options={pickerOptions(() => {})}>{React.createElement('PickerList')}</NewSessionPickerRouteScreen>,
        );
        try {
            expect(screen.findByType('PickerList')).toBeTruthy();
            expect(screen.findByTestId('picker-cancel')).toBeNull();
        } finally {
            screen.unmount();
            storage.setState(previous);
        }
    });
});
