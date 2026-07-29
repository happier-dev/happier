import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import * as registryUiBehavior from '@/agents/registry/registryUiBehavior';
import { createSessionFixture } from '../fixtures/sessionFixtures';
import { createRegistryUiBehaviorModuleMock } from './registryUiBehavior';

describe('UI testkit mock factories', () => {
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
        const section = screen.root.findByType('ToolSectionView');

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
        expect(moduleMock.t('settings.title', { serverId: 's1' })).toEqual({
            key: 'settings.title',
            params: { serverId: 's1' },
        });
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
        expect(routerMock.module.useLocalSearchParams()).toEqual({ serverId: 'server-b' });
        expect(routerMock.module.useNavigation()).toBe(navigation);
        expect(routerMock.state.router).toBe(providedRouter);
        expect(routerMock.spies.push).toHaveBeenCalledWith('/next');
        expect(routerMock.spies.replace).toHaveBeenCalledWith('/replace');
        expect(routerMock.spies.setParams).toHaveBeenCalledWith({ serverId: 'server-b' });
        expect(stackOptionsCapture.getResolved()).toEqual({ title: 'Settings title' });
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
        expect(routerMock.module.useLocalSearchParams()).toEqual({ path: '/next' });
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

        expect(routerMock.module.useLocalSearchParams()).toEqual({ serverId: 'server-a' });

        currentParams = { serverId: 'server-b', path: '/repo' };
        expect(routerMock.module.useLocalSearchParams()).toEqual({ serverId: 'server-b', path: '/repo' });

        routerMock.state.router.setParams({ draftId: 'draft-1' });
        expect(routerMock.module.useLocalSearchParams()).toEqual({
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

        const mock = createStorageModuleStub({
            useSettingMutable: () => [false, vi.fn()],
        });

        expect(mock.useSettingMutable('agentInputEnterToSend')).toEqual([false, expect.any(Function)]);
        expect(mock.useLocalSettingMutable('uiMultiPanePanelsEnabled')).toEqual([expect.anything(), expect.any(Function)]);
        expect(mock.useActiveServerAccountScope()).toBeNull();
        expect(mock.useSessionLastMobileSurface('session-a')).toBeNull();
        expect(mock.useProjectLastMobileSurface('workspace-a')).toBeNull();
        expect(mock.useArtifacts()).toEqual([]);
        expect(mock.useOpenApprovalArtifactsForSession('session-a')).toEqual([]);
        expect(mock.useEnabledAutomationsCountForSession('session-a')).toBe(0);
        const reducerState = mock.useSessionMessagesReducerState('session-a');
        expect(reducerState.messages).toBeInstanceOf(Map);
        expect(mock.useSessionMessagesReducerState('session-a')).toBe(reducerState);
        expect(mock.useMachineListByServerId()).toEqual({});
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
        expect(mockStore.getState().sessionTailContiguousFloorSeq).toEqual({});
        expect(mockStore.getState().settings.mobileWorkspaceExperienceV1).toBeDefined();
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
        const ref = React.createRef<any>();

        const element = (legendListMock.module.LegendList as any).render({
            ref,
            data: [{ id: 'row-1' }, { id: 'row-2' }],
            keyExtractor: (item: { id: string }) => item.id,
            renderItem: ({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id }),
            ListHeaderComponent: React.createElement('Header'),
            ListFooterComponent: React.createElement('Footer'),
        }, ref);

        expect(legendListMock.state.props?.data).toEqual([{ id: 'row-1' }, { id: 'row-2' }]);
        expect(ref.current).toBe(legendListMock.state.refHandle);
        expect(element.type).toBe('LegendList');
        expect(Array.isArray(element.props.children)).toBe(true);
        expect(element.props.children).toHaveLength(4);
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
