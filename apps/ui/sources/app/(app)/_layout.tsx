import { router, usePathname } from 'expo-router';
import { WorkspaceRootStack as Stack } from '@/components/appShell/workspace/WorkspaceRootStack';
import type { ExtendedStackNavigationOptions } from 'expo-router/build/layouts/StackClient';
import { getFocusedRouteNameFromRoute, type ParamListBase, type RouteProp } from '@react-navigation/native';
import 'react-native-reanimated';
import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getPreferredLanguage, t } from '@/text';
import { createAppStackScreenOptions, useAppStackUsesCustomHeader } from '@/components/navigation/createAppStackScreenOptions';
import { useAuth } from '@/auth/context/AuthContext';
import { isTerminalConnectWebPathname } from '@/utils/path/terminalConnectUrl';
import { useRootStackRouteOptions } from '@/components/navigation/root/useRootStackRouteOptions';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { DefaultBackButton } from '@/components/navigation/Header';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/PageHeader';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { MobileBottomChromeHost } from '@/components/navigation/mobile/chrome/MobileBottomChromeHost';
import { tryRenderWebPortal } from '@/components/ui/popover/portal';
import { AuthenticatedAppRuntimeMounts } from '@/components/appShell/runtime/AuthenticatedAppRuntimeMounts';
import { DesktopMainWindowRuntimes } from '@/desktop/DesktopMainWindowRuntimes';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useSetting } from '@/sync/domains/state/storage';
import {
    isNewSessionFloatingComposerPresentation,
    resolveNewSessionRoutePresentation,
    resolveNewSessionWebModalStyle,
} from '@/components/sessions/new/navigation/newSessionPresentation';
import { RootLayoutNavigationEffects } from '@/components/navigation/root/RootLayoutNavigationEffects';
import { renderRootLayoutRedirectGate } from '@/components/navigation/root/RootLayoutRedirectGate';
import { useOnboardingJourneySessionActive } from '@/components/onboarding/tour/state/journeySession';
import { VoiceAnnouncer } from '@/components/voice/surface/VoiceAnnouncer';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';
import { buildUniversalSearchRouteScreenOptions } from '@/components/appShell/search/universalSearchRouteScreenOptions';
import { buildSessionRouteScreenOptions } from '@/components/navigation/sessionRouteScreenOptions';

type StackScreenOptions = ExtendedStackNavigationOptions;
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

// Module-scope so the memo hands the navigator the same object on every render.
const NEW_SESSION_TRANSPARENT_CONTENT_STYLE = { backgroundColor: 'transparent' } as const;
const sessionRouteScreenOptions = ({ route }: { route: RouteProp<ParamListBase, string> }) => (
    buildSessionRouteScreenOptions({ childRouteName: getFocusedRouteNameFromRoute(route) })
);

/**
 * Keeps authenticated runtimes outside the full-viewport onboarding journey and
 * preserves the desktop-overlay/terminal-connect route exclusions.
 *
 * Keeping these subscriptions in this leaf prevents their updates from reaching
 * the Stack subtree.
 */
function AuthenticatedAppRuntimeMountsGate({
    primaryRealm,
    isAuthenticated,
    isDesktopShell,
}: Readonly<{
    primaryRealm: boolean;
    isAuthenticated: boolean;
    isDesktopShell: boolean;
}>): React.ReactElement | null {
    const pathname = usePathname();
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    if (onboardingJourneyActive) return null;

    if (!primaryRealm || isTerminalConnectWebPathname(pathname)) {
        return null;
    }

    return (
        <AuthenticatedAppRuntimeMounts
            isAuthenticated={isAuthenticated}
            isDesktopShell={isDesktopShell}
        />
    );
}

function MobileBottomChromeMountGate(props: Readonly<{
    newSessionRendersFloatingComposer: boolean;
}>): React.ReactElement | null {
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    if (onboardingJourneyActive) return null;
    // The retained navigator is hidden while the workspace owns the visible session.
    // Keep its single bottom-chrome host visible and in the same React registry.
    const chrome = <MobileBottomChromeHost newSessionRendersFloatingComposer={props.newSessionRendersFloatingComposer} />;
    return <>{tryRenderWebPortal({
        shouldPortalWeb: Platform.OS === 'web',
        portalTargetOnWeb: 'body',
        modalPortalTarget: null,
        getBoundaryDomElement: () => null,
        content: chrome,
    }) ?? chrome}</>;
}

