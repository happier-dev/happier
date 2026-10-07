import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';

const ALLOWED_PROTOCOLS = new Set(['https:', 'happier:']);

export function isSafeExternalAuthUrl(raw: string): boolean {
    const value = String(raw ?? '').trim();
    if (!value) return false;
    try {
        const url = new URL(value);
        if (ALLOWED_PROTOCOLS.has(url.protocol)) return true;
        if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return true;
        return false;
    } catch {
        return false;
    }
}
