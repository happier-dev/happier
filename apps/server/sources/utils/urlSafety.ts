import { isIP } from 'node:net';

function parseLegacyIpv4SegmentOrNull(segment: string): number | null {
    if (!segment) return null;
    if (/^0x[0-9a-f]+$/i.test(segment)) {
        return Number.parseInt(segment.slice(2), 16);
    }
    if (segment.length > 1 && segment.startsWith('0')) {
        if (!/^[0-7]+$/.test(segment)) return null;
        return Number.parseInt(segment, 8);
    }
    if (!/^\d+$/.test(segment)) return null;
    return Number.parseInt(segment, 10);
}

function isLegacyIpv4LoopbackOrNull(hostname: string): boolean | null {
    if (hostname.includes(':')) return null;

    if (/^\d+$/.test(hostname)) {
        const asInt = Number.parseInt(hostname, 10);
        if (!Number.isFinite(asInt) || asInt < 0 || asInt > 0xffffffff) return false;
        return ((asInt >>> 24) & 0xff) === 127;
    }

    if (!hostname.includes('.')) return null;
    const parts = hostname.split('.');
    if (parts.length !== 4) return null;

    const octets: number[] = [];
    for (const part of parts) {
        const value = parseLegacyIpv4SegmentOrNull(part);
        if (value === null || !Number.isFinite(value) || value < 0 || value > 255) return false;
        octets.push(value);
    }
    return octets[0] === 127;
}

function extractEmbeddedIpv4OrNull(hostname: string): string | null {
    const last = hostname.split(':').pop() ?? '';
    if (last.includes('.')) {
        return isIP(last) === 4 ? last : null;
    }

    // Also handle IPv4-mapped IPv6 in hex form (e.g. ::ffff:7f00:1).
    const groups = parseIpv6GroupsOrNull(hostname);
    if (!groups) return null;
    const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    if (!isMapped) return null;

    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
    return octets.join('.');
}

function parseIpv6GroupsOrNull(hostname: string): number[] | null {
    const raw = hostname.toLowerCase();
    if (raw.includes('.')) return null;

    const parts = raw.split('::');
    if (parts.length > 2) return null;

    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];

    const all = [...head, ...tail];
    for (const group of all) {
        if (!group) continue;
        if (group.length > 4) return null;
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    }

    const missing = 8 - (head.filter(Boolean).length + tail.filter(Boolean).length);
    if (parts.length === 1) {
        if (missing !== 0) return null;
        return head.map((g) => Number.parseInt(g || '0', 16));
    }

    if (missing < 1) return null;

    const groups = [
        ...head.map((g) => Number.parseInt(g || '0', 16)),
        ...Array.from({ length: missing }, () => 0),
        ...tail.map((g) => Number.parseInt(g || '0', 16)),
    ];
    return groups.length === 8 ? groups : null;
}

function isIpv6Loopback(hostname: string): boolean {
    const groups = parseIpv6GroupsOrNull(hostname);
    if (!groups) return false;
    return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
}

export function isLoopbackHostname(hostname: string): boolean {
    const withoutTrailingDot = hostname.trim().replace(/\.$/, '');
    const withoutBrackets =
        withoutTrailingDot.startsWith('[') && withoutTrailingDot.endsWith(']')
            ? withoutTrailingDot.slice(1, -1)
            : withoutTrailingDot;
    const withoutZoneId = withoutBrackets.split('%')[0] ?? '';
    const normalized = withoutZoneId.toLowerCase();

    if (normalized === 'localhost') return true;
    const legacyIpv4Loopback = isLegacyIpv4LoopbackOrNull(normalized);
    if (legacyIpv4Loopback !== null) return legacyIpv4Loopback;

    const ipVersion = isIP(normalized);
    if (ipVersion === 4) return normalized.split('.')[0] === '127';
    if (ipVersion === 6) {
        const embedded = extractEmbeddedIpv4OrNull(normalized);
        if (embedded) return embedded.split('.')[0] === '127';
        return isIpv6Loopback(normalized);
    }
    return false;
}
