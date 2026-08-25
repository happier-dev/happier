import { Stack, router, usePathname } from 'expo-router';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import 'react-native-reanimated';
import * as React from 'react';
import { Platform, TouchableOpacity } from 'react-native';
import { isRunningOnMac } from '@/utils/platform/platform';
import { useUnistyles } from 'react-native-unistyles';
import { getPreferredLanguage, t } from '@/text';
import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { useAuth } from '@/auth/context/AuthContext';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { Text } from '@/components/ui/text/Text';
import { isTerminalConnectWebPathname } from '@/utils/path/terminalConnectUrl';
import {
    createFriendsStackScreenOptions,
    createInboxStackScreenOptions,
} from '@/utils/navigation/createSocialStackScreenOptions';
import { isDesktopOverlayWindowContext } from '@/desktop/window/isDesktopOverlayWindowContext';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { MobileBottomChromeHost } from '@/components/navigation/mobile/chrome/MobileBottomChromeHost';
import { SessionCockpitChromeRegistryProvider } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { BrowserPresentationRetentionProvider } from '@/components/browser/surfaces/browserPresentationRetention';
import { AuthenticatedAppRuntimeMounts } from '@/components/appShell/runtime/AuthenticatedAppRuntimeMounts';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useSetting } from '@/sync/domains/state/storage';
import {
    isNewSessionFloatingComposerPresentation,
    resolveNewSessionRoutePresentation,
    resolveNewSessionSecretRequirementRoutePresentation,
} from '@/components/sessions/new/navigation/newSessionPresentation';
import { resolveSettingsRouteAnimation, resolveSettingsRoutePresentation } from '@/components/settings/navigation/settingsRoutePresentation';
import { useDeviceType } from '@/utils/platform/responsive';
import { RootLayoutNavigationEffects } from '@/components/navigation/root/RootLayoutNavigationEffects';
import { RootLayoutRedirectGate } from '@/components/navigation/root/RootLayoutRedirectGate';
import { useOnboardingJourneySessionActive } from '@/components/onboarding/tour/state/journeySession';
import { VoiceAnnouncer } from '@/components/voice/surface/VoiceAnnouncer';

type StackScreenOptions = NativeStackNavigationOptions;
type ModalRouteNavigation = Readonly<{
    canGoBack?: () => boolean;
    goBack?: () => void;
    getState?: () => Readonly<{
        index?: number;
        routes?: ReadonlyArray<unknown>;
    }> | undefined;
}>;

function hasPriorModalStackRoute(navigation: ModalRouteNavigation): boolean {
    const state = navigation.getState?.();
    return typeof state?.index === 'number'
        && state.index > 0
        && Array.isArray(state.routes)
        && state.routes.length > 1;
}

const MAIN_TAB_STACK_SCREEN_OPTIONS = { animation: 'none' } as const;
// Module-scope so the memo hands the navigator the same object on every render.
const NEW_SESSION_TRANSPARENT_CONTENT_STYLE = { backgroundColor: 'transparent' } as const;
const SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS = {
    animation: 'none',
    headerShown: false,
} as const satisfies StackScreenOptions;

/**
 * Keeps authenticated runtimes outside the full-viewport onboarding journey and
 * preserves the desktop-overlay/terminal-connect route exclusions.
 *
 * Keeping these subscriptions in this leaf prevents their updates from reaching
 * the Stack subtree.
 */
function AuthenticatedAppRuntimeMountsGate({
    isDesktopOverlayWindow,
    isAuthenticated,
    isDesktopShell,
}: Readonly<{
    isDesktopOverlayWindow: boolean;
    isAuthenticated: boolean;
    isDesktopShell: boolean;
}>): React.ReactElement | null {
    const pathname = usePathname();
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    if (onboardingJourneyActive) return null;

    if (isDesktopOverlayWindow || isTerminalConnectWebPathname(pathname)) {
        return null;
    }

    return (
        <AuthenticatedAppRuntimeMounts
            isAuthenticated={isAuthenticated}
            isDesktopShell={isDesktopShell}
        />
    );
}

