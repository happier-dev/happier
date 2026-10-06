import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Message } from "@happier-dev/session-core/messages";
import type { SessionMobileSurface } from './sessionCockpitState';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CockpitNavigatorFocusContext = React.createContext(true);

const persistedStorage = vi.hoisted(() => new Map<string, string>());
const approvalSessionTargets = vi.hoisted(() => [] as Array<{ serverId: string; sessionId: string } | null>);
const sessionMachineTargetCalls = vi.hoisted(() => [] as unknown[]);
const canonicalSessionPluginRuntime = vi.hoisted(() => ({ values: [] as object[] }));
const cockpitNavigatorState = vi.hoisted(() => ({
    activeSurface: 'chat',
    goBack: null as null | (() => void),
    hardwareBackHandlers: [] as Array<() => boolean>,
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return persistedStorage.get(key);
        }

        set(key: string, value: string) {
            persistedStorage.set(key, value);
        }

        delete(key: string) {
            persistedStorage.delete(key);
        }

        getAllKeys() {
            return [...persistedStorage.keys()];
        }

        clearAll() {
            persistedStorage.clear();
        }
    }

    return { MMKV };
});

const transcriptState = vi.hoisted(() => ({
    ids: [] as string[],
    messagesById: {} as Record<string, unknown>,
}));
const cockpitPluginProjectionState = vi.hoisted(() => ({
    value: {
        pluginUiProjection: null as unknown,
        machineId: null as string | null,
        serverId: null as string | null,
        interactionEnabled: false,
        platform: 'web' as 'web' | 'ios',
        phase: 'establishing' as 'establishing' | 'current' | 'retainedOffline' | 'unavailable',
    },
}));
const cockpitDeviceType = vi.hoisted(() => ({ value: 'phone' as 'phone' | 'tablet' }));

installNavigationCommonModuleMocks({
    // The cockpit tree reaches far more typography styles than the navigation panel alone,
    // so keep the real constants rather than a narrow stub.
    typography: async () => await vi.importActual('@/constants/Typography'),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            // Boundary stub for the RN list host: `any` mirrors the untyped mock-module shape.
            FlatList: ({ data, renderItem, keyExtractor, ...rest }: any) => React.createElement(
                'FlatList',
                rest,
                (data ?? []).map((item: any, index: number) => React.createElement(
                    React.Fragment,
                    { key: keyExtractor ? keyExtractor(item, index) : String(index) },
                    renderItem?.({ item, index }),
                )),
            ),
            BackHandler: {
                addEventListener: vi.fn((_event: string, handler: () => boolean) => {
                    cockpitNavigatorState.hardwareBackHandlers.push(handler);
                    return {
                        remove: () => {
                            const index = cockpitNavigatorState.hardwareBackHandlers.indexOf(handler);
                            if (index >= 0) cockpitNavigatorState.hardwareBackHandlers.splice(index, 1);
                        },
                    };
                }),
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => null,
            useForkedTranscriptSnapshot: () => null,
            useSessionTranscriptIds: () => ({ ids: transcriptState.ids, isLoaded: true }),
            useSessionMessagesById: () => transcriptState.messagesById,
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionCompanionPreferenceSlot: () => ({ storageKey: null, stored: undefined }),
        });
    },
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => '/session/session-1',
        navigation: { addListener: () => () => {} },
    }).module;
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        NavigationContainer: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
        NavigationIndependentTree: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
        useIsFocused: () => React.useContext(CockpitNavigatorFocusContext),
    };
});

