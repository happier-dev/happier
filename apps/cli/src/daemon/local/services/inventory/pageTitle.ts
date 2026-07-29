import type {
    NormalizedLocalServiceInventoryEntry,
    NormalizedLocalServiceInventorySnapshot,
} from './scanner';
import { buildLocalServiceEndpointUrl } from './endpoint';

export type LocalPageTitleSource = 'application_name' | 'og_title' | 'twitter_title' | 'html_title';

export type LocalPageTitleResult = Readonly<{
    title: string;
    source: LocalPageTitleSource;
}>;

export type LocalPageTitleEnricher = Readonly<{
    fetchTitle(url: string): Promise<LocalPageTitleResult | null>;
}>;

export type LocalPageTitleEnricherParams = Readonly<{
    timeoutMs: number;
    maxBodyBytes: number;
    concurrency: number;
    successTtlMs: number;
    failureTtlMs: number;
    /**
     * Hard upper bound on cached title entries. A long-lived daemon scanning many
     * ephemeral loopback ports would otherwise grow the TTL-only cache without limit;
     * once exceeded, the oldest entry is evicted (insertion-order FIFO).
     */
    maxCacheEntries?: number;
    fetch: typeof fetch;
}>;

const DEFAULT_LOCAL_PAGE_TITLE_MAX_CACHE_ENTRIES = 512;

function decodeHtmlEntity(input: string): string {
    return input
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function normalizeTitle(input: string | undefined): string | null {
    const normalized = decodeHtmlEntity(String(input ?? '')).replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    return normalized.slice(0, 200);
}

function readMetaContent(html: string, attrName: string, attrValue: string): string | null {
    const tagPattern = /<meta\b[^>]*>/gi;
    let match: RegExpExecArray | null = null;
    while ((match = tagPattern.exec(html))) {
        const tag = match[0] ?? '';
        const hasName = new RegExp(`\\b${attrName}\\s*=\\s*["']${attrValue}["']`, 'i').test(tag);
        if (!hasName) continue;
        const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        const normalized = normalizeTitle(content);
        if (normalized) return normalized;
    }
    return null;
}

export function extractLocalPageTitle(html: string): LocalPageTitleResult | null {
    const applicationName = readMetaContent(html, 'name', 'application-name');
    if (applicationName) return { title: applicationName, source: 'application_name' };
    const ogTitle = readMetaContent(html, 'property', 'og:title');
    if (ogTitle) return { title: ogTitle, source: 'og_title' };
    const twitterTitle = readMetaContent(html, 'name', 'twitter:title');
    if (twitterTitle) return { title: twitterTitle, source: 'twitter_title' };
    const htmlTitle = normalizeTitle(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
    if (htmlTitle) return { title: htmlTitle, source: 'html_title' };
    return null;
}

function parseIpv4(host: string): readonly number[] | null {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    const out = parts.map((part) => Number(part));
    return out.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? out : null;
}

export function isLocalPageTitleHost(host: string): boolean {
    const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
    // Only the literal `localhost` is trusted by name. A `*.localhost` label can be
    // pointed at a non-loopback address by a hostile resolver (DNS rebinding), so it is
    // NOT trusted on the string alone — it must resolve to a loopback/private IP form
    // (matched by the IP branches below) to pass.
    if (normalized === 'localhost') return true;
    if (normalized === '::' || normalized === '::1') return true;
    if ((normalized.startsWith('fc') || normalized.startsWith('fd')) && normalized.includes(':')) return true;
    if (normalized.startsWith('fe80:')) return true;
    const ipv4 = parseIpv4(normalized);
    if (!ipv4) return false;
    const [a, b] = ipv4;
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && typeof b === 'number' && b >= 16 && b <= 31)
        || (a === 192 && b === 168);
}

function isFetchableTitleUrl(url: URL): boolean {
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLocalPageTitleHost(url.hostname);
}

function parseTitleUrl(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        return null;
    }
}

