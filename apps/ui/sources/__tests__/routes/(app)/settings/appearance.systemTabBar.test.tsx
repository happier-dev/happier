import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { act, standardCleanup } from '@/dev/testkit';
import { installOptionalNativeModuleForTests } from '@/dev/expoModulesCoreStub';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { renderSessionSettingsEntryView, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

const native = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' | 'web' }));
await vi.hoisted(async () => {
    const { installSessionSettingsEntryModuleMocks } = await import('./sessionSettingsEntryTestHelpers');
    installSessionSettingsEntryModuleMocks({
        reactNative: async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeNativeMock({ platformOS: 'ios' }, { Platform: { get OS() { return native.os; } } });
        },
        textModule: async () => ({
            ...(await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
            getLanguageNativeName: () => 'English', SUPPORTED_LANGUAGES: { en: true },
        }),
    });
});
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

const restore = installOptionalNativeModuleForTests('HappierWindowFoldMetrics', {});
afterAll(restore);
await initializeAuthRouteRuntimeForTests();
const { WindowFoldMetricsProvider } = await import('@/utils/platform/useWindowFoldMetrics');
const { WorkspaceRouteBody: AppearanceScreen } = await import('@/app/(app)/settings/appearance');

afterEach(() => { standardCleanup(); resetSessionSettingsEntryState(); native.os = 'ios'; });

describe('Appearance side-rail preference', () => {
    it('shows the searchable row only while iOS reports a rail edge, including with no fold division', async () => {
        const screen = await renderSessionSettingsEntryView(<WindowFoldMetricsProvider><AppearanceScreen /></WindowFoldMetricsProvider>);
        const find = () => screen.findByTestId('settings-appearance-systemTabBar-switch');
        expect(find()).toBeNull();
        const observer = screen.tree.findByType('HappierWindowFoldMetrics');
        const emit = async (verticalBarEdge: unknown) => {
            await act(async () => { observer.props.onMetricsChange({ nativeEvent: { width: 466, height: 678, divisions: [], verticalBarEdge } }); });
        };
        await emit('trailing');
        expect(find()).not.toBeNull();
        expect(screen.tree.findAll(node => node.props.setting?.anchor === 'appearance.systemTabBar').length).toBeGreaterThan(0);
        await emit(null);
        expect(find()).toBeNull();
        await emit('leading');
        expect(find()).not.toBeNull();
        native.os = 'android';
        await emit('trailing');
        expect(find()).toBeNull();
    });
});
