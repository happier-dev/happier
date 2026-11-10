import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

const routeState = vi.hoisted(() => ({ pathname: '/settings' }));

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => routeState.pathname }).module;
});

const { SettingsPageHeader } = await import('./SettingsPageHeader');

afterEach(() => {
    routeState.pathname = '/settings';
});

// Native QA 11-10: the Search sheet presented over Settings moved the URL to its own route and the page lost its title.
it('keeps its page title while a route outside Settings is presented over it', async () => {
    const screen = await renderScreen(<SettingsPageHeader alwaysShowTitle testID="header" description="before" />);
    expect(screen.getTextContent()).toContain(t('settings.title'));

    routeState.pathname = '/search';
    // A fresh render of the page under the presented route (a changed prop, so the memoized header renders again).
    await screen.update(<SettingsPageHeader alwaysShowTitle testID="header" description="after" />);
    expect(screen.getTextContent()).toContain("after");
    expect(screen.getTextContent()).toContain(t('settings.title'));
});
