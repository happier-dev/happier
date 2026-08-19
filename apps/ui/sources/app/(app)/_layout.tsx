import { Stack, router } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Keyboard, Platform, Pressable, TouchableOpacity, useWindowDimensions } from 'react-native';
import { isRunningOnMac } from '@/utils/platform/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    createFriendsStackScreenOptions,
    createInboxStackScreenOptions,
} from '@/utils/navigation/createSocialStackScreenOptions';
import { ActivityBadgeRuntime } from '@/activity/badges/ActivityBadgeRuntime';
import { ActivityLocalNotificationRuntime } from '@/activity/notifications/runtime/ActivityLocalNotificationRuntime';
import { PushNotificationPermissionPrimingRuntime } from '@/activity/notifications/permission/PushNotificationPermissionPrimingRuntime';
import { DesktopTrayRuntime } from '@/desktop/tray/DesktopTrayRuntime';
import { ReleaseNotesAutoShowMount } from '@/changelog/releaseNotes';
import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { MobileBottomChromeHost } from '@/components/navigation/mobile/chrome/MobileBottomChromeHost';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { DesktopPetOverlayRuntimeMount } from '@/components/pets/runtime/DesktopPetOverlayRuntimeMount';
import { PetAppShellCompanionMount } from '@/components/pets/runtime/PetAppShellCompanionMount';
import { isDesktopPetOverlayWindowContext } from '@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext';
import { SessionCockpitChromeRegistryProvider } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { RootLayoutNavigationEffects } from '@/components/navigation/root/RootLayoutNavigationEffects';
import { RootLayoutRedirectGate } from '@/components/navigation/root/RootLayoutRedirectGate';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import {
    isNewSessionFloatingComposerPresentation,
    resolveNewSessionRoutePresentation,
} from '@/components/sessions/new/navigation/newSessionPresentation';
import { useSetting } from '@/sync/domains/state/storage';

const DESKTOP_PET_OVERLAY_SCREEN_OPTIONS = { headerShown: false } as const;
// Module-scope so the options callback hands the navigator the same object on every render.
const NEW_SESSION_TRANSPARENT_CONTENT_STYLE = { backgroundColor: 'transparent' } as const;
const MAIN_TAB_STACK_SCREEN_OPTIONS = { animation: 'none' } as const;
const SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS = {
    animation: 'none',
    headerShown: false,
} as const;
const UNAUTH_SHELL_STACK_SCREEN_OPTIONS = { headerShown: false } as const;
const NEW_SESSION_HEADER_TITLE_TYPOGRAPHY = Typography.header();

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

function canDismissNewSessionWithGesture(navigation: ModalRouteNavigation): boolean {
    return Platform.OS !== 'web' || hasPriorModalStackRoute(navigation);
}

function NewSessionModalHeaderCloseButton(props: Readonly<{ navigation: ModalRouteNavigation }>): React.ReactElement | null {
    const { width: windowWidth } = useWindowDimensions();

    if (Platform.OS === 'web' && isMobileLayoutWidth(windowWidth)) {
        return null;
    }

    return (
        <AppHeaderCloseButton
            testID="new-session-cancel"
            onPress={() => safeRouterBack({ router, navigation: props.navigation, fallbackHref: '/' })}
        />
    );
}

function NewSessionKeyboardDismissHeaderTitle(): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <Pressable
            accessibilityLabel={t('newSession.title')}
            accessibilityRole="button"
            onPress={Keyboard.dismiss}
            testID="new-session-header-keyboard-dismiss"
        >
            <Text
                style={[
                    NEW_SESSION_HEADER_TITLE_TYPOGRAPHY,
                    { color: theme.colors.chrome.header.foreground },
                ]}
            >
                {t('newSession.title')}
            </Text>
        </Pressable>
    );
}

