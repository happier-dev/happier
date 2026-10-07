import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';

export function isSafeBadgeUrl(raw: string): boolean {
    const value = String(raw ?? '').trim();
    if (!value) return false;

    try {
        const url = new URL(value);
        if (url.protocol === 'https:') return true;
        if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return true;
        return false;
    } catch {
        return false;
    }
}
