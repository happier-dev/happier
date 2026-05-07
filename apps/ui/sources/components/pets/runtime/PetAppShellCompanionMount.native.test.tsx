import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { Settings } from '@/sync/domains/settings/settings';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

type PetNativeMountTestState = {
    account: {
        petsEnabled: boolean;
        petsSelectedPetRef: Settings['petsSelectedPetRef'];
    };
    local: Pick<LocalSettings, 'petsEnabledOverride' | 'petsSelectedPetOverride' | 'petsCompanionPosition'> & {
        petsCompanionSizeScale: number;
    };
};

const featureState = vi.hoisted(() => ({
    companion: { state: 'enabled' },
    sync: { state: 'disabled' },
}));
const settingsState = vi.hoisted((): PetNativeMountTestState => ({
    account: {
        petsEnabled: true,
        petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
    },
    local: {
        petsEnabledOverride: 'inherit',
        petsSelectedPetOverride: { kind: 'inherit' },
        petsCompanionSizeScale: 1,
        petsCompanionPosition: {
            schemaVersion: 1,
            surface: 'mobile-app-shell',
            normalizedX: 0.82,
            normalizedY: 0.72,
            lastViewport: null,
        },
    },
}));
const applyLocalSettingsSpy = vi.hoisted(() => vi.fn());
const hapticsSpy = vi.hoisted(() => vi.fn(async () => {}));
const dimensionsState = vi.hoisted(() => ({ width: 390, height: 844 }));
const safeAreaState = vi.hoisted(() => ({
    top: 59,
    right: 0,
    bottom: 34,
    left: 0,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(options: { ios?: T; android?: T; native?: T; default?: T }) =>
                options.ios ?? options.native ?? options.default ?? options.android,
        },
        useWindowDimensions: () => dimensionsState,
        AccessibilityInfo: {
            isReduceMotionEnabled: vi.fn(async () => false),
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
        Keyboard: {
            addListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => safeAreaState,
}));

vi.mock('expo-haptics', () => ({
    ImpactFeedbackStyle: { Light: 'light' },
    impactAsync: hapticsSpy,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => {
        if (featureId === 'pets.companion') return featureState.companion;
        if (featureId === 'pets.sync') return featureState.sync;
        return { state: 'disabled' };
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsSpy,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            ...actual,
            useSettings: () => ({
                ...settingsDefaults,
                ...settingsState.account,
            }),
            useLocalSettings: () => ({
                ...localSettingsDefaults,
                ...settingsState.local,
            }),
            useAllSessions: () => [],
        },
    });
});

describe('PetAppShellCompanionMount.native', () => {
    afterEach(() => {
        standardCleanup();
        applyLocalSettingsSpy.mockReset();
        hapticsSpy.mockClear();
        featureState.companion = { state: 'enabled' };
        featureState.sync = { state: 'disabled' };
        settingsState.account = {
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
        };
        settingsState.local = {
            petsEnabledOverride: 'inherit',
            petsSelectedPetOverride: { kind: 'inherit' },
            petsCompanionSizeScale: 1,
            petsCompanionPosition: {
                schemaVersion: 1,
                surface: 'mobile-app-shell',
                normalizedX: 0.82,
                normalizedY: 0.72,
                lastViewport: null,
            },
        };
    });

    it('renders the selected pet in the native app shell with safe-area-aware positioning', async () => {
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull();
        expect(screen.findByTestId('pet-app-shell-companion-sprite')?.props['data-pet-state']).toBe('idle');
        expect(screen.root.findAllByType('SkiaImage')[0]?.props.image).toBe(
            `skia-image:${String(resolveBuiltInPetPackage('milo').spritesheetSource)}`,
        );
        const rootStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        expect(rootStyle).toEqual(expect.objectContaining({
            position: 'absolute',
            left: 0,
            top: 0,
        }));
        expect(rootStyle.transform[0].translateX).toBeCloseTo(236.68, 2);
        expect(rootStyle.transform[1].translateY).toBeCloseTo(522.68, 2);
    });

    it('applies the local companion size scale to native root and sprite dimensions', async () => {
        settingsState.local = {
            ...settingsState.local,
            petsCompanionSizeScale: 1.5,
        };
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        const rootStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        const spriteStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-sprite')?.props.style);

        expect(rootStyle.width).toBeCloseTo(138, 4);
        expect(rootStyle.height).toBeCloseTo(149.5, 4);
        expect(spriteStyle.width).toBeCloseTo(138, 4);
        expect(spriteStyle.height).toBeCloseTo(149.5, 4);
    });

    it('persists normalized position and fires light haptics only for tap without drag', async () => {
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');
        const screen = await renderScreen(<PetAppShellCompanionMount />);
        const gesture = screen.root.findByType('GestureDetector').props.gesture;

        await act(async () => {
            gesture.__handlers.onBegin?.({
                absoluteX: 120,
                absoluteY: 200,
                translationX: 0,
                translationY: 0,
                velocityX: 0,
                velocityY: 0,
            });
            gesture.__handlers.onUpdate?.({
                absoluteX: 20,
                absoluteY: 400,
                translationX: -999,
                translationY: 999,
                velocityX: -900,
                velocityY: 200,
            });
            gesture.__handlers.onEnd?.({
                absoluteX: 20,
                absoluteY: 400,
                translationX: -999,
                translationY: 999,
                velocityX: -900,
                velocityY: 200,
            }, true);
        });

        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsCompanionPosition: expect.objectContaining({
                schemaVersion: 1,
                surface: 'mobile-app-shell',
                normalizedX: 0,
                normalizedY: 1,
            }),
        });
        expect(hapticsSpy).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('pet-app-shell-companion-hitbox');
        expect(hapticsSpy).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('pet-app-shell-companion-hitbox');

        expect(hapticsSpy).toHaveBeenCalledWith('light');
        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('jumping');
    });

    it('can enable the native companion after an initially disabled render', async () => {
        featureState.companion = { state: 'disabled' };
        settingsState.account.petsEnabled = false;
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');

        const screen = await renderScreen(<PetAppShellCompanionMount />);
        expect(screen.findByTestId('pet-app-shell-companion-root')).toBeNull();

        featureState.companion = { state: 'enabled' };
        settingsState.account.petsEnabled = true;
        await act(async () => {
            screen.tree.update(<PetAppShellCompanionMount />);
        });

        expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull();
    });
});
