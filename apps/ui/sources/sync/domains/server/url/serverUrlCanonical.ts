import { createServerUrlComparableKey as createProtocolServerUrlComparableKey } from '@happier-dev/protocol';

import { isLocalishHostname } from './serverUrlClassification';

export function canonicalizeServerUrl(raw: string): string {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
    try {
        const parsed = new URL(hasScheme ? value : `https://${value}`);
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

export function createServerUrlComparableKey(raw: string): string {
    const canonical = canonicalizeServerUrl(raw);
    if (!canonical) return '';
    try {
        return createProtocolServerUrlComparableKey(canonical);
    } catch {
        return '';
    }
}
