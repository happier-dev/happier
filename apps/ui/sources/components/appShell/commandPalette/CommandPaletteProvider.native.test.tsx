import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/sync/domains/settings/settings';
import type { UniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import type { WorkspaceSymbolSearchInput } from '@/components/appShell/search/workspaceSymbolSearchSource';
import { act } from 'react-test-renderer';

const buildCommandPaletteCommands = vi.hoisted(() => vi.fn(() => []));

const routerPushSpy = vi.hoisted(() => vi.fn());
const capturedNative = vi.hoisted(() => ({
    handlers: null as Record<string, (() => void) | undefined> | null,
    enabledWhenDisabledCommandIds: [] as readonly string[],
}));

const testState = vi.hoisted(() => ({
    segments: [] as string[],
    routeParams: {} as Record<string, string>,
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
    return createExpoRouterMock({ segments: () => testState.segments, params: () => testState.routeParams, router: { push: routerPushSpy } }).module;
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
    KeyboardShortcutProvider: ({ children, handlers, enabledWhenDisabledCommandIds }: React.PropsWithChildren<{
        handlers: Record<string, (() => void) | undefined>;
        enabledWhenDisabledCommandIds?: readonly string[];
    }>) => {
        capturedNative.handlers = handlers;
        capturedNative.enabledWhenDisabledCommandIds = enabledWhenDisabledCommandIds ?? [];
        return React.createElement('KeyboardShortcutProvider', null, children);
    },
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
// The same server feature seam, as the canonical decision the Workflows entry reads.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => null,
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
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    resetDesktopActivityOverlayPosition: vi.fn(async () => {}),
}));

vi.mock('@/components/settings/pets/petSettingsCommandEvents', () => ({
    requestCodexPetRefresh: vi.fn(),
}));

describe('CommandPaletteProvider native', () => {
    // Every case re-imports the provider after `vi.resetModules()`, and the provider's import graph
    // is one of the largest in the app. Warming the transform cache once here keeps that cost out
    // of whichever case happens to run first, which is what pushed it past the suite timeout on a
    // loaded machine.
    beforeAll(async () => {
        await import('./CommandPaletteProvider');
    }, 180_000);

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        testState.segments.splice(0);
        testState.routeParams = {};
    });

    it('opens the native Search route from the canonical commandPalette.open shortcut', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        // Same persisted command identity as web — no `search.open` id, no migration, and no
        // empty handler that silently swallows a hardware keyboard shortcut.
        capturedNative.handlers?.['commandPalette.open']?.();
        expect(routerPushSpy).toHaveBeenCalledWith({ pathname: '/search', params: {} });
        expect(capturedNative.enabledWhenDisabledCommandIds).toContain('commandPalette.open');
    });

    it('coalesces repeated native Search opens until the route lifecycle catches up', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        capturedNative.handlers?.['commandPalette.open']?.();
        capturedNative.handlers?.['commandPalette.open']?.();

        expect(routerPushSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps native symbols in invocation memory rather than the URL and clears them on route exit', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { useUniversalSearchRuntime } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
        let runtime: UniversalSearchRuntime | null = null;
        function Probe() { runtime = useUniversalSearchRuntime(); return <Child />; }
        const readRuntime = () => {
            if (!runtime) throw new Error('Search runtime is not mounted');
            return runtime;
        };
        const scope = { accountId: 'account-a', serverId: 'home-a', sessionId: null, machineId: 'machine-a', rootPath: '/repo' };
        const symbols: WorkspaceSymbolSearchInput = {
            target: { kind: 'workspaceFile', scope, path: 'src/a.ts', accountId: scope.accountId,
                serverId: scope.serverId, workspaceRefId: 'workspace-a', sessionId: null },
            resolverKey: 'native-holder', language: 'typescript', isDark: false, unavailableHint: 'Unavailable',
            getText: () => 'class PrivateUnsavedSymbol {}', flushPendingChange() {}, isCurrent: () => true,
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        };
        const element = <CommandPaletteProvider><Probe /></CommandPaletteProvider>;
        const screen = await renderScreen(element);
        await act(async () => { readRuntime().open(undefined, scope, { source: 'symbols', symbols }); });
        expect(readRuntime().routeSymbols).toBe(symbols);
        expect(routerPushSpy).toHaveBeenCalledWith({ pathname: '/search', params: {
            source: 'symbols', accountId: scope.accountId, serverId: scope.serverId,
            machineId: scope.machineId, rootPath: scope.rootPath,
        } });
        expect(JSON.stringify(routerPushSpy.mock.calls)).not.toContain('PrivateUnsavedSymbol');
        testState.segments = ['(app)', 'search'];
        await screen.update(<CommandPaletteProvider><Probe /></CommandPaletteProvider>);
        expect(readRuntime().routeSymbols).toBe(symbols);
        testState.segments = ['(app)', 'session', '[id]'];
        await screen.update(<CommandPaletteProvider><Probe /></CommandPaletteProvider>);
        expect(readRuntime().routeSymbols).toBeUndefined();
    });

    it.each(['machine', 'managed'] as const)('serializes an explicit %s scope instead of the ambient active Session', async (kind) => {
        testState.segments.push('(app)', 'session', '[id]');
        testState.routeParams = { id: 'ambient-session' };
        const { renderScreen } = await import('@/dev/testkit');
        const { useUniversalSearchRuntime } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
        const workspace = { v: 2 as const, kind: 'managed' as const, serverId: 'home-b', workspaceId: 'checkout', managedId: 'guest',
            controller: { machineId: 'machine-b', installationId: 'installation' }, rootPath: '/repo/b' };

        function ExplicitScopeOpener(): React.ReactElement {
            const search = useUniversalSearchRuntime();
            return React.createElement('ExplicitScopeOpener', {
                onPress: () => search.open('needle', {
                    accountId: 'account-b',
                    serverId: 'home-b',
                    sessionId: 'requested-session',
                    machineId: 'machine-b',
                    rootPath: '/repo/b',
                    ...(kind === 'managed' ? { workspace } : {}),
                }),
            });
        }

        const screen = await renderScreen(
            <CommandPaletteProvider><ExplicitScopeOpener /></CommandPaletteProvider>,
        );
        screen.findByType('ExplicitScopeOpener')?.props.onPress();

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/search',
            params: {
                q: 'needle',
                accountId: 'account-b',
                serverId: 'home-b',
                sessionId: 'requested-session',
                machineId: 'machine-b',
                rootPath: '/repo/b',
                ...(kind === 'managed' ? { workspace: JSON.stringify(workspace) } : {}),
            },
        });
        const { resolveUniversalSearchRouteInitialScope } = await import('@/components/appShell/search/universalSearchScope');
        expect(resolveUniversalSearchRouteInitialScope(routerPushSpy.mock.lastCall?.[0].params)).toMatchObject({
            accountId: 'account-b', serverId: 'home-b', machineId: 'machine-b', rootPath: '/repo/b',
            ...(kind === 'managed' ? { workspace } : {}),
        });
    });

    it('treats an explicit scope as complete and never fills its null fields from the ambient Session', async () => {
        testState.segments.push('(app)', 'session', '[id]');
        testState.routeParams = { id: 'ambient-session' };
        const { renderScreen } = await import('@/dev/testkit');
        const { useUniversalSearchRuntime } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        function ExplicitHomeOpener(): React.ReactElement {
            const search = useUniversalSearchRuntime();
            return React.createElement('ExplicitHomeOpener', {
                onPress: () => search.open('needle', {
                    accountId: 'account-b',
                    serverId: 'home-b',
                    sessionId: null,
                    machineId: null,
                    rootPath: null,
                }),
            });
        }

        const screen = await renderScreen(
            <CommandPaletteProvider><ExplicitHomeOpener /></CommandPaletteProvider>,
        );
        screen.findByType('ExplicitHomeOpener')?.props.onPress();

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/search',
            params: {
                q: 'needle',
                accountId: 'account-b',
                serverId: 'home-b',
            },
        });
    });

    it('does not stack another native Search route while Search is already active', async () => {
        testState.segments.push('(app)', 'search');
        const { renderScreen } = await import('@/dev/testkit');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        capturedNative.handlers?.['commandPalette.open']?.();

        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('leaves the shortcut uninstalled when the command palette setting is off', async () => {
        testState.settings = { ...testState.settings, commandPaletteEnabled: false };
        const { renderScreen } = await import('@/dev/testkit');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        expect(capturedNative.handlers?.['commandPalette.open']).toBeUndefined();
        testState.settings = { ...testState.settings, commandPaletteEnabled: true };
    });

    it('defers command construction to the native Universal Search route', async () => {
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
