import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import type {
    OnboardingWizardController,
    OnboardingWizardSurfaceProps,
} from '@/components/onboarding/surfaces/useOnboardingWizardController';
import { JourneyConfigSlot } from '@/components/onboarding/tour/config/JourneyConfigSlot';
import { stageSurfaceById } from '@/components/onboarding/tour/stage/stageSurfaces';
import { DEMO_RICH_SESSION_ID } from '@/demoMode/world/buildDemoWorld';
import { flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';
import { getDemoFirewallDenyLog, installDemoFirewall, resetDemoFirewallForTests, uninstallDemoFirewall } from '@/demoMode/guards/demoFirewall';
import { clearDemoWorld, seedDemoWorld } from '@/demoMode/seed/seedDemoWorld';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerState = vi.hoisted(() => ({
    pathname: '/',
    params: {} as ExpoRouterParams,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    AuthProvider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 'demo-token', secret: 'demo-secret' },
        login: vi.fn(),
        loginWithCredentials: vi.fn(),
        logout: vi.fn(),
        refreshFromActiveServer: vi.fn(),
    }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const ReactModule = await import('react');
    return createReactNativeWebMock({
        FlatList: (props: Record<string, unknown> & {
            data?: readonly unknown[];
            keyExtractor?: (item: unknown, index: number) => string;
            renderItem?: (params: { item: unknown; index: number }) => React.ReactNode;
        }) => ReactModule.createElement(
            'FlatList',
            props,
            ...(props.data ?? []).map((item, index) => ReactModule.createElement(
                'FlatListItem',
                { key: props.keyExtractor?.(item, index) ?? String(index) },
                props.renderItem?.({ item, index }) ?? null,
            )),
        ),
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options?.web ?? options?.default,
        },
        Pressable: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode) }) => (
            ReactModule.createElement('Pressable', props, typeof children === 'function' ? children({ pressed: false }) : children)
        ),
        useWindowDimensions: () => ({ width: 1280, height: 820 }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/text/i18n', () => ({
    setPreferredLanguageFromSettings: vi.fn(),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: routerState.pathname,
        params: routerState.params,
        router: {
            push: routerPushSpy,
            back: vi.fn(),
            navigate: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
    }).module;
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useNavigation: () => ({
            addListener: () => () => undefined,
            getParent: () => null,
            isFocused: () => true,
            navigate: vi.fn(),
            setOptions: vi.fn(),
        }),
    };
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaInsetsContext: {
        Provider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    },
    SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => null,
}));

vi.mock('expo-application', () => ({
    applicationId: 'dev.happier.demo',
    nativeApplicationVersion: '0.0.0-demo',
    nativeBuildVersion: '0',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: {}, manifest: null },
}));

vi.mock('expo-updates', () => ({
    isEnabled: false,
}));

vi.mock('expo-haptics', () => ({
    impactAsync: vi.fn(async () => undefined),
    selectionAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-audio', () => ({
    AudioModule: {},
    RecordingPresets: {},
    createAudioPlayer: vi.fn(() => null),
}));

vi.mock('expo-file-system', () => ({
    File: class File {},
    Paths: { cache: '/tmp' },
}));

vi.mock('expo-video', () => ({
    useVideoPlayer: () => null,
    VideoView: 'VideoView',
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-reanimated/lib/module', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-reanimated/lib/module/index.js', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-reanimated/lib/module/index', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    KeyboardProvider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    KeyboardStickyView: 'KeyboardStickyView',
    useFocusedInputHandler: vi.fn(),
    useKeyboardHandler: vi.fn(),
    useKeyboardState: () => ({ height: 0, isVisible: false }),
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
}));

vi.mock('react-native-view-shot', () => ({
    captureRef: vi.fn(async () => 'data:image/png;base64,demo'),
    releaseCapture: vi.fn(),
}));

vi.mock('react-native-svg', () => ({
    __esModule: true,
    default: 'Svg',
    Circle: 'Circle',
    G: 'G',
    Line: 'Line',
    Path: 'Path',
    Rect: 'Rect',
    Svg: 'Svg',
    SvgXml: 'SvgXml',
}));

