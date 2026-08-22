import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/sync/domains/settings/settings';

const buildCommandPaletteCommands = vi.hoisted(() => vi.fn(() => []));

const testState = vi.hoisted(() => ({
    settings: {
        commandPaletteEnabled: true,
        keyboardShortcutsV2Enabled: true,
        keyboardSingleKeyShortcutsEnabled: false,
        keyboardShortcutOverridesV1: {},
        keyboardShortcutDisabledCommandIdsV1: [],
    } as Partial<Settings>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ segments: [] }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const readSnapshot = () => ({
        sessions: {},
        settings: {
            ...settingsDefaults,
            ...testState.settings,
        },
    });
    const storage = Object.assign(
        ((selector?: (value: ReturnType<typeof readSnapshot>) => unknown) => {
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

vi.mock('@/keyboard', () => ({
    KeyboardShortcutProvider: ({ children }: React.PropsWithChildren<{
        handlers: Record<string, unknown>;
    }>) => React.createElement('KeyboardShortcutProvider', null, children),
    buildKeyboardShortcutLabels: vi.fn(() => ({})),
    resolveKeyboardPlatform: vi.fn(() => 'mac'),
}));

vi.mock('./buildCommandPaletteCommands', async () => {
    const actual = await vi.importActual<typeof import('./buildCommandPaletteCommands')>('./buildCommandPaletteCommands');
    return {
        ...actual,
        buildCommandPaletteCommands,
    };
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: vi.fn(async () => ({ ok: true, result: {} })),
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => null,
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => vi.fn(),
    useApplySettings: () => vi.fn(),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => false,
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    resetDesktopActivityOverlayPosition: vi.fn(async () => {}),
}));

vi.mock('@/components/settings/pets/petSettingsCommandEvents', () => ({
    requestCodexPetRefresh: vi.fn(),
}));

describe('CommandPaletteProvider native', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('does not build web command-palette commands on native render', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        expect(buildCommandPaletteCommands).not.toHaveBeenCalled();
    });
});

function Child() {
    return React.createElement('Child');
}