vi.mock('@react-navigation/bottom-tabs', () => ({
    createBottomTabNavigator: () => ({
        Navigator: ({ children, initialRouteName, tabBar }: React.PropsWithChildren<Readonly<{
            initialRouteName?: string;
            tabBar?: (props: {
                state: { index: number; routes: Array<{ key: string; name: string }> };
                navigation: { emit: () => { defaultPrevented: boolean }; navigate: (name: string) => void };
            }) => React.ReactNode;
        }>>) => {
            const screens = React.Children.toArray(children).filter(React.isValidElement);
            const routes = screens.map((screen) => {
                const name = String((screen.props as { name: string }).name);
                return { key: name, name };
            });
            const initial = initialRouteName && routes.some((route) => route.name === initialRouteName)
                ? initialRouteName
                : routes[0]?.name ?? 'chat';
            const [activeSurface, setActiveSurface] = React.useState(initial);
            const historyRef = React.useRef([initial]);
            const navigate = React.useCallback((name: string) => {
                if (!routes.some((route) => route.name === name)) return;
                setActiveSurface((current) => {
                    if (current === name) return current;
                    historyRef.current = [...historyRef.current, name];
                    return name;
                });
            }, [routes.map((route) => route.name).join('\u0000')]);
            const goBack = React.useCallback(() => {
                setActiveSurface((current) => {
                    if (historyRef.current.length <= 1) return current;
                    historyRef.current = historyRef.current.slice(0, -1);
                    return historyRef.current.at(-1) ?? current;
                });
            }, []);
            cockpitNavigatorState.activeSurface = activeSurface;
            cockpitNavigatorState.goBack = goBack;
            const navigation = {
                canGoBack: () => historyRef.current.length > 1,
                emit: () => ({ defaultPrevented: false }),
                goBack,
                navigate,
            };
            const activeIndex = Math.max(0, routes.findIndex((route) => route.name === activeSurface));
            return React.createElement(React.Fragment, null, [
                ...screens.map((screen, index) => {
                    const render = (screen.props as { children?: (input: { navigation: typeof navigation }) => React.ReactNode }).children;
                    const route = routes[index];
                    return React.createElement(
                        CockpitNavigatorFocusContext.Provider,
                        { key: route?.key ?? String(index), value: route?.name === activeSurface },
                        render?.({ navigation }),
                    );
                }),
                React.createElement(React.Fragment, { key: 'tab-bar' }, tabBar?.({
                    state: { index: activeIndex, routes },
                    navigation,
                })),
            ]);
        },
        Screen: () => null,
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: Record<string, unknown> & { contentOverride?: React.ReactNode }) => {
        const [composerDraft, setComposerDraft] = React.useState('');
        return React.createElement(
            'SessionView',
            { ...props, composerDraft, setComposerDraft },
            props.contentOverride ?? null,
        );
    },
}));
vi.mock('@/components/sessions/companion/SessionCompanionScreen', () => ({
    SessionCompanionScreen: (props: Record<string, unknown>) => React.createElement('SessionCompanionScreen', props),
}));
vi.mock('@/components/sessions/board/SessionBoardPane', async () => {
    const { useSessionCompanionRevealPort } = await import(
        '@/components/sessions/companion/presentation/SessionCompanionRevealPort'
    );
    const { useSessionBoardContinuity } = await import(
        '@/components/sessions/board/SessionBoardContinuity'
    );
    return {
        SessionBoardPane: (props: Record<string, unknown>) => {
            const serverId = typeof props.serverId === 'string' ? props.serverId : null;
            const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
            const companionRevealPort = useSessionCompanionRevealPort(
                serverId && sessionId ? { serverId, sessionId } : null,
            );
            const continuity = useSessionBoardContinuity(
                serverId && sessionId ? { serverId, sessionId } : null,
            );
            return React.createElement('SessionBoardPane', { ...props, companionRevealPort, continuity });
        },
    };
});
vi.mock('@/components/sessions/board/SessionBoardControllerProvider', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/board/SessionBoardControllerProvider')>();
    const { SessionBoardContinuityProvider } = await import(
        '@/components/sessions/board/SessionBoardContinuity'
    );
    return {
        // The presented-surface target reads the real mounted-controller hook; this
        // stand-in provider mounts no controller, so the real hook answers null.
        ...actual,
        SessionBoardControllerProvider: ({ children, sessionId, serverId }: React.PropsWithChildren<Readonly<{
            sessionId: string;
            serverId?: string | null;
        }>>) => React.createElement(
            SessionBoardContinuityProvider,
            { key: JSON.stringify([serverId ?? null, sessionId]), sessionId, serverId },
            children,
        ),
    };
});
// Sibling cockpit surfaces are irrelevant here and pull very large module graphs.
vi.mock('@/components/sessions/panes/SessionDetailsPanel', () => ({
    SessionDetailsPanel: (props: Record<string, unknown>) => React.createElement('SessionDetailsPanel', props),
}));
vi.mock('@/components/sessions/panes/surfaces/SessionBrowseFilesSurface', () => ({
    SessionBrowseFilesSurface: (props: Record<string, unknown>) => React.createElement('SessionBrowseFilesSurface', props),
}));
vi.mock('@/components/sessions/panes/surfaces/SessionGitSurface', () => ({
    SessionGitSurface: (props: Record<string, unknown>) => React.createElement('SessionGitSurface', props),
}));
vi.mock('@/components/sessions/panes/surfaces/SessionTerminalSurface', () => ({
    SessionTerminalSurface: (props: Record<string, unknown>) => React.createElement('SessionTerminalSurface', props),
}));
vi.mock('@/components/browser/surfaces/BrowserMobileSurfaceScreen', () => ({
    BrowserMobileSurfaceScreen: (props: Record<string, unknown>) => React.createElement('BrowserMobileSurfaceScreen', props),
}));
// A bundler-only platform require that Node's loader cannot resolve in this run.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
vi.mock('@/components/sessions/collaboration/SessionCollaborationSurface', () => ({
    SessionCollaborationSurface: (props: Record<string, unknown>) => React.createElement('SessionCollaborationSurface', props),
}));
vi.mock('./SessionServicesSurfaceScreen', () => ({
    SessionServicesSurfaceScreen: (props: Record<string, unknown>) => React.createElement('SessionServicesSurfaceScreen', props),
}));
vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementHost', props),
}));
vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => cockpitPluginProjectionState.value,
}));
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useDeviceType: () => cockpitDeviceType.value,
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => null,
}));
vi.mock('@/components/sessions/localServices/useServicesOpenInBrowser', () => ({
    useServicesOpenInBrowser: () => () => {},
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: (target: unknown) => {
        sessionMachineTargetCalls.push(target);
        return { machineId: 'machine-1', basePath: '/repo' };
    },
}));
vi.mock('@/components/sessions/plugins/useSessionPluginRuntime', () => ({
    useSessionPluginRuntime: ({ address }: { address: { serverId: string; sessionId: string } | null }) => {
        const runtime = Object.freeze({
            ...cockpitPluginProjectionState.value,
            machineId: address ? 'machine-1' : null,
            serverId: address?.serverId ?? null,
        });
        if (address?.serverId === 'server-1' && address.sessionId === 'session-1') {
            canonicalSessionPluginRuntime.values.push(runtime);
        }
        return runtime;
    },
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));
vi.mock('@/components/appShell/panes/hooks/useDetailsTabCount', () => ({
    useDetailsTabCount: () => 0,
}));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/store/hooks', async () => {
    const { createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return {
    useLocalSetting: createUseLocalSettingMock(),
    useActiveServerAccountScope: () => null,
    useOpenApprovalArtifactsForSession: (target: { serverId: string; sessionId: string } | null) => {
        approvalSessionTargets.push(target);
        return [];
    },
    };
});
vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistoryRemoteEntries: () => ({
        rows: [],
        hasMore: false,
        nextBeforeSeq: null,
        pagesLoaded: 0,
        pendingEncryption: false,
        requestNextPage: () => {},
    }),
}));

