const LOCAL_SERVICE_PREVIEW_ROUTE_PREFIXES = [
    '/v1/local-services/preview/',
    '/v1/local-services/public/',
] as const;

const LOCAL_SERVICE_PREVIEW_BASE_IFRAME_SANDBOX = [
    'allow-downloads',
    'allow-forms',
    'allow-modals',
    'allow-popups',
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
    'allow-scripts',
] as const;

export function resolveExternalUrlIframeSandbox(): string {
    return EXTERNAL_URL_IFRAME_SANDBOX.join(' ');
}
