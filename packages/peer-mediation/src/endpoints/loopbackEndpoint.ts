import {
    PeerLoopbackEndpointCandidateV1Schema,
    type PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';

import type { PeerEndpointMechanism, PeerEndpointTransport, PeerRouteCandidate } from '../route/types.js';

const PEER_LOOPBACK_PROBE_PATH_V1 = '/peer-mediation/v1/probe';

function normalizeLoopbackHostname(hostname: string): string {
    const lower = hostname.toLowerCase();
    return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = normalizeLoopbackHostname(hostname);
    if (normalized === 'localhost') return true;
    if (normalized === '::1') return true;
    const parts = normalized.split('.');
    if (parts.length !== 4 || parts[0] !== '127') return false;
    return parts.slice(1).every((part) => {
        if (!/^\d+$/.test(part)) return false;
        const value = Number(part);
        return Number.isInteger(value) && value >= 0 && value <= 255;
    });
}

function parseLoopbackEndpointUrl(input: string): URL | null {
    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') return null;
    if (!isLoopbackHostname(parsed.hostname)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== PEER_LOOPBACK_PROBE_PATH_V1) return null;
    return parsed;
}

export function normalizePeerLoopbackEndpointUrl(input: string): string | null {
    const parsed = parseLoopbackEndpointUrl(input);
    return parsed ? parsed.toString() : null;
}

function fingerprintPeerLoopbackEndpoint(input: string): string {
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= BigInt(input.charCodeAt(index));
        hash = (hash * 0x100000001b3n) & 0xffff_ffff_ffff_ffffn;
    }
    return `loopback_${hash.toString(36)}_${input.length.toString(36)}`;
}

export function createPeerLoopbackEndpointFingerprint(input: Readonly<{
    url: string;
    routeKind: 'loopback_direct';
    daemonRuntimeId: string;
}>): string {
    const normalizedUrl = normalizePeerLoopbackEndpointUrl(input.url);
    if (!normalizedUrl) {
        throw new Error('Peer loopback endpoint URL must be local and secret-free');
    }
    if (typeof input.daemonRuntimeId !== 'string' || input.daemonRuntimeId.trim().length === 0) {
        throw new Error('Peer loopback endpoint fingerprint requires a fresh daemon runtime id');
    }

    return fingerprintPeerLoopbackEndpoint([
        'peer-loopback-endpoint-v1',
        input.routeKind,
        normalizedUrl,
        input.daemonRuntimeId,
    ].join('\u0000'));
}

export function assertPeerLoopbackEndpointCandidate(candidate: unknown): PeerLoopbackEndpointCandidateV1 | null {
    const parsed = PeerLoopbackEndpointCandidateV1Schema.safeParse(candidate);
    if (!parsed.success) return null;
    const normalizedUrl = normalizePeerLoopbackEndpointUrl(parsed.data.url);
    if (!normalizedUrl) return null;
    return {
        ...parsed.data,
        url: normalizedUrl,
    };
}

function resolveLoopbackEndpointTransport(url: URL): Readonly<{
    transport: PeerEndpointTransport;
    mechanism: PeerEndpointMechanism;
}> {
    if (url.protocol === 'ws:') {
        return {
            transport: 'ws',
            mechanism: 'loopback_ws',
        };
    }
    return {
        transport: 'http',
        mechanism: 'loopback_http',
    };
}

export function createPeerLoopbackRouteCandidate(input: Readonly<{
    url: string;
    expiresAt: number;
    daemonRuntimeId: string;
}>): PeerRouteCandidate {
    const normalizedUrl = normalizePeerLoopbackEndpointUrl(input.url);
    if (!normalizedUrl) {
        throw new Error('Peer loopback route candidate URL must be local and secret-free');
    }

    const parsedUrl = new URL(normalizedUrl);
    return {
        routeKind: 'loopback_direct',
        enabled: true,
        endpoint: {
            ...resolveLoopbackEndpointTransport(parsedUrl),
            url: normalizedUrl,
            endpointFingerprint: createPeerLoopbackEndpointFingerprint({
                url: normalizedUrl,
                routeKind: 'loopback_direct',
                daemonRuntimeId: input.daemonRuntimeId,
            }),
        },
    };
}
