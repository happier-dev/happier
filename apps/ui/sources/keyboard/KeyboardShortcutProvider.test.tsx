import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/sync/domains/settings/settings';

const testState = vi.hoisted(() => ({
    platformOS: 'web',
    settings: {
        commandPaletteEnabled: true,
        keyboardShortcutsV2Enabled: true,
        keyboardSingleKeyShortcutsEnabled: true,
        keyboardShortcutOverridesV1: {},
        keyboardShortcutDisabledCommandIdsV1: [],
    } as Partial<Settings>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return testState.platformOS;
            },
            select: <T,>(options: { web?: T; ios?: T; android?: T; native?: T; default?: T }) =>
                testState.platformOS === 'web'
                    ? options.web ?? options.default ?? options.native
                    : testState.platformOS === 'ios'
                      ? options.ios ?? options.native ?? options.default
                      : options.android ?? options.native ?? options.default,
        },
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const readSnapshot = () => ({
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

const nativeKeyboardState = vi.hoisted(() => ({
    subscribe: vi.fn(),
}));

type KeyboardWindowListener = (event: KeyboardEvent) => void;

const keyboardWindowState = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    listeners: new Set<KeyboardWindowListener>(),
};

vi.mock('@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter', () => ({
    subscribeToNativeHardwareKeyboardEvents: nativeKeyboardState.subscribe,
}));

describe('KeyboardShortcutProvider', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        testState.platformOS = 'web';
        testState.settings = {
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true,
            keyboardShortcutOverridesV1: {},
            keyboardShortcutDisabledCommandIdsV1: [],
        };
        nativeKeyboardState.subscribe.mockReturnValue({ remove: vi.fn() });
        installKeyboardWindowMock();
    });

    it('omits inactive handler labels from shortcut help', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { Modal } = await import('@/modal');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: '?',
                code: 'Slash',
                shiftKey: true,
            }));
        });

        expect(Modal.alertAsync).toHaveBeenCalledTimes(1);
        const [, body] = vi.mocked(Modal.alertAsync).mock.calls[0] ?? [];
        expect(String(body)).not.toContain('Command palette');
        expect(String(body)).not.toContain('New session');
    });

    it('does not consume web events that another focused surface already handled', async () => {
        const openCommandPalette = vi.fn();
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': openCommandPalette }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                metaKey: true,
                defaultPrevented: true,
            }));
        });

        expect(openCommandPalette).not.toHaveBeenCalled();
    });

    it('dispatches descendant scoped handlers through the provider registry', async () => {
        testState.settings = {
            ...testState.settings,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Ctrl+P' }],
            },
        };
        const newSession = vi.fn();
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider, useKeyboardShortcutHandlers } = await import('./KeyboardShortcutProvider');

        function RegisteredChild() {
            useKeyboardShortcutHandlers(React.useMemo(() => ({
                'session.new': newSession,
            }), []));
            return <Child />;
        }

        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <RegisteredChild />
            </KeyboardShortcutProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'p',
                code: 'KeyP',
                ctrlKey: true,
            }));
        });

        expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('keeps the web keydown listener mounted when descendant scoped handlers register', async () => {
        const newSession = vi.fn();
        let showRegisteredChild: (() => void) | null = null;
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider, useKeyboardShortcutHandlers } = await import('./KeyboardShortcutProvider');

        function RegisteredShortcut() {
            useKeyboardShortcutHandlers(React.useMemo(() => ({
                'session.new': newSession,
            }), []));
            return <Child />;
        }

        function ToggleChild() {
            const [registered, setRegistered] = React.useState(false);
            showRegisteredChild = () => setRegistered(true);
            return registered ? <RegisteredShortcut /> : <Child />;
        }

        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <ToggleChild />
            </KeyboardShortcutProvider>,
        );

        expect(keyboardWindowState.addEventListener).toHaveBeenCalledTimes(1);
        expect(keyboardWindowState.removeEventListener).not.toHaveBeenCalled();
        keyboardWindowState.addEventListener.mockClear();
        keyboardWindowState.removeEventListener.mockClear();

        await act(async () => {
            showRegisteredChild?.();
        });

        expect(keyboardWindowState.addEventListener).not.toHaveBeenCalled();
        expect(keyboardWindowState.removeEventListener).not.toHaveBeenCalled();
        expect(keyboardWindowState.listeners.size).toBe(1);

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'n',
                code: 'KeyN',
                altKey: true,
            }));
        });

        expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('updates descendant scoped handler callbacks without re-registering unchanged command keys', async () => {
        testState.platformOS = 'ios';
        const calls: number[] = [];
        let rerenderRegisteredChild: (() => void) | null = null;
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider, useKeyboardShortcutHandlers } = await import('./KeyboardShortcutProvider');

        function RegisteredChild() {
            const [version, setVersion] = React.useState(0);
            rerenderRegisteredChild = () => setVersion((current) => current + 1);
            useKeyboardShortcutHandlers(React.useMemo(() => ({
                'composer.sendImmediate': () => calls.push(version),
            }), [version]));
            return <Child />;
        }

        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <RegisteredChild />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).toHaveBeenCalledTimes(1);
        const listener = nativeKeyboardState.subscribe.mock.calls[0]?.[0] as (event: {
            key: string;
            code?: string;
            modifiers: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean };
            repeat: boolean;
        }) => void;
        nativeKeyboardState.subscribe.mockClear();

        await act(async () => {
            rerenderRegisteredChild?.();
        });

        expect(nativeKeyboardState.subscribe).not.toHaveBeenCalled();

        await act(async () => {
            listener({
                key: 'Enter',
                code: 'Enter',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
        });

        expect(calls).toEqual([1]);
    });

    it('updates native root handlers without re-registering unchanged command keys', async () => {
        testState.platformOS = 'ios';
        const firstSendImmediate = vi.fn();
        const secondSendImmediate = vi.fn();
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': firstSendImmediate }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).toHaveBeenCalledTimes(1);
        const listener = nativeKeyboardState.subscribe.mock.calls[0]?.[0] as (event: {
            key: string;
            code?: string;
            modifiers: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean };
            repeat: boolean;
        }) => void;
        nativeKeyboardState.subscribe.mockClear();

        await screen.update(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': secondSendImmediate }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).not.toHaveBeenCalled();

        await act(async () => {
            listener({
                key: 'Enter',
                code: 'Enter',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
        });

        expect(firstSendImmediate).not.toHaveBeenCalled();
        expect(secondSendImmediate).toHaveBeenCalledTimes(1);
    });

    it('routes native hardware keyboard events through the central registry when the native hook is present', async () => {
        testState.platformOS = 'ios';
        const sendImmediate = vi.fn();
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': sendImmediate }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).toHaveBeenCalledTimes(1);
        expect(nativeKeyboardState.subscribe.mock.calls[0]?.[1]).toEqual({
            allowedEvents: [
                {
                    key: 'Enter',
                    modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                },
            ],
        });
        const listener = nativeKeyboardState.subscribe.mock.calls[0]?.[0] as (event: {
            key: string;
            code?: string;
            modifiers: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean };
            repeat: boolean;
        }) => void;

        await act(async () => {
            listener({
                key: 'Enter',
                code: 'Enter',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
        });

        expect(sendImmediate).toHaveBeenCalledTimes(1);
    });

    it('does not subscribe to native hardware interception when V2 shortcuts are disabled', async () => {
        testState.platformOS = 'ios';
        testState.settings = {
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: false,
            keyboardSingleKeyShortcutsEnabled: true,
            keyboardShortcutOverridesV1: {},
            keyboardShortcutDisabledCommandIdsV1: [],
        };
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).not.toHaveBeenCalled();
    });

    it('does not subscribe to native hardware interception when active handlers have no native-emitted binding', async () => {
        testState.platformOS = 'ios';
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).not.toHaveBeenCalled();
    });
});

function Child() {
    return React.createElement('Child');
}

function installKeyboardWindowMock() {
    keyboardWindowState.listeners.clear();
    keyboardWindowState.addEventListener.mockReset();
    keyboardWindowState.removeEventListener.mockReset();
    keyboardWindowState.addEventListener.mockImplementation((type: string, listener: KeyboardWindowListener) => {
        if (type === 'keydown') keyboardWindowState.listeners.add(listener);
    });
    keyboardWindowState.removeEventListener.mockImplementation((type: string, listener: KeyboardWindowListener) => {
        if (type === 'keydown') keyboardWindowState.listeners.delete(listener);
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            addEventListener: keyboardWindowState.addEventListener,
            removeEventListener: keyboardWindowState.removeEventListener,
            dispatchEvent: (event: KeyboardEvent) => {
                for (const listener of keyboardWindowState.listeners) {
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
