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

export function isWebMobileLikeViewport(params: Readonly<{ width: number; height: number }>): boolean {
    const width = Number(params.width);
    const height = Number(params.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    const minEdge = Math.min(Math.abs(width), Math.abs(height));
    return minEdge > 0 && minEdge <= WEB_QR_SCANNER_MAX_VIEWPORT_MIN_EDGE_PX;
}

export function isWebMobileLikeQrScannerHost(params: Readonly<{ width: number; height: number }>): boolean {
    if (!isWebMobileLikeViewport(params)) return false;
    const nav = readNavigator();
    return isMobileUserAgent(nav) || isTouchOrCoarsePointer(nav);
}
