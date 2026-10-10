import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit/render/renderScreen';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import {
    SessionCockpitChromeRegistryProvider,
    useSessionCockpitPetRect,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
// Collect the production graphs before the interaction budget starts. Neither owner is mocked.
import { PetAppShellCompanionMount as WebPetMount } from './PetAppShellCompanionMount';
import { PetAppShellCompanionMount as NativePetMount } from './PetAppShellCompanionMount.native';

const host = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web', width: 390, height: 844 }));

// Physical platform, viewport and lifecycle facts are the external React Native boundary.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: {
            get OS() { return host.os; },
            select: <T,>(options: { ios?: T; web?: T; native?: T; default?: T }) =>
                host.os === 'web' ? options.web ?? options.default : options.ios ?? options.native ?? options.default,
        },
        useWindowDimensions: () => ({ width: host.width, height: host.height, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ width: host.width, height: host.height, scale: 1, fontScale: 1 }) },
        AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    });
});

vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-haptics', () => ({
    ImpactFeedbackStyle: { Light: 'light' },
    impactAsync: async () => {},
}));

function PetRectProbe() {
    const selected = useSelectedPetPackage();
    const rect = useSessionCockpitPetRect();
    return <>
        <View testID="measured-pet-selection" accessibilityValue={{ text: JSON.stringify(selected) }} />
        <View testID="measured-pet-rect" accessibilityValue={{ text: JSON.stringify(rect) }} />
    </>;
}

function readRect(screen: Awaited<ReturnType<typeof renderScreen>>): FrameRect | null {
    return JSON.parse(screen.findByTestId('measured-pet-rect')!.props.accessibilityValue.text);
}

function expectEnabledBuiltIn(screen: Awaited<ReturnType<typeof renderScreen>>) {
    expect(JSON.parse(screen.findByTestId('measured-pet-selection')!.props.accessibilityValue.text)).toEqual({
        enabled: true, source: { kind: 'builtIn', petId: 'milo' }, fallback: null,
    });
}

const initialStorageState = storage.getState();

beforeEach(async () => {
    host.os = 'ios';
    host.width = 390;
    host.height = 844;
    await upsertAndActivateServer({ serverUrl: 'https://measured-pet-home', scope: 'tab' });
    resetServerFeaturesClientForTests();
    // A genuine Home response feeds the real feature owner; companion is client-represented.
    primeServerFeaturesSnapshot({ snapshot: {
        status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }),
    } });
    storage.setState({
        settings: { ...settingsDefaults, experiments: true,
            featureToggles: { ...settingsDefaults.featureToggles, 'pets.companion': true },
            petsEnabled: true, petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
        },
        localSettings: { ...localSettingsDefaults,
            petsCompanionPosition: { schemaVersion: 1, surface: 'mobile-app-shell',
                normalizedX: 0.82, normalizedY: 0.72, lastViewport: null },
        },
        isDataReady: true,
        sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
        sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
        sessionMessages: {}, sessionPending: {}, accountPetsById: {}, localPetSourcesBySourceKey: {},
    });
});

afterEach(() => {
    standardCleanup();
    storage.setState(initialStorageState, true);
    resetServerFeaturesClientForTests();
    vi.unstubAllGlobals();
});

