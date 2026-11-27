import * as React from 'react';
import { StyleSheet } from 'react-native';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/settings/usage', params: {} }).module);
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@expo/vector-icons', async () =>
    (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const runtime = installSessionPaneRuntimeTestHarness();
const { UsageSettingsScreen } = await import('@/app/(app)/settings/usage');
const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { CurrentUiContextProvider } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { SessionCockpitChromeRegistryProvider, useSessionCockpitBottomChromeHeightSetter,
    useReportSessionCockpitFloatingBottomChromeHeight } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');

function MeasuredChrome(props: Readonly<{ bar: number; floating: number }>) {
    const setBar = useSessionCockpitBottomChromeHeightSetter();
    const reportFloating = useReportSessionCockpitFloatingBottomChromeHeight(true);
    React.useLayoutEffect(() => { setBar(props.bar); reportFloating(props.floating); }, [props.bar, props.floating, reportFloating, setBar]);
    return <UsageSettingsScreen />;
}

function scene(bar: number, floating: number) {
    return <runtime.Wrapper><MainAppTabStateProvider><CurrentUiContextProvider>
        <SessionCockpitChromeRegistryProvider><MeasuredChrome bar={bar} floating={floating} /></SessionCockpitChromeRegistryProvider>
    </CurrentUiContextProvider></MainAppTabStateProvider></runtime.Wrapper>;
}

it('keeps the Usage footer clear of the measured phone chrome and removes its room when chrome leaves', async () => {
    const screen = await renderScreen(scene(56, 44));
    const bottom = () => StyleSheet.flatten(screen.findByTestId('usage-page')!.props.contentContainerStyle).paddingBottom;
    expect(bottom()).toBe(32 + 56 + 44);
    await screen.update(scene(56, 80));
    expect(bottom()).toBe(32 + 56 + 80);
    await screen.update(scene(0, 0));
    expect(bottom()).toBe(32);
});
