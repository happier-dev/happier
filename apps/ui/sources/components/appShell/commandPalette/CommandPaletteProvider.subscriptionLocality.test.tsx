import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { KeyboardShortcutHandlers } from '@/keyboard';
import type { Settings } from '@/sync/domains/settings/settings';

const testState = vi.hoisted(() => ({
    routerPush: vi.fn(),
    keyboardHandlers: null as KeyboardShortcutHandlers | null,
    sessions: {} as Record<string, unknown>,
    store: null as null | { setState: (partial: Record<string, unknown>) => void; getState: () => Record<string, unknown> },
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
    const { create } = await import('zustand');
    // A real zustand store: a session update notifies subscribers exactly as the app store does,
    // so a component that selects `sessions` re-renders and one that does not, does not.
    const storage = create(() => ({
        sessions: {} as Record<string, unknown>,
        settings: { ...settingsDefaults, ...testState.settings },
    }));
    testState.store = storage;
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
// The same server feature seam, as the canonical decision the Workflows entry reads.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => (testState.enabledFeatures.has(featureId) ? { state: 'enabled' } : null),
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
    desktopHostKind: () => null,
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

describe('CommandPaletteProvider subscription locality', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        standardCleanup();
        testState.keyboardHandlers = null;
        testState.enabledFeatures.clear();
    });

    it('does not re-render its app-shell consumers when sessions change while the palette is closed', async () => {
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
        const { useUniversalSearchRuntime } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
        let consumerRenders = 0;
        function RailLikeConsumer() {
            useUniversalSearchRuntime();
            consumerRenders += 1;
            return null;
        }

        await renderScreen(<CommandPaletteProvider><RailLikeConsumer /></CommandPaletteProvider>);
        const rendersAfterMount = consumerRenders;

        for (let tick = 1; tick <= 3; tick += 1) {
            await act(async () => {
                testState.store!.setState({
                    sessions: { live: { id: 'live', updatedAt: tick, metadataVersion: tick, metadata: { name: 'Live', path: '/tmp/live' } } },
                });
            });
        }

        expect(consumerRenders).toBe(rendersAfterMount);
    });

    it('refreshes the open palette with a session that arrives while it is open', async () => {
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);
        await act(async () => {
            testState.keyboardHandlers?.['commandPalette.open']?.();
        });
        await act(async () => {
            testState.store!.setState({
                sessions: { late: { id: 'late', updatedAt: 3, metadata: { name: 'Late session', path: '/tmp/late' } } },
            });
        });

        const updates = vi.mocked(Modal.update).mock.calls.map((call) => call[1] as { commands?: Array<{ id: string }> });
        expect(updates.some((props) => props.commands?.some((command) => command.id === 'session-late'))).toBe(true);
    });
});
