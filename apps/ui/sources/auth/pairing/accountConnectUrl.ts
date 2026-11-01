import { resolveAppUrlScheme } from '@/utils/url/appScheme';
import { parseHappierCustomSchemeUrl } from '@/utils/url/parseHappierCustomSchemeUrl';

export type ParsedAccountConnectDeepLink = Readonly<{
    publicKeyB64Url: string;
    supportsCredentialVariants?: boolean;
}>;

export const ACCOUNT_CONNECT_ROUTE_PARAM = 'accountConnectKey';

function isValidAccountLinkTarget(hostname: string, pathname: string): boolean {
    const normalizedPathname = pathname === 'account' ? '/account' : pathname;

    if (normalizedPathname === '/account') return true;
    if (hostname === 'account' && (normalizedPathname === '' || normalizedPathname === '/')) return true;

    return false;
}

export function parseAccountConnectDeepLink(rawLink: string): ParsedAccountConnectDeepLink | null {
    const parsed = parseHappierCustomSchemeUrl(rawLink);
    if (!parsed) return null;
    if (!isValidAccountLinkTarget(parsed.hostname, parsed.pathname)) return null;

    const tail = String(parsed.search ?? '').replace(/^\?/, '').trim();
    if (!tail) return null;

    const fragment = new URLSearchParams((parsed.hash ?? '').replace(/^#/, ''));
    return {
        publicKeyB64Url: tail,
        ...(fragment.get('supportsCredentialVariants') === '1' ? { supportsCredentialVariants: true } : {}),
    };
}

export function buildAccountConnectDeepLink(input: ParsedAccountConnectDeepLink): string {
    const publicKeyB64Url = String(input.publicKeyB64Url ?? '').trim();
    return `${resolveAppUrlScheme()}:///account?${publicKeyB64Url}${input.supportsCredentialVariants === true ? '#supportsCredentialVariants=1' : ''}`;
}

export function buildAccountConnectRoutePath(input: ParsedAccountConnectDeepLink): string {
    const publicKeyB64Url = String(input.publicKeyB64Url ?? '').trim();
    return `/account?${ACCOUNT_CONNECT_ROUTE_PARAM}=${encodeURIComponent(publicKeyB64Url)}${input.supportsCredentialVariants === true ? '&supportsCredentialVariants=1' : ''}`;
}
