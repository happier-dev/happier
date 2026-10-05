import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/sync/domains/settings/settings';
import { Modal } from '@/modal';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { KeyboardShortcutProvider, useKeyboardShortcutHandlers, useFindSurfaceRegistration, useEmbeddedFindKeyboard, useNativeKeyboardInput } from './KeyboardShortcutProvider';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { SessionCockpitSurfaceNavigationProvider } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { useReviewComposerHandoff } from '@/components/sessions/reviews/comments/useReviewComposerHandoff';

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
    it('routes native keys to the focused input before composer shortcuts and releases them on blur', async () => {
        testState.platformOS = 'ios';
        const insert = vi.fn();
        const send = vi.fn();
        const underlyingSend = vi.fn();
        function Input({ focused }: { focused: boolean }) {
            useNativeKeyboardInput(focused ? {
                bindings: ['Enter', 'Mod+Enter'],
                handleKey: (event) => {
                    if (event.key !== 'Enter') return false;
                    if (event.metaKey) send(); else insert();
                    return true;
                },
            } : null);
            return <Child />;
        }
        const element = (focused: boolean) => <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': underlyingSend }}><Input focused={focused} /></KeyboardShortcutProvider>;
        const screen = await renderScreen(element(true));
        expect(nativeKeyboardState.configureConsumableSignatures.mock.calls.at(-1)?.[0]).toContain('Enter|shift=false|ctrl=false|meta=false|alt=false');
        const event = { key: 'Enter', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } };
        await act(async () => nativeKeyboardState.subscribe.mock.calls.at(-1)?.[0](event));
        expect(send).toHaveBeenCalledOnce();
        expect(underlyingSend).not.toHaveBeenCalled();
        await act(async () => nativeKeyboardState.subscribe.mock.calls.at(-1)?.[0]({ ...event, modifiers: { ...event.modifiers, meta: false } }));
        expect(insert).toHaveBeenCalledOnce();
        await screen.update(element(false));
        expect(nativeKeyboardState.configureConsumableSignatures.mock.calls.at(-1)?.[0]).not.toContain('Enter|shift=false|ctrl=false|meta=false|alt=false');
        await act(async () => nativeKeyboardState.subscribe.mock.calls.at(-1)?.[0](event));
        expect(underlyingSend).toHaveBeenCalledOnce();
    });

    it('gives embedded renderers only configured Find chords and releases disabled bindings', async () => {
        testState.platformOS = 'ios';
        testState.settings = { ...testState.settings, keyboardShortcutOverridesV1: { 'find.open': [{ binding: 'Mod+P' }] } };
        let bridge: ReturnType<typeof useEmbeddedFindKeyboard> | undefined;
        const open = vi.fn();
        function Embedded() { bridge = useEmbeddedFindKeyboard(); return <Child />; }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{ 'find.open': open, 'session.new': () => {} }}><Embedded /></KeyboardShortcutProvider>);
        expect(bridge?.signatures).toContain('p|shift=false|ctrl=false|meta=true|alt=false');
        expect(bridge?.signatures.some((signature) => signature.startsWith('g|'))).toBe(false);
        await act(async () => { bridge?.dispatch({ key: 'p', code: 'KeyP', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } }); });
        expect(open).toHaveBeenCalledOnce();
        testState.settings = { ...testState.settings, keyboardShortcutDisabledCommandIdsV1: ['find.open'] };
        await screen.update(<KeyboardShortcutProvider handlers={{ 'find.open': open }}><Embedded /></KeyboardShortcutProvider>);
        expect(bridge?.signatures).toEqual([]);
    });
    beforeEach(() => {
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

    afterEach(() => {
        standardCleanup();
    });

    it('captures handled Find before terminal input, passes the second Find and never steps during composition', async () => {
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        let opened = false;
        let focused = false;
        let steps = 0;
        const controller: FindController = { query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' }, capabilities: { regex: true, stop: false },
            setQuery() {}, setOptions() {}, step(direction) { steps += direction; }, stop() {}, close() { opened = false; focused = false; } };
        function Surface() {
            useFindSurfaceRegistration({ surfaceId: 'terminal:leaf', containsFocus: () => true, open: () => { opened = true; focused = true; }, isOpen: () => opened, isInputFocused: () => focused, controller });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        expect(window.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
        const first = createKeyboardEvent({ key: 'f', code: 'KeyF', metaKey: true });
        window.dispatchEvent(first);
        expect(opened).toBe(true);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        expect(first.stopImmediatePropagation).toHaveBeenCalledOnce();
        const second = createKeyboardEvent({ key: 'f', code: 'KeyF', metaKey: true });
        window.dispatchEvent(second);
        expect(second.preventDefault).not.toHaveBeenCalled();
        window.dispatchEvent(createKeyboardEvent({ key: 'Enter', code: 'Enter', isComposing: true }));
        expect(steps).toBe(0);
        window.dispatchEvent(createKeyboardEvent({ key: 'Enter', code: 'Enter' }));
        expect(steps).toBe(1);
        window.dispatchEvent(createKeyboardEvent({ key: 'Escape', code: 'Escape' }));
        expect(opened).toBe(false);
    });

    it.each(['browser', 'desktop'] as const)('routes Next from an editable field using the %s host chord', async (host) => {
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        if (host === 'desktop') vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => undefined });
        let navigations = 0;
        function ShellHost() {
            useKeyboardShortcutHandlers({ 'session.pending.next': () => { navigations += 1; } });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><ShellHost /></KeyboardShortcutProvider>);
        const event = { key: 'j', code: 'KeyJ', shiftKey: true, target: { tagName: 'TEXTAREA' } as unknown as EventTarget };
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: host === 'desktop', altKey: host === 'browser' }));
        });
        expect(navigations).toBe(1);
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: host === 'browser', altKey: host === 'desktop' }));
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: true, shiftKey: false }));
        });
        expect(navigations).toBe(1);
    });

    it('admits the rebound Voice command in an editor but ignores keys consumed by a modal and held-key repeats', async () => {
        testState.settings = {
            ...testState.settings,
            keyboardShortcutOverridesV1: { 'voice.toggle': [{ binding: 'Ctrl+Alt+B' }] },
        };
        let toggles = 0;
        function VoiceRuntime() {
            useKeyboardShortcutHandlers({ 'voice.toggle': () => { toggles += 1; } });
            return <Child />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><VoiceRuntime /></KeyboardShortcutProvider>);
        const event = { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true, target: { tagName: 'TEXTAREA' } as unknown as EventTarget };
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, defaultPrevented: true }));
            window.dispatchEvent(createKeyboardEvent({ ...event, repeat: true }));
        });
        expect(toggles).toBe(0);
        await act(async () => { window.dispatchEvent(createKeyboardEvent(event)); });
        expect(toggles).toBe(1);
        await act(async () => { screen.tree.update(<KeyboardShortcutProvider handlers={{}}><Child /></KeyboardShortcutProvider>); });
        await act(async () => { window.dispatchEvent(createKeyboardEvent(event)); });
        expect(toggles).toBe(1);
    });

    it('invokes the current scoped command from an explicit action even when shortcuts are disabled', async () => {
        testState.settings = { ...testState.settings, keyboardShortcutsV2Enabled: false };
        const { renderScreen } = await import('@/dev/testkit');
        const module = await import('./KeyboardShortcutProvider');
        let focused = '';
        let invoke: (command: 'composer.focus') => boolean = () => false;
        function Action() {
            invoke = module.useKeyboardCommand();
            return <Child />;
        }
        function Composer({ name }: { name: string }) {
            module.useKeyboardShortcutHandlers({ 'composer.focus': () => { focused = name; } });
            return <Child />;
        }
        const screen = await renderScreen(<module.KeyboardShortcutProvider handlers={{}}><Composer name="first" /><Action /></module.KeyboardShortcutProvider>);
        expect(invoke('composer.focus')).toBe(true);
        expect(focused).toBe('first');
        await act(async () => { screen.tree.update(<module.KeyboardShortcutProvider handlers={{}}><Composer name="second" /><Action /></module.KeyboardShortcutProvider>); });
        invoke('composer.focus');
        expect(focused).toBe('second');
        await act(async () => { screen.tree.update(<module.KeyboardShortcutProvider handlers={{}}><Action /></module.KeyboardShortcutProvider>); });
        expect(invoke('composer.focus')).toBe(false);
    });

    it('hands review back to mobile chat before focusing, preserving tabs without sending', async () => {
        testState.platformOS = 'ios';
        testState.settings = { ...testState.settings, keyboardShortcutsV2Enabled: false };
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');
        type Surface = import('@/components/workspaceCockpit/session/sessionCockpitState').SessionMobileSurface;
        let surface: Surface = 'tabs';
        let focusedSurface: Surface | null = null;
        let sent = 0;
        let handoff = () => {};
        let paneState: ReturnType<typeof useAppPaneContext>['state'] | null = null;
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        function Probe() {
            const context = useAppPaneContext();
            paneState = context.state;
            handoff = useReviewComposerHandoff('session:s1');
            React.useEffect(() => {
                context.dispatch({ type: 'activateScope', scopeId: 'session:s1' });
                context.dispatch({ type: 'openRight', scopeId: 'session:s1', tabId: 'git' });
                context.dispatch({ type: 'openDetailsTab', scopeId: 'session:s1', tab: { key: 'scmReview:working', kind: 'scmReview', title: 'Review', resource: {} }, openAs: 'pinned' });
                context.dispatch({ type: 'setDetailsTabState', scopeId: 'session:s1', tabKey: 'scmReview:working', nextState: { scrollTop: 120 } });
                context.dispatch({ type: 'enterFocusMode', scopeId: 'session:s1' });
            }, [context.dispatch]);
            return <Child />;
        }
        function Harness() {
            const [activeSurface, setSurface] = React.useState<Surface>('tabs');
            surface = activeSurface;
            return <KeyboardShortcutProvider handlers={{ 'composer.focus': () => { focusedSurface = activeSurface; }, 'composer.sendImmediate': () => { sent += 1; } }}>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface: setSurface, returnToPreviousSurface: () => {} }}>
                    <AppPaneProvider><Probe /></AppPaneProvider>
                </SessionCockpitSurfaceNavigationProvider>
            </KeyboardShortcutProvider>;
        }
        try {
            await renderScreen(<Harness />);
            await act(async () => { handoff(); });
            expect(surface).toBe('chat');
            const state = paneState as ReturnType<typeof useAppPaneContext>['state'] | null;
            expect(state?.focusMode.scopeId).toBeNull();
            expect(state?.scopes['session:s1']?.details.isOpen).toBe(false);
            expect(state?.scopes['session:s1']?.right.isOpen).toBe(false);
            const details = state?.scopes['session:s1']?.details;
            expect(details && buildDetailsWorkspaceStateView(details).tabs.map((tab) => tab.key)).toEqual(['scmReview:working']);
            expect(state?.scopes['session:s1']?.details.tabState['scmReview:working']).toEqual({ scrollTop: 120 });
            expect(focusedSurface).toBeNull();
            await act(async () => { for (const callback of frames) callback(0); });
            expect(focusedSurface).toBe('chat');
            expect(sent).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('omits inactive handler labels from shortcut help', async () => {
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
            isEditableTarget?: boolean;
        }) => void;

        await act(async () => {
            listener({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
                isEditableTarget: false,
            });
        });

        expect(openCommandPalette).toHaveBeenCalledTimes(1);
    });

    it('routes native Cmd+G and Shift+Cmd+G from the focused Find field using the registered commands', async () => {
        testState.platformOS = 'ios';
        const steps: number[] = [];
        const controller: FindController = {
            query: 'needle', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
            capabilities: { regex: true, stop: false }, setQuery() {}, setOptions() {},
            step: (direction) => { steps.push(direction); }, stop() {}, close() {},
        };
        function Surface() {
            useFindSurfaceRegistration({ surfaceId: 'chat', containsFocus: () => true, open() {},
                isOpen: () => true, isInputFocused: () => true, controller });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        const listener = nativeKeyboardState.subscribe.mock.calls.at(-1)?.[0];
        expect(listener).toBeTypeOf('function');
        await act(async () => {
            for (const shift of [false, true]) listener?.({ key: 'g', code: 'KeyG',
                modifiers: { shift, ctrl: false, meta: true, alt: false }, repeat: false,
                target: 'reactNativeTextInput', isEditableTarget: true });
        });
        expect(steps).toEqual([1, -1]);
        expect(nativeKeyboardState.configureConsumableSignatures.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining([
            'g|shift=false|ctrl=false|meta=true|alt=false', 'g|shift=true|ctrl=false|meta=true|alt=false',
        ]));
    });

    it('does not dispatch a native shortcut that is disallowed in the focused editable target', async () => {
        testState.platformOS = 'ios';
        const openCommandPalette = vi.fn();

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': openCommandPalette }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        const listener = nativeKeyboardState.subscribe.mock.calls.at(-1)?.[0] as (event: {
            key: string;
            code?: string;
            modifiers: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean };
            repeat: boolean;
            isEditableTarget?: boolean;
        }) => void;

        await act(async () => {
            listener({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
            listener({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
                isEditableTarget: true,
            });
        });

        expect(openCommandPalette).not.toHaveBeenCalled();
    });

    it('configures native consumable signatures from active registry bindings before subscribing', async () => {
        testState.platformOS = 'ios';

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
            'k|shift=false|ctrl=false|meta=true|alt=false',
        ]);
        expect(nativeKeyboardState.configureConsumableSignatures.mock.invocationCallOrder[0])
            .toBeLessThan(nativeKeyboardState.subscribe.mock.invocationCallOrder[0]);
    });

    it('clears native consumable signatures during provider cleanup', async () => {
        testState.platformOS = 'ios';
        const remove = vi.fn();
        nativeKeyboardState.subscribe.mockReturnValue({ remove });

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
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        testState.settings = {
            ...testState.settings,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Mod+P' }],
            },
        };
        const newSession = vi.fn();

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
            addEventListener: vi.fn((type: string, listener: (event: KeyboardEvent) => void) => {
                if (type === 'keydown') listeners.add(listener);
            }),
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
        stopImmediatePropagation: vi.fn(),
        target: null,
        ...event,
    } as KeyboardEvent;
}
