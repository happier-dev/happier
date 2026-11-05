import { Platform } from 'react-native';
import { isHappierCoarsePrimaryPointer, useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

type NavigatorLike = {
    maxTouchPoints?: number;
    userAgent?: string;
    userAgentData?: { mobile?: boolean; platform?: string };
};

const WEB_QR_SCANNER_MAX_VIEWPORT_MIN_EDGE_PX = 500;

function readNavigator(): NavigatorLike | null {
    if (typeof navigator === 'undefined') return null;
    return navigator as any;
}

function matchMedia(query: string): boolean {
    if (typeof window === 'undefined') return false;
    const fn = (window as any)?.matchMedia;
    if (typeof fn !== 'function') return false;
    try {
        return Boolean(fn.call(window, query)?.matches);
    } catch {
        return false;
    }
}

function isMobileUserAgent(nav: NavigatorLike | null): boolean {
    if (!nav) return false;
    if (nav.userAgentData?.mobile === true) return true;
    // A desktop user agent cannot override an explicit mobile-platform client hint.
    if (nav.userAgentData?.platform === 'Android' || nav.userAgentData?.platform === 'iOS') return true;
    const ua = typeof nav.userAgent === 'string' ? nav.userAgent : '';
    return /mobi|android|iphone|ipod|ipad/i.test(ua);
}

function isTouchOrCoarsePointer(nav: NavigatorLike | null): boolean {
    const coarse =
        matchMedia('(pointer: coarse)') ||
        matchMedia('(any-pointer: coarse)') ||
        matchMedia('(hover: none)') ||
        matchMedia('(any-hover: none)');
    if (coarse) return true;

    const fine = matchMedia('(pointer: fine)') || matchMedia('(any-pointer: fine)');
    if (fine) return false;

    return typeof nav?.maxTouchPoints === 'number' && nav.maxTouchPoints > 0;
}

/** Browser hardware classification, independent of responsive viewport width. */
export function isWebMobileHost(): boolean {
    const nav = readNavigator();
    if (isMobileUserAgent(nav)) return true;
    const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
    // iPadOS can advertise a Mac user agent, including when a trackpad can hover.
    if (/Macintosh/i.test(ua) && typeof nav?.maxTouchPoints === 'number' && nav.maxTouchPoints > 1) return true;
    // Pointer capability alone cannot turn a touchscreen computer into a phone/tablet.
    if (/Windows NT|X11|Macintosh|CrOS|Linux (?:x86_64|i[3-6]86|aarch64)/i.test(ua)) return false;
    return isCoarsePrimaryPointerEnvironment();
}

/**
 * True when the host's PRIMARY pointer cannot hover (phone/tablet touch).
 *
 * Deliberately narrower than `isTouchOrCoarsePointer` above: `any-pointer` /
 * `any-hover` also match a hover-capable laptop that merely has a touchscreen,
 * which must keep its hover-reveal affordances. Only `pointer:` / `hover:`
 * describe the primary pointer, so only those decide here.
 */
export function isCoarsePrimaryPointerEnvironment(): boolean {
    return isHappierCoarsePrimaryPointer();
}

/**
 * True when the host's primary pointer can announce intent BEFORE it activates
 * something.
 *
 * A mouse or trackpad has to travel over a control to click it, and a keyboard has
 * to focus it, so both give a surface a usable head start — hundreds of
 * milliseconds — on work that would otherwise start at the click. A finger gives
 * none: press-in is roughly one frame before activation.
 *
 * Subscribes to the shared primary-pointer owner rather than reading media per consumer.
 */
export function useHoverCapablePrimaryPointer(): boolean {
    const touch = useHappierTouchPrimaryPointer(Platform.OS);
    return Platform.OS === 'web' && !touch;
}

export function isWebMobileLikeViewport(params: Readonly<{ width: number; height: number }>): boolean {
    const width = Number(params.width);
    const height = Number(params.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    const minEdge = Math.min(Math.abs(width), Math.abs(height));
    return minEdge > 0 && minEdge <= WEB_QR_SCANNER_MAX_VIEWPORT_MIN_EDGE_PX;
}

export function isWebMobileLikeHost(params: Readonly<{ width: number; height: number }>): boolean {
    if (!isWebMobileLikeViewport(params)) return false;
    const nav = readNavigator();
    return isMobileUserAgent(nav) || isTouchOrCoarsePointer(nav);
}

export function isWebMobileLikeQrScannerHost(params: Readonly<{ width: number; height: number }>): boolean {
    return isWebMobileLikeHost(params);
}
