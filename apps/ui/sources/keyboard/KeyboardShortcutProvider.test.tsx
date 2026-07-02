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
    configureConsumableSignatures: vi.fn(),
}));

vi.mock('@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter', () => ({
    subscribeToNativeHardwareKeyboardEvents: nativeKeyboardState.subscribe,
    configureNativeHardwareKeyboardConsumableEventSignatures: nativeKeyboardState.configureConsumableSignatures,
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
        nativeKeyboardState.configureConsumableSignatures.mockReset();
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

    it('routes native hardware keyboard events through the central registry when the native hook is present', async () => {
        testState.platformOS = 'ios';
        const openCommandPalette = vi.fn();
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': openCommandPalette }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).toHaveBeenCalled();
        const listener = nativeKeyboardState.subscribe.mock.calls.at(-1)?.[0] as (event: {
            key: string;
            code?: string;
            modifiers: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean };
            repeat: boolean;
        }) => void;

        await act(async () => {
            listener({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
        });

        expect(openCommandPalette).toHaveBeenCalledTimes(1);
    });

    it('configures native consumable signatures from active Enter and Escape registry bindings before subscribing', async () => {
        testState.platformOS = 'ios';
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider
                handlers={{
                    'composer.sendImmediate': vi.fn(),
                    'composer.abortConfirm': vi.fn(),
                    'commandPalette.open': vi.fn(),
                }}
            >
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.configureConsumableSignatures).toHaveBeenCalledWith([
            'Escape|shift=true|ctrl=false|meta=false|alt=false',
            'Enter|shift=false|ctrl=false|meta=true|alt=false',
        ]);
        expect(nativeKeyboardState.configureConsumableSignatures.mock.invocationCallOrder[0])
            .toBeLessThan(nativeKeyboardState.subscribe.mock.invocationCallOrder[0]);
    });

    it('clears native consumable signatures during provider cleanup', async () => {
        testState.platformOS = 'ios';
        const remove = vi.fn();
        nativeKeyboardState.subscribe.mockReturnValue({ remove });
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        await screen.unmount();

        expect(remove).toHaveBeenCalledTimes(1);
        expect(nativeKeyboardState.configureConsumableSignatures).toHaveBeenLastCalledWith([]);
    });

    it('does not subscribe to native keyboard events when V2 is disabled and no compatibility handler can run', async () => {
        testState.platformOS = 'ios';
        testState.settings = {
            ...testState.settings,
            keyboardShortcutsV2Enabled: false,
        };
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'session.new': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).not.toHaveBeenCalled();
        expect(nativeKeyboardState.configureConsumableSignatures).not.toHaveBeenCalled();
    });

    it('does not subscribe to native keyboard events when no effective handler can match', async () => {
        testState.platformOS = 'ios';
        testState.settings = {
            ...testState.settings,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open'],
        };
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).not.toHaveBeenCalled();
        expect(nativeKeyboardState.configureConsumableSignatures).not.toHaveBeenCalled();
    });

    it('dispatches descendant scoped handlers through the provider registry', async () => {
        testState.platformOS = 'web';
        testState.settings = {
            ...testState.settings,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Mod+P' }],
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
                metaKey: true,
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

        expect(nativeKeyboardState.subscribe).toHaveBeenCalled();
        const listener = nativeKeyboardState.subscribe.mock.calls.at(-1)?.[0] as (event: {
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

        expect(nativeKeyboardState.subscribe).toHaveBeenCalled();
        const listener = nativeKeyboardState.subscribe.mock.calls.at(-1)?.[0] as (event: {
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

    it('uses latest native root handlers before passive effects run', async () => {
        testState.platformOS = 'ios';
        const firstSendImmediate = vi.fn();
        const secondSendImmediate = vi.fn();
        let latestNativeListener: ((event: {
            key: string;
            code?: string;
            modifiers: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean };
            repeat: boolean;
        }) => void) | null = null;
        nativeKeyboardState.subscribe.mockImplementation((listener) => {
            latestNativeListener = listener as typeof latestNativeListener;
            return { remove: vi.fn() };
        });
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');

        function NativeDispatchOnLayout(props: Readonly<{ enabled: boolean }>) {
            React.useLayoutEffect(() => {
                if (!props.enabled) return;
                latestNativeListener?.({
                    key: 'Enter',
                    code: 'Enter',
                    modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                    repeat: false,
                });
            }, [props.enabled]);
            return <Child />;
        }

        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': firstSendImmediate }}>
                <NativeDispatchOnLayout enabled={false} />
            </KeyboardShortcutProvider>,
        );

        nativeKeyboardState.subscribe.mockClear();

        await screen.update(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': secondSendImmediate }}>
                <NativeDispatchOnLayout enabled />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.subscribe).not.toHaveBeenCalled();
        expect(firstSendImmediate).not.toHaveBeenCalled();
        expect(secondSendImmediate).toHaveBeenCalledTimes(1);
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
