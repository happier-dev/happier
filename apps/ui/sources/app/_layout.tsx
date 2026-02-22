import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import * as Fonts from 'expo-font';
import { Asset } from 'expo-asset';
import * as Notifications from 'expo-notifications';
import { FontAwesome } from '@expo/vector-icons';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { AuthProvider } from '@/auth/context/AuthContext';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SidebarNavigator } from '@/components/navigation/shell/SidebarNavigator';
import sodium from '@/encryption/libsodium.lib';
import { View, Platform } from 'react-native';
import { ModalProvider } from '@/modal';
import { PostHogProvider } from 'posthog-react-native';
import { tracking } from '@/track/tracking';
import { syncRestore } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { getActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
import { NotificationsSettingsV1Schema } from '@happier-dev/protocol';
import { useTrackScreens } from '@/track/useTrackScreens';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import { FaviconPermissionIndicator } from '@/components/web/FaviconPermissionIndicator';
import { CommandPaletteProvider } from '@/components/CommandPalette/CommandPaletteProvider';
import { StatusBarProvider } from '@/components/ui/layout/StatusBarProvider';
import { DesktopUpdateBanner } from '@/components/ui/feedback/DesktopUpdateBanner';
// import * as SystemUI from 'expo-system-ui';
import { monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds } from '@/utils/system/remoteLogger';
import { installBugReportConsoleCapture } from '@/utils/system/bugReportLogBuffer';
import { configureBugReportUserActionTrail } from '@/utils/system/bugReportActionTrail';
import { useUnistyles } from 'react-native-unistyles';
import { AsyncLock } from '@/utils/system/lock';
import { useWebUiFontScale } from '@/components/ui/text/useWebUiFontScale';

function shouldCaptureRnwUnexpectedTextNodeStacks(): boolean {
    // Dev-only diagnostics: enable via `?debugRnwTextNode=1` on web.
    // Keep this silent by default to avoid console noise.
    if (process.env.NODE_ENV === 'production') return false;
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
        try {
            const first = args[0];
            if (typeof first === 'string' && first.startsWith('Unexpected text node:')) {
                // De-dupe per unique message to keep logs readable.
                if (!seen.has(first)) {
                    seen.add(first);
                    let ownerHint: any = null;
                    try {
                        // Best-effort: during render, React may expose the current owner fiber.
                        const internals =
                            (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
                        const owner = internals?.ReactCurrentOwner?.current;
                        const ownerType = owner?.type;
                        const ownerName =
                            (typeof ownerType === 'function' && (ownerType.displayName || ownerType.name)) ||
                            (typeof ownerType === 'string' ? ownerType : null);
                        const source = owner?._debugSource || owner?._debugOwner?._debugSource || null;
                        ownerHint = ownerName ? { ownerName, source } : source ? { source } : null;
                    } catch {
                        ownerHint = null;
                    }
                    original(...args);
                    if (ownerHint) original('[debugRnwTextNode] owner:', ownerHint);
                    original('[debugRnwTextNode] stack:', new Error(first).stack);
                    if (crash) {
                        // Throwing inside render will (usually) include a component stack overlay,
                        // which helps locate the offending component.
                        throw new Error(first);
                    }
                    return;
                }
            }
        } catch {
            // ignore
        }
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
            const dotChild = flat.find((c) => typeof c === 'string' && c.trim() === '.') as string | undefined;
            if (dotChild !== undefined) {
                const typeName =
                    (typeof type === 'function' && (type.displayName || type.name))
                    || (typeof type?.render === 'function' && (type.render.displayName || type.render.name))
                    || (typeof type === 'string' ? type : 'unknown');

                const isViewLike = type === View
                    || type?.displayName === 'View'
                    || type?.name === 'View'
                    || type?.render?.displayName === 'View'
                    || type?.render?.name === 'View';

                const signature = `${typeName}|${props?.testID ?? ''}|${props?.accessibilityLabel ?? ''}|dot`;
                if (!seen.has(signature) && logged < 10) {
                    seen.add(signature);
                    logged += 1;

                    let ownerHint: any = null;
                    try {
                        const internals =
                            (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
                        const owner = internals?.ReactCurrentOwner?.current;
                        const ownerType = owner?.type;
                        const ownerName =
                            (typeof ownerType === 'function' && (ownerType.displayName || ownerType.name)) ||
                            (typeof ownerType === 'string' ? ownerType : null);
                        const source = owner?._debugSource || owner?._debugOwner?._debugSource || null;
                        ownerHint = ownerName ? { ownerName, source } : source ? { source } : null;
                    } catch {
                        ownerHint = null;
                    }

                    console.error('[debugRnwTextNode] element created with dot primitive child', {
                        typeName,
                        isViewLike,
                        testID: props?.testID ?? null,
                        accessibilityLabel: props?.accessibilityLabel ?? null,
                        ownerHint,
                    });
                    console.error('[debugRnwTextNode] createElement stack:', new Error('dot child').stack);
                }
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
                const dotChild = flat.find((c) => typeof c === 'string' && c.trim() === '.') as string | undefined;
                if (dotChild !== undefined) {
                    const typeName =
                        (typeof type === 'function' && (type.displayName || type.name))
                        || (typeof type?.render === 'function' && (type.render.displayName || type.render.name))
                        || (typeof type === 'string' ? type : 'unknown');

                    const isViewLike = type === View
                        || type?.displayName === 'View'
                        || type?.name === 'View'
                        || type?.render?.displayName === 'View'
                        || type?.render?.name === 'View';

                    const signature = `${typeName}|${props?.testID ?? ''}|${props?.accessibilityLabel ?? ''}|dot`;
                    if (!seen.has(signature)) {
                        seen.add(signature);

                        let ownerHint: any = null;
                        try {
                            const internals =
                                (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
                            const owner = internals?.ReactCurrentOwner?.current;
                            const ownerType = owner?.type;
                            const ownerName =
                                (typeof ownerType === 'function' && (ownerType.displayName || ownerType.name)) ||
                                (typeof ownerType === 'string' ? ownerType : null);
                            const source = owner?._debugSource || owner?._debugOwner?._debugSource || null;
                            ownerHint = ownerName ? { ownerName, source } : source ? { source } : null;
                        } catch {
                            ownerHint = null;
                        }

                        console.error('[debugRnwTextNode] jsx-runtime element created with dot primitive child', {
                            typeName,
                            isViewLike,
                            testID: props?.testID ?? null,
                            accessibilityLabel: props?.accessibilityLabel ?? null,
                            ownerHint,
                        });
                        console.error('[debugRnwTextNode] jsx-runtime stack:', new Error('dot child').stack);
                    }
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

// Configure notification handler for foreground notifications.
// Suppresses same-session notifications and respects the foregroundBehavior setting.
Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
        const data = notification.request.content.data as { sessionId?: string } | undefined;
        const notifSessionId = typeof data?.sessionId === 'string' ? data.sessionId : null;

        // Same-session suppression: user already sees real-time updates.
        if (notifSessionId && notifSessionId === getActiveViewingSessionId()) {
            return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true, shouldShowBanner: false, shouldShowList: false };
        }

        // Read the foregroundBehavior setting from the Zustand store (synchronous, safe outside React).
        let foregroundBehavior: 'full' | 'silent' | 'off' = 'full';
        try {
            const raw = storage.getState().settings.notificationsSettingsV1;
            const parsed = NotificationsSettingsV1Schema.safeParse(raw);
            if (parsed.success) {
                foregroundBehavior = parsed.data.foregroundBehavior;
            }
        } catch { /* default to 'full' (current behavior) */ }

        switch (foregroundBehavior) {
            case 'off':
                return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: true, shouldShowBanner: false, shouldShowList: false };
            case 'silent':
                return { shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true };
            case 'full':
            default:
                return { shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true };
        }
    },
});

// Setup Android notification channel (required for Android 8.0+)
if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
}

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

// Set window background color - now handled by Unistyles
// SystemUI.setBackgroundColorAsync('white');

// NEVER ENABLE REMOTE LOGGING IN PRODUCTION
// This is for local debugging with AI only
// So AI will have all the logs easily accessible in one file for analysis
if (!!process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) {
    monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds()
}
installBugReportConsoleCapture({ maxEntries: 300 });
configureBugReportUserActionTrail({ maxActions: 300 });

if (shouldCaptureRnwUnexpectedTextNodeStacks()) {
    installRnwUnexpectedTextNodeStackCaptureOnce();
    installReactCreateElementUnexpectedTextNodeCaptureOnce();
    installReactJsxRuntimeUnexpectedTextNodeCaptureOnce();
}

// Component to apply horizontal safe area padding
function HorizontalSafeAreaWrapper({ children }: { children: React.ReactNode }) {
    const insets = useSafeAreaInsets();
    return (
        <View style={{
            flex: 1,
            paddingLeft: insets.left,
            paddingRight: insets.right
        }}>
            {children}
        </View>
    );
}

let lock = new AsyncLock();
let loaded = false;
let suppressFontTimeoutErrorsUntilMs = 0;
let webFontLoadAttemptedAtMs = 0;

function escapeCssString(value: string): string {
    // Enough for our controlled font family names; avoid pulling in a heavier CSS escaping dependency.
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function injectWebFontFaces(fontMap: Parameters<typeof Fonts.loadAsync>[0]): void {
    if (typeof document === 'undefined') return;
    if (typeof document.getElementById !== 'function') return;
    if (typeof document.createElement !== 'function') return;
    const head = document.head;
    if (!head) return;

    const styleId = 'happier-web-font-faces';
    if (document.getElementById(styleId)) return;

    const rules: string[] = [];
    for (const [fontFamily, fontModule] of Object.entries(fontMap)) {
        try {
            if (!fontModule) continue;
            let uri: string | null = null;
            if (typeof fontModule === 'string' || typeof fontModule === 'number') {
                uri = Asset.fromModule(fontModule).uri;
            } else if (
                typeof fontModule === 'object'
                && fontModule !== null
                && 'uri' in fontModule
                && typeof (fontModule as { uri?: unknown }).uri === 'string'
            ) {
                uri = (fontModule as { uri: string }).uri;
            }
            if (!uri) continue;

            const lower = uri.toLowerCase();
            const format =
                lower.endsWith('.woff2') ? 'woff2'
                : lower.endsWith('.woff') ? 'woff'
                : lower.endsWith('.otf') ? 'opentype'
                : lower.endsWith('.ttf') ? 'truetype'
                : null;

            const src = format ? `url("${uri}") format("${format}")` : `url("${uri}")`;
            rules.push(
                `@font-face{font-family:"${escapeCssString(fontFamily)}";src:${src};font-display:swap;}`
            );
        } catch {
            // Best-effort only; don't let font injection break app startup.
        }
    }

    if (rules.length === 0) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = rules.join('\n');
    head.appendChild(style);
}

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
            // Keep existing font
            SpaceMono: require('@/assets/fonts/SpaceMono-Regular.ttf'),

            // Inter family (default typography)
            'Inter-Regular': require('@/assets/fonts/Inter-Regular.ttf'),
            'Inter-Italic': require('@/assets/fonts/Inter-Italic.ttf'),
            'Inter-SemiBold': require('@/assets/fonts/Inter-SemiBold.ttf'),

            // IBM Plex Mono family
            'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
            'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
            'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

            // Bricolage Grotesque
            'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

            ...FontAwesome.font,
        };

        // On web, expo-font uses FontFaceObserver with a hard-coded ~6s timeout. In practice, this
        // can time out (and surface as uncaught errors / unhandled rejections) even when font files
        // are reachable. Avoid expo-font entirely on web and inject `@font-face` rules instead.
        if (isWeb) {
            try {
                webFontLoadAttemptedAtMs = Date.now();
                injectWebFontFaces(fontMap);
            } catch {
                // Do not surface font init issues on web.
            }
            return;
        }

        // Native platforms: block startup until fonts are ready.
        await Fonts.loadAsync(fontMap);
    });
}

