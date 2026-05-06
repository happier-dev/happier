import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PetCommandControls } from './buildCommandPaletteCommands';

const applySettingsMock = vi.hoisted(() => vi.fn());
const applyLocalSettingsMock = vi.hoisted(() => vi.fn());
const resetDesktopActivityOverlayPositionMock = vi.hoisted(() => vi.fn(async () => {}));
const captured = vi.hoisted(() => ({
    petControls: null as PetCommandControls | null,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSegments: () => [],
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: vi.fn(async () => {}) }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: (selector: (state: unknown) => unknown) => selector({
        sessions: {},
        localSettings: { commandPaletteEnabled: true },
    }),
}));

vi.mock('zustand/react/shallow', () => ({
    useShallow: <T,>(selector: T) => selector,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'pets.companion',
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    resetDesktopActivityOverlayPosition: resetDesktopActivityOverlayPositionMock,
}));

vi.mock('@/components/settings/pets/petSettingsCommandEvents', () => ({
    requestCodexPetRefresh: vi.fn(),
}));

vi.mock('@/hooks/ui/useGlobalKeyboard', () => ({
    useGlobalKeyboard: () => {},
}));

vi.mock('@/modal', () => ({
    Modal: {
        alertAsync: vi.fn(async () => {}),
        show: vi.fn(),
    },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: vi.fn(async () => ({ ok: true, result: {} })),
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => null,
}));

vi.mock('./buildCommandPaletteCommands', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./buildCommandPaletteCommands')>();
    return {
        ...actual,
        buildCommandPaletteCommands: (input: Parameters<typeof actual.buildCommandPaletteCommands>[0]) => {
            captured.petControls = input.petControls ?? null;
            return [];
        },
    };
});

describe('CommandPaletteProvider pet commands', () => {
    beforeEach(() => {
        applySettingsMock.mockClear();
        applyLocalSettingsMock.mockClear();
        resetDesktopActivityOverlayPositionMock.mockClear();
        captured.petControls = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('wakes and tucks the Dev activity overlay companion through the pet-specific overlay override', async () => {
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        captured.petControls?.wake();
        captured.petControls?.tuck();

        expect(applySettingsMock).toHaveBeenCalledWith({ petsEnabled: true });
        expect(applyLocalSettingsMock).toHaveBeenNthCalledWith(1, {
            petsEnabledOverride: 'enabled',
            desktopPetOverlayEnabledOverride: 'enabled',
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'always_when_enabled',
        });
        expect(applyLocalSettingsMock).toHaveBeenNthCalledWith(2, {
            desktopPetOverlayEnabledOverride: 'disabled',
            desktopOverlayEnabled: false,
        });
    });
});