vi.mock('@/track', () => ({
    trackFriendsSearch: vi.fn(),
    trackLogout: vi.fn(),
    tracking: false,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

const AppPaneProviderWrapper: React.ComponentType<React.PropsWithChildren> = ({ children }) => (
    <AppPaneProvider>{children ?? null}</AppPaneProvider>
);

async function mountSeededSurface(element: React.ReactElement): Promise<Awaited<ReturnType<typeof renderScreen>>> {
    await seedDemoWorld();
    installAuditedStaticFetchBoundary();
    installDemoFirewall();
    return renderScreen(element, {
        wrapper: AppPaneProviderWrapper,
        flushOptions: { cycles: 8, turns: 3, frames: 1 },
    });
}

async function mountSeededSurfaceFromFactory(
    createElement: () => React.ReactElement,
): Promise<Awaited<ReturnType<typeof renderScreen>>> {
    await seedDemoWorld();
    installAuditedStaticFetchBoundary();
    installDemoFirewall();
    return renderScreen(createElement(), {
        wrapper: AppPaneProviderWrapper,
        flushOptions: { cycles: 8, turns: 3, frames: 1 },
    });
}

async function settleAndPressControl(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    testID: string,
): Promise<void> {
    await flushHookEffects({ cycles: 4, turns: 3, frames: 1 });
    await pressTestInstanceAsync(screen.findByTestId(testID), testID);
    await flushHookEffects({ cycles: 4, turns: 3, frames: 1 });
}

let allowedStaticFetchAttempts: string[] = [];

function stringifyFetchInput(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
}

function installAuditedStaticFetchBoundary(): void {
    allowedStaticFetchAttempts = [];
    globalThis.fetch = (vi.fn(async (input: RequestInfo | URL) => {
        allowedStaticFetchAttempts = [
            ...allowedStaticFetchAttempts,
            stringifyFetchInput(input),
        ];
        return new Response('unexpected demo static fetch');
    }) as unknown) as typeof globalThis.fetch;
}

function expectZeroFirewallEgress(): void {
    expect(getDemoFirewallDenyLog()).toEqual([]);
    expect(allowedStaticFetchAttempts).toEqual([]);
}

function createJourneyPreAuthController(): OnboardingWizardController {
    return {
        stepId: 'relay_select',
        currentStepIndex: 0,
        stepCount: 2,
        contentTransitionDirection: 'replace',
        showBack: true,
        showSkip: false,
        onBack: vi.fn(),
        onSkip: null,
        onPrimary: vi.fn(),
        primaryLabel: 'Continue',
        primaryDisabled: false,
        skipLabel: null,
        skipDisabled: false,
        title: 'Relay',
        subtitle: null,
        footerHint: null,
        body: React.createElement('PreAuthControllerBody'),
        goToStep: vi.fn(),
    };
}

function createJourneyWizardSurfaceProps(): OnboardingWizardSurfaceProps {
    return {
        testID: 'wizard',
        layout: 'landscape',
        isDesktopShell: true,
        authEntryOptions: {
            serverAvailability: 'ready',
            serverUrlForCopy: 'https://relay.example.test',
            showAuthActions: true,
            showProviderSignup: false,
            showAnonymousSignup: false,
            showMtlsLogin: false,
            showKeylessProviderLogin: false,
            providerId: null,
            keylessProviderId: null,
            providerSignupTitle: '',
            providerKeylessTitle: '',
            anonymousSignupTitle: '',
            mtlsTitle: '',
            primarySignupTitle: '',
            mtlsPrimary: false,
            keylessPrimary: false,
            autoRedirect: {
                enabled: false,
                providerId: null,
                toKeyedProvision: false,
                toKeylessLogin: false,
                toMtls: false,
                toLegacySignupProvider: false,
            },
            retryServerCheck: () => undefined,
        },
        onCreateAccount: vi.fn(),
        onCreateAccountViaProvider: vi.fn(),
        onLoginWithKeylessProvider: vi.fn(),
        onLoginWithMtls: vi.fn(),
    };
}

async function mountJourneyAt(initialBeatId: 'A2' | 'A7' | 'A14') {
    const { OnboardingJourneyHost } = await import('@/components/onboarding/tour/OnboardingJourneyHost');
    const sessionsListSurface = stageSurfaceById.get('sessions-list');
    if (!sessionsListSurface) throw new Error('Missing sessions-list stage surface fixture owner.');
    journeyOriginalSessionsListSurface = sessionsListSurface;
    stageSurfaceById.set('sessions-list', {
        ...sessionsListSurface,
        component: React.lazy(async () => ({ default: SubscribedJourneyStageSurface })),
    });
    installAuditedStaticFetchBoundary();
    return renderScreen(
        <OnboardingJourneyHost
            surface="desktop"
            isDesktopShell
            initialBeatId={initialBeatId}
            preAuthController={createJourneyPreAuthController()}
            wizardSurfaceProps={createJourneyWizardSurfaceProps()}
            testID="journey-host"
        />,
        {
            wrapper: AppPaneProviderWrapper,
            flushOptions: { cycles: 12, turns: 4, frames: 2 },
        },
    );
}

function SubscribedJourneyStageSurface(): React.ReactElement {
    React.useEffect(() => storage.subscribe(() => undefined), []);
    return React.createElement('SubscribedJourneyStageSurface', {
        testID: 'journey-host-subscribed-stage-surface',
    });
}

let journeyOriginalSessionsListSurface: ReturnType<typeof stageSurfaceById.get> = undefined;

async function invokeJourneyAction(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    action: 'onPrimary' | 'onSkip',
): Promise<void> {
    const controller = screen.findByType(JourneyConfigSlot).props.controller;
    const handler = controller[action];
    expect(handler).toBeTypeOf('function');
    if (typeof handler !== 'function') throw new Error(`Missing journey action: ${action}`);
    let actionResult: void | Promise<void> = undefined;
    await act(async () => {
        actionResult = handler();
        await Promise.resolve();
    });
    await Promise.resolve(actionResult);
    await flushHookEffects({ cycles: 8, turns: 4, frames: 2 });
}

async function expectNoEgressAfterMountAndInteraction(
    element: React.ReactElement,
    interactionTestId: string,
): Promise<void> {
    const screen = await mountSeededSurface(element);
    await settleAndPressControl(screen, interactionTestId);
    expectZeroFirewallEgress();
}

async function expectNoEgressAfterFactoryMountAndInteraction(
    createElement: () => React.ReactElement,
    interactionTestId: string,
): Promise<void> {
    const screen = await mountSeededSurfaceFromFactory(createElement);
    await settleAndPressControl(screen, interactionTestId);
    expectZeroFirewallEgress();
}

async function expectNoEgressAfterMount(element: React.ReactElement): Promise<void> {
    await mountSeededSurface(element);
    await flushHookEffects({ cycles: 6, turns: 3, frames: 1 });
    expectZeroFirewallEgress();
}

describe('demo mode egress-zero smoke', () => {
    let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
    let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        routerPushSpy.mockReset();
        routerState.pathname = '/';
        routerState.params = {};
        originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
        originalFetch = globalThis.fetch;
        allowedStaticFetchAttempts = [];
        let nextAnimationFrameId = 1;
        const queuedAnimationFrames = new Set<number>();
        globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
            const frameId = nextAnimationFrameId;
            nextAnimationFrameId += 1;
            queuedAnimationFrames.add(frameId);
            queueMicrotask(() => {
                if (!queuedAnimationFrames.delete(frameId)) return;
                callback(performance.now());
            });
            return frameId;
        }) as typeof globalThis.requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((frameId: number) => {
            queuedAnimationFrames.delete(frameId);
        }) as typeof globalThis.cancelAnimationFrame;
    });

    afterEach(async () => {
        standardCleanup();
        if (journeyOriginalSessionsListSurface) {
            stageSurfaceById.set('sessions-list', journeyOriginalSessionsListSurface);
            journeyOriginalSessionsListSurface = undefined;
        }
        uninstallDemoFirewall();
        resetDemoFirewallForTests();
        globalThis.fetch = originalFetch;
        allowedStaticFetchAttempts = [];
        let clearError: unknown;
        try {
            await clearDemoWorld();
        } catch (error) {
            clearError = error;
        } finally {
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            allowedStaticFetchAttempts = [];
            vi.restoreAllMocks();
        }
        if (clearError) throw clearError;
    });

    it('mounts the seeded sessions list/sidebar surface without network egress', async () => {
        routerState.pathname = '/';
        const { SessionsListView } = await import('@/components/sessions/shell/SessionsList');
        const {
            resolveSessionListSurfaceOwnership,
            SESSION_LIST_SURFACE_OWNER_SIDEBAR,
        } = await import('@/components/sessions/shell/surface/sessionListSurfaceOwnership');

        await expectNoEgressAfterFactoryMountAndInteraction(
            () => {
                const activeServerId = getActiveServerSnapshot().serverId;
                const activeIndex = storage.getState().sessionListIndexByServerId[activeServerId] ?? null;
                const sessionCount = activeIndex?.filter((item) => item.type === 'session').length ?? 0;

                return (
                    <SessionsListView
                        storageKind="all"
                        paneState={{
                            summary: { sessionsReady: true, sessionCount },
                            visibleSessionListIndex: activeIndex,
                            hasHiddenInactiveSessions: false,
                            folderFocus: null,
                            showLoading: false,
                            showEmptyState: sessionCount === 0,
                        }}
                        surfaceOwnership={resolveSessionListSurfaceOwnership({
                            ownerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
                            interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_SIDEBAR,
                            visible: true,
                        })}
                    />
                );
            },
            `session-list-item-${DEMO_RICH_SESSION_ID}`,
        );
    });

    it('mounts the seeded rich SessionView without network egress', async () => {
        routerState.pathname = `/session/${DEMO_RICH_SESSION_ID}`;
        const { SessionView } = await import('@/components/sessions/shell/SessionView');

        await expectNoEgressAfterMountAndInteraction(
            <SessionView id={DEMO_RICH_SESSION_ID} surfaceFocusedOverride routeAnchorOverride />,
            'session-header-action-menu-trigger',
        );
    });

    it('mounts the relay settings surface without network egress', async () => {
        routerState.pathname = '/settings/server';
        const { ServerSettingsScreen } = await import('@/components/settings/server/screens/ServerSettingsScreen');

        await expectNoEgressAfterMountAndInteraction(<ServerSettingsScreen />, 'settings.server.openSetupWizard');
    });

    it('mounts the machines settings surface without network egress', async () => {
        routerState.pathname = '/settings/machines';
        const { MachinesSettingsView } = await import('@/components/settings/machines/MachinesSettingsView');

        await expectNoEgressAfterMountAndInteraction(
            <MachinesSettingsView />,
            'settings.machines.openWizard.setupThisComputer',
        );
    });

    it('mounts the subagents dream surface (A5) without network egress', async () => {
        routerState.pathname = '/settings/sub-agent';
        const { SubAgentSettingsView } = await import('@/components/settings/subAgent/SubAgentSettingsView');
        await expectNoEgressAfterMount(<SubAgentSettingsView />);
    });

    it('mounts the source-control dream surface (A9) without network egress', async () => {
        routerState.pathname = '/settings/source-control';
        const { SourceControlSettingsView } = await import('@/components/settings/sourceControl/SourceControlSettingsView');
        await expectNoEgressAfterMount(<SourceControlSettingsView />);
    });

    it('mounts the theme-profiles dream surface (A13) without network egress', async () => {
        routerState.pathname = '/settings/appearance/themes';
        const { ThemeProfilesSettingsScreen } = await import('@/components/settings/appearance/themeProfiles/ThemeProfilesSettingsScreen');
        await expectNoEgressAfterMount(<ThemeProfilesSettingsScreen />);
    });

    it('mounts the MCP servers dream surface (A11) without network egress', async () => {
        routerState.pathname = '/settings/mcp';
        const { McpServersSettingsScreen } = await import('@/components/settings/mcpServers/McpServersSettingsScreen');
        await expectNoEgressAfterMount(<McpServersSettingsScreen />);
    });

    it('mounts the connected-services dream surface (A12) without network egress', async () => {
        routerState.pathname = '/settings/connected-services';
        const { ConnectedServicesSettingsView } = await import('@/components/settings/connectedServices/ConnectedServicesSettingsView');
        await expectNoEgressAfterMount(<ConnectedServicesSettingsView />);
    });

    it('mounts the review dream surface content (A8) without network egress', async () => {
        const { DEMO_REVIEW_SESSION_ID } = await import('@/demoMode/world/constants');
        routerState.pathname = `/session/${DEMO_REVIEW_SESSION_ID}`;
        const { SessionView } = await import('@/components/sessions/shell/SessionView');
        const screen = await mountSeededSurface(
            <SessionView id={DEMO_REVIEW_SESSION_ID} surfaceFocusedOverride routeAnchorOverride />,
        );
        await settleAndPressControl(screen, 'session-header-action-menu-trigger');
        expectZeroFirewallEgress();
        // The pending/blocked review session schedules a benign relative-time UI
        // timer; the real journey clears the demo with the diagnostic residue
        // policy, so mirror that here (the egress-zero invariant is asserted above).
        await clearDemoWorld({ residuePolicy: 'diagnostic' });
    });

    it('mounts the voice dream surface (A10) static designed state without network egress', async () => {
        routerState.pathname = '/';
        const { VoiceSurfaceView } = await import('@/components/voice/surface/VoiceSurfaceView');
        const { buildJourneyVoiceStageModel } = await import('@/components/onboarding/tour/stage/surfaces/JourneyVoiceStageSurface');
        await expectNoEgressAfterMount(<VoiceSurfaceView model={buildJourneyVoiceStageModel()} />);
    });

    it('unmounts the real subscribed DemoStage before clearing on the A14 dream-to-setup boundary', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const screen = await mountJourneyAt('A14');

        expect(screen.findByTestId('demo-stage')).not.toBeNull();
        expect(screen.findByTestId('journey-host-subscribed-stage-surface')).not.toBeNull();

        const unsubscribeRuntimeResidue = storage.subscribe(() => undefined);
        try {
            await invokeJourneyAction(screen, 'onPrimary');
        } finally {
            unsubscribeRuntimeResidue();
        }

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(screen.findByTestId('demo-stage')).toBeNull();
        expectZeroFirewallEgress();
        expect(warnSpy.mock.calls.every(([message]) => (
            message === '[DemoStage] Missing spotlight target "session-list-attention-group"; framing full surface.'
            || (typeof message === 'string' && message.includes('[DemoMode]'))
        ))).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DemoMode]'), {
            code: 'demo_runtime_residue',
            findings: [{
                kind: 'storeSubscription',
                label: 'active storage subscriptions',
                count: 1,
            }],
        });
    });

    it('unmounts the real subscribed DemoStage before clearing on skip to S1', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const screen = await mountJourneyAt('A2');

        expect(screen.findByTestId('demo-stage')).not.toBeNull();
        expect(screen.findByTestId('journey-host-subscribed-stage-surface')).not.toBeNull();

        const unsubscribeRuntimeResidue = storage.subscribe(() => undefined);
        try {
            // The dream-beat "skip to setup" affordance is the absolute glass pill
            // (JV3-COMPOSITION D17), not a column-controller action.
            await settleAndPressControl(screen, 'journey-host-desktop-skip-pill');
        } finally {
            unsubscribeRuntimeResidue();
        }

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(screen.findByTestId('demo-stage')).toBeNull();
        expectZeroFirewallEgress();
        expect(warnSpy.mock.calls.every(([message]) => (
            message === '[DemoStage] Missing spotlight target "session-list-attention-group"; framing full surface.'
            || (typeof message === 'string' && message.includes('[DemoMode]'))
        ))).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DemoMode]'), {
            code: 'demo_runtime_residue',
            findings: [{
                kind: 'storeSubscription',
                label: 'active storage subscriptions',
                count: 1,
            }],
        });
    });
});
