import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/sync/domains/settings/settings';

const testState = vi.hoisted(() => ({
    routerPush: vi.fn(),
    sessions: {} as Record<string, any>,
    settings: {
        commandPaletteEnabled: true,
        keyboardShortcutsV2Enabled: false,
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
    return createExpoRouterMock({ segments: [], router: { push: testState.routerPush } }).module;
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
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: vi.fn(async () => ({ ok: true, result: {} })),
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => null,
}));

vi.mock('@/components/pets/desktop/bridge/desktopPetOverlayBridge', () => ({
    resetDesktopPetOverlayPosition: vi.fn(async () => {}),
}));

vi.mock('@/components/settings/pets/petSettingsCommandEvents', () => ({
    requestCodexPetRefresh: vi.fn(),
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => vi.fn(),
    useApplySettings: () => vi.fn(),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

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

describe('CommandPaletteProvider', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        testState.routerPush.mockClear();
        testState.sessions = {};
        testState.settings = {
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: false,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutOverridesV1: {},
            keyboardShortcutDisabledCommandIdsV1: [],
        };
        installKeyboardWindowMock();
    });

    it('builds command entries lazily when the palette opens', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        expect(buildCommandPaletteCommandsSpy).not.toHaveBeenCalled();

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                altKey: true,
            }));
        });

        expect(buildCommandPaletteCommandsSpy).toHaveBeenCalledTimes(1);
        expect(Modal.show).toHaveBeenCalledTimes(1);
    });

    it('uses the latest sessions when opening the palette after a closed-state update', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        testState.sessions = {
            'session-late': {
                id: 'session-late',
                updatedAt: 3,
                metadata: { name: 'Late session', path: '/tmp/late-session' },
            },
        };

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                altKey: true,
            }));
        });

        const showProps = vi.mocked(Modal.show).mock.calls[0]?.[0]?.props as { commands?: Array<{ id: string }> } | undefined;
        expect(showProps?.commands?.some((command) => command.id === 'session-session-late')).toBe(true);
    });

    it('keeps the web-safe command palette shortcut enabled when the V2 shortcut registry is disabled', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                altKey: true,
            }));
        });

        expect(Modal.show).toHaveBeenCalledTimes(1);
    });

    it('does not consume Mod+K when command palette is disabled while V2 shortcuts are enabled', async () => {
        testState.settings = {
            commandPaletteEnabled: false,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutOverridesV1: {},
            keyboardShortcutDisabledCommandIdsV1: [],
        };
        const { renderScreen } = await import('@/dev/testkit');
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');
        const event = createKeyboardEvent({
            key: 'k',
            code: 'KeyK',
            metaKey: true,
        });

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        await act(async () => {
            window.dispatchEvent(event);
        });

        expect(Modal.show).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
    });

    it('passes effective shortcut labels to command palette commands', async () => {
        testState.settings = {
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutOverridesV1: {
                'settings.open': [{ binding: 'Mod+I' }],
            },
            keyboardShortcutDisabledCommandIdsV1: ['session.new'],
        };
        const { renderScreen } = await import('@/dev/testkit');
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                altKey: true,
            }));
        });

        const showProps = vi.mocked(Modal.show).mock.calls[0]?.[0]?.props as { commands?: Array<{ id: string; shortcut?: string }> } | undefined;
        const commands = showProps?.commands ?? [];
        expect(commands.find((command) => command.id === 'new-session')?.shortcut).toBeUndefined();
        expect(commands.find((command) => command.id === 'settings')?.shortcut).toBe('Cmd+I');
    });

    it('routes configured settings and new-session shortcuts through root handlers', async () => {
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
        const { renderScreen } = await import('@/dev/testkit');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 's',
                code: 'KeyS',
                altKey: true,
            }));
            window.dispatchEvent(createKeyboardEvent({
                key: 'n',
                code: 'KeyN',
                altKey: true,
            }));
        });

        expect(testState.routerPush).toHaveBeenCalledWith('/settings');
        expect(testState.routerPush).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
    });

    it('shares the ordinary-entry callback between the palette item and keyboard shortcut', async () => {
        testState.settings = {
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Alt+N' }],
            },
            keyboardShortcutDisabledCommandIdsV1: [],
        };
        const { renderScreen } = await import('@/dev/testkit');
        const { Modal } = await import('@/modal');
        const { CommandPaletteProvider } = await import('./CommandPaletteProvider');

        await renderScreen(
            <CommandPaletteProvider>
                <Child />
            </CommandPaletteProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ key: 'k', code: 'KeyK', altKey: true }));
        });
        const showProps = vi.mocked(Modal.show).mock.calls[0]?.[0]?.props as {
            commands?: Array<{ id: string; action: () => void | Promise<void> }>;
        } | undefined;
        await act(async () => {
            await showProps?.commands?.find((command) => command.id === 'new-session')?.action();
            window.dispatchEvent(createKeyboardEvent({ key: 'n', code: 'KeyN', altKey: true }));
        });

        const ordinaryRouteCalls = testState.routerPush.mock.calls.filter(([route]) => (
            typeof route === 'object'
            && route !== null
            && (route as { pathname?: unknown }).pathname === '/new'
        ));
        expect(ordinaryRouteCalls).toHaveLength(2);
        expect(ordinaryRouteCalls).toEqual(expect.arrayContaining([
            [{
                pathname: '/new',
                params: {
                    draftId: expect.any(String),
                    draftOrigin: 'ordinary',
                },
            }],
        ]));
    });
});

function Child() {
    return React.createElement('Child');
}

function installKeyboardWindowMock() {
    const listeners = new Set<(event: KeyboardEvent) => void>();
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
                if (type === 'keydown') listeners.add(listener);
            },
            removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
                if (type === 'keydown') listeners.delete(listener);
            },
            dispatchEvent: (event: KeyboardEvent) => {
                for (const listener of listeners) {
                    listener(event);
                }
                return true;
            },
        },
    });
}

function createKeyboardEvent(event: Partial<KeyboardEvent>): KeyboardEvent {
    return {
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
        ...event,
    } as KeyboardEvent;
}
