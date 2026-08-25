import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { KeyboardShortcutHandlers } from '@/keyboard';
import type { Settings } from '@/sync/domains/settings/settings';

const testState = vi.hoisted(() => ({
    routerPush: vi.fn(),
    keyboardHandlers: null as KeyboardShortcutHandlers | null,
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
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: { push: testState.routerPush },
        segments: [],
    }).module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: vi.fn(async () => {}) }),
}));

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

vi.mock('zustand/react/shallow', () => ({
    useShallow: <T,>(selector: T) => selector,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
    useApplyLocalSettings: () => vi.fn(),
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
            testState.keyboardHandlers = handlers;
            return React.createElement('KeyboardShortcutProvider', null, children);
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

describe('CommandPaletteProvider keyboard shortcuts', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        testState.keyboardHandlers = null;
        testState.settings = {
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutOverridesV1: {
                'settings.open': [{ binding: 'Alt+S' }],
                'session.new': [{ binding: 'Alt+N' }],
            },
            keyboardShortcutDisabledCommandIdsV1: [],
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('routes configured settings and new-session shortcuts through root handlers', async () => {
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        testState.keyboardHandlers?.['settings.open']?.();
        testState.keyboardHandlers?.['session.new']?.();

        expect(testState.routerPush).toHaveBeenCalledWith('/settings');
        expect(testState.routerPush).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
    });
});
