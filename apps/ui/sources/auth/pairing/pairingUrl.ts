import { resolveAppUrlProtocol, resolveAppUrlScheme } from '@/utils/url/appScheme';

type PairingDeepLinkPayload = {
    pairId: string;
    secret: string;
    serverUrl: string | null;
};

function isValidPairingLinkTarget(url: URL): boolean {
    if (url.protocol !== resolveAppUrlProtocol()) return false;

    const pathname = url.pathname ?? '';
    const hostname = url.hostname ?? '';

    if (pathname === '/pair') return true;
    if (hostname === 'pair' && (pathname === '' || pathname === '/')) return true;

    return false;
}

function normalizeServerUrl(raw: string): string | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;

    const pathname = url.pathname === '/' ? '' : url.pathname;
    const search = url.search ?? '';
    return `${url.origin}${pathname}${search}`;
}

export function parsePairingDeepLink(rawLink: string): PairingDeepLinkPayload | null {
    let url: URL;
    try {
        url = new URL(rawLink);
    } catch {
        return null;
    }

    if (!isValidPairingLinkTarget(url)) return null;

    const version = url.searchParams.get('v');
    if (version != null && version !== '1') return null;

    const pairId = url.searchParams.get('pairId');
    const secret = url.searchParams.get('secret');
    if (!pairId || !secret) return null;

    const server = url.searchParams.get('server');
    const serverUrl = server ? normalizeServerUrl(server) : null;

    return { pairId, secret, serverUrl };
}

export function buildPairingDeepLink(input: { pairId: string; secret: string; serverUrl?: string | null }): string {
    const pairId = encodeURIComponent(input.pairId);
    const secret = encodeURIComponent(input.secret);

    const serverSegment =
        input.serverUrl != null && input.serverUrl.length > 0
            ? `&server=${encodeURIComponent(input.serverUrl)}`
            : '';

    return `${resolveAppUrlScheme()}:///pair?v=1&pairId=${pairId}&secret=${secret}${serverSegment}`;
}
