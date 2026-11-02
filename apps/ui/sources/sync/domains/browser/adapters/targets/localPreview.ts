const LOCAL_SERVICE_PREVIEW_ROUTE_PREFIXES = [
    '/v1/local-services/preview/',
    '/v1/local-services/public/',
] as const;

const LOCAL_SERVICE_PREVIEW_BASE_IFRAME_SANDBOX = [
    'allow-downloads',
    'allow-forms',
    'allow-modals',
    'allow-popups',
    'allow-pointer-lock',
    'allow-scripts',
] as const;

const LOCAL_SERVICE_PREVIEW_HOST_ORIGIN_IFRAME_SANDBOX = [
    ...LOCAL_SERVICE_PREVIEW_BASE_IFRAME_SANDBOX,
    'allow-same-origin',
] as const;

function parseUrl(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        return null;
    }
}

export function isPathModePreviewUrl(rawUrl: string): boolean {
    const url = parseUrl(rawUrl);
    if (!url) {
        return true;
    }
    return LOCAL_SERVICE_PREVIEW_ROUTE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

export function resolveLocalPreviewIframeSandbox(url: string): string {
    const entries = isPathModePreviewUrl(url)
        ? LOCAL_SERVICE_PREVIEW_BASE_IFRAME_SANDBOX
        : LOCAL_SERVICE_PREVIEW_HOST_ORIGIN_IFRAME_SANDBOX;
    return entries.join(' ');
}

export function resolveUrlOrigin(rawUrl: string): string | null {
    return parseUrl(rawUrl)?.origin ?? null;
}

/**
 * Sandbox for an arbitrary cross-origin external URL embedded in a web iframe. Deliberately omits
 * `allow-same-origin`: an external site is never same-origin with the host document, so granting it
 * (alongside `allow-scripts`) would let the framed page break out of the sandbox. Scripts/forms/
 * popups/modals/downloads are allowed so a framable site behaves normally inline; non-framable sites
 * are handled by the engine's framability fallback (open in system browser).
 */
const EXTERNAL_URL_IFRAME_SANDBOX = [
    'allow-downloads',
    'allow-forms',
    'allow-modals',
    'allow-popups',
    'allow-pointer-lock',
    'allow-scripts',
] as const;

export function resolveExternalUrlIframeSandbox(): string {
    return EXTERNAL_URL_IFRAME_SANDBOX.join(' ');
}

/**
 * Why a relay preview's own proxy will not serve its document: the route to the Machine is down, or
 * the preview no longer exists for this viewer (revoked, expired or never admitted).
 */
export type BrowserPreviewRefusalReasonCode = 'preview_transport_unavailable' | 'preview_ended';

export function isBrowserPreviewRefusalReasonCode(value: string): value is BrowserPreviewRefusalReasonCode {
    return value === 'preview_transport_unavailable' || value === 'preview_ended';
}

/** Typed refusals from preview admission and the preview proxy, not application error bodies. */
export function resolveBrowserPreviewRefusal(status: number, result: unknown): BrowserPreviewRefusalReasonCode | null {
    const error = result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    if (status === 503 && error === 'preview_transport_unavailable') return 'preview_transport_unavailable';
    if ((status === 404 && error === 'preview_not_found') || ((status === 401 || status === 403) && error === 'preview_access_denied')) return 'preview_ended';
    return null;
}