const SCREEN_TEST_ID = 'session-transcript-navigation-screen';
const ENTRY_TEST_ID = 'session-transcript-navigation-entry:session-1:user-turn:3';

function userMessage(id: string, seq: number, text: string): Message {
    return {
        id,
        localId: null,
        seq,
        createdAt: seq * 1000,
        kind: 'user-text',
        text,
        displayText: text,
    } as unknown as Message;
}

function seedTranscript() {
    const messages = [userMessage('m3', 3, 'Run the tests')];
    transcriptState.ids = messages.map((message) => message.id);
    transcriptState.messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
}

/**
 * Mirrors the cockpit tab navigator: it owns the visible surface, so a switch really does
 * unmount the navigation surface the way it does on the phone.
 *
 * Built lazily: the module mocks above are only installed once this file's body has run,
 * so the cockpit tree must not be imported from the static import list.
 */
const REVIEW_PLUGIN_ID = 'acme.review';
const REVIEW_PLUGIN_SURFACE = `plugin:${REVIEW_PLUGIN_ID}:review-panel` as SessionMobileSurface;

function createCockpitPluginProjection(input: Readonly<{
    includePhoneRejectedRightPane?: boolean;
}> = {}) {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: REVIEW_PLUGIN_ID,
        destinationId: 'review-panel',
        rendererId: 'review-panel',
        container: 'rightSidebarTab',
        target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    if (!binding) throw new Error('cockpit plugin fixture must be admitted');
    const placement = {
        id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel`,
        pluginId: REVIEW_PLUGIN_ID,
        contributionKind: 'surfacePlacement' as const,
        descriptorId: 'review-panel',
        occurrenceId: 'review-install-occurrence',
        binding,
        target: binding.target,
        renderer: { kind: 'reactNative' as const, contributionId: 'review-panel' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
        hostOrigin: {
            machineId: 'machine-1',
            serverId: 'server-1',
            generation: 4,
            interactionEnabled: true,
            // The canonical union producer stamps projection phase; currentness
            // is never inferred from the model or the interaction boolean.
            phase: 'current',
            executionOrigin: {
                serverIdentityId: 'srv_account_one',
                materializationRef: {
                    pluginId: REVIEW_PLUGIN_ID,
                    machineId: 'machine-1',
                    materializationId: 'review-install-a',
                },
            } satisfies PluginMachineExecutionOriginV1,
        },
    };
    const rejectedPaneBinding = input.includePhoneRejectedRightPane
        ? normalizePluginUiDestinationBindingV1({
            pluginId: REVIEW_PLUGIN_ID,
            destinationId: 'review-pane',
            rendererId: 'review-pane',
            container: 'rightPane',
            target: { kind: 'session', sessionIdPath: '/session/id' },
            instancePolicy: 'multiple',
        })
        : null;
    if (input.includePhoneRejectedRightPane && !rejectedPaneBinding) {
        throw new Error('cockpit rejected-pane fixture must be admitted before runtime form-factor filtering');
    }
    const rejectedPanePlacement = rejectedPaneBinding
        ? {
            ...placement,
            id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-pane`,
            descriptorId: 'review-pane',
            binding: rejectedPaneBinding,
            target: rejectedPaneBinding.target,
            renderer: { kind: 'reactNative' as const, contributionId: 'review-pane' },
        }
        : null;
    return Object.freeze({
        generation: 4,
        translationsByPluginId: Object.freeze({}),
        sessionHeaderActionsById: Object.freeze({}),
        hostedWebById: Object.freeze({}),
        reactNativeBundlesById: Object.freeze({}),
        surfacePlacementsById: Object.freeze({
            [placement.id]: placement,
            ...(rejectedPanePlacement ? { [rejectedPanePlacement.id]: rejectedPanePlacement } : {}),
        }),
        unknownEntriesById: Object.freeze({}),
    });
}

