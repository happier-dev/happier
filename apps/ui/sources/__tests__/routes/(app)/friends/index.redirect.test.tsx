import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOkFetchResponse, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { AuthProvider } from '@/auth/context/AuthContext';
import { profileDefaults } from '@/sync/domains/profiles/profile';

const boundary = vi.hoisted(() => ({
    push: vi.fn(), replace: vi.fn(), width: 390,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: boundary.push, replace: boundary.replace } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        useWindowDimensions: () => ({ width: boundary.width, height: 844, scale: 1, fontScale: 1 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));

beforeEach(() => {
    boundary.width = 390;
    boundary.push.mockClear();
    boundary.replace.mockClear();
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'social.friends': true } });
    storage.getState().applyProfile({ ...profileDefaults, username: 'alice' });
    const features = createRootLayoutFeaturesResponse({
        capabilities: { social: { friends: { allowUsername: true, requiredIdentityProviderId: null } } },
    });
    vi.stubGlobal('fetch', vi.fn(async () => createOkFetchResponse(features)));
});

describe('/friends', () => {
    it.each([390, 1024])('opens friend search from the header at width %i', async (width) => {
        boundary.width = width;
        const Page = (await import('@/app/(app)/friends/index')).default;
        const screen = await renderScreen(<AuthProvider initialCredentials={null}><Page /></AuthProvider>);
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('tabs.friends');

        const buttons = screen.findAllByProps({ accessibilityRole: 'button', testID: 'friends-add-friend' });
        expect(buttons).toHaveLength(1);
        expect(buttons[0].props.disabled).toBe(false);
        await act(async () => { buttons[0].props.onPress(); });
        expect(boundary.push).toHaveBeenCalledWith('/friends/search');
        expect(boundary.replace).not.toHaveBeenCalledWith('/inbox');
    });

    it('keeps search disabled until the required identity is ready', async () => {
        storage.getState().applyProfile({ ...profileDefaults, username: null });
        const Page = (await import('@/app/(app)/friends/index')).default;
        const screen = await renderScreen(<AuthProvider initialCredentials={null}><Page /></AuthProvider>);
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('tabs.friends');

        const button = screen.findByProps({ accessibilityRole: 'button', testID: 'friends-add-friend' });
        expect(button.props.disabled).toBe(true);
        expect(button.props.accessibilityState).toMatchObject({ disabled: true });
        await act(async () => { button.props.onPress(); });
        expect(boundary.push).not.toHaveBeenCalled();
    });
});