function MobileBottomChromeMountGate(): React.ReactElement | null {
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    if (onboardingJourneyActive) return null;
    return <MobileBottomChromeHost />;
}

const RootLayoutShell = React.memo(function RootLayoutShell(): React.ReactElement {
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const { theme } = useUnistyles();
    const preferredLanguage = getPreferredLanguage();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const isDesktopOverlayWindow = isDesktopOverlayWindowContext();
    const isDesktopShell = isDesktopHost();
    const newSessionPresentationMode = useSetting('newSessionPresentationModeV1');
    // `/new` renders either the bare composer (simple) or the profile wizard, and the two want
    // different native presentations. A native stack reads `modalPresentationStyle` at present time
    // and ignores later changes, so the decision has to be made HERE, before the push — it cannot
    // be made inside the screen. `useEnhancedSessionWizard` is the whole predicate (see
    // `buildNewSessionScreenVariantModel`).
    const newSessionVariant = useSetting('useEnhancedSessionWizard') ? 'wizard' : 'simple';
    const newSessionRendersFloatingComposer = isNewSessionFloatingComposerPresentation({
        mode: newSessionPresentationMode,
        variant: newSessionVariant,
        platformOs: Platform.OS,
    });
    const deviceType = useDeviceType();
    const stackContentStyle = React.useMemo(
        () => ({
            backgroundColor: isDesktopOverlayWindow ? 'transparent' : theme.colors.surface.base,
        }),
        [isDesktopOverlayWindow, theme.colors.surface.base],
    );

    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const rootStackScreenOptions = React.useMemo(() => createAppStackScreenOptions({
        contentStyle: stackContentStyle,
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [
        shouldUseCustomHeader,
        stackContentStyle,
        preferredLanguage,
        theme.colors.chrome.header.background,
        theme.colors.chrome.header.foreground,
    ]);
    const rootStackRouteOptions = React.useMemo(() => {
        const back = t('common.back');
        const cancel = t('common.cancel');
        const hiddenHeader: StackScreenOptions = { headerShown: false };
        const blankBack: StackScreenOptions = {
            headerTitle: '',
            headerBackTitle: back,
        };
        const visibleBlankBack: StackScreenOptions = {
            headerShown: true,
            headerTitle: '',
            headerBackTitle: back,
        };
        const visibleSessionHistory: StackScreenOptions = {
            headerShown: true,
            headerTitle: t('sessionHistory.title'),
            headerBackTitle: back,
        };

        return {
            index: {
                headerShown: false,
                headerTitle: '',
                ...MAIN_TAB_STACK_SCREEN_OPTIONS,
            },
            inboxIndex: {
                ...createInboxStackScreenOptions(t),
                ...MAIN_TAB_STACK_SCREEN_OPTIONS,
            },
            friendsIndex: {
                ...createFriendsStackScreenOptions(t),
                ...MAIN_TAB_STACK_SCREEN_OPTIONS,
            },
            hiddenHeader,
            settings: {
                // Nested navigator; per-settings-screen headers are configured in `settings/_layout.tsx`.
                headerShown: false,
                ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                // Tablet/desktop present settings as a modal (nav rail on the left, section
                // content on the right). Phones keep it as a full-screen tab reached via the
                // bottom tab bar — see resolveSettingsRoutePresentation.
                presentation: resolveSettingsRoutePresentation({ deviceType, platformOs: Platform.OS }),
                // Animate only in modal mode; the phone tab keeps the instant `animation: 'none'`
                // inherited from MAIN_TAB_STACK_SCREEN_OPTIONS (overridden per device type here).
                animation: resolveSettingsRouteAnimation({ deviceType }),
            },
            desktopActivityOverlay: {
                headerShown: false,
                contentStyle: {
                    backgroundColor: 'transparent',
                },
            },
            automationsIndex: {
                headerShown: true,
                headerTitle: t('navigation.automations'),
                headerBackTitle: back,
            },
            automationsId: {
                headerShown: true,
                headerTitle: t('navigation.automation'),
                headerBackTitle: back,
            },
            automationsNew: {
                headerShown: true,
                headerTitle: t('navigation.newAutomation'),
                headerBackTitle: back,
            },
            automationsSettings: {
                headerShown: true,
                headerTitle: t('automations.settings.title'),
                headerBackTitle: back,
            },
            visibleBlankBack,
            sessionRuns: {
                headerShown: true,
                headerTitle: t('runs.title'),
                headerBackTitle: back,
            },
            sessionInfo: {
                ...visibleBlankBack,
                headerBackVisible: false,
                headerLeft: () => null,
            },
            files: SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS,
            sessionCockpitSurface: SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS,
            sessionRecent: visibleSessionHistory,
            sessionArchived: visibleSessionHistory,
            terminalIndex: {
                headerTitle: t('navigation.connectTerminal'),
            },
            changelog: {
                headerShown: true,
                headerTitle: t('navigation.whatsNew'),
                headerBackTitle: back,
            },
            artifactsIndex: {
                headerShown: true,
                headerTitle: t('artifacts.title'),
                headerBackTitle: back,
            },
            artifactsId: {
                headerShown: false,
            },
            artifactsNew: {
                headerShown: true,
                headerTitle: t('artifacts.new'),
                headerBackTitle: cancel,
            },
            artifactsEdit: {
                headerShown: true,
                headerTitle: t('artifacts.edit'),
                headerBackTitle: cancel,
            },
            friendsSearch: {
                headerShown: true,
                headerTitle: t('friends.addFriend'),
                headerBackTitle: back,
            },
            userId: visibleBlankBack,
            devIndex: {
                headerTitle: t('navigation.developerTools'),
            },
            devListDemo: {
                headerTitle: t('navigation.listComponentsDemo'),
            },
            devTypography: {
                headerTitle: t('navigation.typography'),
            },
            devColors: {
                headerTitle: t('navigation.colors'),
            },
            devTools2: {
                headerTitle: t('navigation.toolViewsDemo'),
            },
            devShimmerDemo: {
                headerTitle: t('navigation.shimmerViewDemo'),
            },
            devMultiTextInput: {
                headerTitle: t('navigation.multiTextInput'),
            },
            blankBack,
            newPickSecretRequirement: {
                headerShown: false,
                presentation: resolveNewSessionSecretRequirementRoutePresentation({
                    mode: newSessionPresentationMode,
                    platformOs: Platform.OS,
                }),
            },
            zenIndex: hiddenHeader,
            zenNew: {
                presentation: 'modal',
                headerTitle: t('navigation.zenNewTask'),
                headerBackTitle: cancel,
            },
            zenView: {
                presentation: 'modal',
                headerTitle: t('navigation.zenTaskDetails'),
                headerBackTitle: back,
            },
        } satisfies Record<string, StackScreenOptions>;
    }, [newSessionPresentationMode, preferredLanguage, deviceType]);
    const friendsManageScreenOptions = React.useCallback((args: { navigation: { navigate: (route: never) => void } }) => ({
        headerShown: true,
        headerTitle: t('navigation.friends'),
        headerBackTitle: t('common.back'),
        headerRight: () =>
            (
                <TouchableOpacity
                    onPress={() => args.navigation.navigate('friends/search' as never)}
                    style={{ paddingHorizontal: 16, opacity: friendsIdentityReady ? 1 : 0.5 }}
                    disabled={!friendsIdentityReady}
                    accessibilityState={{ disabled: !friendsIdentityReady }}
                >
                    <Text style={{ color: theme.colors.button.primary.tint, fontSize: 16 }}>
                        {t('friends.addFriend')}
                    </Text>
                </TouchableOpacity>
            ),
    }), [friendsIdentityReady, preferredLanguage, theme.colors.button.primary.tint]);
    const newSessionScreenOptions = React.useMemo<StackScreenOptions>(() => {
        const presentation = resolveNewSessionRoutePresentation({
            mode: newSessionPresentationMode,
            variant: newSessionVariant,
            platformOs: Platform.OS,
        });
        if (newSessionRendersFloatingComposer) {
            return {
                // The composer paints its own backdrop and owns its own close control, so the
                // navigator contributes no chrome at all.
                headerShown: false,
                presentation,
                // Required on BOTH platforms. The entrance is owned in Reanimated inside the
                // screen because a native-stack transition moves the WHOLE view — the backdrop
                // would slide up with the card instead of fading in place. On iOS every value
                // except `fade`/`flip` leaves UIKit's CoverVertical anyway, and on Android the
                // default would otherwise animate the screen BELOW, which is visible through a
                // transparent presentation.
                animation: 'none',
                // native-stack already omits its own opaque background for the transparent
                // presentations, but `createAppStackScreenOptions` supplies `surface.base` for
                // every screen and is applied after it.
                contentStyle: NEW_SESSION_TRANSPARENT_CONTENT_STYLE,
                // `UIModalPresentationOverFullScreen` has no sheet presentation controller, so
                // there is no interactive pull-to-dismiss to enable.
                gestureEnabled: false,
                fullScreenGestureEnabled: false,
            };
        }
        return {
            headerTitle: t('newSession.title'),
            headerShown: true,
            headerBackTitle: t('common.cancel'),
            presentation,
            // Swipe-to-dismiss is not consistently available across platforms; always provide a close button.
            headerBackVisible: false,
            headerLeft: () => null,
        };
    }, [newSessionPresentationMode, newSessionRendersFloatingComposer, newSessionVariant, preferredLanguage]);
    const externalSessionBrowseScreenOptions = React.useMemo<StackScreenOptions>(() => ({
        headerTitle: t('externalSessions.browseTitle'),
        headerShown: true,
        headerBackTitle: t('common.cancel'),
        presentation: 'modal',
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        headerBackVisible: false,
        headerLeft: () => null,
    }), [preferredLanguage]);

    return (
        <SessionCockpitChromeRegistryProvider>
            <BrowserPresentationRetentionProvider>
            {/*
              * The one automatic Voice announcer for the whole app (§5.4a). It sits
              * OUTSIDE `AuthenticatedAppRuntimeMountsGate` on purpose: that gate returns
              * null while the onboarding journey is active, and the journey still renders
              * a Voice surface — mounting inside it would make onboarding silent on every
              * platform. Horizon, the orb and the composer planet expose labels and states
              * only; two live regions do not coalesce.
              */}
            {/*
              * The one automatic Voice announcer for the whole app (§5.4a). It sits
              * OUTSIDE `AuthenticatedAppRuntimeMountsGate` on purpose: that gate returns
              * null while the onboarding journey is active, and the journey still renders
              * a Voice surface — mounting inside it would make onboarding silent on every
              * platform. Horizon, the orb and the composer planet expose labels and states
              * only; two live regions do not coalesce.
              */}
            <VoiceAnnouncer />
            <AuthenticatedAppRuntimeMountsGate
                isDesktopOverlayWindow={isDesktopOverlayWindow}
                isAuthenticated={isAuthenticated}
                isDesktopShell={isDesktopShell}
            />
            <Stack screenOptions={rootStackScreenOptions}>
                <Stack.Screen
                    name="index"
                    options={rootStackRouteOptions.index}
                />
                <Stack.Screen
                    name="inbox/index"
                    options={rootStackRouteOptions.inboxIndex}
                />
                <Stack.Screen
                    name="friends/index"
                    options={rootStackRouteOptions.friendsIndex}
                />
                <Stack.Screen
                    name="oauth/[provider]"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="settings"
                    options={rootStackRouteOptions.settings}
                />
                <Stack.Screen
                    name="desktop/activity-overlay"
                    options={rootStackRouteOptions.desktopActivityOverlay}
                />
                <Stack.Screen
                    name="automations/index"
                    options={rootStackRouteOptions.automationsIndex}
                />
                <Stack.Screen
                    name="automations/[id]"
                    options={rootStackRouteOptions.automationsId}
                />
                <Stack.Screen
                    name="automations/[id]/runs/[runId]"
                    options={rootStackRouteOptions.visibleBlankBack}
                />
                <Stack.Screen
                    name="automations/new"
                    options={rootStackRouteOptions.automationsNew}
                />
                <Stack.Screen
                    name="automations/settings"
                    options={rootStackRouteOptions.automationsSettings}
                />
                <Stack.Screen
                    name="session/[id]/info"
                    options={({ navigation }) => ({
                        ...rootStackRouteOptions.sessionInfo,
                        headerRight: () => <AppHeaderCloseButton accessibilityLabel={t('common.close')} testID="session-info-close" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />,
                    })}
                />
                <Stack.Screen
                    name="session/[id]/runs"
                    options={rootStackRouteOptions.sessionRuns}
                />
                <Stack.Screen
                    name="session/[id]/runs/new"
                    options={rootStackRouteOptions.visibleBlankBack}
                />
                <Stack.Screen
                    name="session/[id]/runs/[runId]"
                    options={rootStackRouteOptions.visibleBlankBack}
                />
                <Stack.Screen
                    name="session/[id]/files"
                    options={rootStackRouteOptions.files}
                />
                <Stack.Screen
                    name="session/[id]/git"
                    options={rootStackRouteOptions.sessionCockpitSurface}
                />
                <Stack.Screen
                    name="session/[id]/details"
                    options={rootStackRouteOptions.sessionCockpitSurface}
                />
                <Stack.Screen
                    name="session/[id]/terminal"
                    options={rootStackRouteOptions.sessionCockpitSurface}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/terminal"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/index"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/index"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/files"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/git"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/details"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="session/[id]/index"
                    options={rootStackRouteOptions.sessionCockpitSurface}
                />
                <Stack.Screen
                    name="session/[id]/message/[messageId]"
                    options={rootStackRouteOptions.visibleBlankBack}
                />
                <Stack.Screen
                    name="session/recent"
                    options={rootStackRouteOptions.sessionRecent}
                />
                <Stack.Screen
                    name="session/archived"
                    options={rootStackRouteOptions.sessionArchived}
                />
                <Stack.Screen
                    name="terminal/connect"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="terminal/index"
                    options={rootStackRouteOptions.terminalIndex}
                />
                <Stack.Screen
                    name="scan/terminal"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="scan/account"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="restore/index"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="restore/show-qr"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="restore/manual"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="restore/lost-access"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="changelog"
                    options={rootStackRouteOptions.changelog}
                />
                <Stack.Screen
                    name="artifacts/index"
                    options={rootStackRouteOptions.artifactsIndex}
                />
                <Stack.Screen
                    name="artifacts/[id]"
                    options={rootStackRouteOptions.artifactsId}
                />
                <Stack.Screen
                    name="artifacts/new"
                    options={rootStackRouteOptions.artifactsNew}
                />
                <Stack.Screen
                    name="artifacts/edit/[id]"
                    options={rootStackRouteOptions.artifactsEdit}
                />
                <Stack.Screen
                    name="friends/manage"
                    options={friendsManageScreenOptions}
                />
                <Stack.Screen
                    name="friends/search"
                    options={rootStackRouteOptions.friendsSearch}
                />
                <Stack.Screen
                    name="user/[id]"
                    options={rootStackRouteOptions.userId}
                />
                <Stack.Screen
                    name="dev/index"
                    options={rootStackRouteOptions.devIndex}
                />
                <Stack.Screen
                    name="dev/list-demo"
                    options={rootStackRouteOptions.devListDemo}
                />
                <Stack.Screen
                    name="dev/typography"
                    options={rootStackRouteOptions.devTypography}
                />
                <Stack.Screen
                    name="dev/colors"
                    options={rootStackRouteOptions.devColors}
                />
                <Stack.Screen
                    name="dev/tools2"
                    options={rootStackRouteOptions.devTools2}
                />
                <Stack.Screen
                    name="dev/shimmer-demo"
                    options={rootStackRouteOptions.devShimmerDemo}
                />
                <Stack.Screen
                    name="dev/multi-text-input"
                    options={rootStackRouteOptions.devMultiTextInput}
                />
                <Stack.Screen
                    name="new/pick/machine"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/path"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/profile"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/server"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/profile-edit"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/secret-requirement"
                    options={rootStackRouteOptions.newPickSecretRequirement}
                />
                <Stack.Screen
                    name="new/index"
                    options={({ navigation }) => {
                        // The floating composer has no navigator chrome and no sheet presentation
                        // controller, so the memo below IS the whole contract: nothing here may
                        // re-enable a gesture or a header close for it.
                        if (newSessionRendersFloatingComposer) {
                            return newSessionScreenOptions;
                        }
                        const isWebModal = Platform.OS === 'web' && newSessionScreenOptions.presentation === 'modal';
                        const canDismissWithGesture = !isWebModal || hasPriorModalStackRoute(navigation);
                        return {
                            ...newSessionScreenOptions,
                            // Expo Router's web modal closes its Vaul drawer before calling goBack().
                            // A direct /new entry has no route to pop, so keep the drawer open and
                            // use the explicit close affordance's deterministic fallback instead.
                            gestureEnabled: canDismissWithGesture,
                            fullScreenGestureEnabled: canDismissWithGesture,
                            headerRight: Platform.OS === 'web'
                                ? () => <AppHeaderCloseButton testID="new-session-cancel" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />
                                : undefined,
                        };
                    }}
                />
                <Stack.Screen
                    name="external/browse"
                    options={({ navigation }) => ({
                        ...externalSessionBrowseScreenOptions,
                        headerRight: () => <AppHeaderCloseButton testID="external-session-browse-cancel" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />,
                    })}
                />
                <Stack.Screen
                    name="direct/browse"
                    options={({ navigation }) => ({
                        ...externalSessionBrowseScreenOptions,
                        headerRight: () => <AppHeaderCloseButton testID="direct-session-browse-cancel" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />,
                    })}
                />
                <Stack.Screen
                    name="zen/index"
                    options={rootStackRouteOptions.zenIndex}
                />
                <Stack.Screen
                    name="zen/new"
                    options={rootStackRouteOptions.zenNew}
                />
                <Stack.Screen
                    name="zen/view"
                    options={rootStackRouteOptions.zenView}
                />
            </Stack>
            <MobileBottomChromeMountGate />
            </BrowserPresentationRetentionProvider>
        </SessionCockpitChromeRegistryProvider>
    );
});

export default function RootLayout(): React.ReactElement {
    // Composition root: subscribes to nothing that changes per navigation, so the
    // `<RootLayoutShell />` element reference stays stable and its Stack subtree is not
    // re-rendered when the route changes. Navigation/auth side effects live in the null-rendering
    // `<RootLayoutNavigationEffects />` sibling; the unauthenticated redirect check and the
    // web-server-override hold live in the `<RootLayoutRedirectGate />`, the only
    // navigation-subscribing owner in this render path.
    return (
        <>
            <RootLayoutNavigationEffects />
            <RootLayoutRedirectGate>
                {/*
                  * One Voice energy clock for the whole app (§4.2 rule 6): every
                  * Voice surface animates from these shared values, so amplitude
                  * costs one frame callback rather than one per surface. It wraps
                  * `<RootLayoutShell />` — an element created here, so the shell
                  * subtree is untouched when the provider re-renders on a Voice
                  * setting or session-status change.
                  */}
                <RootLayoutShell />
            </RootLayoutRedirectGate>
        </>
    );
}