async function loadCockpitHarness(): Promise<React.ComponentType<Readonly<{
    events: string[];
    initialSurface?: SessionMobileSurface;
}>>> {
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { SessionCockpitSurfaceNavigationProvider } = await import('./SessionCockpitSurfaceNavigation');
    const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
    const { PluginSurfacePaneLaunchScope } = await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
    const { SessionBoardContinuityProvider } = await import('@/components/sessions/board/SessionBoardContinuity');

    return function CockpitHarness(props: Readonly<{
        events: string[];
        initialSurface?: SessionMobileSurface;
    }>) {
        const [surface, setSurface] = React.useState<SessionMobileSurface>(props.initialSurface ?? 'navigation');
        const switchSurface = React.useCallback((next: SessionMobileSurface) => {
            props.events.push(`surface:${next}`);
            setSurface(next);
        }, [props.events]);

        return (
            <AppPaneProvider>
                <SessionCockpitChromeRegistryProvider>
                    <SessionCockpitSurfaceNavigationProvider value={{ switchSurface, returnToPreviousSurface: () => switchSurface('chat') }}>
                        <PluginSurfacePaneLaunchScope>
                            <SessionBoardContinuityProvider sessionId="session-1" serverId="server-1">
                                <SessionCockpitSurfaceScreen
                                    sessionId="session-1"
                                    routeHydrationState={{ kind: 'available', sessionId: 'session-1', serverId: 'server-1' }}
                                    scopeId="session:session-1"
                                    surface={surface}
                                    terminalTabAvailable={false}
                                />
                            </SessionBoardContinuityProvider>
                        </PluginSurfacePaneLaunchScope>
                    </SessionCockpitSurfaceNavigationProvider>
                </SessionCockpitChromeRegistryProvider>
            </AppPaneProvider>
        );
    };
}

/**
 * Publishes the exact Home's `sessions.board` answer through the canonical
 * feature owner. Board and Companion are one Lane 08 destination family, so the
 * same bit decides both; nothing here mocks the decision hook.
 */
async function primeSessionBoardFeature(enabled: boolean): Promise<void> {
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol');
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', enabled)) {
        throw new Error('The sessions.board bit could not be written by its own writer');
    }
    primeServerFeaturesSnapshot({ serverId: 'server-1', snapshot: { status: 'ready', features } });
}