const AuthenticatedAppShellRuntimes = React.memo(function AuthenticatedAppShellRuntimes(): React.ReactElement {
    return (
        <>
            <DesktopPetOverlayRuntimeMount />
            <PetAppShellCompanionMount />
            <ReleaseNotesAutoShowMount />
            <PushNotificationPermissionPrimingRuntime />
        </>
    );
});

const RootLayoutShell = React.memo(function RootLayoutShell(): React.ReactElement {
    const auth = useAuth();
    const { theme } = useUnistyles();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;

    // `/new` renders either the bare composer (simple) or the profile wizard, and the two want
    // different native presentations. A native stack reads `modalPresentationStyle` at present time
    // and ignores later changes, so the decision has to be made HERE, before the push — it cannot be
    // made inside the screen. `useEnhancedSessionWizard` is the whole predicate: `wizardSections` is
    // null whenever it is false (see `buildNewSessionScreenVariantModel`).
    const newSessionVariant = useSetting('useEnhancedSessionWizard') ? 'wizard' : 'simple';
    const newSessionPresentation = resolveNewSessionRoutePresentation({
        variant: newSessionVariant,
        platformOs: Platform.OS,
    });
    const newSessionRendersFloatingComposer = isNewSessionFloatingComposerPresentation({
        variant: newSessionVariant,
        platformOs: Platform.OS,
    });

    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const isDesktopPetOverlayWindow = isDesktopPetOverlayWindowContext();
    const baseStackScreenOptions = React.useMemo(() => createAppStackScreenOptions({
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [shouldUseCustomHeader, theme]);
    const mixedUseRouteScreenOptions = React.useMemo(() => {
        if (!auth.isAuthenticated) {
            return {
                terminal: UNAUTH_SHELL_STACK_SCREEN_OPTIONS,
                restore: UNAUTH_SHELL_STACK_SCREEN_OPTIONS,
                restoreManual: UNAUTH_SHELL_STACK_SCREEN_OPTIONS,
                restoreLostAccess: UNAUTH_SHELL_STACK_SCREEN_OPTIONS,
            };
        }

        return {
            terminal: {
                headerShown: true,
                headerTitle: t('terminal.connectTerminal'),
                headerBackTitle: t('common.back'),
            },
            restore: {
                headerShown: true,
                headerTitle: t('connect.restoreAccount'),
                headerBackTitle: t('common.back'),
            },
            restoreManual: {
                headerShown: true,
                headerTitle: t('navigation.restoreWithSecretKey'),
                headerBackTitle: t('common.back'),
            },
            restoreLostAccess: {
                headerShown: true,
                headerTitle: t('connect.lostAccessTitle'),
                headerBackTitle: t('common.back'),
            },
        };
    }, [auth.isAuthenticated]);

    if (isDesktopPetOverlayWindow) {
        return (
            <Stack screenOptions={DESKTOP_PET_OVERLAY_SCREEN_OPTIONS}>
                <Stack.Screen
                    name="desktop/pet-overlay"
                    options={DESKTOP_PET_OVERLAY_SCREEN_OPTIONS}
                />
            </Stack>
        );
    }

    return (
        <SessionCockpitChromeRegistryProvider>
            <ActivityBadgeRuntime />
            <ActivityLocalNotificationRuntime />
            <DesktopTrayRuntime />
            {auth.isAuthenticated ? <AuthenticatedAppShellRuntimes /> : null}
            <Stack screenOptions={baseStackScreenOptions}>
            <Stack.Screen
                name="desktop/pet-overlay"
                options={DESKTOP_PET_OVERLAY_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="index"
                options={{
                    ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                    headerShown: false,
                    headerTitle: '',
                }}
            />
            <Stack.Screen
                name="inbox/index"
                options={{
                    ...createInboxStackScreenOptions(t),
                    ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                }}
            />
            <Stack.Screen
                name="friends/index"
                options={{
                    ...createFriendsStackScreenOptions(t),
                    ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                }}
            />
            <Stack.Screen
                name="oauth/[provider]"
                options={UNAUTH_SHELL_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="mtls"
                options={UNAUTH_SHELL_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="setup"
                options={UNAUTH_SHELL_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="settings"
                options={{
                    ...MAIN_TAB_STACK_SCREEN_OPTIONS,
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="automations/index"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.automations'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="automations/[id]"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.automation'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="automations/new"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.newAutomation'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/info"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs"
                options={{
                    headerShown: true,
                    headerTitle: t('runs.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs/new"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs/[runId]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/agents"
                options={{
                    headerShown: true,
                    headerTitle: t('session.agentActivity.screenTitle'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/transcript"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/files"
                // The Files/SCM mobile route renders the exact same surface as the desktop right panel,
                // including its own header (tabs + close button). Avoid double headers.
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/git"
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/details"
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/terminal"
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/index"
                options={SESSION_COCKPIT_SURFACE_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/recent"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/archived"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="terminal/connect"
                options={mixedUseRouteScreenOptions.terminal}
            />
            <Stack.Screen
                name="terminal/index"
                options={mixedUseRouteScreenOptions.terminal}
            />
            <Stack.Screen
                name="scan/terminal"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="scan/account"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="restore/index"
                options={mixedUseRouteScreenOptions.restore}
            />
            <Stack.Screen
                name="restore/show-qr"
                options={UNAUTH_SHELL_STACK_SCREEN_OPTIONS}
            />
            <Stack.Screen
                name="restore/manual"
                options={mixedUseRouteScreenOptions.restoreManual}
            />
            <Stack.Screen
                name="restore/lost-access"
                options={mixedUseRouteScreenOptions.restoreLostAccess}
            />
            <Stack.Screen
                name="changelog"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.whatsNew'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/index"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/[id]"
                options={{
                    headerShown: false, // We'll set header dynamically
                }}
            />
            <Stack.Screen
                name="artifacts/new"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.new'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="artifacts/edit/[id]"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.edit'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="friends/manage"
                options={({ navigation }) => ({
                    headerShown: true,
                    headerTitle: t('navigation.friends'),
                    headerBackTitle: t('common.back'),
                    headerRight: () =>
                        (
                            <TouchableOpacity
                                onPress={() => navigation.navigate('friends/search' as never)}
                                style={{ paddingHorizontal: 16, opacity: friendsIdentityReady ? 1 : 0.5 }}
                                disabled={!friendsIdentityReady}
                                accessibilityState={{ disabled: !friendsIdentityReady }}
                            >
                                <Text style={{ color: theme.colors.button.primary.tint, fontSize: 16 }}>
                                    {t('friends.addFriend')}
                                </Text>
                            </TouchableOpacity>
                        ),
                })}
            />
            <Stack.Screen
                name="friends/search"
                options={{
                    headerShown: true,
                    headerTitle: t('friends.addFriend'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="user/[id]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="dev/index"
                options={{
                    headerTitle: t('navigation.developerTools'),
                }}
            />

            <Stack.Screen
                name="dev/list-demo"
                options={{
                    headerTitle: t('navigation.listComponentsDemo'),
                }}
            />
            <Stack.Screen
                name="dev/typography"
                options={{
                    headerTitle: t('navigation.typography'),
                }}
            />
            <Stack.Screen
                name="dev/colors"
                options={{
                    headerTitle: t('navigation.colors'),
                }}
            />
            <Stack.Screen
                name="dev/tools2"
                options={{
                    headerTitle: t('navigation.toolViewsDemo'),
                }}
            />
            <Stack.Screen
                name="dev/shimmer-demo"
                options={{
                    headerTitle: t('navigation.shimmerViewDemo'),
                }}
            />
            <Stack.Screen
                name="dev/multi-text-input"
                options={{
                    headerTitle: t('navigation.multiTextInput'),
                }}
            />
            <Stack.Screen
                name="new/pick/machine"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/path"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/profile"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/server"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/profile-edit"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/secret-requirement"
                options={{
                    headerShown: false,
                    // /new is presented modally on iOS. Ensure this overlay screen is too,
                    // otherwise it can end up pushed "behind" the modal (invisible but on the back stack).
                    presentation: Platform.OS === 'ios' ? 'containedModal' : 'modal',
                }}
            />
            <Stack.Screen
                name="new/index"
                options={({ navigation }) => {
                    const canDismissWithGesture = canDismissNewSessionWithGesture(navigation);
                    if (newSessionRendersFloatingComposer) {
                        return {
                            // The composer paints its own backdrop and owns its own close control,
                            // so the navigator contributes no chrome at all.
                            headerShown: false,
                            presentation: newSessionPresentation,
                            // No native transition at all: the screen owns both directions in
                            // Reanimated. UIKit's cross-dissolve is the only modal transition whose
                            // timing tracks the presentation, but its duration is not settable
                            // (`animationDuration` is inert for every modal presentation), and it
                            // was too slow and too soft to read as a composer arriving. Owning it
                            // buys the snap and the slide; the mistiming that made a JS entrance
                            // unusable before is solved by starting it from the composer's first
                            // layout rather than from mount.
                            animation: 'none',
                            // native-stack already omits its own opaque background for the two
                            // transparent presentations, but `createAppStackScreenOptions` supplies
                            // `surface.base` for every screen and is applied after it.
                            contentStyle: NEW_SESSION_TRANSPARENT_CONTENT_STYLE,
                            // `UIModalPresentationOverFullScreen` has no sheet presentation
                            // controller, so there is no interactive pull-to-dismiss to enable.
                            gestureEnabled: false,
                            fullScreenGestureEnabled: false,
                        };
                    }
                    return {
                        headerShown: true,
                        headerBackTitle: t('common.cancel'),
                        presentation: newSessionPresentation,
                        // Expo Router's web modal closes its Vaul drawer before calling goBack().
                        // With a direct /new entry there is no route to pop, so keep the drawer open
                        // and use the explicit close affordance's deterministic fallback instead.
                        gestureEnabled: canDismissWithGesture,
                        fullScreenGestureEnabled: canDismissWithGesture,
                        // Swipe-to-dismiss is not consistently available across platforms; always provide a close button.
                        headerBackVisible: false,
                        headerTitle: Platform.OS === 'web'
                            ? t('newSession.title')
                            : NewSessionKeyboardDismissHeaderTitle,
                        headerLeft: () => null,
                        headerRight: () => <NewSessionModalHeaderCloseButton navigation={navigation} />,
                    };
                }}
            />
            <Stack.Screen
                name="direct/browse"
                options={({ navigation }) => ({
                    headerTitle: t('directSessions.browseTitle'),
                    headerShown: true,
                    headerBackTitle: t('common.cancel'),
                    presentation: 'modal',
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                    headerBackVisible: false,
                    headerLeft: () => null,
                    headerRight: () => <AppHeaderCloseButton testID="direct-session-browse-cancel" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />,
                })}
            />
            <Stack.Screen
                name="zen/index"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="zen/new"
                options={{
                    presentation: 'modal',
                    headerTitle: t('navigation.zenNewTask'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="zen/view"
                options={{
                    presentation: 'modal',
                    headerTitle: t('navigation.zenTaskDetails'),
                    headerBackTitle: t('common.back'),
                }}
            />
            </Stack>
            <MobileBottomChromeHost />
        </SessionCockpitChromeRegistryProvider>
    );
});

export default function RootLayout(): React.ReactElement {
    // Composition root: subscribes to nothing that changes per navigation, so the
    // `<RootLayoutShell />` element reference stays stable and its Stack subtree is not
    // re-rendered when the route changes. Navigation/auth side effects live in the null-rendering
    // `<RootLayoutNavigationEffects />` sibling; the unauthenticated redirect check lives in the
    // `<RootLayoutRedirectGate />`, the only navigation-subscribing owner in this render path.
    return (
        <>
            <RootLayoutNavigationEffects />
            <RootLayoutRedirectGate>
                <RootLayoutShell />
            </RootLayoutRedirectGate>
        </>
    );
}
