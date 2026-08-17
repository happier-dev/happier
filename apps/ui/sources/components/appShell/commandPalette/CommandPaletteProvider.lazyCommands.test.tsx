import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { KeyboardShortcutHandlers } from '@/keyboard';
import type { Settings } from '@/sync/domains/settings/settings';

const testState = vi.hoisted(() => ({
    routerPush: vi.fn(),
    keyboardHandlers: null as KeyboardShortcutHandlers | null,
    sessions: {} as Record<string, unknown>,
    enabledFeatures: new Set<string>(),
    settings: {
        commandPaletteEnabled: true,
        keyboardShortcutsV2Enabled: true,
        keyboardSingleKeyShortcutsEnabled: false,
        keyboardShortcutOverridesV1: {},
        keyboardShortcutDisabledCommandIdsV1: [],
    } as Partial<Settings>,
}));

const buildCommandPaletteCommandsSpy = vi.hoisted(() => vi.fn());

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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const readSnapshot = () => ({
        sessions: testState.sessions,
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

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => testState.enabledFeatures.has(featureId),
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

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    resetDesktopActivityOverlayPosition: vi.fn(async () => {}),
}));

vi.mock('@/components/settings/pets/petSettingsCommandEvents', () => ({
    requestCodexPetRefresh: vi.fn(),
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

vi.mock('./buildCommandPaletteCommands', async () => {
    const actual = await vi.importActual<typeof import('./buildCommandPaletteCommands')>('./buildCommandPaletteCommands');
    return {
        ...actual,
        buildCommandPaletteCommands: ((params: Parameters<typeof actual.buildCommandPaletteCommands>[0]) => {
            buildCommandPaletteCommandsSpy(params);
            return actual.buildCommandPaletteCommands(params);
        }) satisfies typeof actual.buildCommandPaletteCommands,
    };
});

describe('CommandPaletteProvider lazy command building', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        standardCleanup();
        testState.routerPush.mockClear();
        testState.keyboardHandlers = null;
        testState.sessions = {};
        testState.enabledFeatures.clear();
        testState.settings = {
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutOverridesV1: {},
            keyboardShortcutDisabledCommandIdsV1: [],
        };
    });

    it('builds command entries only when the palette opens', async () => {
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        expect(buildCommandPaletteCommandsSpy).not.toHaveBeenCalled();

        testState.keyboardHandlers?.['commandPalette.open']?.();

        expect(buildCommandPaletteCommandsSpy).toHaveBeenCalledTimes(1);
        expect(Modal.show).toHaveBeenCalledTimes(1);
    });

    it('uses the latest sessions when opening after a closed-state session update', async () => {
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        testState.sessions = {
            'session-late': {
                id: 'session-late',
                updatedAt: 3,
                metadata: { name: 'Late session', path: '/tmp/late-session' },
            },
        };

        testState.keyboardHandlers?.['commandPalette.open']?.();

        const showProps = vi.mocked(Modal.show).mock.calls[0]?.[0]?.props as { commands?: Array<{ id: string }> } | undefined;
        expect(showProps?.commands?.some((command) => command.id === 'session-session-late')).toBe(true);
    });

    it('opens the canonical Browse Existing Sessions compact destination from the web palette', async () => {
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
        testState.enabledFeatures.add('sessions.direct');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        testState.keyboardHandlers?.['commandPalette.open']?.();

        const showProps = vi.mocked(Modal.show).mock.calls[0]?.[0]?.props as {
            commands?: Array<{ id: string; action: () => void | Promise<void> }>;
        } | undefined;
        const browse = showProps?.commands?.find((command) => (
            command.id === 'app-destination:browseExistingSessions'
        ));
        expect(browse).toBeTruthy();

        await browse!.action();
        expect(testState.routerPush).toHaveBeenCalledWith('/external/browse');
    });
});
