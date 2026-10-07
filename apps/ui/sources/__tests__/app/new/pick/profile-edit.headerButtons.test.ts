import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { IModal } from '@/modal';
import {
    createNavigationMock, createRouterMock, createStackOptionsCapture,
    enableReactActEnvironment, installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();
const routerMock = createRouterMock();
const navigationMock = {
    ...createNavigationMock(), setOptions: vi.fn(), addListener: vi.fn(() => () => {}),
};
const stackOptionsCapture = createStackOptionsCapture();
const alertSpy = vi.fn<IModal['alert']>();
let profileData = '';

vi.mock('expo-constants', () => ({ default: { statusBarHeight: 0 } }));
vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));

installPickerCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            Platform: { isPad: false },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        });
    },
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        navigation: navigationMock,
        params: () => ({ profileData }),
        router: { push: routerMock.push, back: routerMock.back, replace: routerMock.replace, setParams: routerMock.setParams },
        stackOptionsCapture,
    }).module,
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { alert: alertSpy },
    }).module,
});
const runtime = installSessionPaneRuntimeTestHarness();

beforeEach(async () => {
    const { createEmptyCustomProfile } = await import('@/sync/domains/profiles/profileMutations');
    profileData = JSON.stringify({ ...createEmptyCustomProfile(), id: 'p1', name: 'Test profile' });
    storage.getState().applySettingsLocal({ profiles: [] });
    stackOptionsCapture.reset();
    alertSpy.mockClear();
    navigationMock.goBack.mockClear();
    navigationMock.dispatch.mockClear();
    navigationMock.setOptions.mockClear();
    routerMock.back.mockClear();
    routerMock.replace.mockClear();
});

async function renderProfileEditor() {
    const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
    const screen = await renderScreen(React.createElement(runtime.Wrapper, {
        children: React.createElement(ProfileEditScreen),
    }));
    return screen;
}

function pressHeaderClose() {
    const button = stackOptionsCapture.getResolved()?.headerLeft?.();
    if (!button?.props.onPress) throw new Error('Expected editor close action');
    button.props.onPress();
}
async function closeAndFlush() {
    await act(async () => { pressHeaderClose(); });
}
async function editName(screen: Awaited<ReturnType<typeof renderProfileEditor>>, name = 'Edited profile') {
    const field = screen.findHostByTestId('profile-slim-name') ?? screen.findHostByTestId('profile-legacy-name');
    if (!field || typeof field.props.onChangeText !== 'function') throw new Error('Expected actual profile name input');
    await act(async () => field.props.onChangeText(name));
    expect(stackOptionsCapture.getResolved()?.headerRight?.()?.props.disabled).toBe(false);
}
async function chooseDecision(text: string) {
    const buttons = alertSpy.mock.calls.at(-1)?.[2];
    const button = buttons?.find((candidate) => candidate.text === text);
    if (!button?.onPress) throw new Error('Expected unsaved-changes decision: ' + text);
    await act(async () => { button.onPress?.(); });
}
function savedProfiles() {
    return storage.getState().settings.profiles;
}

describe('ProfileEditScreen (header buttons)', () => {
    it('renders a pristine close action through the real keyboard-aware form', async () => {
        const screen = await renderProfileEditor();
        const { KeyboardAwareScreen } = await import('@/components/ui/keyboardAvoidance');
        expect(screen.findAllByType(KeyboardAwareScreen)).toHaveLength(1);
        expect(typeof stackOptionsCapture.getResolved()?.headerLeft).toBe('function');
        await closeAndFlush();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(navigationMock.goBack).toHaveBeenCalledOnce();
    });

    it('disables the actual header save action while the form is pristine', async () => {
        await renderProfileEditor();
        expect(typeof stackOptionsCapture.getResolved()?.headerRight).toBe('function');
        expect(stackOptionsCapture.getResolved()?.headerRight?.()?.props.disabled).toBe(true);
    });

    it('serializes repeated dirty closes into one presented prompt and discarded continuation', async () => {
        const screen = await renderProfileEditor();
        await editName(screen);
        await act(async () => { pressHeaderClose(); pressHeaderClose(); });
        expect(alertSpy).toHaveBeenCalledOnce();
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        await chooseDecision('common.discard');
        expect(navigationMock.goBack).toHaveBeenCalledOnce();
        expect(savedProfiles()).toEqual([]);
    });

    it('keeps the dirty editor open after the presented keep-editing decision', async () => {
        const screen = await renderProfileEditor();
        await editName(screen);
        await closeAndFlush();
        expect(alertSpy).toHaveBeenCalledOnce();
        await chooseDecision('common.keepEditing');
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(savedProfiles()).toEqual([]);
    });

    it('lets a real successful save own the destination instead of continuing dirty close', async () => {
        const screen = await renderProfileEditor();
        await editName(screen);
        await closeAndFlush();
        await chooseDecision('common.save');
        expect(savedProfiles()).toEqual([expect.objectContaining({ id: 'p1', v: 2, name: 'Edited profile' })]);
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        expect(routerMock.replace).toHaveBeenCalledWith({ pathname: '/new', params: expect.objectContaining({ profileId: 'p1' }) });
    });

    it('saves a built-in as a new current profile through the same presented guard', async () => {
        const { DEFAULT_PROFILES, getBuiltInProfile } = await import('@/sync/domains/profiles/profileUtils');
        const builtIn = getBuiltInProfile(DEFAULT_PROFILES[0].id);
        if (!builtIn) throw new Error('Expected canonical built-in profile');
        profileData = JSON.stringify(builtIn);
        const screen = await renderProfileEditor();
        await editName(screen, 'Saved built-in copy');
        await closeAndFlush();
        expect(alertSpy.mock.calls.at(-1)?.[2]?.some((button) => button.text === 'common.saveAs')).toBe(true);
        await chooseDecision('common.saveAs');
        expect(savedProfiles()).toEqual([expect.objectContaining({ v: 2, name: 'Saved built-in copy' })]);
        const { readAiLaunchProfileCollection } = await import('@happier-dev/protocol');
        const entry = readAiLaunchProfileCollection(savedProfiles()).entries[0];
        if (!entry || entry.kind === 'opaque') throw new Error('Expected saved current profile');
        expect(entry.profile.id).not.toBe(builtIn.id);
        expect(getBuiltInProfile(builtIn.id)).toEqual(builtIn);
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        expect(routerMock.replace).toHaveBeenCalledWith({ pathname: '/new', params: expect.objectContaining({ profileId: entry.profile.id }) });
    });
});