const RootLayoutShell = React.memo(function RootLayoutShell(): React.ReactElement {
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const { theme } = useUnistyles();
    const preferredLanguage = getPreferredLanguage();
    const windowContext = resolveDesktopWindowContext();
    const isDesktopOverlayWindow = windowContext.role === 'presenter';
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
    const stackContentStyle = React.useMemo(
        () => ({
            backgroundColor: isDesktopOverlayWindow ? 'transparent' : theme.colors.surface.base,
        }),
        [isDesktopOverlayWindow, theme.colors.surface.base],
    );

    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = useAppStackUsesCustomHeader();
    const appShellPresent = useAppShellColumn().present;
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
    const rootStackRouteOptions = useRootStackRouteOptions();
    const workflowEditorScreenOptions = React.useCallback(() => ({
        ...rootStackRouteOptions['workflows/[id]/index'],
        // Desktop workflow pages own Back when their column is collapsed.
        // Publishing the native control there creates a second trailing Back.
        ...(appShellPresent ? {} : {
        headerLeft: ({ tintColor }: { tintColor?: string }) => (
            <DefaultBackButton
                testID="workflow-back"
                tintColor={tintColor}
                onPress={() => { void runGuardedNavigation(() => router.replace('/workflows' as never)); }}
            />
        ),
        }),
    }), [appShellPresent, rootStackRouteOptions['workflows/[id]/index'], router]);
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
            webModalStyle: resolveNewSessionWebModalStyle({
                mode: newSessionPresentationMode,
                variant: newSessionVariant,
                platformOs: Platform.OS,
            }),
        };
    }, [newSessionPresentationMode, newSessionRendersFloatingComposer, newSessionVariant, preferredLanguage]);
    const externalSessionBrowseScreenOptions = React.useMemo<StackScreenOptions>(() => ({
        headerTitle: t('externalSessions.browseTitle'),
        // An unhosted web route opens in the command-surface card, which draws its own band
        // with ⋯ and close. WorkspaceRootStack admits hosted routes as ordinary URL sinks.
        headerShown: Platform.OS !== 'web',
        headerBackTitle: t('common.cancel'),
        presentation: Platform.OS === 'web' ? 'transparentModal' : 'modal',
        ...(Platform.OS === 'web' ? { contentStyle: NEW_SESSION_TRANSPARENT_CONTENT_STYLE } : {}),
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        headerBackVisible: false,
        headerLeft: () => null,
    }), [preferredLanguage]);

    return (
            <ActivityPersonalSessionMembershipProvider enabled={isAuthenticated}>
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
            {windowContext.role === 'primary' ? <VoiceAnnouncer /> : null}
            {/* The main window's tray and Quit handoff, outside the onboarding gate (R13C-F3). */}
            {isDesktopShell && windowContext.role === 'primary' ? <DesktopMainWindowRuntimes /> : null}
            <AuthenticatedAppRuntimeMountsGate
                primaryRealm={windowContext.role === 'primary'}
                isAuthenticated={isAuthenticated}
                isDesktopShell={isDesktopShell}
            />
            {/*
              * On phones root-stack pages show their title in the stack header, so a page header below
              * it shows only the purpose line (entity pages opt back in with `alwaysShowTitle`). Inside
              * the desktop app shell there is no stack header (`createHeader`), so the page header
              * carries the title. Settings re-provides its own value.
              */}
            <NavigationTitleChromeProvider showsTitle={!appShellPresent}>
            <Stack screenOptions={rootStackScreenOptions} layout={renderRootLayoutRedirectGate}>
                <Stack.Screen
                    name="index"
                    options={rootStackRouteOptions['index']}
                />
                <Stack.Screen
                    name="inbox/index"
                    options={rootStackRouteOptions['inbox/index']}
                />
                <Stack.Screen
                    name="friends/index"
                    options={rootStackRouteOptions['friends/index']}
                />
                <Stack.Screen
                    name="discussions/index"
                    options={rootStackRouteOptions['discussions/index']}
                />
                <Stack.Screen
                    name="discussions/new"
                    options={rootStackRouteOptions['discussions/new']}
                />
                <Stack.Screen
                    name="discussions/[discussionId]"
                    options={rootStackRouteOptions['discussions/[discussionId]']}
                />
                <Stack.Screen
                    name="oauth/[provider]"
                    options={rootStackRouteOptions['oauth/[provider]']}
                />
                <Stack.Screen
                    name="oauth/mcp/callback"
                    options={rootStackRouteOptions['oauth/mcp/callback']}
                />
                {/* All tabs (phone): a full page over the session, reached by pulling the session title down. */}
                <Stack.Screen
                    name="all-tabs"
                    options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade' }}
                />
                <Stack.Screen
                    name="settings"
                    options={rootStackRouteOptions['settings']}
                />
                <Stack.Screen
                    name="dev"
                    options={rootStackRouteOptions['dev']}
                />
                <Stack.Screen
                    name="plugins/index"
                    options={rootStackRouteOptions['plugins/index']}
                />
                <Stack.Screen
                    name="plugins/listing"
                    options={rootStackRouteOptions['plugins/listing']}
                />
                <Stack.Screen
                    name="plugins/[pluginId]"
                    options={rootStackRouteOptions['plugins/[pluginId]']}
                />
                <Stack.Screen
                    name="search"
                    options={buildUniversalSearchRouteScreenOptions({ platformOs: Platform.OS })}
                />
                <Stack.Screen
                    name="desktop/activity-overlay"
                    options={rootStackRouteOptions['desktop/activity-overlay']}
                />
                <Stack.Screen
                    name="desktop/capture"
                    options={rootStackRouteOptions['desktop/activity-overlay']}
                />
                <Stack.Screen
                    name="desktop/capture-selection"
                    options={rootStackRouteOptions['desktop/activity-overlay']}
                />
                <Stack.Screen
                    name="automations/index"
                    options={rootStackRouteOptions['automations/index']}
                />
                <Stack.Screen
                    name="automations/[id]"
                    options={rootStackRouteOptions['automations/[id]']}
                />
                <Stack.Screen
                    name="automations/[id]/runs/[runId]"
                    options={rootStackRouteOptions['automations/[id]/runs/[runId]']}
                />
                <Stack.Screen
                    name="automations/new"
                    options={rootStackRouteOptions['automations/new']}
                />
                <Stack.Screen
                    name="automations/edit"
                    options={rootStackRouteOptions['automations/edit']}
                />
                <Stack.Screen
                    name="automations/settings"
                    options={rootStackRouteOptions['automations/settings']}
                />
                <Stack.Screen
                    name="workflows/index"
                    options={rootStackRouteOptions['workflows/index']}
                />
                <Stack.Screen
                    name="boards/index"
                    options={rootStackRouteOptions['boards/index']}
                />
                <Stack.Screen
                    name="boards/[boardId]"
                    options={rootStackRouteOptions['boards/[boardId]']}
                />
                <Stack.Screen
                    name="workflows/edit"
                    options={workflowEditorScreenOptions}
                />
                <Stack.Screen
                    name="workflows/[id]/index"
                    options={workflowEditorScreenOptions}
                />
                <Stack.Screen
                    name="workflows/runs/[runId]"
                    options={rootStackRouteOptions['workflows/runs/[runId]']}
                />
                <Stack.Screen
                    name="workflows/runs/index"
                    options={rootStackRouteOptions['workflows/runs/index']}
                />
                <Stack.Screen
                    name="workflows/settings"
                    options={rootStackRouteOptions['workflows/settings']}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/terminal"
                    options={rootStackRouteOptions['projects/[workspaceRefId]/terminal']}
                />
                <Stack.Screen
                    name="projects/index"
                    options={rootStackRouteOptions['projects/index']}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/index"
                    options={rootStackRouteOptions['projects/[workspaceRefId]/index']}
                />



                <Stack.Screen name="projects/[workspaceRefId]/overview" options={rootStackRouteOptions['projects/[workspaceRefId]/overview']} />
                <Stack.Screen name="projects/[workspaceRefId]/code" options={rootStackRouteOptions['projects/[workspaceRefId]/code']} />
                <Stack.Screen name="projects/[workspaceRefId]/changes" options={rootStackRouteOptions['projects/[workspaceRefId]/changes']} />
                <Stack.Screen name="projects/[workspaceRefId]/scripts" options={rootStackRouteOptions['projects/[workspaceRefId]/scripts']} />
                <Stack.Screen name="projects/[workspaceRefId]/services" options={rootStackRouteOptions['projects/[workspaceRefId]/services']} />
                <Stack.Screen name="projects/[workspaceRefId]/context" options={rootStackRouteOptions['projects/[workspaceRefId]/context']} />
                <Stack.Screen name="projects/[workspaceRefId]/memory" options={rootStackRouteOptions['projects/[workspaceRefId]/memory']} />
                {/*
                  * `session/[id]` has its own `_layout` (a Slot), so this is the stack's only screen for
                  * every Session route (no `session/[id]/…` entry here would name a stack child). The
                  * nested route decides: the Session view and its cockpit surfaces draw their own
                  * header, so the stack adds none (no second back row above the Session header).
                  */}
                <Stack.Screen
                    name="session/[id]"
                    options={sessionRouteScreenOptions}
                />
                <Stack.Screen
                    name="session/recent"
                    options={rootStackRouteOptions['session/recent']}
                />
                <Stack.Screen
                    name="session/archived"
                    options={rootStackRouteOptions['session/archived']}
                />
                <Stack.Screen
                    name="teams/[teamId]/sessions"
                    options={rootStackRouteOptions['teams/[teamId]/sessions']}
                />
                {/*
                 * The two public Team entries. Both are opened from a link by
                 * somebody who may have no Home Account yet, so they take the
                 * same full-viewport shell as OAuth and restore rather than app
                 * chrome that would be answering for an Account they lack.
                 */}
                <Stack.Screen
                    name="teams/[teamId]/sign-in"
                    options={rootStackRouteOptions['teams/[teamId]/sign-in']}
                />
                <Stack.Screen
                    name="join/[token]"
                    options={rootStackRouteOptions['join/[token]']}
                />
                <Stack.Screen
                    name="terminal/connect"
                    options={rootStackRouteOptions['terminal/connect']}
                />
                <Stack.Screen
                    name="terminal/index"
                    options={rootStackRouteOptions['terminal/index']}
                />
                <Stack.Screen
                    name="scan/terminal"
                    options={rootStackRouteOptions['scan/terminal']}
                />
                <Stack.Screen
                    name="scan/account"
                    options={rootStackRouteOptions['scan/account']}
                />
                <Stack.Screen
                    name="homes/sign-in"
                    options={rootStackRouteOptions['homes/sign-in']}
                />
                <Stack.Screen
                    name="restore/index"
                    options={rootStackRouteOptions['restore/index']}
                />
                <Stack.Screen
                    name="restore/show-qr"
                    options={rootStackRouteOptions['restore/show-qr']}
                />
                <Stack.Screen
                    name="restore/manual"
                    options={rootStackRouteOptions['restore/manual']}
                />
                <Stack.Screen
                    name="restore/lost-access"
                    options={rootStackRouteOptions['restore/lost-access']}
                />
                <Stack.Screen
                    name="auth/password/recover"
                    options={rootStackRouteOptions['auth/password/recover']}
                />
                <Stack.Screen
                    name="auth/email/verify/[token]"
                    options={rootStackRouteOptions['auth/email/verify/[token]']}
                />
                <Stack.Screen
                    name="auth/password/reset/[token]"
                    options={rootStackRouteOptions['auth/password/reset/[token]']}
                />
                <Stack.Screen
                    name="home"
                    // The phone's Home, opened from the Sessions header logo: the page is its own title.
                    options={rootStackRouteOptions['home']}
                />
                <Stack.Screen
                    name="changelog"
                    options={rootStackRouteOptions['changelog']}
                />
                <Stack.Screen
                    name="server"
                    options={rootStackRouteOptions['server']}
                />
                <Stack.Screen
                    name="homes/index"
                    options={({ navigation }) => ({
                        ...rootStackRouteOptions['homes/index'],
                        // Opened from the Sessions header's Home line; phone web reports no stack `back`,
                        // so the page names its own way back (lab `xacct-P1`), falling back to Sessions.
                        headerLeft: ({ tintColor }: { tintColor?: string }) => (
                            <DefaultBackButton
                                testID="account-homes-back"
                                tintColor={tintColor}
                                onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })}
                            />
                        ),
                    })}
                />
                <Stack.Screen
                    name="artifacts/index"
                    options={rootStackRouteOptions['artifacts/index']}
                />
                <Stack.Screen
                    name="artifacts/[id]"
                    options={rootStackRouteOptions['artifacts/[id]']}
                />
                <Stack.Screen
                    name="artifacts/new"
                    options={rootStackRouteOptions['artifacts/new']}
                />
                <Stack.Screen
                    name="artifacts/edit/[id]"
                    options={rootStackRouteOptions['artifacts/edit/[id]']}
                />
                <Stack.Screen
                    name="friends/manage"
                    options={rootStackRouteOptions['friends/manage']}
                />
                <Stack.Screen
                    name="friends/search"
                    options={rootStackRouteOptions['friends/search']}
                />
                <Stack.Screen
                    name="user/[id]"
                    options={rootStackRouteOptions['user/[id]']}
                />
                <Stack.Screen
                    name="new/pick/machine"
                    options={rootStackRouteOptions['new/pick/machine']}
                />
                <Stack.Screen
                    name="new/pick/path"
                    options={rootStackRouteOptions['new/pick/path']}
                />
                <Stack.Screen
                    name="new/pick/profile"
                    options={rootStackRouteOptions['new/pick/profile']}
                />
                <Stack.Screen
                    name="new/pick/server"
                    options={rootStackRouteOptions['new/pick/server']}
                />
                <Stack.Screen
                    name="new/pick/profile-edit"
                    options={rootStackRouteOptions['new/pick/profile-edit']}
                />
                <Stack.Screen
                    name="new/pick/secret-requirement"
                    options={rootStackRouteOptions['new/pick/secret-requirement']}
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
                    options={rootStackRouteOptions['zen/index']}
                />
                <Stack.Screen
                    name="zen/new"
                    options={rootStackRouteOptions['zen/new']}
                />
                <Stack.Screen
                    name="zen/view"
                    options={rootStackRouteOptions['zen/view']}
                />
            </Stack>
            </NavigationTitleChromeProvider>
            <MobileBottomChromeMountGate newSessionRendersFloatingComposer={newSessionRendersFloatingComposer} />
            </ActivityPersonalSessionMembershipProvider>
    );
});

export default function RootLayout(): React.ReactElement {
    // Composition root: subscribes to nothing that changes per navigation, so the
    // `<RootLayoutShell />` element reference stays stable and its Stack subtree is not
    // re-rendered when the route changes. Navigation/auth side effects live in the null-rendering
    // `<RootLayoutNavigationEffects />` sibling; the unauthenticated redirect check and the
    // auth-recovery hold live inside the navigator's `<RootLayoutRedirectGate />`, the only
    // navigation-subscribing owner in this render path.
    return (
        <>
            <RootLayoutNavigationEffects />
                {/*
                  * One Voice energy clock for the whole app (§4.2 rule 6): every
                  * Voice surface animates from these shared values, so amplitude
                  * costs one frame callback rather than one per surface. It wraps
                  * `<RootLayoutShell />` — an element created here, so the shell
                  * subtree is untouched when the provider re-renders on a Voice
                  * setting or session-status change.
                  */}
                <RootLayoutShell />
        </>
    );
}