describe('PetAppShellCompanionMount.native', () => {
    it('publishes its settled measured rectangle without feeding pointer samples to the shell', async () => {
        const screen = await renderScreen(<SessionCockpitChromeRegistryProvider>
            <NativePetMount /><PetRectProbe />
        </SessionCockpitChromeRegistryProvider>);
        try {
            expectEnabledBuiltIn(screen);
            const resting = readRect(screen)!;
            expect(resting.width).toBe(92);
            expect(resting.x).toBeCloseTo(236.68, 2);
            const gesture = screen.root.findByType('GestureDetector').props.gesture;
            await act(async () => {
                gesture.__handlers.onBegin({ absoluteX: 120, absoluteY: 200 });
                gesture.__handlers.onUpdate({ translationX: -999, translationY: 999 });
            });
            expect(readRect(screen)).toEqual(resting);
            await act(async () => {
                gesture.__handlers.onEnd({ translationX: -999, translationY: 999, velocityX: 0, velocityY: 0 }, true);
            });
            expect(readRect(screen)!.x).toBeLessThan(resting.x);
            expect(readRect(screen)!.y).toBeGreaterThan(resting.y);
            expect(storage.getState().localSettings.petsCompanionPosition?.normalizedX).toBe(0);
            await act(async () => {
                storage.getState().applyLocalSettings({ petsCompanionPosition: {
                    schemaVersion: 1, surface: 'mobile-app-shell', normalizedX: 1, normalizedY: 0, lastViewport: null,
                } });
            });
            const restoredStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-root')!.props.style);
            expect(readRect(screen)!.x).toBeCloseTo(restoredStyle.transform[0].translateX, 6);
            expect(readRect(screen)!.y).toBeCloseTo(restoredStyle.transform[1].translateY, 6);
            const restored = readRect(screen)!;
            const resumedGesture = screen.root.findByType('GestureDetector').props.gesture;
            await act(async () => {
                resumedGesture.__handlers.onBegin({ absoluteX: restored.x + 5, absoluteY: restored.y + 5 });
                resumedGesture.__handlers.onUpdate({ translationX: -20, translationY: 30 });
            });
            expect(readRect(screen)).toEqual(restored);
            await act(async () => {
                // RNGH2 sends active cancellation through onEnd(event, false), then onFinalize.
                const event = { translationX: -20, translationY: 30, velocityX: 0, velocityY: 0 };
                resumedGesture.__handlers.onEnd(event, false);
                resumedGesture.__handlers.onFinalize(event, false);
            });
            const cancelledStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-root')!.props.style);
            expect(readRect(screen)!.x).toBeLessThan(restored.x);
            expect(readRect(screen)!.y).toBeGreaterThan(restored.y);
            expect(readRect(screen)!.x).toBeCloseTo(cancelledStyle.transform[0].translateX, 6);
            expect(readRect(screen)!.y).toBeCloseTo(cancelledStyle.transform[1].translateY, 6);
            expect(storage.getState().localSettings.petsCompanionPosition?.normalizedX).toBeLessThan(1);
            await act(async () => {
                storage.setState((state) => ({ settings: { ...state.settings,
                    featureToggles: { ...state.settings.featureToggles, 'pets.companion': false },
                } }));
            });
            expect(readRect(screen)).toBeNull();
            expect(JSON.parse(screen.findByTestId('measured-pet-selection')!.props.accessibilityValue.text)).toEqual({
                enabled: false, source: null,
                fallback: { reason: 'companion_feature_disabled', shouldPersist: false },
            });
        } finally { await screen.unmount(); }
    });
});

describe('PetAppShellCompanionMount', () => {
    it('keeps web drag movement bounded to the app shell viewport', async () => {
        host.os = 'web';
        host.width = 320;
        host.height = 260;
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
            constructor(type: string, init: { clientX: number; clientY: number }) {
                super(type);
                this.clientX = this.screenX = init.clientX;
                this.clientY = this.screenY = init.clientY;
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const scene = (visible: boolean) => <SessionCockpitChromeRegistryProvider>
            {visible ? <WebPetMount /> : null}<PetRectProbe />
        </SessionCockpitChromeRegistryProvider>;
        const screen = await renderScreen(scene(true));
        try {
            expectEnabledBuiltIn(screen);
            const resting = readRect(screen)!;
            expect(resting).toEqual(expect.objectContaining({ x: 204, width: 92 }));
            expect(resting.y).toBeCloseTo(136.3333, 3);
            expect(resting.height).toBeCloseTo(99.6667, 3);
            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('pet-app-shell-companion-hitbox'), 'onPointerDown', {
                    button: 0, clientX: 220, clientY: 180, screenX: 220, screenY: 180,
                    target: { closest: (selector: string) => selector.includes('data-pet-mascot') ? {} : null },
                    preventDefault: () => {}, stopPropagation: () => {},
                });
                fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', { clientX: -200, clientY: -200 }));
            });
            const rootStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-root')!.props.style);
            expect(rootStyle.transform).toEqual([{ translateX: -180 }, { translateY: -112.33333333333333 }]);
            expect(screen.findByTestId('pet-companion-state')!.props['data-pet-state']).toBe('running-left');
            expect(readRect(screen)).toEqual(resting);
            await act(async () => {
                fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', { clientX: -200, clientY: -200 }));
            });
            expect(readRect(screen)!.x).toBeCloseTo(24, 6);
            expect(readRect(screen)!.y).toBeCloseTo(24, 6);
            await screen.update(scene(false));
            expect(readRect(screen)).toBeNull();
        } finally { await screen.unmount(); }
    });
});
