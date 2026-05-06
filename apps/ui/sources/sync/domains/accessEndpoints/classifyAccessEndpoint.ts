import {
    isLocalishHostname,
    isLoopbackHostname,
} from '@/sync/domains/server/url/serverUrlClassification';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';

import type {
    AccessEndpointClientContext,
    AccessEndpointHostedHttpsCompatibility,
    AccessEndpointReachability,
} from './accessEndpointModel';

function stripBrackets(hostname: string): string {
    const host = String(hostname ?? '').trim();
    if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
    return host;
}

function isTailscaleIpv4(hostname: string): boolean {
    const match = stripBrackets(hostname).match(/^100\.(\d+)\./);
    if (!match) return false;
    const octet = Number(match[1]);
    return octet >= 64 && octet <= 127;
}

function isPrivateNetworkHostname(hostname: string): boolean {
    const host = stripBrackets(hostname).toLowerCase();
    if (!host) return false;
    if (isTailscaleIpv4(host)) return true;
    if (host.endsWith('.ts.net')) return true;
    if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd'))) return true;
    return false;
}

export function normalizeAccessEndpointHttpBaseUrl(raw: unknown): string | null {
    const normalized = canonicalizeServerUrl(String(raw ?? ''));
    return normalized || null;
}

export function classifyAccessEndpointReachability(httpBaseUrl: string): AccessEndpointReachability {
    try {
        const url = new URL(httpBaseUrl);
        if (isLoopbackHostname(url.hostname)) return 'loopback';
        if (isPrivateNetworkHostname(url.hostname)) return 'private-network';
        if (isLocalishHostname(url.hostname)) return 'lan';
        return 'public';
    } catch {
        return 'public';
    }
}

export function classifyAccessEndpointHostedHttpsCompatibility(params: Readonly<{
    httpBaseUrl: string;
    clientContext?: AccessEndpointClientContext | string;
}>): AccessEndpointHostedHttpsCompatibility {
    if (params.clientContext !== 'hosted-https-web') return 'not-applicable';

    try {
        const url = new URL(params.httpBaseUrl);
        if (url.protocol === 'https:') return 'compatible';
        if (url.protocol === 'http:') return 'mixed-content-blocked';
        return 'requires-configuration';
    } catch {
        return 'unknown';
    }
}

export function deriveAccessEndpointWsBaseUrl(httpBaseUrl: string): string | null {
    const normalized = normalizeAccessEndpointHttpBaseUrl(httpBaseUrl);
    if (!normalized) return null;

    try {
        const url = new URL(normalized);
        if (url.protocol === 'https:') url.protocol = 'wss:';
        else if (url.protocol === 'http:') url.protocol = 'ws:';
        else return null;
        return url.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}
