import { isAcceptedHappierUrlProtocol } from '@/utils/url/appScheme';

export type ParsedHappierCustomSchemeUrl = Readonly<{
    protocol: string;
    hostname: string;
    pathname: string;
    search: string;
    searchParams: URLSearchParams;
    hash?: string;
}>;

function normalizeProtocol(value: string): string {
    return value.endsWith(':') ? value : `${value}:`;
}

function parseAuthorityAndPathname(raw: string): Readonly<{ hostname: string; pathname: string }> {
    if (!raw.startsWith('//')) {
        return {
            hostname: '',
            pathname: raw,
        };
    }

    const remainder = raw.slice(2);
    if (remainder.startsWith('/')) {
        return {
            hostname: '',
            pathname: remainder,
        };
    }

    const firstSlashIndex = remainder.indexOf('/');
    if (firstSlashIndex < 0) {
        return {
            hostname: remainder,
            pathname: '',
        };
    }

    return {
        hostname: remainder.slice(0, firstSlashIndex),
        pathname: remainder.slice(firstSlashIndex),
    };
}

export function parseHappierCustomSchemeUrl(raw: string): ParsedHappierCustomSchemeUrl | null {
    const value = String(raw ?? '').trim();
    const schemeMatch = /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(value);
    if (!schemeMatch?.groups) return null;

    const protocol = normalizeProtocol(schemeMatch.groups.scheme);
    if (!isAcceptedHappierUrlProtocol(protocol)) return null;

    const remainder = value.slice(protocol.length);
    const hashIndex = remainder.indexOf('#');
    const withoutHash = hashIndex >= 0 ? remainder.slice(0, hashIndex) : remainder;

    const queryIndex = withoutHash.indexOf('?');
    const locationPart = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
    const search = queryIndex >= 0 ? withoutHash.slice(queryIndex) : '';

    const { hostname, pathname } = parseAuthorityAndPathname(locationPart);

    return {
        protocol,
        hostname,
        pathname,
        search,
        ...(hashIndex >= 0 ? { hash: remainder.slice(hashIndex) } : {}),
        searchParams: new URLSearchParams(search.replace(/^\?/, '')),
    };
}
