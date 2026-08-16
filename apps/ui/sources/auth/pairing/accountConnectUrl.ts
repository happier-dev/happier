import { isAcceptedHappierUrlProtocol, resolveAppUrlScheme } from '@/utils/url/appScheme';

export type ParsedAccountConnectDeepLink = Readonly<{
    publicKeyB64Url: string;
}>;

export const ACCOUNT_CONNECT_ROUTE_PARAM = 'accountConnectKey';

function isValidAccountLinkTarget(url: URL): boolean {
    if (!isAcceptedHappierUrlProtocol(url.protocol)) return false;

    const pathname = url.pathname ?? '';
    const hostname = url.hostname ?? '';

    if (pathname === '/account') return true;
    if (hostname === 'account' && (pathname === '' || pathname === '/')) return true;

    return false;
}

export function parseAccountConnectDeepLink(rawLink: string): ParsedAccountConnectDeepLink | null {
    let url: URL;
    try {
        url = new URL(rawLink);
    } catch {
        return null;
    }

    if (!isValidAccountLinkTarget(url)) return null;

    const tail = String(url.search ?? '').replace(/^\?/, '').trim();
    if (!tail) return null;

    return { publicKeyB64Url: tail };
}

export function buildAccountConnectDeepLink(input: Readonly<{ publicKeyB64Url: string }>): string {
    const publicKeyB64Url = String(input.publicKeyB64Url ?? '').trim();
    return `${resolveAppUrlScheme()}:///account?${publicKeyB64Url}`;
}

export function buildAccountConnectRoutePath(input: Readonly<{ publicKeyB64Url: string }>): string {
    const publicKeyB64Url = String(input.publicKeyB64Url ?? '').trim();
    return `/account?${ACCOUNT_CONNECT_ROUTE_PARAM}=${encodeURIComponent(publicKeyB64Url)}`;
}
