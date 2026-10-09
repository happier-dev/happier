import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { KeyboardShortcutHandlers } from '@/keyboard';
import type { Settings } from '@/sync/domains/settings/settings';
import { CommandPaletteProvider } from './CommandPaletteProvider';
import { executeCommandPaletteAction } from './commandPaletteActionRuntime';

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

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => false,
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

    it('lets a mounted Action invoke the same account navigation without opening the palette', async () => {
        const screen = await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);
        await expect(executeCommandPaletteAction({
            actionId: 'ui.command_palette.invoke', input: { commandId: 'account' }, context: { surface: 'agent' },
        })).resolves.toEqual({ ok: true, result: { invoked: true } });
        expect(testState.routerPush).toHaveBeenCalledWith('/settings/account');
        await act(async () => { screen.unmount(); });
        await expect(executeCommandPaletteAction({
            actionId: 'ui.command_palette.list', input: {}, context: { surface: 'agent' },
        })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    });

    it('offers Ask Happier through the mounted manual command catalog without starting a Session', async () => {
        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);
        const listing = await executeCommandPaletteAction({
            actionId: 'ui.command_palette.list', input: {}, context: { surface: 'agent' },
        });
        expect(listing).toMatchObject({
            ok: true, result: { commands: expect.arrayContaining([expect.objectContaining({ id: 'askHappier' })]) },
        });
        expect(testState.routerPush).not.toHaveBeenCalled();
    });

    it('offers phone pairing in Search and invokes the same modal through the palette Action', async () => {
        const { Modal } = await import('@/modal');
        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        const listing = await executeCommandPaletteAction({
            actionId: 'ui.command_palette.list', input: {}, context: { surface: 'agent' },
        });
        expect(listing).toMatchObject({
            ok: true, result: { commands: expect.arrayContaining([expect.objectContaining({ id: 'add-phone' })]) },
        });

        await expect(executeCommandPaletteAction({
            actionId: 'ui.command_palette.invoke', input: { commandId: 'add-phone' }, context: { surface: 'agent' },
        })).resolves.toEqual({ ok: true, result: { invoked: true } });
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ purpose: 'phone' }),
            chrome: expect.objectContaining({ kind: 'card', header: 'none' }),
        }));
        expect(testState.routerPush).not.toHaveBeenCalled();
    });

    it('keeps repeated web open requests on the existing Search modal', async () => {
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(<CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>);

        testState.keyboardHandlers?.['commandPalette.open']?.();
        testState.keyboardHandlers?.['commandPalette.open']?.();

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

    it('builds web commands for the explicitly requested Session instead of ambient context', async () => {
        const { useUniversalSearchRuntime } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        function ExplicitScopeOpener(): React.ReactElement {
            const search = useUniversalSearchRuntime();
            return React.createElement('ExplicitScopeOpener', {
                onPress: () => search.open('needle', {
                    accountId: 'account-b',
                    serverId: 'home-b',
                    sessionId: 'requested-session',
                    machineId: 'machine-b',
                    rootPath: '/repo/b',
                }),
            });
        }

        const screen = await renderScreen(
            <CommandPaletteProvider><ExplicitScopeOpener /></CommandPaletteProvider>,
        );
        buildCommandPaletteCommandsSpy.mockClear();
        screen.findByType('ExplicitScopeOpener')?.props.onPress();

        expect(buildCommandPaletteCommandsSpy).toHaveBeenCalledWith(expect.objectContaining({
            activeSessionId: 'requested-session',
        }));
    });

    it('refreshes an open web Search modal when the command-builder generation changes', async () => {
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
        const element = () => <CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>;
        const screen = await renderScreen(element());

        testState.keyboardHandlers?.['commandPalette.open']?.();
        vi.mocked(Modal.update).mockClear();

        testState.enabledFeatures.add('sessions.direct');
        await act(async () => {
            screen.tree.update(element());
        });

        expect(Modal.update).toHaveBeenCalledWith('modal-id', {
            commands: expect.arrayContaining([
                expect.objectContaining({ id: 'app-destination:browseExistingSessions' }),
            ]),
        });
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