describe('SessionCockpitSurfaceScreen navigation surface', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        standardCleanup();
        persistedStorage.clear();
        seedTranscript();
        await primeSessionBoardFeature(true);
        cockpitPluginProjectionState.value = {
            pluginUiProjection: null,
            machineId: null,
            serverId: null,
            interactionEnabled: false,
            platform: 'web',
            phase: 'establishing',
        };
        cockpitDeviceType.value = 'phone';
        approvalSessionTargets.length = 0;
        sessionMachineTargetCalls.length = 0;
        canonicalSessionPluginRuntime.values = [];
        cockpitNavigatorState.activeSurface = 'chat';
        cockpitNavigatorState.goBack = null;
        cockpitNavigatorState.hardwareBackHandlers = [];
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        transcriptNavigationPaneStore.set('session-1', null);
    });

    it('routes repeated Companion work reveals to the separate Chat scene without losing its draft', async () => {
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
        const { SessionCockpitShell } = await import('./SessionCockpitShell');
        const renderNavigator = (serverId: string, sessionId: string) => (
            <AppPaneProvider>
                <SessionCockpitChromeRegistryProvider>
                    <SessionCockpitShell
                        surface="companion"
                        routeServerId={serverId}
                        scopeId={`session:${sessionId}`}
                        sessionId={sessionId}
                        terminalTabAvailable={false}
                    />
                </SessionCockpitChromeRegistryProvider>
            </AppPaneProvider>
        );
        const screen = await renderScreen(renderNavigator('server-1', 'session-1'));
        const companion = screen.tree.findByType('SessionCompanionScreen' as never);
        const destinations = companion.props.summaryDestinations as Readonly<{ work: () => void }>;
        const chatScene = screen.findByTestId('session-cockpit-scene:chat');
        if (!chatScene) throw new Error('The production navigator did not mount Chat');
        const readChat = () => chatScene.findByType('SessionView' as never);
        expect(readChat().props.openWorkStateRequestKey).toBeNull();

        await act(async () => destinations.work());

        expect(cockpitNavigatorState.activeSurface).toBe('chat');
        expect(readChat().props.openWorkStateRequestKey).toBe(1);
        expect(approvalSessionTargets.at(-1)).toEqual({ serverId: 'server-1', sessionId: 'session-1' });

        await act(async () => readChat().props.setComposerDraft('keep my draft'));
        await act(async () => cockpitNavigatorState.goBack?.());
        expect(cockpitNavigatorState.activeSurface).toBe('companion');
        await act(async () => destinations.work());

        expect(cockpitNavigatorState.activeSurface).toBe('chat');
        expect(readChat().props.openWorkStateRequestKey).toBe(2);
        expect(readChat().props.composerDraft).toBe('keep my draft');

        await screen.update(renderNavigator(' server-1 ', 'session-1'));
        expect(readChat().props.composerDraft).toBe('keep my draft');
        expect(readChat().props.openWorkStateRequestKey).toBe(2);

        await screen.update(renderNavigator('server-2', 'session-1'));
        expect(screen.findByTestId('session-cockpit-scene:chat')?.findByType('SessionView' as never).props.openWorkStateRequestKey).toBeNull();
        await act(async () => screen.tree.findByType('SessionCompanionScreen' as never).props.summaryDestinations.work());
        await screen.update(renderNavigator('server-2', 'session-2'));
        expect(screen.findByTestId('session-cockpit-scene:chat')?.findByType('SessionView' as never).props.openWorkStateRequestKey).toBeNull();
    });

    it('mounts Board and Companion through the resolved exact Home when the route has no server hint', async () => {
        const CockpitHarness = await loadCockpitHarness();
        const boardScreen = await renderScreen(
            <CockpitHarness events={[]} initialSurface={'board' as SessionMobileSurface} />,
        );
        const board = boardScreen.tree.findByType('SessionBoardPane' as never);

        expect(board.props.serverId).toBe('server-1');
        expect(sessionMachineTargetCalls.at(-1)).toEqual({ serverId: 'server-1', sessionId: 'session-1' });
        expect(board.props.pluginRuntime).toBeUndefined();
        expect(board.props.callerHostedHtmlRuntime).toBeUndefined();
        expect(canonicalSessionPluginRuntime.values)
            .toContain(boardScreen.tree.findByType('SessionView' as never).props.sessionPluginRuntime);

        standardCleanup();
        const companionScreen = await renderScreen(
            <CockpitHarness events={[]} initialSurface={'companion' as SessionMobileSurface} />,
        );
        expect(companionScreen.tree.findByType('SessionCompanionScreen' as never).props.address)
            .toEqual({ serverId: 'server-1', sessionId: 'session-1' });
    });

    it('serves a retained Companion destination on a Home without Board', async () => {
        // Companion has no feature bit of its own and its first-party Session
        // Summary is composed from Session facts alone, so a Home whose
        // `sessions.board` answer is missing, malformed or false still opens the
        // destination. Only the Board content it can present follows that answer.
        await primeSessionBoardFeature(false);
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(
            <CockpitHarness events={[]} initialSurface={'companion' as SessionMobileSurface} />,
        );

        expect(screen.findByTestId('session-companion-screen')).toBeTruthy();
        expect(screen.findByTestId('session-board-screen')).toBeNull();
    });

    it('keeps the Companion route mounted across a live Board decision change', async () => {
        // The canonical feature owner publishes a new answer for this exact Home
        // while the Companion destination is the current route. Companion stays
        // in place on every answer; the Board destination is the one that follows.
        const CockpitHarness = await loadCockpitHarness();
        await primeSessionBoardFeature(false);
        const screen = await renderScreen(
            <CockpitHarness events={[]} initialSurface={'companion' as SessionMobileSurface} />,
        );
        expect(screen.findByTestId('session-companion-screen')).toBeTruthy();

        await act(async () => { await primeSessionBoardFeature(true); });
        expect(screen.findByTestId('session-companion-screen')).toBeTruthy();

        await act(async () => { await primeSessionBoardFeature(false); });
        expect(screen.findByTestId('session-companion-screen')).toBeTruthy();
    });

    it('publishes the exact mobile Companion reveal destination to the Board host', async () => {
        const events: string[] = [];
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(
            <CockpitHarness events={events} initialSurface={'board' as SessionMobileSurface} />,
        );
        const board = screen.tree.findByType('SessionBoardPane' as never);
        const port = board.props.companionRevealPort;

        expect(port?.address).toEqual({ serverId: 'server-1', sessionId: 'session-1' });
        await act(async () => port?.revealAfterMutation({
            previous: {
                v: 1,
                visible: false,
                collapsed: false,
                edge: 'trailing',
                density: 'comfortable',
                items: [],
            },
            applied: {
                v: 1,
                visible: true,
                collapsed: false,
                edge: 'trailing',
                density: 'comfortable',
                items: [{ kind: 'widget', widgetId: 'item-1' }],
            },
        }));

        expect(events).toContain('surface:companion');
        expect(screen.tree.findByType('SessionCompanionScreen' as never).props.address)
            .toEqual({ serverId: 'server-1', sessionId: 'session-1' });
    });

    it('keeps an expanded Board item in the mobile Board surface and returns to the same Board', async () => {
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(
            <CockpitHarness events={[]} initialSurface={'board' as SessionMobileSurface} />,
        );
        let board = screen.tree.findByType('SessionBoardPane' as never);

        await act(async () => board.props.onReadFullItem('item-1'));
        board = screen.tree.findByType('SessionBoardPane' as never);
        expect(board.props.focusedItemId).toBe('item-1');

        await act(async () => board.props.onLeaveFocusedItem());
        board = screen.tree.findByType('SessionBoardPane' as never);
        expect(board.props.focusedItemId).toBeNull();
        expect(screen.findByTestId('session-board-screen')).toBeTruthy();
    });

    it('reveals the exact Companion item when switching to the mobile Board', async () => {
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(
            <CockpitHarness events={[]} initialSurface={'companion' as SessionMobileSurface} />,
        );
        const companion = screen.tree.findByType('SessionCompanionScreen' as never);

        await act(async () => companion.props.onRevealBoardItem('item-1'));

        const board = screen.tree.findByType('SessionBoardPane' as never);
        expect(board.props.focusedItemId).toBe('item-1');
        expect(screen.findByTestId('session-board-screen')).toBeTruthy();
    });

    it('shares focused-item continuity across the production multi-scene navigator and clears it before Board Back', async () => {
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol');
        const features = createRootLayoutFeaturesResponse();
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) {
            throw new Error('The sessions.board bit could not be written by its own writer');
        }
        primeServerFeaturesSnapshot({ serverId: 'server-1', snapshot: { status: 'ready', features } });
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = (serverId: string, sessionId: string) => (
            <AppPaneProvider>
                <SessionCockpitChromeRegistryProvider>
                    <SessionCockpitTabNavigator
                        initialSurface="chat"
                        routeServerId={serverId}
                        scopeId={`session:${sessionId}`}
                        sessionId={sessionId}
                        terminalTabAvailable={false}
                    />
                </SessionCockpitChromeRegistryProvider>
            </AppPaneProvider>
        );
        const screen = await renderScreen(renderNavigator('server-1', 'session-1'));
        let board = screen.tree.findByType('SessionBoardPane' as never);
        const companion = screen.tree.findByType('SessionCompanionScreen' as never);
        const chatScene = screen.findByTestId('session-cockpit-scene:chat');
        if (!chatScene) throw new Error('The production navigator did not mount the retained Chat scene');
        const continuity = board.props.continuity;
        const removalFocusRequest = { removedViewId: 'view-removed', requestId: 7 };

        await act(async () => {
            continuity.viewSelection.request('view-2');
            continuity.controller.viewRemovalFocusRequest[1](removalFocusRequest);
            continuity.editorDrafts.write('note:item-1', 'draft body');
            continuity.presentationPositions.write('mobileCockpit:view-2', {
                anchorItemId: 'item-1',
                offsetWithinItem: 12,
                absoluteOffset: 180,
            });
            chatScene.findByType('SessionView' as never).props.setComposerDraft('composer draft');
        });

        await act(async () => companion.props.onRevealBoardItem('item-1'));

        board = screen.tree.findByType('SessionBoardPane' as never);
        expect(cockpitNavigatorState.activeSurface).toBe('board');
        expect(board.props.focusedItemId).toBe('item-1');
        expect(board.props.continuity.viewSelection.read()).toBe('view-2');
        expect(board.props.continuity.controller.viewRemovalFocusRequest[0]).toEqual(removalFocusRequest);
        expect(board.props.continuity.editorDrafts.read('note:item-1')).toBe('draft body');
        expect(board.props.continuity.presentationPositions.read('mobileCockpit:view-2')).toEqual({
            anchorItemId: 'item-1',
            offsetWithinItem: 12,
            absoluteOffset: 180,
        });
        expect(chatScene.findByType('SessionView' as never).props.composerDraft).toBe('composer draft');

        await act(async () => {
            expect(cockpitNavigatorState.hardwareBackHandlers.at(-1)?.()).toBe(true);
        });
        board = screen.tree.findByType('SessionBoardPane' as never);
        expect(board.props.focusedItemId).toBeNull();
        expect(cockpitNavigatorState.activeSurface).toBe('board');

        await act(async () => cockpitNavigatorState.goBack?.());
        expect(cockpitNavigatorState.activeSurface).toBe('chat');
        expect(chatScene.findByType('SessionView' as never).props.composerDraft).toBe('composer draft');

        act(() => {
            primeServerFeaturesSnapshot({ serverId: 'server-2', snapshot: { status: 'ready', features } });
        });
        await screen.update(renderNavigator('server-2', 'session-1'));
        board = screen.tree.findByType('SessionBoardPane' as never);
        expect(board.props.focusedItemId).toBeNull();
        expect(board.props.continuity.address).toEqual({ serverId: 'server-2', sessionId: 'session-1' });
        expect(board.props.continuity.viewSelection.read()).toBeNull();
        expect(board.props.continuity.editorDrafts.read('note:item-1')).toBeNull();
        expect(board.props.continuity.presentationPositions.read('mobileCockpit:view-2')).toBeNull();

        await act(async () => {
            screen.tree.findByType('SessionCompanionScreen' as never).props.onRevealBoardItem('item-2');
        });
        expect(screen.tree.findByType('SessionBoardPane' as never).props.focusedItemId).toBe('item-2');

        await screen.update(renderNavigator('server-2', 'session-2'));
        board = screen.tree.findByType('SessionBoardPane' as never);
        expect(board.props.focusedItemId).toBeNull();
        expect(board.props.continuity.address).toEqual({ serverId: 'server-2', sessionId: 'session-2' });
    });

    it('keeps a restoring plugin cockpit destination loading only while projection establishment is active', async () => {
        const CockpitHarness = await loadCockpitHarness();
        const establishing = await renderScreen(
            <CockpitHarness events={[]} initialSurface={REVIEW_PLUGIN_SURFACE} />,
        );

        expect(establishing.findByTestId('plugin-rn-ui-unavailable')).toBeNull();

        standardCleanup();
        cockpitPluginProjectionState.value = {
            ...cockpitPluginProjectionState.value,
            phase: 'unavailable',
        };
        const settled = await renderScreen(
            <CockpitHarness events={[]} initialSurface={REVIEW_PLUGIN_SURFACE} />,
        );

        expect(settled.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();

        standardCleanup();
        cockpitPluginProjectionState.value = {
            ...cockpitPluginProjectionState.value,
            phase: 'retainedOffline',
        };
        const retainedWithoutDestination = await renderScreen(
            <CockpitHarness events={[]} initialSurface={REVIEW_PLUGIN_SURFACE} />,
        );
        expect(retainedWithoutDestination.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
    });

    it('keeps an exact retained-offline plugin destination mounted but interaction-disabled', async () => {
        cockpitPluginProjectionState.value = {
            pluginUiProjection: createCockpitPluginProjection(),
            machineId: 'machine-1',
            serverId: 'server-1',
            interactionEnabled: false,
            platform: 'web',
            phase: 'retainedOffline',
        };
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(
            <CockpitHarness events={[]} initialSurface={REVIEW_PLUGIN_SURFACE} />,
        );

        expect(screen.tree.findByType('PluginSurfacePlacementHost' as never).props)
            .toMatchObject({ projectionInteractionEnabled: false });
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
    });

    it('renders the session timeline with no transcript host mounted for the session', async () => {
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={[]} />);

        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeTruthy();
        expect(screen.findByTestId(ENTRY_TEST_ID)).toBeTruthy();
        expect(screen.getTextContent()).toContain('Run the tests');
        // The surface replaces the transcript subtree, so nothing registered a jump handler.
        expect(transcriptNavigationPaneStore.get('session-1').onEntryPress).toBeNull();
    });

    it('reveals the chat surface before the transcript jump runs', async () => {
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        const events: string[] = [];
        const jumped: Array<{ id: string; seq: number | null }> = [];
        const onEntryPress = vi.fn((entry: { id: string; seq: number | null }) => {
            events.push('jump');
            jumped.push(entry);
            return { status: 'scrolled' as const };
        });

        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={events} />);
        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeTruthy();

        await screen.pressByTestIdAsync(ENTRY_TEST_ID);

        // The surface really switched, so the navigation screen is gone and the transcript
        // scene is the visible one before anything scrolls it.
        expect(events).toEqual(['surface:chat']);
        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeNull();
        expect(onEntryPress).not.toHaveBeenCalled();

        // The revealed (un-frozen) transcript host republishes its jump handler.
        await act(async () => {
            transcriptNavigationPaneStore.set('session-1', { onEntryPress });
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(onEntryPress).toHaveBeenCalledTimes(1);
        expect(jumped[0]).toMatchObject({ id: 'session-1:user-turn:3', seq: 3 });
        expect(events).toEqual(['surface:chat', 'jump']);
    });

    it('wears the phone pane header as its only header, with no nested close of its own', async () => {
        const events: string[] = [];
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={events} />);

        // B21 + lab Np: the large title is the surface header; leaving is the navigation bar's back
        // (or Escape, below), never a second close inside the body.
        expect(screen.findByTestId(`${SCREEN_TEST_ID}:header`)).not.toBeNull();
        expect(screen.findByTestId('session-transcript-navigation-close')).toBeNull();
        expect(events).toEqual([]);
    });

    it('exits the navigation surface on Escape from the timeline', async () => {
        const events: string[] = [];
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={events} />);

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('session-transcript-navigation-entry-list'),
                'onKeyDown',
                { nativeEvent: { key: 'Escape' }, preventDefault: () => {} },
            );
        });

        expect(events).toEqual(['surface:chat']);
        expect(screen.findByTestId(SCREEN_TEST_ID)).toBeNull();
    });

    it('routes a mounted cockpit plugin tab through the shared qualified resolver', async () => {
        cockpitPluginProjectionState.value = {
            pluginUiProjection: createCockpitPluginProjection(),
            machineId: 'machine-1',
            serverId: 'server-1',
            interactionEnabled: true,
            platform: 'web',
            phase: 'current',
        };
        const events: string[] = [];
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(
            <CockpitHarness events={events} initialSurface={REVIEW_PLUGIN_SURFACE} />,
        );
        const host = screen.tree.findByType('PluginSurfacePlacementHost' as never);
        const openSurface = host.props.binding?.openSurface as undefined | ((request: Readonly<{
            destination: { pluginId: string; localId: string };
            input?: unknown;
        }>) => Promise<unknown> | unknown);

        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('cockpit mount did not receive an openSurface handler');
        await act(async () => {
            await expect(openSurface({
                destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'review-panel' },
                input: { issueId: '42' },
            })).resolves.toEqual({ ok: true });
        });

        expect(events).toEqual([`surface:${REVIEW_PLUGIN_SURFACE}`]);
        expect(screen.tree.findByType('PluginSurfacePlacementHost' as never).props.launchInput)
            .toEqual({ issueId: '42' });
    });

    it('rejects a desktop/tablet Session pane before a phone cockpit delegates to an unavailable owner', async () => {
        cockpitPluginProjectionState.value = {
            pluginUiProjection: createCockpitPluginProjection({ includePhoneRejectedRightPane: true }),
            machineId: 'machine-1',
            serverId: 'server-1',
            interactionEnabled: true,
            platform: 'ios',
            phase: 'current',
        };
        const events: string[] = [];
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(
            <CockpitHarness events={events} initialSurface={REVIEW_PLUGIN_SURFACE} />,
        );
        const host = screen.tree.findByType('PluginSurfacePlacementHost' as never);
        const openSurface = host.props.binding?.openSurface as undefined | ((request: Readonly<{
            destination: { pluginId: string; localId: string };
            instanceKey?: string;
        }>) => Promise<unknown> | unknown);

        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('cockpit mount did not receive an openSurface handler');
        await expect(openSurface({
            destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'review-pane' },
            instanceKey: 'issue-42',
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_platform_unavailable',
        });
        expect(events).toEqual([]);
    });

});