async function readResponsePrefix(response: Response, maxBodyBytes: number): Promise<string> {
    const body = response.body;
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let readBytes = 0;
    try {
        while (readBytes < maxBodyBytes) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value;
            const remaining = maxBodyBytes - readBytes;
            chunks.push(chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk);
            readBytes += Math.min(chunk.byteLength, remaining);
            if (chunk.byteLength > remaining) break;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    const merged = new Uint8Array(readBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
}

function isHtmlResponse(response: Response): boolean {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    return !contentType || contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}

export function createLocalPageTitleEnricher(params: LocalPageTitleEnricherParams): LocalPageTitleEnricher {
    const cache = new Map<string, Readonly<{ expiresAt: number; value: LocalPageTitleResult | null }>>();
    const maxCacheEntries = Math.max(1, Math.trunc(params.maxCacheEntries ?? DEFAULT_LOCAL_PAGE_TITLE_MAX_CACHE_ENTRIES));
    const setCacheEntry = (key: string, entry: Readonly<{ expiresAt: number; value: LocalPageTitleResult | null }>) => {
        // Re-insert so an updated key moves to the most-recent position, then evict the
        // oldest insertion-order entries until within the bound.
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > maxCacheEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
    };
    const active = { count: 0 };
    const waiters: Array<() => void> = [];

    const acquire = async () => {
        const limit = Math.max(1, Math.trunc(params.concurrency));
        if (active.count < limit) {
            active.count += 1;
            return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        active.count += 1;
    };
    const release = () => {
        active.count = Math.max(0, active.count - 1);
        waiters.shift()?.();
    };

    const fetchOnce = async (rawUrl: string, redirectsLeft: number): Promise<LocalPageTitleResult | null> => {
        const url = parseTitleUrl(rawUrl);
        if (!url) return null;
        if (!isFetchableTitleUrl(url)) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs));
        try {
            const response = await params.fetch(url.toString(), {
                method: 'GET',
                redirect: 'manual',
                headers: { accept: 'text/html,application/xhtml+xml' },
                signal: controller.signal,
            });
            if (response.status >= 300 && response.status < 400) {
                if (redirectsLeft <= 0) return null;
                const location = response.headers.get('location');
                if (!location) return null;
                const nextUrl = new URL(location, url);
                if (!isFetchableTitleUrl(nextUrl)) return null;
                return await fetchOnce(nextUrl.toString(), redirectsLeft - 1);
            }
            if (!response.ok || !isHtmlResponse(response)) return null;
            return extractLocalPageTitle(await readResponsePrefix(response, Math.max(1, params.maxBodyBytes)));
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    };

    return {
        async fetchTitle(url: string): Promise<LocalPageTitleResult | null> {
            const cached = cache.get(url);
            const now = Date.now();
            if (cached && cached.expiresAt > now) return cached.value;
            await acquire();
            try {
                const value = await fetchOnce(url, 3);
                setCacheEntry(url, {
                    value,
                    expiresAt: now + (value ? params.successTtlMs : params.failureTtlMs),
                });
                return value;
            } finally {
                release();
            }
        },
    };
}

function localTitleHostForEntry(entry: NormalizedLocalServiceInventoryEntry): string | null {
    const host = entry.address.host;
    if (entry.address.kind === 'wildcard') {
        return '127.0.0.1';
    }
    if (entry.address.family === 'ipv6') {
        return `[${host.replace(/^\[|\]$/gu, '')}]`;
    }
    return host;
}

export function buildLocalPageTitleUrl(entry: NormalizedLocalServiceInventoryEntry): string | null {
    if (entry.state !== 'listening') return null;
    const endpointUrl = entry.endpoint ? buildLocalServiceEndpointUrl(entry.endpoint) : null;
    if (endpointUrl) return endpointUrl;
    const host = localTitleHostForEntry(entry);
    if (!host || entry.endpoint?.scheme === 'unknown') return null;
    return null;
}

export async function enrichLocalServiceInventoryPageTitles(input: Readonly<{
    snapshot: NormalizedLocalServiceInventorySnapshot;
    enricher: LocalPageTitleEnricher;
}>): Promise<NormalizedLocalServiceInventorySnapshot> {
    const entries = await Promise.all(input.snapshot.entries.map(async (entry) => {
        const url = buildLocalPageTitleUrl(entry);
        if (!url) return entry;
        const title = await input.enricher.fetchTitle(url);
        if (!title) return entry;
        return {
            ...entry,
            presentation: {
                ...entry.presentation,
                pageTitle: title.title,
                pageTitleSource: title.source,
                addressLabel: entry.presentation?.addressLabel ?? `${entry.address.host}:${entry.port}`,
            },
        };
    }));

    return {
        ...input.snapshot,
        entries,
    };
}
