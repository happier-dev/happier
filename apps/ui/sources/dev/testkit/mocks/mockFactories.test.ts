import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import * as registryUiBehavior from '@/agents/registry/registryUiBehavior';
import { createSessionFixture } from '../fixtures/sessionFixtures';
import { createAccountEncryptionModeModuleMock } from './accountEncryptionMode';
import { createRegistryUiBehaviorModuleMock } from './registryUiBehavior';
import type { ExpoRouterParams } from './router';
import { createTokenStorageModuleMock } from './tokenStorage';

describe('UI testkit mock factories', () => {
    it('keeps the real portal target owner above the scoped Test Renderer paint port', async () => {
        const { installBrowserRuntimeForTests } = await import('../harness/browserRuntimeHarness');
        const browser = await installBrowserRuntimeForTests({ url: 'https://portal-boundary.test/' });
        const { Platform } = await import('react-native');
        const previousOS = Object.getOwnPropertyDescriptor(Platform, 'OS');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const { requireReactDOM } = await import('@/utils/web/reactDomCjs');
        const reactDom = requireReactDOM() as typeof import('react-dom');
        const originalCreatePortal = reactDom.createPortal;
        const { installReactDomPortalBoundaryForTests } = await import('./reactDom');
        const boundary = installReactDomPortalBoundaryForTests();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const { tryRenderWebPortal } = await import('@/components/ui/popover/portal');
            const content = React.createElement('View', { testID: 'portal-owner-child' });
            const portaled = tryRenderWebPortal({ shouldPortalWeb: true, portalTargetOnWeb: 'body',
                modalPortalTarget: null, getBoundaryDomElement: () => null, content });
            expect(boundary.createPortal).toHaveBeenCalledWith(content, document.body);
            await act(async () => { tree = renderer.create(React.createElement(React.Fragment, null, portaled)); });
            expect(tree?.root.findByProps({ testID: 'portal-owner-child' })).toBeTruthy();
            reactDom.createPortal(content, document.body, 'captured-key');
            expect(boundary.createPortal).toHaveBeenLastCalledWith(content, document.body, 'captured-key');
        } finally {
            await act(async () => { tree?.unmount(); });
            boundary.restore();
            browser.restore();
            if (previousOS) Object.defineProperty(Platform, 'OS', previousOS);
            else Reflect.deleteProperty(Platform, 'OS');
        }
        expect(reactDom.createPortal).toBe(originalCreatePortal);
    });

    it('aborts a held external fetch response without a competing timeout', async () => {
        const { waitForNetworkResponseForTests } = await import('./runtimeFetch');
        expect(await waitForNetworkResponseForTests(Promise.resolve('published'))).toBe('published');
        const controller = new AbortController();
        const reason = new DOMException('Account retired', 'AbortError');
        const held = waitForNetworkResponseForTests(new Promise<never>(() => undefined), controller.signal);
        controller.abort(reason);
        await expect(held).rejects.toBe(reason);
    });
    it('delivers removable native keyboard notifications and captures focused-input handlers', async () => {
        const { createKeyboardControllerModuleMock } = await import('./keyboardController');
        const boundary = await createKeyboardControllerModuleMock();
        const listener = vi.fn();
        const subscription = boundary.KeyboardEvents.addListener('keyboardDidShow', listener);
        const event = { height: 200, duration: 100, timestamp: 1, target: 2, type: 'default', appearance: 'light' } as const;
        boundary.emitKeyboardEvent('keyboardDidShow', event);
        expect(listener).toHaveBeenCalledWith(event);
        expect(boundary.useReanimatedKeyboardAnimation().height.value).toBe(200);
        subscription.remove();
        boundary.emitKeyboardEvent('keyboardDidShow', { ...event, height: 250 });
        expect(listener).toHaveBeenCalledTimes(1);
        const handler = { onSelectionChange: vi.fn() };
        boundary.useFocusedInputHandler(handler, []);
        expect(boundary.useFocusedInputHandler).toHaveBeenCalledWith(handler, []);
    });
    it('updates shared values through the SDK updater and removable listener contract', async () => {
        const { createReanimatedModuleMock } = await import('./reanimated');
        const shared = createReanimatedModuleMock().makeMutable(1);
        const values: number[] = [];
        shared.addListener(7, (value) => values.push(value));
        shared.set((previous) => previous + 2);
        expect(shared.get()).toBe(3);
        expect(values).toEqual([3]);

        // Installed valueSetter uses ===; modify defaults to a forced publication.
        shared.value = 3;
        shared.modify(undefined, false);
        expect(values).toEqual([3]);
        shared.modify();
        expect(values).toEqual([3, 3]);
        shared.removeListener(7);
        shared.modify((previous) => previous + 4);
        expect(shared.value).toBe(7);
        expect(values).toEqual([3, 3]);
    });

    it('autostarts frame callbacks by default and stops the native frame port after unmount', async () => {
        const { createReanimatedModuleMock, readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } = await import('./reanimated');
        resetReanimatedFrameCallbacks();
        const boundary = createReanimatedModuleMock();
        const callback = vi.fn();
        function FrameOwner() {
            boundary.useFrameCallback(callback);
            return null;
        }
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            await act(async () => { tree = renderer.create(React.createElement(FrameOwner)); });
            const frame = readReanimatedFrameCallbacks()[0]!;
            frame.run({ timestamp: 1, timeSincePreviousFrame: null, timeSinceFirstFrame: 0 });
            expect(callback).toHaveBeenCalledOnce();
            await act(async () => { tree?.unmount(); });
            tree = undefined;
            frame.run({ timestamp: 2, timeSincePreviousFrame: 1, timeSinceFirstFrame: 1 });
            expect(callback).toHaveBeenCalledOnce();
        } finally {
            await act(async () => { tree?.unmount(); });
            resetReanimatedFrameCallbacks();
        }
    });

    it('keeps the real Expo widget wrapper over the native timeline port', async () => {
        const { installOptionalNativeModuleForTests, requireNativeModule } = await import('@/dev/expoStub');
        const fixtureModule = { nativeWidgetPort: true };
        const restoreNative = installOptionalNativeModuleForTests('ExpoWidgets', fixtureModule);
        expect(requireNativeModule('ExpoWidgets')).toBe(fixtureModule);
        restoreNative();
        const { createWidget, createLiveActivity } = await import('expo-widgets');
        const widget = createWidget<{ title: string }>('boundary-widget', () => React.createElement('View'));
        const date = new Date(1_234);
        widget.updateTimeline([{ date, props: { title: 'captured' } }]);
        expect(await widget.getTimeline()).toEqual([{ date, props: { title: 'captured' } }]);
        expect(createLiveActivity('boundary-activity', () => ({ banner: React.createElement('View') })).getInstances()).toEqual([]);
    });
    it('keeps released V2 omission distinct from an explicitly unassigned current Session projection', async () => {
        const { createPlainV2SessionRecordFixture, createPlainSessionCurrentProjectionRecordFixture } = await import('../fixtures/sessionFixtures');
        const released = createPlainV2SessionRecordFixture({ id: 'session-current' });
        const current = createPlainSessionCurrentProjectionRecordFixture({ id: 'session-current' });
        expect(released.responsibleAccountId).toBeUndefined();
        expect(released.responsibleAccount).toBeUndefined();
        expect(current).toMatchObject({ id: 'session-current', responsibleAccountId: null, responsibleAccount: null });
    });

    it('provides real browser nodes and one shared storage/locking port', async () => {
        const { installBrowserRuntimeForTests } = await import('../harness/browserRuntimeHarness');
        const navigate = vi.fn();
        const browser = await installBrowserRuntimeForTests({ url: 'https://browser-boundary.test/', onNavigate: navigate });
        try {
            const node = browser.document.createElement('div');
            node.id = 'browser-owner';
            browser.document.body.appendChild(node);
            expect(document.getElementById('browser-owner')).toBe(node);
            browser.storage.setItem('captured-home', 'home-a');
            expect(window.localStorage.getItem('captured-home')).toBe('home-a');
            expect(localStorage.getItem('captured-home')).toBe('home-a');
            sessionStorage.setItem('tab-home', 'home-b');
            expect(window.sessionStorage.getItem('tab-home')).toBe('home-b');
            await navigator.locks.request('browser-owner', () => browser.storage.removeItem('captured-home'));
            expect(browser.storage.getItem('captured-home')).toBeNull();
            window.location.assign('/oauth');
            expect(navigate).toHaveBeenCalledWith('https://browser-boundary.test/oauth');
            browser.reconfigureUrl('https://second-browser-boundary.test/');
            expect(window.location.origin).toBe('https://second-browser-boundary.test');
        } finally {
            browser.restore();
        }
    });

    it('shares MMKV persistence for the same native store identity without crossing stores', async () => {
        const { MMKV } = await import('react-native-mmkv');
        const writer = new MMKV({ id: 'mock-factories-shared' });
        const reader = new MMKV({ id: 'mock-factories-shared' });
        const other = new MMKV({ id: 'mock-factories-other' });
        writer.clearAll();
        other.clearAll();
        writer.set('pending', 'captured-home');
        expect(reader.getString('pending')).toBe('captured-home');
        expect(other.getString('pending')).toBeUndefined();
        reader.clearAll();
        expect(writer.getString('pending')).toBeUndefined();
    });

    it('preserves live native AppState reads across OS transitions', async () => {
        const { createReactNativeAppStateEmitter, createReactNativeNativeMock } = await import('./reactNative');
        const emitter = createReactNativeAppStateEmitter('unknown');
        const native = await createReactNativeNativeMock({ platformOS: 'ios' }, { AppState: emitter.appState });
        const listener = vi.fn();
        const subscription = native.AppState.addEventListener('change', listener);
        expect(native.AppState.currentState).toBe('unknown');
        emitter.emit('active');
        expect(native.AppState.currentState).toBe('active');
        emitter.emit('background');
        expect(native.AppState.currentState).toBe('background');
        expect(listener).toHaveBeenLastCalledWith('background');
        subscription.remove();
        expect(emitter.getListenerCount()).toBe(0);
    });

    it('reads native file chunks at the current offset and rejects a retired handle', async () => {
        const { createExpoFileSystemFileMock } = await import('./expoFileSystem');
        const boundary = createExpoFileSystemFileMock();
        const file = new boundary.module.File('file:///upload');
        file.write(new Uint8Array([1, 2, 3]));
        const handle = file.open();
        expect(file.size).toBe(3);
        expect([...handle.readBytes(2)]).toEqual([1, 2]);
        expect([...handle.readBytes(2)]).toEqual([3]);
        handle.offset = 1;
        handle.writeBytes(new Uint8Array([4]));
        handle.offset = 0;
        expect([...handle.readBytes(3)]).toEqual([1, 4, 3]);
        handle.close();
        expect(handle.size).toBeNull();
        expect(() => handle.readBytes(1)).toThrow();
    });

    it('keeps a TextInput ref usable through focus, native updates and blur', async () => {
        const { createFocusableTextInputMock } = await import('./reactNative');
        const focused = vi.fn();
        const blurred = vi.fn();
        const nativeUpdates = vi.fn();
        const TextInput = createFocusableTextInputMock(focused, undefined, { onBlur: blurred, onSetNativeProps: nativeUpdates });
        const ref = React.createRef<React.ComponentRef<typeof TextInput>>();
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(React.createElement(TextInput, { ref })); });
        ref.current!.focus();
        expect(ref.current!.isFocused()).toBe(true);
        ref.current!.setNativeProps({ text: 'draft' });
        expect(nativeUpdates).toHaveBeenCalledWith({ text: 'draft' });
        ref.current!.blur();
        expect(ref.current!.isFocused()).toBe(false);
        expect(blurred).toHaveBeenCalledOnce();
        await act(async () => tree.unmount());
    });

    it('exposes the native Appearance boundary used by real theme readers', async () => {
        const { createReactNativeWebMock } = await import('./reactNative');
        const moduleMock = await createReactNativeWebMock();
        expect(moduleMock.Appearance.getColorScheme()).toBe('light');
        const subscription = moduleMock.Appearance.addChangeListener(() => undefined);
        expect(subscription.remove).toEqual(expect.any(Function));
        subscription.remove();
    });

    it('preserves account-encryption-mode exports while allowing a focused reader override', async () => {
        const fetchAccountEncryptionMode = vi.fn(async () => ({ mode: 'plain' as const, updatedAt: 0 }));
        const moduleMock = await createAccountEncryptionModeModuleMock({
            importOriginal: async <T,>() => await import('@/sync/api/account/apiAccountEncryptionMode') as T,
            overrides: { fetchAccountEncryptionMode },
        });

        expect(await moduleMock.fetchAccountEncryptionMode({ token: 'test-token' }))
            .toEqual({ mode: 'plain', updatedAt: 0 });
        expect(moduleMock.subscribeAccountEncryptionModeCacheInvalidation).toBeTypeOf('function');
        expect(moduleMock.invalidateAccountEncryptionModeCache).toBeTypeOf('function');
    });

    it('preserves token-storage exports and supplies a removable credential-mutation boundary', async () => {
        const moduleMock = await createTokenStorageModuleMock({
            importOriginal: async <T,>() => await import('@/auth/storage/tokenStorage') as T,
            tokenStorage: {
                getCredentialsForServerUrl: vi.fn(async () => ({ token: 'test-token' })),
            },
        });
        const listener = vi.fn();

        expect(await moduleMock.TokenStorage.getCredentialsForServerUrl('https://home.example.test'))
            .toEqual({ token: 'test-token' });
        expect(moduleMock.TokenStorage.getCredentials).toBeTypeOf('function');
        expect(moduleMock.TokenStorage.accountDirectoryAuthCredentials.get).toBeTypeOf('function');
        expect(moduleMock.subscribeHomeCredentialMutations(listener)).toBeTypeOf('function');
    });

    it('creates a complete registry UI behavior module mock with caller overrides', () => {
        const supportsEditableSessionGoals = vi.fn(() => true);

        const moduleMock = createRegistryUiBehaviorModuleMock({
            supportsEditableSessionGoals,
        });

        expect(Object.keys(moduleMock).sort()).toEqual(Object.keys(registryUiBehavior).sort());
        expect(moduleMock.isAttachedSessionTerminalAvailableForSession).toBeTypeOf('function');
        expect(moduleMock.isAttachedSessionTerminalAvailableForSession(createSessionFixture())).toBe(false);
        expect(moduleMock.supportsEditableSessionGoals).toBeTypeOf('function');
        expect(moduleMock.supportsEditableSessionGoals).toBe(supportsEditableSessionGoals);
    });

    it('creates a ToolSectionView mock that preserves sibling exports', async () => {
        const { createToolSectionViewModuleMock } = await import('./toolSectionView');
        const ToolSectionSpacingProvider = ({ children }: { children?: React.ReactNode }) =>
            React.createElement('ToolSectionSpacingProvider', null, children);
        const actual: typeof import('@/components/tools/shell/presentation/ToolSectionView') = {
            ToolSectionSpacingProvider,
            ToolSectionView: React.memo(() => null),
        };

        const moduleMock = await createToolSectionViewModuleMock({
            importOriginal: async <T,>() => actual as T,
            mode: 'host',
        });

        expect(moduleMock.ToolSectionSpacingProvider).toBe(ToolSectionSpacingProvider);

        let screen!: ReturnType<typeof renderer.create>;
        await act(async () => {
            screen = renderer.create(
                React.createElement(moduleMock.ToolSectionView, { title: 'Input', fullWidth: true, children: 'Body' }),
            );
        });
        const toolSectionHostType: string = 'ToolSectionView';
        const section = screen.root.find((node) => node.type === toolSectionHostType);

        expect(section.props.title).toBe('Input');
        expect(section.props.fullWidth).toBe(true);
        expect(section.children).toEqual(['Body']);

        await act(async () => {
            screen.unmount();
        });
    });

    it('creates a React Native web mock with merged platform and AppState overrides', async () => {
        const { createReactNativeWebMock } = await import('./reactNative');

        const moduleMock = await createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                customFlag: true,
            },
            AppState: {
                currentState: 'background',
            },
        });
        const platform = moduleMock.Platform as {
            OS: string;
            customFlag?: boolean;
            select: <T>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => T | undefined;
        };
        const appState = moduleMock.AppState as {
            currentState: string;
            addEventListener: () => unknown;
        };

        expect(platform.OS).toBe('ios');
        expect(platform.customFlag).toBe(true);
        expect(platform.select({ web: 'web', ios: 'ios', default: 'default' })).toBe('web');
        expect(appState.currentState).toBe('background');
        expect(typeof appState.addEventListener).toBe('function');
    });

    it('renders Pressable render-prop children with the default unpressed state', async () => {
        const { createReactNativeWebMock } = await import('./reactNative');
        const moduleMock = await createReactNativeWebMock();
        const backHandlerSubscription = moduleMock.BackHandler.addEventListener('hardwareBackPress', () => true);
        expect(backHandlerSubscription.remove).toEqual(expect.any(Function));
        const renderChild = vi.fn((state: { pressed: boolean }) => (
            React.createElement('Text', { testID: 'pressable-child' }, state.pressed ? 'pressed' : 'idle')
        ));

        let screen!: ReturnType<typeof renderer.create>;
        await act(async () => {
            screen = renderer.create(
                React.createElement(moduleMock.Pressable, {
                    testID: 'pressable',
                    children: renderChild,
                }),
            );
        });

        expect(renderChild).toHaveBeenCalledExactlyOnceWith({ pressed: false });
        expect(screen.root.findByProps({ testID: 'pressable-child' }).children).toEqual(['idle']);

        await act(async () => {
            screen.unmount();
        });
    });

    it('creates a removable React Native AppState change emitter', async () => {
        const { createReactNativeAppStateEmitter } = await import('./reactNative');
        const boundary = createReactNativeAppStateEmitter();
        const listener = vi.fn();
        const subscription = boundary.appState.addEventListener('change', listener);

        boundary.emit('inactive');
        expect(boundary.appState.currentState).toBe('inactive');
        expect(listener).toHaveBeenCalledExactlyOnceWith('inactive');
        expect(boundary.getListenerCount()).toBe(1);

        subscription.remove();
        boundary.emit('background');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(boundary.getListenerCount()).toBe(0);
    });

    it('preserves nested stub exports when overriding React Native module objects like Animated', async () => {
        const { createReactNativeWebMock } = await import('./reactNative');

        const moduleMock = await createReactNativeWebMock({
            Animated: {
                timing: vi.fn(() => ({ start: vi.fn() })),
                parallel: vi.fn(() => ({ start: vi.fn() })),
            },
        });

        const animated = moduleMock.Animated as unknown as {
            View?: unknown;
            Value?: unknown;
            timing?: unknown;
            parallel?: unknown;
        };

        expect(animated.View).toBe('Animated.View');
        expect(animated.Value).toBeDefined();
        expect(typeof animated.timing).toBe('function');
        expect(typeof animated.parallel).toBe('function');
    });

    it('preserves getter-based Platform overrides dynamically', async () => {
        const { createReactNativeWebMock } = await import('./reactNative');
        let platformOS: 'ios' | 'web' = 'ios';

        const moduleMock = await createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOS;
                },
                select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
                    options?.[platformOS] ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
            },
        });

        expect((moduleMock.Platform as { OS: string }).OS).toBe('ios');
        platformOS = 'web';
        expect((moduleMock.Platform as { OS: string }).OS).toBe('web');
    });

    it('creates a Unistyles mock that evaluates functional StyleSheet factories against fixture theme data', async () => {
        const { createUnistylesMock } = await import('./unistyles');

        const moduleMock = await createUnistylesMock({
            theme: {
                colors: {
                    text: {
                        primary: '#123456',
                    },
                },
            },
            rt: {
                breakpoint: 'md',
            },
        });
        const unistyles = moduleMock.useUnistyles() as {
            theme: unknown;
            rt: { breakpoint: string };
        };

        expect((unistyles.theme as { colors: { text: { primary: string } } }).colors.text.primary).toBe('#123456');
        expect(unistyles.rt.breakpoint).toBe('md');
        expect(
            moduleMock.StyleSheet.create((theme: any, runtime: any) => ({
                color: theme.colors.text.primary,
                breakpoint: runtime.breakpoint,
            })),
        ).toEqual({
            color: '#123456',
            breakpoint: 'md',
        });
    });

    it('creates a Unistyles runtime mock with overridable module helpers', async () => {
        const { createUnistylesMock } = await import('./unistyles');
        const setTheme = vi.fn();

        const moduleMock = await createUnistylesMock({
            runtime: {
                setTheme,
            },
        });

        const runtime = moduleMock.UnistylesRuntime as {
            setTheme: (themeName: string) => void;
            setAdaptiveThemes: () => void;
        };

        runtime.setTheme('dark');

        expect(setTheme).toHaveBeenCalledWith('dark');
        expect(typeof runtime.setAdaptiveThemes).toBe('function');
    });

    it('creates a text module mock with stable identity translation output', async () => {
        const { createTextModuleMock } = await import('./text');

        const moduleMock = createTextModuleMock();

        expect(moduleMock.t('settings.title')).toBe('settings.title');
        // The real `t` always returns a string; a parameterized mock that returned
        // `{ key, params }` produced a shape production can never emit and crashed
        // any component rendering it as a React child.
        expect(moduleMock.t('settings.title', { serverId: 's1' })).toBe('settings.title(serverId=s1)');
        expect(moduleMock.tLoose('settings.title')).toBe('settings.title');
        expect(moduleMock.getPreferredLanguage()).toBe('en');
    });

    it('creates a text module mock with distinct tLoose and language overrides', async () => {
        const { createTextModuleMock } = await import('./text');

        const moduleMock = createTextModuleMock({
            translate: (key: string) => `t:${key}`,
            translateLoose: (key: string) => `loose:${key}`,
            getPreferredLanguage: () => 'de',
        });

        expect(moduleMock.t('settings.title')).toBe('t:settings.title');
        expect(moduleMock.tLoose('settings.title')).toBe('loose:settings.title');
        expect(moduleMock.getPreferredLanguage()).toBe('de');
    });

    it('creates a react-navigation native mock with focus hooks and CommonActions', async () => {
        const { createReactNavigationNativeMock } = await import('./reactNavigation');

        const moduleMock = createReactNavigationNativeMock({
            isFocused: false,
        });

        expect(moduleMock.useIsFocused()).toBe(false);
        expect(moduleMock.CommonActions.setParams({ id: 'abc' })).toEqual({
            type: 'SET_PARAMS',
            payload: { params: { id: 'abc' } },
        });
        expect(typeof moduleMock.useFocusEffect).toBe('function');
    });

    it('creates a modal module mock with reusable spies', async () => {
        const { createModalModuleMock } = await import('./modal');

        const modalMock = createModalModuleMock({
            confirmResult: true,
        });

        await modalMock.module.Modal.confirm('Confirm title', 'Confirm body');
        modalMock.module.Modal.alert('Alert title', 'Alert body');

        expect(modalMock.spies.confirm).toHaveBeenCalledWith('Confirm title', 'Confirm body');
        expect(modalMock.spies.alert).toHaveBeenCalledWith('Alert title', 'Alert body');
    });

    it('creates a modal module mock with caller-provided show, hide, and update spies', async () => {
        const { createModalModuleMock } = await import('./modal');
        const showSpy = vi.fn(() => 'modal-1');
        const hideSpy = vi.fn();
        const updateSpy = vi.fn();

        const modalMock = createModalModuleMock({
            spies: {
                show: showSpy,
                hide: hideSpy,
                update: updateSpy,
            },
        });

        expect(modalMock.module.Modal.show({ component: (() => null) as any })).toBe('modal-1');
        modalMock.module.Modal.hide('modal-1');
        modalMock.module.Modal.update('modal-1', { open: true } as any);

        expect(modalMock.spies.show).toBe(modalMock.module.Modal.show);
        expect(modalMock.spies.hide).toBe(modalMock.module.Modal.hide);
        expect(modalMock.spies.update).toBe(modalMock.module.Modal.update);
        expect(showSpy).toHaveBeenCalledTimes(1);
        expect(hideSpy).toHaveBeenCalledWith('modal-1');
        expect(updateSpy).toHaveBeenCalledWith('modal-1', { open: true });
    });

    it('creates an expo-router mock with mutable params, navigation spies, and Stack.Screen capture', async () => {
        const { createExpoRouterMock, createStackOptionsCapture } = await import('./router');
        const navigation = {
            goBack: vi.fn(),
            dispatch: vi.fn(),
        };
        const stackOptionsCapture = createStackOptionsCapture();
        const providedRouter = {
            push: vi.fn(),
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        };

        const routerMock = createExpoRouterMock({
            pathname: '/settings',
            params: { serverId: 'server-a' },
            segments: ['(app)', 'settings'],
            navigation,
            router: providedRouter,
            stackOptionsCapture,
        });

        routerMock.state.router.push('/next');
        routerMock.state.router.replace('/replace');
        routerMock.state.router.setParams({ serverId: 'server-b' });
        routerMock.module.Stack.Screen({
            options: () => ({
                title: 'Settings title',
            }),
        });

        expect(routerMock.module.usePathname()).toBe('/settings');
        expect(routerMock.module.useSegments()).toEqual(['(app)', 'settings']);
        expect(routerMock.state.params).toEqual({ serverId: 'server-b' });
        expect(routerMock.module.useNavigation()).toBe(navigation);
        expect(routerMock.state.router).toBe(providedRouter);
        expect(routerMock.spies.push).toHaveBeenCalledWith('/next');
        expect(routerMock.spies.replace).toHaveBeenCalledWith('/replace');
        expect(routerMock.spies.setParams).toHaveBeenCalledWith({ serverId: 'server-b' });
        expect(stackOptionsCapture.getResolved()).toEqual({ title: 'Settings title' });
    });

    it('keeps supplied router setParams resettable while merging dynamic route params', async () => {
        const { createExpoRouterMock } = await import('./router');
        let currentParams = { serverId: 'server-a' };
        const onSetParams = vi.fn((value: ExpoRouterParams) => value.path);
        const providedRouter = { setParams: onSetParams };
        const routerMock = createExpoRouterMock({
            router: providedRouter,
            params: () => currentParams,
        });

        expect(providedRouter.setParams({ path: '/first' })).toBe('/first');
        expect(routerMock.state.params).toEqual({ serverId: 'server-a', path: '/first' });

        providedRouter.setParams.mockClear();
        expect(routerMock.spies.setParams).not.toHaveBeenCalled();
        currentParams = { serverId: 'server-b' };
        expect(providedRouter.setParams({ path: '/next' })).toBe('/next');

        expect(routerMock.spies.setParams).toHaveBeenCalledExactlyOnceWith({ path: '/next' });
        expect(onSetParams).toHaveBeenCalledTimes(2);
        expect(routerMock.state.params).toEqual({ serverId: 'server-b', path: '/next' });
        routerMock.resetParams();
        expect(routerMock.state.params).toEqual({ serverId: 'server-b' });
    });

    it('fills in missing router methods when only a partial router is supplied', async () => {
        const { createExpoRouterMock } = await import('./router');

        const providedRouter = {
            push: vi.fn(),
        };

        const routerMock = createExpoRouterMock({
            router: providedRouter,
        });

        routerMock.state.router.push('/next');
        routerMock.state.router.back();
        routerMock.state.router.replace('/replace');
        routerMock.state.router.setParams({ path: '/next' });

        expect(routerMock.state.router).toBe(providedRouter);
        expect(routerMock.spies.push).toHaveBeenCalledWith('/next');
        expect(routerMock.spies.back).toHaveBeenCalledTimes(1);
        expect(routerMock.spies.replace).toHaveBeenCalledWith('/replace');
        expect(routerMock.spies.setParams).toHaveBeenCalledWith({ path: '/next' });
        expect(routerMock.state.params).toEqual({ path: '/next' });
    });

    it('preserves caller-provided router vi.fn methods without wrapping them', async () => {
        const { createExpoRouterMock } = await import('./router');

        const providedRouter = {
            push: vi.fn(),
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        };

        const routerMock = createExpoRouterMock({
            router: providedRouter,
        });

        expect(routerMock.state.router.push).toBe(providedRouter.push);
        expect(routerMock.state.router.back).toBe(providedRouter.back);
        expect(routerMock.state.router.replace).toBe(providedRouter.replace);
        expect(routerMock.spies.push).toBe(providedRouter.push);
        expect(routerMock.spies.back).toBe(providedRouter.back);
        expect(routerMock.spies.replace).toBe(providedRouter.replace);
        routerMock.state.router.setParams({ route: '/settings' });
        expect(routerMock.spies.setParams).toHaveBeenCalledWith({ route: '/settings' });
    });

    it('supports dynamic search-param suppliers and preserves local setParams overrides', async () => {
        const { createExpoRouterMock } = await import('./router');

        let currentParams: Record<string, string | string[] | undefined> = { serverId: 'server-a' };

        const routerMock = createExpoRouterMock({
            params: () => currentParams,
        });

        expect(routerMock.state.params).toEqual({ serverId: 'server-a' });

        currentParams = { serverId: 'server-b', path: '/repo' };
        routerMock.resetParams();
        expect(routerMock.state.params).toEqual({ serverId: 'server-b', path: '/repo' });

        routerMock.state.router.setParams({ draftId: 'draft-1' });
        expect(routerMock.state.params).toEqual({
            serverId: 'server-b',
            path: '/repo',
            draftId: 'draft-1',
        });
    });

    it('supports dynamic segment suppliers', async () => {
        const { createExpoRouterMock } = await import('./router');

        let currentSegments = ['(app)', 'settings'];

        const routerMock = createExpoRouterMock({
            segments: () => currentSegments,
        });

        expect(routerMock.module.useSegments()).toEqual(['(app)', 'settings']);

        currentSegments = ['(app)', 'session', '123', 'file'];
        expect(routerMock.module.useSegments()).toEqual(['(app)', 'session', '123', 'file']);
    });

    it('does not eagerly evaluate dynamic segment suppliers during router mock creation', async () => {
        const { createExpoRouterMock } = await import('./router');

        const segmentsSpy = vi.fn(() => ['(app)', 'settings']);

        const routerMock = createExpoRouterMock({
            segments: segmentsSpy,
        });

        expect(segmentsSpy).not.toHaveBeenCalled();
        expect(routerMock.module.useSegments()).toEqual(['(app)', 'settings']);
        expect(segmentsSpy).toHaveBeenCalledTimes(1);
    });

    it('supports dynamic pathname suppliers', async () => {
        const { createExpoRouterMock } = await import('./router');

        let currentPathname = '/settings';

        const routerMock = createExpoRouterMock({
            pathname: () => currentPathname,
        });

        expect(routerMock.module.usePathname()).toBe('/settings');

        currentPathname = '/session/123/file';
        expect(routerMock.module.usePathname()).toBe('/session/123/file');
    });

    it('does not eagerly evaluate dynamic pathname suppliers during router mock creation', async () => {
        const { createExpoRouterMock } = await import('./router');

        const pathnameSpy = vi.fn(() => '/settings');

        const routerMock = createExpoRouterMock({
            pathname: pathnameSpy,
        });

        expect(pathnameSpy).not.toHaveBeenCalled();
        expect(routerMock.module.usePathname()).toBe('/settings');
        expect(pathnameSpy).toHaveBeenCalledTimes(1);
    });

    it('provides a Redirect component on the expo-router mock module', async () => {
        const { createExpoRouterMock } = await import('./router');

        const routerMock = createExpoRouterMock();
        const redirect = routerMock.module.Redirect({ href: '/settings' }) as unknown as {
            type: string;
            props: { href: string };
        };

        expect(redirect.type).toBe('Redirect');
        expect(redirect.props.href).toBe('/settings');
    });

    it('provides a ModalProvider passthrough on the modal mock module', async () => {
        const { createModalModuleMock } = await import('./modal');

        const modalMock = createModalModuleMock();
        const provider = modalMock.module.ModalProvider({
            active: false,
            children: 'child',
        }) as unknown as { type: string; props: { active?: boolean; children?: unknown } };

        expect(provider.type).toBe('ModalProvider');
        expect(provider.props.active).toBe(false);
        expect(provider.props.children).toBe('child');
    });

    it('preserves requesting sibling state while mounting, updating, and closing custom content', async () => {
        const { createModalModuleMock } = await import('./modal');
        const modalMock = createModalModuleMock({ renderCustomModals: true });
        const Content = ({ label, onClose }: { label: string; onClose(): void }) =>
            React.createElement('button', { onClick: onClose }, label);
        function Owner() {
            const [selected, setSelected] = React.useState(false);
            return React.createElement('owner', { selected, onClick: () => setSelected(true) });
        }
        let screen!: ReturnType<typeof renderer.create>;
        await act(async () => {
            screen = renderer.create(React.createElement(modalMock.module.ModalProvider, null,
                React.createElement('peer'), React.createElement(Owner)));
        });
        try {
            await act(async () => { screen.root.findByType('owner').props.onClick(); });
            let id = '';
            await act(async () => { id = modalMock.module.Modal.show({ component: Content, props: { label: 'first' } }); });
            expect(screen.root.findByType('button').children).toEqual(['first']);
            expect(screen.root.findByType('owner').props.selected).toBe(true);
            await act(async () => { modalMock.module.Modal.update(id, { label: 'updated' }); });
            expect(screen.root.findByType('button').children).toEqual(['updated']);
            await act(async () => { screen.root.findByType('button').props.onClick(); });
            expect(screen.root.findAllByType('button')).toHaveLength(0);
            await act(async () => {
                modalMock.module.Modal.show({ component: Content, props: { label: 'second' } });
                modalMock.module.Modal.show({ component: Content, props: { label: 'third' } });
            });
            expect(screen.root.findAllByType('button')).toHaveLength(2);
            await act(async () => { modalMock.module.Modal.hideAll(); });
            expect(screen.root.findAllByType('button')).toHaveLength(0);
            expect(screen.root.findByType('owner').props.selected).toBe(true);
        } finally {
            await act(async () => { screen.unmount(); });
        }
    });

    it('creates a modal mock with caller-provided alert and prompt spies', async () => {
        const { createModalModuleMock } = await import('./modal');
        const alertSpy = vi.fn();
        const promptSpy = vi.fn(async () => 'typed');

        const modalMock = createModalModuleMock({
            spies: {
                alert: alertSpy,
                prompt: promptSpy,
            },
        });

        modalMock.module.Modal.alert('Alert title');
        expect(modalMock.spies.alert).toBe(modalMock.module.Modal.alert);
        expect(alertSpy).toHaveBeenCalledWith('Alert title');
        await expect(modalMock.module.Modal.prompt({ title: 'Prompt' } as any)).resolves.toBe('typed');
        expect(promptSpy).toHaveBeenCalledTimes(1);
    });

    it('creates a modal mock with caller-provided alertAsync spies', async () => {
        const { createModalModuleMock } = await import('./modal');
        const alertAsyncSpy = vi.fn(async () => {});

        const modalMock = createModalModuleMock({
            spies: {
                alertAsync: alertAsyncSpy,
            },
        });

        await expect(modalMock.module.Modal.alertAsync('Alert title', 'Alert body')).resolves.toBeUndefined();
        expect(modalMock.spies.alertAsync).toBe(modalMock.module.Modal.alertAsync);
        expect(alertAsyncSpy).toHaveBeenCalledWith('Alert title', 'Alert body');
    });

    it('creates paired ItemList pass-through exports when either list component is requested', async () => {
        const { createPassThroughModule } = await import('./components');

        const moduleMock = createPassThroughModule(['ItemList']);

        expect(moduleMock.ItemList).toBeTypeOf('function');
        expect(moduleMock.ItemListStatic).toBeTypeOf('function');
    });

    it('creates a storage module mock by merging overrides onto the original module', async () => {
        const { createStorageModuleMock, createUseSettingMock } = await import('./storage');

        const mock = await createStorageModuleMock({
            importOriginal: async () =>
                ({
                    useSetting: () => 'actual-setting',
                    useAllMachines: () => ['machine-a'],
                }) as any,
            overrides: {
                useSetting: createUseSettingMock({
                    values: { agentInputEnterToSend: false },
                }),
            },
        });

        expect(mock.useSetting('agentInputEnterToSend')).toBe(false);
        expect(mock.useAllMachines()).toEqual(['machine-a']);
    });

    it('completes a callable storage store fixture with the store surface production readers subscribe to', async () => {
        const { createStorageModuleMock } = await import('./storage');
        const state = { marker: 'callable-fixture' };
        // The real `storage` export is a zustand bound store: callable AND carrying
        // getState/subscribe/... Fixtures routinely supply only the callable + getState,
        // which used to leave `storage.subscribe` undefined and crash every
        // `useSyncExternalStore(storage.subscribe, …)` reader at passive-effect mount.
        const fixture = Object.assign(
            (selector?: (value: typeof state) => unknown) => (
                typeof selector === 'function' ? selector(state) : state
            ),
            { getState: () => state },
        );

        const mock = await createStorageModuleMock({
            importOriginal: async () =>
                ({ storage: { getState: () => ({ marker: 'actual-storage' }) } }) as any,
            overrides: { storage: fixture as any },
        });

        // The caller's own selector still reads the fixture state.
        expect((mock.storage as any)((value: typeof state) => value.marker)).toBe('callable-fixture');
        const snapshot = mock.storage.getState();
        expect(snapshot).toMatchObject(state);
        expect(snapshot.sessions).toEqual({});
        expect(snapshot.localSettings.sessionMruOrderV1).toEqual([]);
        expect(mock.getStorage().getState()).toBe(snapshot);
        expect(mock.storage((value) => value)).toBe(snapshot);
        expect(mock.storage.subscribe).toBeTypeOf('function');
        expect(mock.storage.subscribe(() => {})).toBeTypeOf('function');
        expect(mock.storage.getInitialState()).toBe(snapshot);
    });

    it('keeps a callable storage fixture own subscribe instead of substituting an inert one', async () => {
        const { createStorageModuleMock } = await import('./storage');
        const state = { marker: 'reactive-fixture' };
        const listeners = new Set<() => void>();
        const subscribe = (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        };
        const fixture = Object.assign(
            (selector?: (value: typeof state) => unknown) => (
                typeof selector === 'function' ? selector(state) : state
            ),
            { getState: () => state, subscribe },
        );

        const mock = await createStorageModuleMock({
            importOriginal: async () =>
                ({ storage: { getState: () => ({ marker: 'actual-storage' }) } }) as any,
            overrides: { storage: fixture as any },
        });

        expect(mock.storage.subscribe).toBe(subscribe as any);
        const unsubscribe = mock.storage.subscribe(() => {});
        expect(listeners.size).toBe(1);
        unsubscribe();
        expect(listeners.size).toBe(0);
    });

    it('keeps the original storage store readable when the original module finishes loading after the mock is built', async () => {
        const { createStorageModuleMock, createUseSettingMock } = await import('./storage');
        const store = { getState: () => ({ marker: 'actual-storage' }) };
        // An import cycle hands `importOriginal()` a namespace whose bindings are still
        // uninitialized; the live getter only answers once the original module has run.
        let initialized = false;
        const namespace = {};
        Object.defineProperty(namespace, 'storage', { enumerable: true, get: () => (initialized ? store : undefined) });

        const mock = await createStorageModuleMock({
            importOriginal: async () => namespace as any,
            overrides: { useSetting: createUseSettingMock({ values: {} }) },
        });
        initialized = true;

        expect(mock.getStorage()).toBe(store);
        expect(mock.storage).toBe(store);
    });

    it('preserves explicit getStorage overrides in storage module mocks', async () => {
        const { createStorageModuleMock } = await import('./storage');
        const storageOverride = {
            getState: () => ({ marker: 'override' }),
        };

        const mock = await createStorageModuleMock({
            importOriginal: async () =>
                ({
                    storage: { getState: () => ({ marker: 'actual-storage' }) },
                    getStorage: () => ({ getState: () => ({ marker: 'actual-getStorage' }) }),
                }) as any,
            overrides: {
                getStorage: () => storageOverride as any,
            },
        });

        expect(mock.getStorage()).toBe(storageOverride);
        expect(mock.getStorage().getState()).toEqual({ marker: 'override' });
    });

    it('creates a storage module stub without importing the original module', async () => {
        const { createStorageModuleStub } = await import('./storage');
        const { buildSessionListServerScopedRowKey } = await import(
            '@/sync/domains/session/listing/sessionListKeyNormalization'
        );

        const mock = createStorageModuleStub({
            useSettingMutable: () => [false, vi.fn()],
        });

        expect(mock.useSettingMutable('agentInputEnterToSend')).toEqual([false, expect.any(Function)]);
        expect(mock.useLocalSettingMutable('uiMultiPanePanelsEnabled')).toEqual([expect.anything(), expect.any(Function)]);
        expect(mock.useActiveServerAccountScope()).toBeNull();
        expect(mock.useSessionLastMobileSurface('session-a')).toBeNull();
        expect(mock.useProjectLastMobileSurface('workspace-a')).toBeNull();
        expect(mock.useArtifacts()).toEqual([]);
        expect(mock.useOpenApprovalArtifactsForSession({ serverId: 'home-a', sessionId: 'session-a' })).toEqual([]);
        expect(mock.useEnabledAutomationsCountForSession('session-a')).toBe(0);
        const reducerState = mock.useSessionMessagesReducerState('session-a');
        expect(reducerState.messages).toBeInstanceOf(Map);
        expect(mock.useSessionMessagesReducerState('session-a')).toBe(reducerState);
        expect(mock.useMachineListByServerId()).toEqual({});
        // The single-Home readers agree with the empty map: no list loaded, status idle.
        expect(mock.useMachineListForServer('home-a')).toBeNull();
        expect(mock.useMachineListStatusForServer('home-a')).toBe('idle');
        expect(mock.useMachine('machine-a')).toBeNull();
        expect(mock.useSocketStatus()).toEqual({
            status: 'connected',
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastError: null,
            lastErrorAt: null,
        });
        expect(mock.useEndpointConnectivity()).toEqual({
            status: 'online',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        expect(mock.useSyncError()).toBeNull();
        expect(mock.buildSessionListReachabilityRenderableKey('home\u0000part', 'session')).toBe(
            buildSessionListServerScopedRowKey('home\u0000part', 'session'),
        );
    });

    it('creates a selector-capable storage store mock with getState support', async () => {
        const { createStorageStoreMock } = await import('./storage');
        const { createSessionMessagesFixture } = await import('../fixtures/transcriptFixtures');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');

        const mockStore = createStorageStoreMock({
            settings: settingsDefaults,
            sessionMessages: {
                'session-1': createSessionMessagesFixture(),
            },
        });

        expect(mockStore((state) => state.sessionMessages['session-1']?.messagesById ?? null)).toEqual({});
        expect(mockStore.getState().sessionMessages['session-1']?.messagesMap).toEqual({});
        expect(mockStore.getState().sessionTailContiguousBoundary).toEqual({});
        expect(mockStore.getState().settings.mobileWorkspaceExperienceV1).toBeDefined();
    });

    it('lets a partial live store defer and evict unmounted transcripts while retaining mounted ones', async () => {
        const { createLiveStorageStoreMock } = await import('./storage');
        const { createSessionMessagesFixture } = await import('../fixtures/transcriptFixtures');
        const { createSessionTranscriptRetentionController } = await import('@/sync/engine/sessions/sessionTranscriptRetention');
        let sessionMessages: import('@/sync/store/types').StorageState['sessionMessages'] = {
            unmounted: createSessionMessagesFixture(),
            mounted: createSessionMessagesFixture(),
        };
        const store = createLiveStorageStoreMock(() => ({ sessionMessages }));
        const evictedSessionIds: string[] = [];
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const retention = createSessionTranscriptRetentionController({
            readHydratedSessionIds: () => Object.keys(store.getState().sessionMessages),
            readProtectedSessionIds: () => new Set(['mounted']),
            readLastViewedAtBySessionId: () => store.getState().sessionLastViewed,
            evictSessionTranscript: (sessionId) => {
                evictedSessionIds.push(sessionId);
                sessionMessages = { ...sessionMessages };
                delete sessionMessages[sessionId];
            },
            tuning: { recentKeepCount: 0, graceMs: 100, sweepDebounceMs: 10 },
        });
        try {
            retention.scheduleSweep();
            vi.advanceTimersByTime(10);
            expect(evictedSessionIds).toEqual([]);
            expect(Object.keys(store.getState().sessionMessages)).toEqual(['unmounted', 'mounted']);
            vi.advanceTimersByTime(100);
            expect(evictedSessionIds).toEqual(['unmounted']);
            expect(Object.keys(store.getState().sessionMessages)).toEqual(['mounted']);
        } finally {
            retention.dispose();
            vi.useRealTimers();
        }
    });

    it('creates a useSetting mock from a keyed settings map with optional fallback', async () => {
        const { createUseSettingMock } = await import('./storage');

        const useSetting = createUseSettingMock({
            values: {
                wrapLinesInDiffs: false,
                showLineNumbers: undefined,
            },
            fallback: (key) => `fallback:${String(key)}`,
        });

        expect(useSetting('wrapLinesInDiffs')).toBe(false);
        expect(useSetting('showLineNumbers')).toBeUndefined();
        expect(useSetting('toolViewTapAction' as any)).toBe('fallback:toolViewTapAction');
    });

    it('installs direct vi.mock factories for react-native, text, and unistyles', async () => {
        const { installReactNativeWebMock } = await import('./reactNative');
        const { installTextModuleMock } = await import('./text');
        const { installUnistylesMock } = await import('./unistyles');

        const reactNativeModule = await installReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'ios',
            },
        })();
        const textModule = installTextModuleMock({
            translate: (key) => `tx:${key}`,
        })();
        const unistylesModule = await installUnistylesMock({
            theme: {
                colors: {
                    text: '#abcdef',
                },
            },
        })();
        const installedUnistyles = unistylesModule.useUnistyles();
        const installedTheme = installedUnistyles.theme as Record<string, unknown>;
        const installedColors = installedTheme.colors as Record<string, unknown> | undefined;

        expect(reactNativeModule.View).toBe('View');
        expect(reactNativeModule.Platform.OS).toBe('ios');
        expect(textModule.t('settings.title')).toBe('tx:settings.title');
        expect(installedColors?.text).toBe('#abcdef');
    });

    it('installs importOriginal-based vi.mock factories for storage, persistence, sync ops, and server-scope resolver modules', async () => {
        const { installPartialStorageModuleMock } = await import('./storage');
        const { installPersistenceModuleMock } = await import('@/dev/testkit');
        const { installSyncOpsModuleMock } = await import('./syncOps');
        const {
            installResolvePreferredServerIdForSessionIdModuleMock,
            installResolveServerIdForSessionIdFromLocalCacheModuleMock,
        } = await import('./serverScopedRpc');

        const storageModule = await installPartialStorageModuleMock({
            useSetting: () => 'mock-setting',
        })(async () =>
            ({
                useSetting: () => 'actual-setting',
                useAllMachines: () => ['machine-a'],
            }) as any);
        const persistenceModule = await installPersistenceModuleMock({
            loadSettings: () => ({ settings: { analyticsOptOut: true }, version: null }),
        })(async () =>
            ({
                loadSettings: () => ({ settings: { analyticsOptOut: false }, version: null }),
                loadLocalPetSourcesBySourceKey: () => ({}),
            }) as any);
        const syncOpsModule = await installSyncOpsModuleMock({
            sessionAbort: vi.fn(async (_sessionId: string) => {}),
        })(async () =>
            ({
                machinePreviewEnv: vi.fn(async () => ({ supported: false })),
                sessionAbort: vi.fn(async () => {
                    throw new Error('expected override');
                }),
            }) as any);
        const resolveServerModule = await installResolveServerIdForSessionIdFromLocalCacheModuleMock({
            resolveServerIdForSessionIdFromLocalCache: vi.fn(() => 'server-cache'),
        })(async () =>
            ({
                resolveServerIdForSessionIdFromLocalCache: vi.fn(() => null),
                resolveServerIdForSessionIdFromLocalState: vi.fn(() => null),
            }) as any);
        const resolvePreferredModule = await installResolvePreferredServerIdForSessionIdModuleMock({
            resolvePreferredServerIdForSessionId: vi.fn(() => 'server-owned'),
        })(async () =>
            ({
                resolvePreferredServerIdForSessionId: vi.fn(() => null),
            }) as any);

        expect(storageModule.useSetting('agentInputEnterToSend')).toBe('mock-setting');
        expect(storageModule.useAllMachines()).toEqual(['machine-a']);
        const loadedSettings = persistenceModule.loadSettings() as {
            settings: { analyticsOptOut: boolean };
        };
        expect(loadedSettings.settings.analyticsOptOut).toBe(true);
        expect(persistenceModule.loadLocalPetSourcesBySourceKey()).toEqual({});

        await syncOpsModule.sessionAbort('session-1');

        expect(syncOpsModule.machinePreviewEnv).toBeTypeOf('function');
        expect(vi.mocked(syncOpsModule.sessionAbort)).toHaveBeenCalledWith('session-1');
        expect(resolveServerModule.resolveServerIdForSessionIdFromLocalCache('session-1')).toBe('server-cache');
        expect(resolveServerModule.resolveServerIdForSessionIdFromLocalState({}, 'session-1')).toBeNull();
        expect(resolvePreferredModule.resolvePreferredServerIdForSessionId('session-1')).toBe('server-owned');
    });

    it('creates a partial serverProfiles module mock that preserves sibling exports', async () => {
        const { createPartialServerProfilesModuleMock } = await import('./serverProfiles');

        const moduleMock = await createPartialServerProfilesModuleMock(
            async <T,>() => ({
                HAPPIER_CLOUD_SERVER_URL: 'https://cloud.example.test',
                getActiveServerUrl: () => 'https://actual.example.test',
            }) as T,
            {
                profiles: [{
                    id: 'server-a',
                    serverUrl: 'https://server-a.example.test',
                    serverIdentityId: 'identity-a',
                    legacyServerIds: ['legacy-a'],
                }],
                overrides: {
                    getActiveServerUrl: () => 'https://override.example.test',
                },
            },
        );

        expect(moduleMock.HAPPIER_CLOUD_SERVER_URL).toBe('https://cloud.example.test');
        expect(moduleMock.getActiveServerUrl()).toBe('https://override.example.test');
        const scopedProfile = { id: 'server-a', serverIdentityId: 'identity-a' } satisfies Parameters<typeof moduleMock.resolveServerProfileScopeId>[0];
        expect(moduleMock.resolveServerProfileScopeId(scopedProfile)).toBe('identity-a');
        expect(moduleMock.resolveServerProfileScopeIdForIdentifier('legacy-a')).toBe('identity-a');
        expect(moduleMock.areServerProfileIdentifiersEquivalent('legacy-a', 'identity-a')).toBe(true);
    });

    it('creates a capturing LegendList mock that stores props, renders rows, and assigns ref handles', async () => {
        const React = await import('react');
        const { createCapturingLegendListMock } = await import('./legendList');

        const legendListMock = createCapturingLegendListMock({ renderItems: true });
        const ref = React.createRef<typeof legendListMock.state.refHandle>();
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(React.createElement(legendListMock.module.LegendList, {
            ref,
            data: [{ id: 'row-1' }, { id: 'row-2' }],
            keyExtractor: (item: { id: string }) => item.id,
            renderItem: ({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id }),
            ListHeaderComponent: React.createElement('Header'),
            ListFooterComponent: React.createElement('Footer'),
        })); });

        expect(legendListMock.state.props?.data).toEqual([{ id: 'row-1' }, { id: 'row-2' }]);
        expect(ref.current).toBe(legendListMock.state.refHandle);
        expect(tree.root.findAllByType('Row').map(row => row.props.id)).toEqual(['row-1', 'row-2']);
        expect(tree.root.findByType('Header')).toBeTruthy();
        expect(tree.root.findByType('Footer')).toBeTruthy();
        await act(async () => tree.unmount());
    });

    it('creates a capturing FlatList mock that stores props and renders rows with headers and footers', async () => {
        const React = await import('react');
        const { createCapturingFlatListMock } = await import('./virtualizedList');

        const flatListMock = createCapturingFlatListMock({ renderItems: true });

        const element = flatListMock.module.FlatList({
            data: [{ id: 'row-1' }, { id: 'row-2' }],
            keyExtractor: (item: { id: string }) => item.id,
            renderItem: ({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id }),
            ListHeaderComponent: React.createElement('Header'),
            ListFooterComponent: React.createElement('Footer'),
        }) as any;

        expect(flatListMock.state.props?.data).toEqual([{ id: 'row-1' }, { id: 'row-2' }]);
        expect(element.type).toBe('FlatList');
        expect(Array.isArray(element.props.children)).toBe(true);
        expect(element.props.children).toHaveLength(4);
    });

    it('creates a sync ops module mock by merging overrides onto the original module', async () => {
        const { createSyncOpsModuleMock } = await import('./syncOps');
        const originalPreview = vi.fn(async () => ({ supported: false }));
        const overrideAbort = vi.fn(async (_sessionId: string) => {});

        const mock = await createSyncOpsModuleMock({
            importOriginal: async () =>
                ({
                    machinePreviewEnv: originalPreview,
                    sessionAbort: vi.fn(async () => {
                        throw new Error('should use override');
                    }),
                }) as any,
            overrides: {
                sessionAbort: overrideAbort,
            },
        });

        await mock.sessionAbort('session-1');

        expect(mock.machinePreviewEnv).toBe(originalPreview);
        expect(overrideAbort).toHaveBeenCalledWith('session-1');
    });

    it('creates a vector-icons mock surface', async () => {
        const { createExpoVectorIconsMock } = await import('./icons');

        expect(createExpoVectorIconsMock()).toEqual({
            Ionicons: 'Ionicons',
            Octicons: 'Octicons',
            AntDesign: 'AntDesign',
            MaterialIcons: 'MaterialIcons',
            FontAwesome: 'FontAwesome',
            FontAwesome5: 'FontAwesome5',
            Feather: 'Feather',
        });
    });
});