export default function RootLayout() {
    const { theme } = useUnistyles();
    useWebUiFontScale();
    const navigationTheme = React.useMemo(() => {
        if (theme.dark) {
            return {
                ...DarkTheme,
                colors: {
                    ...DarkTheme.colors,
                    background: theme.colors.groupped.background,
                }
            }
        }
        return {
            ...DefaultTheme,
            colors: {
                ...DefaultTheme.colors,
                background: theme.colors.groupped.background,
            }
        };
    }, [theme.dark]);

    //
    // Init sequence
    //
    const [initState, setInitState] = React.useState<{ credentials: AuthCredentials | null } | null>(null);
    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            let credentials: AuthCredentials | null = null;
            try {
                try {
                    await loadFonts();
                } catch (error) {
                    // Font loading failures should not brick startup.
                    console.error('Failed to load fonts during init, continuing startup:', error);
                }
                await sodium.ready;
                credentials = await TokenStorage.getCredentials();
                if (credentials) {
                    try {
                        await syncRestore(credentials);
                    } catch (error) {
                        // Preserve app usability even if sync restore fails during boot.
                        console.error('Failed to restore sync during init, continuing startup:', error);
                    }
                }
            } catch (error) {
                console.error('Error initializing:', error);
            } finally {
                if (!cancelled) {
                    setInitState({ credentials });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

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

    if (!initState) {
        return null;
    }

    //
    // Boot
    //

    let providers = (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <KeyboardProvider>
                <GestureHandlerRootView style={{ flex: 1 }}>
                    <AuthProvider initialCredentials={initState.credentials}>
                        <ThemeProvider value={navigationTheme}>
                            <StatusBarProvider />
                            <ModalProvider>
                                <CommandPaletteProvider>
                                    <RealtimeProvider>
                                        <HorizontalSafeAreaWrapper>
                                            <DesktopUpdateBanner />
                                            <View style={{ flex: 1 }}>
                                                <SidebarNavigator />
                                            </View>
                                        </HorizontalSafeAreaWrapper>
                                    </RealtimeProvider>
                                </CommandPaletteProvider>
                            </ModalProvider>
                        </ThemeProvider>
                    </AuthProvider>
                </GestureHandlerRootView>
            </KeyboardProvider>
        </SafeAreaProvider>
    );
    if (tracking) {
        providers = (
            <PostHogProvider client={tracking}>
                {providers}
            </PostHogProvider>
        );
    }

    return (
        <>
            <FaviconPermissionIndicator />
            {providers}
        </>
    );
}