describe('SessionCockpitSurfaceScreen collaboration surface', () => {
    beforeEach(async () => {
        standardCleanup();
        persistedStorage.clear();
        seedTranscript();
        cockpitPluginProjectionState.value = {
            pluginUiProjection: null,
            machineId: null,
            serverId: null,
            interactionEnabled: false,
            platform: 'web',
            phase: 'establishing',
        };
        cockpitDeviceType.value = 'phone';
    });

    /** Publishes what this Home serves through the canonical feature owner. */
    async function primeSessionSharing(enabled: boolean, publicLinkEnabled: boolean = enabled) {
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol');
        const features = createRootLayoutFeaturesResponse();
        for (const feature of ['sharing.session'] as const) {
            if (!tryWriteServerEnabledBitInPlace(features, feature, enabled)) {
                throw new Error(`The ${feature} bit could not be written by its own writer`);
            }
        }
        if (!tryWriteServerEnabledBitInPlace(features, 'sharing.public', publicLinkEnabled)) {
            throw new Error('The sharing.public bit could not be written by its own writer');
        }
        primeServerFeaturesSnapshot({ serverId: 'server-1', snapshot: { status: 'ready', features } });
    }

    it('mounts the canonical Collaboration surface for a Home that serves it', async () => {
        await primeSessionSharing(true);
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={[]} initialSurface={'collaboration' as SessionMobileSurface} />);

        expect(screen.findByTestId('session-collaboration-screen')).toBeTruthy();
    });

    it('falls through to the Session surface host when this Home serves no collaboration child at all', async () => {
        await primeSessionSharing(false);
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={[]} initialSurface={'collaboration' as SessionMobileSurface} />);

        // A retained or deep-linked Collaboration destination on a Home without any
        // supported child must land on the same host every other unsupported surface
        // uses, never on an empty full-screen shell.
        expect(screen.findByTestId('session-collaboration-screen')).toBeNull();
        expect(screen.findByTestId('session-details-screen')).toBeTruthy();
    });

    it('keeps the destination for a Home that serves publication but not named access', async () => {
        // Publication is separately shippable and has no other entry point, so
        // named access being off cannot retire the whole destination.
        await primeSessionSharing(false, true);
        const CockpitHarness = await loadCockpitHarness();
        const screen = await renderScreen(<CockpitHarness events={[]} initialSurface={'collaboration' as SessionMobileSurface} />);

        expect(screen.findByTestId('session-collaboration-screen')).toBeTruthy();
    });
});
