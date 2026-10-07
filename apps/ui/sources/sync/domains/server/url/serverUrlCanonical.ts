import { createServerUrlComparableKey as createProtocolServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';

import { isLocalishHostname } from './serverUrlClassification';

const SERVER_URL_CANONICAL_CACHE_LIMIT = 256;

const canonicalServerUrlCache = new Map<string, string>();
const comparableServerUrlCache = new Map<string, string>();

function readBoundedCache(cache: Map<string, string>, key: string): string | undefined {
    const value = cache.get(key);
    if (value === undefined) return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function writeBoundedCache(cache: Map<string, string>, key: string, value: string): string {
    cache.set(key, value);
    while (cache.size > SERVER_URL_CANONICAL_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
    }
    return value;
}

function canonicalizeServerUrlUncached(raw: string): string {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
    try {
        const parsed = new URL(hasScheme ? value : `https://${value}`);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        parsed.username = '';
        parsed.password = '';
        if (!hasScheme) {
            parsed.protocol = isLocalishHostname(parsed.hostname) ? 'http:' : 'https:';
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
}

export function canonicalizeServerUrl(raw: string): string {
    const key = String(raw ?? '');
    const cached = readBoundedCache(canonicalServerUrlCache, key);
    if (cached !== undefined) return cached;
    return writeBoundedCache(canonicalServerUrlCache, key, canonicalizeServerUrlUncached(key));
}

/**
 * Resolves a descriptor-provided independent HTTPS ingress. Unlike ordinary
 * server URL entry, this boundary requires an explicit HTTPS URL and rejects
 * embedded credentials rather than silently carrying or stripping them.
 */
export function resolveIndependentHttpsServerOrigin(raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    } catch {
        return null;
    }
    return canonicalizeServerUrl(value) || null;
}

export function createServerUrlComparableKey(raw: string): string {
    const key = String(raw ?? '');
    const cached = readBoundedCache(comparableServerUrlCache, key);
    if (cached !== undefined) return cached;
    const canonical = canonicalizeServerUrl(key);
    if (!canonical) return '';
    try {
        return writeBoundedCache(comparableServerUrlCache, key, createProtocolServerUrlComparableKey(canonical));
    } catch {
        return writeBoundedCache(comparableServerUrlCache, key, '');
    }
}
