import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PetCommandControls } from './buildCommandPaletteCommands';
import type { KeyboardShortcutHandlers } from '@/keyboard';
import type { Settings } from '@/sync/domains/settings/settings';
import { CommandPaletteProvider } from './CommandPaletteProvider';

const applySettingsMock = vi.hoisted(() => vi.fn());
const applyLocalSettingsMock = vi.hoisted(() => vi.fn());
const resetDesktopActivityOverlayPositionMock = vi.hoisted(() => vi.fn(async () => {}));
const captured = vi.hoisted(() => ({
    petControls: null as PetCommandControls | null,
    shortcutLabelHandlers: null as KeyboardShortcutHandlers | null,
    keyboardHandlers: null as KeyboardShortcutHandlers | null,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ segments: [] }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: vi.fn(async () => {}) }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const settings: Settings = {
        ...settingsDefaults,
        commandPaletteEnabled: true,
        keyboardShortcutsV2Enabled: true,
        keyboardSingleKeyShortcutsEnabled: false,
        keyboardShortcutOverridesV1: {},
        keyboardShortcutDisabledCommandIdsV1: [],
    };
    const readSnapshot = () => ({ sessions: {}, settings });
    const storage = Object.assign(
        ((selector?: (state: ReturnType<typeof readSnapshot>) => unknown) => {
            const snapshot = readSnapshot();
            return typeof selector === 'function' ? selector(snapshot) : snapshot;
        }),
        {
            getState: readSnapshot,
            getInitialState: readSnapshot,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    );
    return createStorageModuleStub({ storage });
});

vi.mock('zustand/react/shallow', () => ({
    useShallow: <T,>(selector: T) => selector,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'pets.companion',
}));
// The same server feature seam, as the canonical decision the Workflows entry reads.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => null,
}));

vi.mock('@/sync/store/settingsWriters', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/store/settingsWriters')>(),
    // Keep the real scope reader; these two probes preserve the pet write-intent assertions.
    useApplySettings: () => applySettingsMock,
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => true,
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    resetDesktopActivityOverlayPosition: resetDesktopActivityOverlayPositionMock,
}));

vi.mock('@/components/settings/pets/petSettingsCommandEvents', () => ({
    requestCodexPetRefresh: vi.fn(),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

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
            _platform: Parameters<typeof actual.buildKeyboardShortcutLabels>[0],
            _surface: Parameters<typeof actual.buildKeyboardShortcutLabels>[1],
            options: NonNullable<Parameters<typeof actual.buildKeyboardShortcutLabels>[2]>,
        ) => {
            captured.shortcutLabelHandlers = options.handlers ?? null;
            return {};
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

// Runner transformation is not a user operation; the owner graph test covers cold imports.
await import('@/components/appShell/search/UniversalSearchModal');

describe('CommandPaletteProvider pet commands', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);
        await act(async () => { await captured.keyboardHandlers?.['commandPalette.open']?.(); });

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
        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        expect(captured.shortcutLabelHandlers?.['session.new']).toEqual(expect.any(Function));
        expect(captured.shortcutLabelHandlers?.['settings.open']).toEqual(expect.any(Function));
    });
});
