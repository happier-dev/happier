import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import * as Fonts from 'expo-font';
import { loadBundledFontAssets } from '@/constants/bundledFonts';
import { FontAwesome, Ionicons } from '@expo/vector-icons';
import { Slot, Stack } from 'expo-router';
import { useCurrentRoutePathname } from '@/components/appShell/workspace/currentRouteLocation';
import { ctx } from 'expo-router/_ctx';
import { registerWorkspaceRouteContext } from '@/components/appShell/workspace/workspaceRouteContext';
import {
    PUSH_NOTIFICATION_BUNDLED_SOUND_FILES, PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS, resolveAndroidNotificationSoundName, } from '@happier-dev/protocol/push/pushNotificationActions';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AuthProvider, ConcurrentSessionCacheRuntime, useAuth } from '@/auth/context/AuthContext';
import { WebServerOverrideGate } from '@/components/navigation/root/RootLayoutRedirectGate';
import { OrganizationPolicyDiagnostic } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SidebarNavigator } from '@/components/navigation/shell/SidebarNavigator';
import { HorizontalSafeAreaRoot } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { WindowFoldMetricsProvider } from '@/utils/platform/useWindowFoldMetrics';
import sodium from '@/encryption/libsodium.lib';
import { View, Platform } from 'react-native';
import { AppPaneModalProvider } from '@/components/appShell/providers/AppPaneModalProvider';
import { ModalProvider } from '@/modal/ModalProvider';
import { CurrentUiContextProvider } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextActionHost } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { PostHogProvider } from 'posthog-react-native';
import { tracking } from '@/track/tracking';
import { SettingsAnalyticsRuntime } from '@/track/settingsAnalytics/SettingsAnalyticsRuntime';
import { restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { storage } from '@/sync/domains/state/storage';
import {
    clearSessionSurfaceVisibilityForNonSessionRoute,
    isSessionSurfaceVisible,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { NotificationsSettingsV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
import { useTrackScreens } from '@/track/useTrackScreens';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';
import { VoiceEnergyAppProvider } from '@/components/voice/light/VoiceEnergyAppProvider';
import { FaviconPermissionIndicator } from '@/components/web/FaviconPermissionIndicator';
import { BotsRosterRuntimeProvider } from '@/components/sessions/bots/BotsRosterRuntime';
import { CommandPaletteProvider } from '@/components/appShell/commandPalette/CommandPaletteProvider';
import { NewSessionShellHostProvider } from '@/components/sessions/new/navigation/newSessionEntry';
import { NewSessionDockedHost } from '@/components/sessions/new/components/NewSessionDockedHost';
import { WorkspaceAppShellProvider } from '@/components/appShell/workspace/WorkspaceAppShellProvider';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useWorkspaceNavigationActive } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { BrowserPresentationRetentionProvider } from '@/components/browser/surfaces/browserPresentationRetention';
import { SessionCockpitChromeRegistryProvider } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { StatusBarProvider } from '@/components/ui/layout/StatusBarProvider';
import { UpdatesEntry } from '@/components/updates/UpdatesPopoverButton';
import { UpdatesSummaryProvider } from '@/updates/useUpdatesSummary';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
// import * as SystemUI from 'expo-system-ui';
import { monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds } from '@/utils/system/remoteLogger';
import { readAiAutoDebugRemoteLoggingEnabled } from '@/utils/system/aiAutoDebuggingEnv';
import { installBugReportConsoleCapture } from '@/utils/system/bugReportLogBuffer';
import { configureBugReportUserActionTrail } from '@/utils/system/bugReportActionTrail';
import { AsyncLock } from '@/utils/system/lock';
import { useWebUiFontScale } from '@/components/ui/text/useWebUiFontScale';
import { GlassMaterialRuntime } from '@/components/ui/glass/GlassMaterialRuntime';
import { ThemeProfileRuntimeSync } from '@/theme/ThemeProfileRuntimeSync';
import { ThemeTryBarHost } from '@/theme/ThemeTryBarHost';
import { useWebRootCanvasPresentation } from '@/theme/useWebRootCanvasPresentation';
import { GlassNavigationThemeProvider } from '@/components/ui/glass/GlassNavigationThemeProvider';
import { captureExceptionIfEnabled, initializeSentryOnce, wrapWithSentryIfEnabled } from '@/utils/system/sentry';
import { t } from '@/text';
import { preloadTranslations } from '@/text/i18n';
import { AppCrashRecoveryBoundary } from '@/components/appShell/AppCrashRecoveryBoundary';
import { WebCryptoStartupGate } from '@/components/web/WebCryptoStartupGate';
import { consumeRestartBugReportIntent } from '@/utils/system/restartBugReportIntent';
import { getCurrentReactOwnerHint, getUnexpectedPrimitiveViewChildInfo } from '@/utils/system/debugUnexpectedTextNodeCapture';
import { resolveForegroundNotificationBehavior } from '@/activity/notifications/resolveForegroundNotificationBehavior';
import { configureNotificationCategories } from '@/activity/notifications/configureNotificationCategories';
import { resolveBootCredentials } from '@/boot/resolveBootCredentials';
import { runAppBootSequence, reportDesktopAppBootPhase, type AppBootPhase, type AppBootReadyState } from '@/boot/runAppBootSequence';
import { AppBootPendingSurface } from '@/boot/AppBootPendingSurface';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { prepareWarmCacheStorage } from '@/sync/domains/state/warmCachePersistence';
import { installTauriMcpBridgeOnce } from '@/desktop/mcp/maybeInstallTauriMcpBridge';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { DesktopShellUpdateIndicatorHost } from '@/components/navigation/shell/desktopChrome/DesktopShellUpdateIndicatorHost';
import { DesktopShellWindowControlsHost } from '@/components/navigation/shell/desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from '@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls';
import { isTerminalConnectWebPathname } from '@/utils/path/terminalConnectUrl';
import { desktopHostKind, isDesktopHost } from '@/utils/platform/desktopHost';
import { installTauriExternalLinkClicks } from '@/utils/url/installTauriExternalLinkClicks';
import { useIsTablet } from '@/utils/platform/responsive';
import { resolveAppShellChromeHost } from '@/components/appShell/resolveAppShellChromeHost';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { readBrowserAppWindowRecord, resolveDesktopAppWindowBootCredentials, runDesktopAppWindowBootSequence } from '@/desktop/window/appWindowBoot';
import { ThemePreferenceTransitionHost } from '@/components/settings/appearance/ThemePreferenceTransitionHost';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { useDesktopMainWindowContentReady } from '@/desktop/window/useDesktopMainWindowContentReady';
import { loadExpoNotifications, type ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { installWebFontFaces } from '@/platform/installWebFontFaces';
import { AppPresentationPlatformProvider } from '@/components/ui/presentation/AppPresentationPlatformProvider';
import { CompanionNoDragRegionProvider } from '@/components/companion/interaction/CompanionNoDragRegion';
import { PersonalHomeBootstrapRuntimeMount } from '@/components/personalHome/bootstrap';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { EmbedSessionRuntimeProvider } from '@/embed/runtime/EmbedSessionRuntimeProvider';
import { EmbedBridgeRuntime } from '@/embed/bridge/EmbedBridgeRuntime';

const embedWindowContext = isEmbedWindowContext();
const desktopWindowContext = resolveDesktopWindowContext();
const nativeSecondaryWindow = desktopWindowContext.role === 'secondary' && isDesktopHost();
const browserAppWindow = desktopWindowContext.role === 'secondary' && !nativeSecondaryWindow ? readBrowserAppWindowRecord() : undefined;

// Expo evaluates this root before rendering any workspace route. Publishing
// its exact context here keeps optional workspace graphs free of the app tree
// and preserves Router's existing entry and React Fast Refresh boundary.
registerWorkspaceRouteContext(ctx);

if (!embedWindowContext) {
    initializeSentryOnce();
    installTauriMcpBridgeOnce();
}

function shouldCaptureRnwUnexpectedTextNodeStacks(): boolean {
    // Dev-only diagnostics: enable via `?debugRnwTextNode=1` on web.
    // Keep this silent by default to avoid console noise.
    if (process.env.NODE_ENV === 'production') return false;
    if (Platform.OS !== 'web') return false;
    if (typeof window === 'undefined') return false;
    try {
        const current = new URL(window.location.href);
        const raw = (current.searchParams.get('debugRnwTextNode') ?? '').trim().toLowerCase();
        return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
    } catch {
        return false;
    }
}

function shouldCrashOnRnwUnexpectedTextNode(): boolean {
    // Dev-only diagnostics: enable via `?debugRnwTextNodeCrash=1` on web.
    if (process.env.NODE_ENV === 'production') return false;
    if (Platform.OS !== 'web') return false;
    if (typeof window === 'undefined') return false;
    try {
        const current = new URL(window.location.href);
        const raw = (current.searchParams.get('debugRnwTextNodeCrash') ?? '').trim().toLowerCase();
        return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
    } catch {
        return false;
    }
}

function installRnwUnexpectedTextNodeStackCaptureOnce() {
    if (typeof globalThis === 'undefined') return;
    const g = globalThis as any;
    if (g.__HAPPIER_RNW_TEXTNODE_STACK_CAPTURE_INSTALLED__) return;
    g.__HAPPIER_RNW_TEXTNODE_STACK_CAPTURE_INSTALLED__ = true;

    const original = console.error;
    const seen = new Set<string>();
    const crash = shouldCrashOnRnwUnexpectedTextNode();

    console.error = (...args: any[]) => {
        let handledUnexpectedTextNode = false;
        let crashMessage: string | null = null;
        try {
            const first = args[0];
            if (typeof first === 'string' && first.startsWith('Unexpected text node:')) {
                handledUnexpectedTextNode = true;
                // De-dupe per unique message to keep logs readable.
                if (!seen.has(first)) {
                    seen.add(first);
                    const ownerHint = getCurrentReactOwnerHint(React);
                    original(...args);
                    if (ownerHint) original('[debugRnwTextNode] owner:', ownerHint);
                    original('[debugRnwTextNode] stack:', new Error(first).stack);
                    if (crash) {
                        crashMessage = first;
                    }
                }
            }
        } catch {
            // ignore
        }
        if (crashMessage) {
            throw new Error(crashMessage);
        }
        if (handledUnexpectedTextNode) return;
        original(...args);
    };
}

function installReactCreateElementUnexpectedTextNodeCaptureOnce() {
    if (typeof globalThis === 'undefined') return;
    const g = globalThis as any;
    if (g.__HAPPIER_REACT_CREATE_ELEMENT_TEXTNODE_CAPTURE_INSTALLED__) return;
    g.__HAPPIER_REACT_CREATE_ELEMENT_TEXTNODE_CAPTURE_INSTALLED__ = true;

    const original = React.createElement;
    const seen = new Set<string>();
    let logged = 0;

    (React as any).createElement = (type: any, props: any, ...children: any[]) => {
        try {
            const rawChildren = children.length > 0 ? children : (props?.children ?? []);
            const flat = React.Children.toArray(rawChildren as any[]);
            const info = getUnexpectedPrimitiveViewChildInfo({
                type,
                props,
                flatChildren: flat,
            });
            if (info && !seen.has(info.signature) && logged < 10) {
                seen.add(info.signature);
                logged += 1;

                const ownerHint = getCurrentReactOwnerHint(React);
                console.error('[debugRnwTextNode] element created with primitive View child', {
                    ...info,
                    ownerHint,
                });
                console.error('[debugRnwTextNode] createElement stack:', new Error('primitive child').stack);
            }
        } catch {
            // ignore
        }
        return original(type, props, ...children);
    };
}

function installReactJsxRuntimeUnexpectedTextNodeCaptureOnce() {
    // React's automatic JSX runtime bypasses React.createElement, so patching createElement won't
    // catch problematic primitives passed into <View>. In dev-only debug mode, patch jsx/jsxs.
    if (typeof globalThis === 'undefined') return;
    const g = globalThis as any;
    if (g.__HAPPIER_REACT_JSX_RUNTIME_TEXTNODE_CAPTURE_INSTALLED__) return;
    g.__HAPPIER_REACT_JSX_RUNTIME_TEXTNODE_CAPTURE_INSTALLED__ = true;

    try {
        const seen = new Set<string>();

        const logIfBadChildren = (type: any, props: any) => {
            try {
                const flat = React.Children.toArray(props?.children ?? []);
                const info = getUnexpectedPrimitiveViewChildInfo({
                    type,
                    props,
                    flatChildren: flat,
                });
                if (info && !seen.has(info.signature)) {
                    seen.add(info.signature);

                    const ownerHint = getCurrentReactOwnerHint(React);
                    console.error('[debugRnwTextNode] jsx-runtime element created with primitive View child', {
                        ...info,
                        ownerHint,
                    });
                    console.error('[debugRnwTextNode] jsx-runtime stack:', new Error('primitive child').stack);
                }
            } catch {
                // ignore
            }
        };

        const wrapJsx = (fn: any) => (type: any, props: any, key: any) => {
            logIfBadChildren(type, props);
            return fn(type, props, key);
        };

        // In dev, React uses jsxDEV from react/jsx-dev-runtime.
        // Patch both modules to catch primitives passed into <View>.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const runtime = require('react/jsx-runtime');
        if (runtime) {
            if (typeof runtime.jsx === 'function') runtime.jsx = wrapJsx(runtime.jsx);
            if (typeof runtime.jsxs === 'function') runtime.jsxs = wrapJsx(runtime.jsxs);
        }

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const devRuntime = require('react/jsx-dev-runtime');
        if (devRuntime && typeof devRuntime.jsxDEV === 'function') {
            const original = devRuntime.jsxDEV;
            devRuntime.jsxDEV = (type: any, props: any, key: any, isStaticChildren: any, source: any, self: any) => {
                logIfBadChildren(type, props);
                return original(type, props, key, isStaticChildren, source, self);
            };
        }
    } catch {
        // ignore
    }
}

function installReactNativeViewRenderUnexpectedTextNodeCaptureOnce() {
    if (typeof globalThis === 'undefined') return;
    const g = globalThis as any;
    if (g.__HAPPIER_RNW_VIEW_RENDER_TEXTNODE_CAPTURE_INSTALLED__) return;
    g.__HAPPIER_RNW_VIEW_RENDER_TEXTNODE_CAPTURE_INSTALLED__ = true;

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const reactNative = require('react-native');
        const viewCandidate = reactNative?.View;
        if (!viewCandidate) return;

        const wrapRender = (original: any) => {
            const seen = new Set<string>();
            return function wrappedViewRender(this: unknown, props: Record<string, unknown>, ref: unknown) {
                try {
                    const flatChildren = React.Children.toArray((props as any)?.children ?? []);
                    const info = getUnexpectedPrimitiveViewChildInfo({
                        type: viewCandidate,
                        props,
                        flatChildren,
                    });
                    if (info && !seen.has(info.signature)) {
                        seen.add(info.signature);
                        console.error('[debugRnwTextNode] View render primitive child', {
                            ...info,
                            ownerHint: getCurrentReactOwnerHint(React),
                        });
                        console.error('[debugRnwTextNode] View render stack:', new Error('primitive child').stack);
                    }
                } catch {
                    // ignore
                }
                return original.call(this, props, ref);
            };
        };

        if (typeof viewCandidate?.render === 'function') {
            viewCandidate.render = wrapRender(viewCandidate.render);
            return;
        }

        if (typeof viewCandidate === 'function') {
            reactNative.View = wrapRender(viewCandidate);
        }
    } catch {
        // ignore
    }
}

function configureForegroundNotificationHandler(Notifications: ExpoNotificationsModule): void {
    // Suppresses same-session notifications and respects the foregroundBehavior setting.
    Notifications.setNotificationHandler({
        handleNotification: async (notification) => {
        // One owner names the arrival's exact Home, event and channel, applies
        // exact-Home same-Session suppression and asks the delivery-plan owner.
        const foregroundBehavior = await resolveForegroundNotificationBehavior({
            content: notification.request.content,
            localSettings: storage.getState().localSettings,
            now: new Date(),
            isSessionVisible: (address) => isSessionSurfaceVisible(address.sessionId, address.serverId),
        });

        switch (foregroundBehavior) {
            case 'off':
                return { shouldPlaySound: false, shouldSetBadge: true, shouldShowBanner: false, shouldShowList: false };
            case 'silent':
                return { shouldPlaySound: false, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true };
            case 'full':
            default:
                return { shouldPlaySound: true, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true };
        }
        },
    });
}

function configureAndroidNotificationChannels(Notifications: ExpoNotificationsModule): void {
    if (Platform.OS !== 'android') return;

    const channelConfigs = [
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultV1,
            name: t('notifications.channels.default'),
            importance: Notifications.AndroidImportance.MAX,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultSoftV1,
            name: t('notifications.channels.default'),
            importance: Notifications.AndroidImportance.MAX,
            sound: resolveAndroidNotificationSoundName('soft'),
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultUrgentV1,
            name: t('notifications.channels.default'),
            importance: Notifications.AndroidImportance.MAX,
            sound: resolveAndroidNotificationSoundName('urgent'),
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultSilentV1,
            name: t('notifications.channels.default'),
            importance: Notifications.AndroidImportance.MAX,
            sound: null,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1,
            name: t('notifications.channels.permissionRequests'),
            importance: Notifications.AndroidImportance.MAX,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsSoftV1,
            name: t('notifications.channels.permissionRequests'),
            importance: Notifications.AndroidImportance.MAX,
            sound: PUSH_NOTIFICATION_BUNDLED_SOUND_FILES.soft.androidSoundName,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsUrgentV1,
            name: t('notifications.channels.permissionRequests'),
            importance: Notifications.AndroidImportance.MAX,
            sound: PUSH_NOTIFICATION_BUNDLED_SOUND_FILES.urgent.androidSoundName,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsSilentV1,
            name: t('notifications.channels.permissionRequests'),
            importance: Notifications.AndroidImportance.MAX,
            sound: null,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1,
            name: t('notifications.channels.userActionRequests'),
            importance: Notifications.AndroidImportance.HIGH,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsSoftV1,
            name: t('notifications.channels.userActionRequests'),
            importance: Notifications.AndroidImportance.HIGH,
            sound: PUSH_NOTIFICATION_BUNDLED_SOUND_FILES.soft.androidSoundName,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsUrgentV1,
            name: t('notifications.channels.userActionRequests'),
            importance: Notifications.AndroidImportance.HIGH,
            sound: PUSH_NOTIFICATION_BUNDLED_SOUND_FILES.urgent.androidSoundName,
        },
        {
            id: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsSilentV1,
            name: t('notifications.channels.userActionRequests'),
            importance: Notifications.AndroidImportance.HIGH,
            sound: null,
        },
    ] as const;

    for (const channel of channelConfigs) {
        const channelSound = 'sound' in channel ? channel.sound : undefined;
        void Notifications.setNotificationChannelAsync(channel.id, {
            name: channel.name,
            importance: channel.importance,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#FF231F7C',
            showBadge: true,
            ...('sound' in channel ? { sound: channelSound } : {}),
        }).catch(() => {});
    }
}

void (async () => {
    if (embedWindowContext || desktopWindowContext.role !== 'primary') return;
    try {
        const Notifications = await loadExpoNotifications();
        configureForegroundNotificationHandler(Notifications);
        configureAndroidNotificationChannels(Notifications);
        if (Platform.OS !== 'web') await configureNotificationCategories(Notifications);
    } catch {
        // Native notification modules are optional in local dev clients; startup must still render.
    }
})();

export {
    // Catch any errors thrown by the Layout component.
    ErrorBoundary,
} from 'expo-router';

// Configure splash screen
SplashScreen.setOptions({
    fade: true,
    duration: 300,
})
SplashScreen.preventAutoHideAsync();

// NEVER ENABLE REMOTE LOGGING IN PRODUCTION
// This is for local debugging with AI only
// So AI will have all the logs easily accessible in one file for analysis
if (!embedWindowContext && readAiAutoDebugRemoteLoggingEnabled()) {
    monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds()
}
if (!embedWindowContext) {
    installBugReportConsoleCapture({ maxEntries: 300 });
    configureBugReportUserActionTrail({ maxActions: 300 });
}

if (shouldCaptureRnwUnexpectedTextNodeStacks()) {
    installRnwUnexpectedTextNodeStackCaptureOnce();
    installReactCreateElementUnexpectedTextNodeCaptureOnce();
    installReactJsxRuntimeUnexpectedTextNodeCaptureOnce();
    installReactNativeViewRenderUnexpectedTextNodeCaptureOnce();
}

let lock = new AsyncLock();
let loaded = false;
let suppressFontTimeoutErrorsUntilMs = 0;
let webFontLoadAttemptedAtMs = 0;

async function loadFonts() {
    await lock.inLock(async () => {
        if (loaded) {
            return;
        }
        loaded = true;
        // Prefer DOM detection over Platform.OS so web builds remain resilient even if Platform.OS is
        // surprising in some environments.
        const isWeb = Platform.OS === 'web' || (typeof document !== 'undefined');

        const isWebAutomation = isWeb &&
            typeof navigator !== 'undefined' &&
            (navigator as any).webdriver === true;

        const isFontTimeoutSuppressionEnabled = (() => {
            if (isWebAutomation) return true;
            const raw = String(process.env.PUBLIC_EXPO_WEB_SUPPRESS_FONT_TIMEOUT_OVERLAY ?? '').trim().toLowerCase();
            return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
        })();

        const suppressFontTimeoutBootWindowMs =
            Number(process.env.PUBLIC_EXPO_WEB_FONT_TIMEOUT_SUPPRESS_BOOT_WINDOW_MS) || 20_000;
        const suppressFontTimeoutAttemptWindowMs =
            Number(process.env.PUBLIC_EXPO_WEB_FONT_TIMEOUT_SUPPRESS_ATTEMPT_WINDOW_MS) || 60_000;

        // expo-font uses FontFaceObserver on web with a hard-coded 6s timeout; in practice, timeouts
        // can surface as uncaught errors or unhandled rejections during startup even when font files
        // are reachable. Only suppress this signature when explicitly enabled (automation contexts by
        // default), to avoid hiding unrelated startup errors for real users.
        if (isWeb && isFontTimeoutSuppressionEnabled) {
            suppressFontTimeoutErrorsUntilMs = Date.now() + suppressFontTimeoutBootWindowMs;
        }

        if (
            isWeb &&
            isFontTimeoutSuppressionEnabled &&
            typeof window !== 'undefined' &&
            typeof window.addEventListener === 'function'
        ) {
            // expo-font uses FontFaceObserver on web. In practice, it can emit unhandled timeout
            // rejections in some environments (including automation), even when callers ignore the
            // load promise. Suppress only that known FontFaceObserver timeout case.
            window.addEventListener('unhandledrejection', (event: any) => {
                const reason = event?.reason;
                const message = typeof reason?.message === 'string' ? reason.message : '';
                const stack = typeof reason?.stack === 'string' ? reason.stack : '';
                const stackLower = stack.toLowerCase();
                // FontFaceObserver timeouts can surface with either a useful stack, or an empty stack
                // string (depending on environment). Suppress only this known timeout signature.
                const inBootWindow = Date.now() < suppressFontTimeoutErrorsUntilMs;
                const inFontAttemptWindow =
                    webFontLoadAttemptedAtMs > 0 &&
                    (Date.now() - webFontLoadAttemptedAtMs) < suppressFontTimeoutAttemptWindowMs;
                const matchesFontTimeoutSignature =
                    stackLower.includes('fontfaceobserver')
                    || (isWebAutomation && !stack && (inBootWindow || inFontAttemptWindow));
                if (message.includes('ms timeout exceeded') && matchesFontTimeoutSignature) {
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    // Prevent dev overlays (and other listeners) from surfacing this known-safe startup
                    // timeout by stopping propagation when supported.
                    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                    if (typeof event.stopPropagation === 'function') event.stopPropagation();
                }
            });

            // Some environments surface the same FontFaceObserver timeout as an uncaught error
            // (instead of an unhandled rejection). Suppress only this known timeout signature.
            window.addEventListener('error', (event: any) => {
                const err = event?.error;
                const message =
                    (typeof err?.message === 'string' ? err.message : '') ||
                    (typeof event?.message === 'string' ? event.message : '');
                const stack = typeof err?.stack === 'string' ? err.stack : '';
                const stackLower = stack.toLowerCase();
                const inBootWindow = Date.now() < suppressFontTimeoutErrorsUntilMs;
                const inFontAttemptWindow =
                    webFontLoadAttemptedAtMs > 0 &&
                    (Date.now() - webFontLoadAttemptedAtMs) < suppressFontTimeoutAttemptWindowMs;
                const matchesFontTimeoutSignature =
                    stackLower.includes('fontfaceobserver')
                    || (isWebAutomation && !stack && (inBootWindow || inFontAttemptWindow));
                if (message.includes('ms timeout exceeded') && matchesFontTimeoutSignature) {
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                    if (typeof event.stopPropagation === 'function') event.stopPropagation();
                }
            });
        }

        const fontMap = {
            ...loadBundledFontAssets(),
            ...FontAwesome.font,
            ...Ionicons.font,
        };

        // On web, expo-font uses FontFaceObserver with a hard-coded ~6s timeout. In practice, this
        // can time out (and surface as uncaught errors / unhandled rejections) even when font files
        // are reachable. Avoid expo-font entirely on web and inject `@font-face` rules instead.
        if (isWeb) {
            try {
                webFontLoadAttemptedAtMs = Date.now();
                await installWebFontFaces(fontMap);
            } catch {
                // Do not surface font init issues on web.
            }
            return;
        }

        // Native platforms: register bundled fonts; boot can use platform fallback meanwhile.
        await Fonts.loadAsync(fontMap);
    });
}

function EmbedRootLayout() {
    useWebRootCanvasPresentation(false);
    return <AppPresentationPlatformProvider><WebCryptoStartupGate><EmbedAppBoot /></WebCryptoStartupGate></AppPresentationPlatformProvider>;
}

function EmbedAppBoot() {
    const [ready, setReady] = React.useState(false);
    const [error, setError] = React.useState<Error | null>(null);
    React.useEffect(() => {
        let cancelled = false;
        void runAppBootSequence({
            onPhase: reportDesktopAppBootPhase,
            context: 'embed',
            loadFonts,
            sodiumReady: sodium.ready,
            resolveCredentials: () => resolveBootCredentials(Platform.OS),
            prepareWarmCache: prepareWarmCacheStorage,
            prepareSessionDrafts: prepareSessionDraftPersistenceStorage,
            prepareTranslations: () => preloadTranslations(),
            restoreSync: restoreConnectionToActiveServer,
            onReady: () => {
                if (cancelled) return;
                setReady(true);
                void SplashScreen.hideAsync().catch(() => {});
            },
        }).catch((cause: unknown) => {
            if (cancelled) return;
            setError(cause instanceof Error ? cause : new Error('Failed to initialize embed', { cause }));
            void SplashScreen.hideAsync().catch(() => {});
        });
        return () => { cancelled = true; };
    }, []);
    if (error) throw error;
    if (!ready) return null;
    return (
        <EmbedSessionRuntimeProvider>
            <EmbedBridgeRuntime />
            <Slot />
        </EmbedSessionRuntimeProvider>
    );
}

function FullAppRootLayout() {
    React.useEffect(() => {
        if (Platform.OS === 'web' && desktopHostKind() === 'tauri') {
            return installTauriExternalLinkClicks();
        }
    }, []);
    useWebUiFontScale();

    const onRestart = React.useCallback(() => {
        if (Platform.OS === 'web') {
            try {
                (globalThis as any).location?.reload?.();
            } catch {
                // ignore
            }
            return;
        }

        void import('expo-updates')
            .then((Updates) => Updates.reloadAsync())
            .catch(() => {});
    }, []);

    return (
        <AppPresentationPlatformProvider>
            <CompanionNoDragRegionProvider>
            <GlassMaterialRuntime>
            <ThemeProfileRuntimeSync enabled={!embedWindowContext} />
            <WebCryptoStartupGate>
                <AppCrashRecoveryBoundary
                    onRestart={onRestart}
                    onError={(error) => captureExceptionIfEnabled(error)}
                >
                    <AppBoot />
                </AppCrashRecoveryBoundary>
            </WebCryptoStartupGate>
            </GlassMaterialRuntime>
            </CompanionNoDragRegionProvider>
        </AppPresentationPlatformProvider>
    );
}

/** Recovery enters through the same retained-destination owner as ordinary navigation. */
function RestartBugReportNavigation(props: Readonly<{ pending: boolean; onDispatched: () => void }>) {
    const router = useDestinationRouter();
    // Reads only whether the workspace hosts the route, so tab and query writes do not wake it.
    const workspaceActive = useWorkspaceNavigationActive();
    // The provider also exists on native, where the stack owns navigation and
    // an inactive workspace is not a hydration barrier for that stack.
    const ready = Platform.OS !== 'web' || workspaceActive;
    React.useEffect(() => {
        if (!props.pending || !ready) return;
        try {
            router.push('/settings/report-issue');
            props.onDispatched();
        } catch {
            console.warn('[bug-report] Could not open the saved crash report');
        }
    }, [props.onDispatched, props.pending, ready, router]);
    return null;
}

function AppBoot() {
    //
    // Init sequence
    //
    const pathname = useCurrentRoutePathname();
    const isDesktopOverlayWindow = desktopWindowContext.role === 'presenter';
    const primaryRealm = desktopWindowContext.role === 'primary';
    const fullChrome = desktopWindowContext.chrome === 'full';
    const [initState, setInitState] = React.useState<AppBootReadyState | null>(null);
    const bootReady = initState !== null;
    const [bootError, setBootError] = React.useState<Error | null>(null);
    const [bootPhase, setBootPhase] = React.useState<AppBootPhase | null>(null);
    const [restartBugReportPending, setRestartBugReportPending] = React.useState(false);
    const restartBugReportIntent = React.useRef<Promise<boolean> | null>(null);
    const onRestartBugReportDispatched = React.useCallback(() => setRestartBugReportPending(false), []);

    React.useEffect(() => {
        if (!bootReady || !primaryRealm) return;
        let current = true;
        // Account/catalog admission can withdraw the workspace subtree. Keep its
        // one-time recovery request here until that owner can accept navigation.
        restartBugReportIntent.current ??= consumeRestartBugReportIntent();
        void restartBugReportIntent.current.then((requested) => {
            if (current) setRestartBugReportPending(requested);
        }).catch(() => {
            console.warn('[bug-report] Could not read the restart report intent');
        });
        return () => { current = false; };
    }, [bootReady, primaryRealm]);

    const isTerminalConnectRoute = isTerminalConnectWebPathname(pathname);

    React.useEffect(() => {
        clearSessionSurfaceVisibilityForNonSessionRoute(pathname);
    }, [pathname]);

    React.useEffect(() => {
        let cancelled = false;
        const runBoot = nativeSecondaryWindow ? runDesktopAppWindowBootSequence : runAppBootSequence;
        void runBoot({
            context: isDesktopOverlayWindow ? 'presenter' : 'app',
            onPhase: (phase) => {
                reportDesktopAppBootPhase(phase);
                // Phases passed within one task batch into one render: only a phase that is
                // still current when React renders (a held credential read) is ever drawn.
                if (!cancelled) setBootPhase(phase);
            },
            loadFonts,
            sodiumReady: sodium.ready,
            resolveCredentials: () => nativeSecondaryWindow
                ? resolveDesktopAppWindowBootCredentials(Platform.OS)
                : browserAppWindow === null ? Promise.resolve(null)
                    : resolveBootCredentials(Platform.OS, browserAppWindow && {
                        serverId: browserAppWindow.homeId, accountId: browserAppWindow.accountId,
                    }),
            prepareWarmCache: prepareWarmCacheStorage,
            prepareSessionDrafts: prepareSessionDraftPersistenceStorage,
            prepareTranslations: () => preloadTranslations(),
            restoreSync: isDesktopOverlayWindow ? null : restoreConnectionToActiveServer,
            onReady: (state) => {
                if (cancelled) return;
                setInitState(state);
            },
        }).catch((error: unknown) => {
            if (cancelled) return;
            setBootError(error instanceof Error ? error : new Error('Failed to initialize app storage', { cause: error }));
            void SplashScreen.hideAsync().catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [isDesktopOverlayWindow]);

    React.useEffect(() => {
        if (initState) {
            setTimeout(() => {
                SplashScreen.hideAsync();
            }, 100);
        }
    }, [initState]);


    // Track the screens
    useTrackScreens()

    //
    // Not inited
    //

    if (bootError) throw bootError;
    if (!initState) {
        return <AppBootPendingSurface phase={bootPhase} />;
    }

    //
    // Boot
    //

    const routeNavigation = (
        <VoiceEnergyAppProvider>
            <SidebarNavigator />
        </VoiceEnergyAppProvider>
    );
    const realtimeRouteContent = primaryRealm ? <RealtimeProvider>{routeNavigation}</RealtimeProvider> : routeNavigation;
    const routeContent = desktopWindowContext.chrome === 'destination'
        ? realtimeRouteContent
        : <AppActivityOwner>{realtimeRouteContent}</AppActivityOwner>;

    const appShellWithRootDesktopDragSurface = (
        <RootShellChromeFrame
            isAuthenticated={initState.credentials != null}
            fullChrome={fullChrome}
            isTerminalConnectRoute={isTerminalConnectRoute}
        >
            {primaryRealm ? <PersonalHomeBootstrapRuntimeMount>{routeContent}</PersonalHomeBootstrapRuntimeMount> : routeContent}
        </RootShellChromeFrame>
    );

    const appContent = (
        <ThemePreferenceTransitionHost>
            <HorizontalSafeAreaRoot>
                <CurrentUiContextActionHost />
                <OrganizationPolicyDiagnostic />
                {/* Routes and hosted workspace destinations share the retained source owner.
                    Keep its portal beneath the same keyboard and current-UI contexts. */}
                <BrowserPresentationRetentionProvider>
                    {fullChrome && !isTerminalConnectRoute
                        ? <NewSessionDockedHost>{appShellWithRootDesktopDragSurface}</NewSessionDockedHost>
                        : appShellWithRootDesktopDragSurface}
                </BrowserPresentationRetentionProvider>
            </HorizontalSafeAreaRoot>
        </ThemePreferenceTransitionHost>
    );
    /*
     * Voice/realtime still wrap `SidebarNavigator`, which renders the sidebar voice
     * surface above the nested route layout. They intentionally live inside the Personal Home
     * content gate: the stable root canvas/chrome and normal route stay mounted during automatic
     * Home startup, while explicit existing-Home and recovery decisions still hold the route.
     */
    let providers = (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <KeyboardProvider>
                <GestureHandlerRootView style={{ flex: 1 }}>
                    <WindowFoldMetricsProvider>
                    {/*
                      * Keyed on the boot auth generation: `0` on every normal boot, so the key never
                      * changes and nothing remounts. It only advances when a keychain read that missed
                      * its boot deadline lands afterwards, which is how a recovered session is adopted
                      * instead of the user silently appearing signed out.
                      */}
                    {isDesktopOverlayWindow ? (
                        <GlassNavigationThemeProvider>
                            <ModalProvider>
                                <HorizontalSafeAreaRoot><Slot /></HorizontalSafeAreaRoot>
                            </ModalProvider>
                        </GlassNavigationThemeProvider>
                    ) : <AuthProvider initialCredentials={initState.credentials}>
                        <GlassNavigationThemeProvider>
                            <StatusBarProvider />
                            <AppPaneModalProvider>
                                <WebServerOverrideGate>
                                <ConcurrentSessionCacheRuntime>
                                <SessionCockpitChromeRegistryProvider>
                                <WorkspaceAppShellProvider browserWindow={browserAppWindow}>
                                {primaryRealm ? <RestartBugReportNavigation pending={restartBugReportPending} onDispatched={onRestartBugReportDispatched} /> : null}
                                <NewSessionShellHostProvider>
                                <MainAppTabStateProvider>
                                <CurrentUiContextProvider>
                                <BotsRosterRuntimeProvider>
                                <CommandPaletteProvider>
                                    {appContent}
                                </CommandPaletteProvider>
                                </BotsRosterRuntimeProvider>
                                </CurrentUiContextProvider>
                                </MainAppTabStateProvider>
                                </NewSessionShellHostProvider>
                                {!embedWindowContext ? <ThemeTryBarHost /> : null}
                                </WorkspaceAppShellProvider>
                                </SessionCockpitChromeRegistryProvider>
                                </ConcurrentSessionCacheRuntime>
                                </WebServerOverrideGate>
                            </AppPaneModalProvider>
                        </GlassNavigationThemeProvider>
                    </AuthProvider>}
                    </WindowFoldMetricsProvider>
                </GestureHandlerRootView>
            </KeyboardProvider>
        </SafeAreaProvider>
    );
    if (tracking) {
        providers = (
            <PostHogProvider client={tracking} autocapture={{ captureScreens: false }}>
                <SettingsAnalyticsRuntime />
                {providers}
            </PostHogProvider>
        );
    }

    return (
        <>
            {primaryRealm && !isTerminalConnectRoute ? <FaviconPermissionIndicator /> : null}
            {providers}
        </>
    );
}

/** Sidebar and global Voice share the same authenticated personal-session census. */
function AppActivityOwner(props: React.PropsWithChildren): React.ReactElement {
    const { isAuthenticated } = useAuth();
    return <ActivityPersonalSessionMembershipProvider enabled={isAuthenticated}>{props.children}</ActivityPersonalSessionMembershipProvider>;
}

/** Breakpoint geometry updates this frame without rebuilding the boot/provider/route tree. */
function RootShellChromeFrame(props: React.PropsWithChildren<Readonly<{
    isAuthenticated: boolean;
    fullChrome: boolean;
    isTerminalConnectRoute: boolean;
}>>) {
    const onContentLayout = useDesktopMainWindowContentReady();
    const chromeSafeArea = useChromeSafeAreaInsets();
    const isTablet = useIsTablet();
    const desktopHost = isDesktopHost();
    const chromeHost = !props.fullChrome ? 'none' : resolveAppShellChromeHost({
        isAuthenticated: props.isAuthenticated,
        isDesktopHost: desktopHost,
        isTablet,
        isTerminalConnectRoute: props.isTerminalConnectRoute,
    });
    const shell = <View onLayout={onContentLayout} style={{ flex: 1, position: 'relative' }}>
        {chromeHost === 'narrow-desktop-fallback' ? <DesktopFallbackShellChrome chromeSafeArea={chromeSafeArea} /> : null}
        <View style={{ flex: 1 }}>{props.children}</View>
    </View>;
    return <DesktopMainContentDragSurface
        enabled={(chromeHost === 'unauth-shell' || chromeHost === 'narrow-desktop-fallback') && Platform.OS === 'web' && desktopHost}
        leftOffsetPx={0} style={{ flex: 1 }}>
        {props.fullChrome ? <UpdatesSummaryProvider>{shell}</UpdatesSummaryProvider> : shell}
    </DesktopMainContentDragSurface>;
}

function DesktopFallbackShellChrome(props: Readonly<{
    chromeSafeArea: Readonly<{ top: number; left: number }>;
}>) {
    const resolvedDesktopWindowControls = useResolvedDesktopWindowControls({
        variant: 'expanded',
    });

    return (
        <View
            pointerEvents="box-none"
            style={{
                position: 'absolute',
                top: props.chromeSafeArea.top + 12,
                left: props.chromeSafeArea.left + 16,
                zIndex: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
            }}
            testID="desktop-narrow-shell-chrome"
        >
            <DesktopShellWindowControlsHost>
                {resolvedDesktopWindowControls}
            </DesktopShellWindowControlsHost>
            <DesktopShellUpdateIndicatorHost>
                <UpdatesEntry variant="pill" testID="root-shell-updates-pill" />
            </DesktopShellUpdateIndicatorHost>
        </View>
    );
}

// This realm chooses its boot owner once. Route navigation cannot start another runtime.
const RootLayout = embedWindowContext ? EmbedRootLayout : wrapWithSentryIfEnabled(FullAppRootLayout);
export default RootLayout;
