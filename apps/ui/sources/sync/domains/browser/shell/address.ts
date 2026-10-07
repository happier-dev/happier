import {
    BrowserExternalUrlTargetV1Schema,
    type BrowserViewTargetV1,
} from '@happier-dev/protocol/browser/target/v1';

export type BrowserAddressNormalizationOptions = Readonly<{
    /** A `{query}` template; omitted means the default engine below. */
    searchUrlTemplate?: string;
}>;

/**
 * The search engine a typed query goes to when nothing chooses another. Without a default every
 * non-address entry ended in "No search engine is configured" (H-UX F-16), because no producer of a
 * template existed. A privacy-respecting engine with a stable, documented `?q=` URL. A user setting
 * can pass its own template through `searchUrlTemplate` when one exists; this stays the default.
 */
export const DEFAULT_BROWSER_SEARCH_URL_TEMPLATE = 'https://duckduckgo.com/?q={query}';

export type BrowserAddressNormalizationResult =
    | Readonly<{ ok: true; url: string }>
    | Readonly<{ ok: false; reasonCode: 'empty' | 'invalid_url' }>;

function parseHttpUrl(input: string): string | null {
    try {
        const parsed = new URL(input);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function looksLikeLocalhost(input: string): boolean {
    return /^localhost(?::\d+)?(?:\/.*)?$/i.test(input)
        || /^127(?:\.[0-9]{1,3}){3}(?::\d+)?(?:\/.*)?$/i.test(input);
}

function looksLikeDomain(input: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?::\d+)?(?:\/.*)?$/.test(input);
}

function fillSearchTemplate(template: string, query: string): string {
    return template.replace('{query}', encodeURIComponent(query));
}

/**
 * Normalizes a user-typed address into a canonical `externalUrl` browser target. Bare hosts
 * (`example.test`, `localhost:5173`) gain an inferred `https://` scheme so a one-word entry still
 * resolves. Returns `null` when the value cannot be parsed into an http/https URL — the caller then
 * shows an inline invalid affordance and does NOT delegate an open.
 *
 * This is the ONE address→target normalizer: both the in-content launchpad URL entry and the
 * toolbar address field (the no-active-view "new tab" entry point, B-1) build their `externalUrl`
 * target through it, so the two URL-entry surfaces never drift.
 */
export function resolveExternalUrlTargetFromInput(value: string): BrowserViewTargetV1 | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let normalizedUrl: string;
    let host: string;
    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
            return null;
        }
        normalizedUrl = parsed.toString();
        host = parsed.host;
    } catch {
        return null;
    }
    const parsedTarget = BrowserExternalUrlTargetV1Schema.safeParse({
        kind: 'externalUrl',
        targetId: `externalUrl:${normalizedUrl}`,
        url: normalizedUrl,
        display: {
            title: host,
            addressLabel: host,
        },
    });
    return parsedTarget.success ? parsedTarget.data : null;
}

export function normalizeBrowserAddressInput(
    value: string,
    options: BrowserAddressNormalizationOptions = {},
): BrowserAddressNormalizationResult {
    const input = value.trim();
    if (!input) {
        return { ok: false, reasonCode: 'empty' };
    }

    const directUrl = parseHttpUrl(input);
    if (directUrl) {
        return { ok: true, url: directUrl };
    }

    if (looksLikeLocalhost(input)) {
        const localUrl = parseHttpUrl(`http://${input}`);
        return localUrl ? { ok: true, url: localUrl } : { ok: false, reasonCode: 'invalid_url' };
    }

    if (looksLikeDomain(input)) {
        const domainUrl = parseHttpUrl(`https://${input}`);
        return domainUrl ? { ok: true, url: domainUrl } : { ok: false, reasonCode: 'invalid_url' };
    }

    // Something with a scheme was meant as an address; a malformed one is an error, not a query.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
        return { ok: false, reasonCode: 'invalid_url' };
    }

    const searchUrl = parseHttpUrl(fillSearchTemplate(options.searchUrlTemplate ?? DEFAULT_BROWSER_SEARCH_URL_TEMPLATE, input));
    return searchUrl ? { ok: true, url: searchUrl } : { ok: false, reasonCode: 'invalid_url' };
}

/**
 * Formats a raw URL into a clean, human-readable address for the blurred address
 * field: the http(s) scheme, a leading `www.`, and a bare root trailing slash are
 * trimmed while the path/query/fragment are preserved. Non-http(s) or unparseable
 * input falls back to the trimmed raw value so the field is never blank when a URL
 * exists; `null`/empty input yields an empty string. `hostOnly` keeps just the host (the phone's
 * address capsule, which names where the page is and leaves the path for a tap).
 */
export function formatBrowserDisplayUrl(raw: string | null, options?: Readonly<{ hostOnly?: boolean }>): string {
    const input = (raw ?? '').trim();
    if (!input) {
        return '';
    }

    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch {
        return input;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return input;
    }

    const host = parsed.host.replace(/^www\./i, '');
    if (options?.hostOnly === true) return host;
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${host}${path}${parsed.search}${parsed.hash}`;
}
