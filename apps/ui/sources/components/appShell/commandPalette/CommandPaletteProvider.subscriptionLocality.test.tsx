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
    setRouteParams: null as null | ((params: Record<string, string>) => void),
    segments: [] as string[],
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
    const mock = createExpoRouterMock({
        router: { push: testState.routerPush },
        segments: () => testState.segments,
    });
    testState.setRouteParams = (params) => { mock.spies.setParams(params); };
    return mock.module;
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

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
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

// Runner transformation is not a user operation; the owner graph test covers cold imports.
await import('@/components/appShell/search/UniversalSearchModal');

describe('CommandPaletteProvider subscription locality', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        standardCleanup();
        testState.keyboardHandlers = null;
        testState.enabledFeatures.clear();
        testState.segments = [];
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

    it('does not re-render its app-shell consumers when route params change while the palette is closed', async () => {
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
        const handlersAfterMount = testState.keyboardHandlers;

        for (const serverId of ['server-a', 'server-b']) {
            await act(async () => { testState.setRouteParams!({ serverId }); });
        }

        // The runtime is open/build entry points, not route state: its consumers (the Sessions list,
        // quick-open empty state) must not render for a route change they cannot observe.
        expect(consumerRenders).toBe(rendersAfterMount);
        expect(testState.keyboardHandlers).toBe(handlersAfterMount);
    });

    it('builds commands for the switched Session while Expo still mirrors the previous one', async () => {
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
        const { CurrentRouteLocationProvider } = await import('@/components/appShell/workspace/currentRouteLocation');
        const { useUniversalSearchRuntime } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
        // Expo's mirror stays on /session/session-a; the workspace switched the same route pattern to session-b.
        testState.segments = ['(app)', 'session', '[id]'];
        testState.setRouteParams!({ id: 'session-a' });
        const location = { pathname: '/session/session-b', params: { id: 'session-b' } };
        let runtime: ReturnType<typeof useUniversalSearchRuntime> | null = null;
        function RuntimeReader() {
            runtime = useUniversalSearchRuntime();
            return null;
        }

        await renderScreen(<CurrentRouteLocationProvider value={location}>
            <CommandPaletteProvider><RuntimeReader /></CommandPaletteProvider>
        </CurrentRouteLocationProvider>);
        runtime!.buildCommands();

        expect(buildCommandPaletteCommandsSpy.mock.calls.at(-1)?.[0]).toMatchObject({ activeSessionId: 'session-b' });
    });

    it('refreshes the open palette with a session that arrives while it is open', async () => {
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);
        await act(async () => {
            await testState.keyboardHandlers?.['commandPalette.open']?.();
        });
        await act(async () => {
            testState.store!.setState({
                sessions: { late: { id: 'late', updatedAt: 3, metadata: { name: 'Late session', path: '/tmp/late' } } },
            });
        });

        const updates = vi.mocked(Modal.update).mock.calls.map((call) => call[1] as { commands?: Array<{ id: string }> });
        expect(updates.some((props) => props.commands?.some((command) => command.id === 'session-late'))).toBe(true);
    });

    it('republishes open palette commands only when the Sessions they list change', async () => {
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
        // Seven Sessions: the palette lists the five most recent. A busy Account streams the newest
        // one (its activity time moves, it stays first) and touches one outside the five.
        const sessionsAt = (tick: number, newestName = 'Session 7') => Object.fromEntries(
            Array.from({ length: 7 }, (_, index) => {
                const id = `s${index + 1}`;
                const updatedAt = id === 's7' ? 100 + tick : id === 's1' ? 1 + tick / 100 : index + 1;
                const name = id === 's7' ? newestName : `Session ${index + 1}`;
                return [id, { id, updatedAt, metadataVersion: tick, metadata: { name, path: `/tmp/${id}` } }];
            }),
        );
        await act(async () => { testState.store!.setState({ sessions: sessionsAt(0) }); });

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);
        await act(async () => {
            await testState.keyboardHandlers?.['commandPalette.open']?.();
        });
        const commandUpdates = () => vi.mocked(Modal.update).mock.calls
            .map((call) => call[1] as { commands?: Array<{ id: string; title: string }> })
            .filter((props) => props.commands);
        const updatesAfterOpen = commandUpdates().length;

        for (let tick = 1; tick <= 5; tick += 1) {
            await act(async () => { testState.store!.setState({ sessions: sessionsAt(tick) }); });
        }
        expect(commandUpdates().length - updatesAfterOpen).toBe(0);

        // A listed Session's title is real content: the open palette shows it.
        await act(async () => { testState.store!.setState({ sessions: sessionsAt(6, 'Renamed newest') }); });
        expect(commandUpdates().length - updatesAfterOpen).toBe(1);
        expect(commandUpdates().at(-1)!.commands!.find((command) => command.id === 'session-s7')?.title).toBe('Renamed newest');
    });
});
