import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ThemePreferenceTransitionHost } from './ThemePreferenceTransitionHost.native';
import { runThemePreferenceChange } from './themePreferenceTransition';

const screenshot = vi.hoisted(() => ({
    captureFile: vi.fn(async () => 'file://theme-before.png'),
    image: { dispose: vi.fn(), width: () => 80, height: () => 60 },
}));
// Both native screenshot APIs are OS boundaries. The previous file-writing path
// must stay unused even though its mock succeeds.
vi.mock('react-native-view-shot', () => ({ captureRef: screenshot.captureFile, releaseCapture: vi.fn() }));
vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    makeImageFromView: async () => screenshot.image,
}));
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({ settleTimingCallbacks: true }));
afterEach(() => { vi.useRealTimers(); });

it('keeps the native pre-auth wipe and chooses Horizon only after sign-in, without remounting the host', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const credentials = { token: 'test-token', secret: 'test-secret' };
    const element = (signedIn: boolean) => <InjectedAuthProvider credentials={signedIn ? credentials : null}>
        <ThemePreferenceTransitionHost><>{'app-content'}</></ThemePreferenceTransitionHost>
    </InjectedAuthProvider>;
    const screen = await renderScreen(element(false), { createNodeMock: () => ({}) });
    const change = () => runThemePreferenceChange({ currentPreference: 'light', nextPreference: 'dark',
        platform: 'ios', reduceMotion: false, systemTheme: 'light', mutation() {} });
    const pending = change();
    await flushHookEffects();
    expect(screenshot.captureFile).not.toHaveBeenCalled();
    expect(screen.findAll(node => node.props.image === screenshot.image).length).toBeGreaterThan(0);
    await act(async () => { vi.advanceTimersByTime(32); });
    await pending;
    expect(screenshot.image.dispose).toHaveBeenCalled();
    await screen.update(element(true));
    const authenticated = change();
    await flushHookEffects();
    expect(screen.findAllByType('Picture').length).toBeLessThanOrEqual(1);
    await act(async () => { vi.advanceTimersByTime(32); });
    await screen.unmount();
    await authenticated;
});
