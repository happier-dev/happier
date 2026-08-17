import { Platform } from 'react-native';

type NavigatorLike = {
    maxTouchPoints?: number;
    userAgent?: string;
    userAgentData?: { mobile?: boolean };
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

/**
 * True when the host's PRIMARY pointer cannot hover (phone/tablet touch).
 *
 * Deliberately narrower than `isTouchOrCoarsePointer` above: `any-pointer` /
 * `any-hover` also match a hover-capable laptop that merely has a touchscreen,
 * which must keep its hover-reveal affordances. Only `pointer:` / `hover:`
 * describe the primary pointer, so only those decide here.
 */
export function isCoarsePrimaryPointerEnvironment(): boolean {
    if (matchMedia('(pointer: fine)') || matchMedia('(hover: hover)')) return false;
    if (matchMedia('(pointer: coarse)') || matchMedia('(hover: none)')) return true;
    const nav = readNavigator();
    return typeof nav?.maxTouchPoints === 'number' && nav.maxTouchPoints > 0;
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
 * Deliberately built on {@link isCoarsePrimaryPointerEnvironment}, which already
 * owns "can the PRIMARY pointer hover", rather than adding a second reading of the
 * same media queries.
 */
export function isHoverCapablePrimaryPointer(): boolean {
    return Platform.OS === 'web' && !isCoarsePrimaryPointerEnvironment();
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
