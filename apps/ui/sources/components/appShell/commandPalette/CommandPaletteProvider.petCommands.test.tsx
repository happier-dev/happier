import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PetCommandControls } from './buildCommandPaletteCommands';
import type { KeyboardShortcutHandlers } from '@/keyboard';

const applySettingsMock = vi.hoisted(() => vi.fn());
const applyLocalSettingsMock = vi.hoisted(() => vi.fn());
const resetDesktopActivityOverlayPositionMock = vi.hoisted(() => vi.fn(async () => {}));
const captured = vi.hoisted(() => ({
    petControls: null as PetCommandControls | null,
    shortcutLabelHandlers: null as KeyboardShortcutHandlers | null,
    keyboardHandlers: null as KeyboardShortcutHandlers | null,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSegments: () => [],
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: vi.fn(async () => {}) }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: Object.assign(
        (selector: (state: unknown) => unknown) => selector({
            sessions: {},
            settings: { commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled: false, keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: [] },
        }),
        {
            getState: () => ({
                sessions: {},
                settings: { commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled: false, keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: [] },
            }),
        },
    ),
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

vi.mock('@/modal', () => ({
    Modal: {
        alertAsync: vi.fn(async () => {}),
        show: vi.fn(),
    },
}));

vi.mock('@/keyboard', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/keyboard')>();
    return {
        ...actual,
        KeyboardShortcutProvider: ({ children, handlers }: React.PropsWithChildren<{
            handlers: KeyboardShortcutHandlers;
        }>) => {
            captured.keyboardHandlers = handlers;
            return React.createElement('KeyboardShortcutProvider', null, children);
        },
        buildKeyboardShortcutLabels: (
            platform: Parameters<typeof actual.buildKeyboardShortcutLabels>[0],
            surface: Parameters<typeof actual.buildKeyboardShortcutLabels>[1],
            options: NonNullable<Parameters<typeof actual.buildKeyboardShortcutLabels>[2]>,
        ) => {
            captured.shortcutLabelHandlers = options.handlers ?? null;
            return actual.buildKeyboardShortcutLabels(platform, surface, options);
        },
    };
});

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
        captured.shortcutLabelHandlers = null;
        captured.keyboardHandlers = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('wakes and tucks the Dev activity overlay companion through the pet-specific overlay override', async () => {
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);
        captured.keyboardHandlers?.['commandPalette.open']?.();

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

    it('computes command-palette row shortcut labels from active command handlers', async () => {
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        expect(captured.shortcutLabelHandlers?.['session.new']).toEqual(expect.any(Function));
        expect(captured.shortcutLabelHandlers?.['settings.open']).toEqual(expect.any(Function));
    });
});
