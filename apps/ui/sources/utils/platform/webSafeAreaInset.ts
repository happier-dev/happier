// Web bottom safe-area trust boundary.
//
// The web `env(safe-area-inset-bottom)` probe (via react-native-safe-area-context's web
// provider) is only meaningful on iOS browsers: the Safari/Chrome-iOS layout viewport with
// `viewport-fit=cover` really extends under the home indicator, so content must clear it.
// Everywhere else the viewport already stops at the system UI (Android on-screen nav bar) or
// there is no system UI at all (desktop) — and Firefox Android still reports the nav-bar
// height as the bottom inset (reproduced on-device: a ~72 CSS px phantom band under the
// floating chrome), so trusting it double-clears a region the window never overlaps.

type NavigatorLike = Readonly<{
    maxTouchPoints?: number;
    userAgent?: string;
}>;

function readNavigator(): NavigatorLike | null {
    if (typeof navigator === 'undefined') return null;
    return { userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints };
}

/** True only when the web host is an iOS browser (the home-indicator safe area is real). */
export function isWebIosBrowser(nav: NavigatorLike | null = readNavigator()): boolean {
    if (!nav) return false;
    const ua = typeof nav.userAgent === 'string' ? nav.userAgent : '';
    if (/ipad|iphone|ipod/i.test(ua)) return true;
    // iPadOS desktop-mode UA pretends to be macOS; touch points separate it from a real Mac.
    if (/macintosh/i.test(ua)) {
        return typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 1;
    }
    return false;
}

/**
 * The bottom safe-area inset a web consumer may actually clear. `0` on every web platform
 * except iOS browsers, where the viewport genuinely extends under the home indicator.
 */
export function resolveTrustedWebSafeAreaBottomInset(
    bottomInset: number,
    options?: Readonly<{ isWebIos?: boolean }>,
): number {
    const isWebIos = options?.isWebIos ?? isWebIosBrowser();
    if (!isWebIos) return 0;
    return Number.isFinite(bottomInset) ? Math.max(0, bottomInset) : 0;
}
