import {
    cidrContains,
    isGloballyRoutableAddress,
    parseIpAddress,
    parseIpCidr,
    type IpAddressFacts,
    type IpCidr,
} from "@/app/net/addressPolicy";
import { isLoopbackHostname } from "@happier-dev/protocol";

/**
 * Outbound network policy for administrator-defined identity endpoints (OIDC
 * discovery/JWKS/token/refresh/UserInfo, and later GitHub Enterprise Server).
 *
 * This module decides; `outboundIdentityFetch.ts` connects. Keeping the decision
 * transport-free keeps every denial exercisable without a socket and keeps one
 * owner for "may this server talk to that endpoint".
 */

export type OutboundAddressPolicy =
    /** Shared/cloud Homes: only globally routable public unicast addresses. */
    | Readonly<{ kind: "publicOnly" }>
    /**
     * Released deployment behavior for env/file-configured OIDC providers: the
     * deployment operator already chose the issuer, so addresses are not filtered.
     * Scheme, port, redirect, peer-pinning, size, and timeout bounds still apply.
     * This is a compatibility mode, not a self-hosted "allow private" switch.
     */
    | Readonly<{ kind: "deploymentConfigured" }>
    /** Self-hosted Home: exact issuer hostnames inside exact CIDRs. */
    | Readonly<{ kind: "privateAllowlist"; hostnames: readonly string[]; cidrs: readonly string[] }>;

export type OutboundNetworkPolicy = Readonly<{
    address: OutboundAddressPolicy;
    /** `any` preserves released deployment behavior; managed policies name exact ports. */
    allowedPorts: "any" | readonly number[];
    /** Explicit local-development authority. Plaintext HTTP is never allowed off loopback. */
    allowLoopbackHttp: boolean;
    /** Decoded response bound, applied while reading, before any JSON parse. */
    maxResponseBytes?: number;
    maxHeaderBytes?: number;
    timeoutMs?: number;
}>;

/** Identity endpoints retain their owning consumer's mandatory resource bounds. */
export type OutboundIdentityNetworkPolicy = OutboundNetworkPolicy & Readonly<{
    maxResponseBytes: number;
    maxHeaderBytes: number;
    timeoutMs: number;
}>;

export type OutboundIdentityDenialCode =
    | "outbound_scheme_forbidden"
    | "outbound_url_credentials_forbidden"
    | "outbound_url_fragment_forbidden"
    | "outbound_port_forbidden"
    | "outbound_host_forbidden"
    | "outbound_address_forbidden"
    | "outbound_dns_unresolved"
    | "outbound_peer_mismatch"
    | "outbound_unexpected_redirect"
    | "outbound_response_too_large"
    | "outbound_timeout"
    | "outbound_canceled"
    | "outbound_transport_failed";

/**
 * Typed, redacted outbound failure. It carries the scheme/host/port/path an
 * administrator needs to fix configuration and never the query string, request or
 * response body, headers, credentials, or the resolved peer addresses.
 */
export class OutboundIdentityEndpointError extends Error {
    readonly code: OutboundIdentityDenialCode;
    readonly endpoint: string;
    readonly reason: string | null;

    constructor(code: OutboundIdentityDenialCode, endpoint: string, reason?: string) {
        super(`${code}: ${endpoint}${reason ? ` (${reason})` : ""}`);
        this.name = "OutboundIdentityEndpointError";
        this.code = code;
        this.endpoint = endpoint;
        this.reason = reason ?? null;
    }
}

/** Scheme, host, port, and path only — no credentials, query, or fragment. */
export function redactEndpoint(url: URL): string {
    return `${url.protocol}//${url.host}${url.pathname}`;
}

export type OutboundUrlDecision =
    | Readonly<{ allowed: true; hostname: string; requiresLoopbackAddresses: boolean }>
    | Readonly<{ allowed: false; code: OutboundIdentityDenialCode; reason: string }>;

/**
 * Parse-time URL admission. This is necessary but never sufficient: every resolved
 * address is still classified, and the connected peer is still pinned.
 */
export function evaluateOutboundUrl(policy: OutboundNetworkPolicy, url: URL): OutboundUrlDecision {
    if (url.username || url.password) {
        return { allowed: false, code: "outbound_url_credentials_forbidden", reason: "url userinfo is not allowed" };
    }
    if (url.hash) {
        return { allowed: false, code: "outbound_url_fragment_forbidden", reason: "url fragment is not allowed" };
    }

    const protocol = url.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
        return { allowed: false, code: "outbound_scheme_forbidden", reason: `unsupported scheme ${protocol}` };
    }

    const hostname = normalizeOutboundHostname(url.hostname);
    if (!hostname) {
        return { allowed: false, code: "outbound_host_forbidden", reason: "missing hostname" };
    }

    let requiresLoopbackAddresses = false;
    if (protocol === "http:") {
        if (!policy.allowLoopbackHttp || !isLoopbackHostname(url.hostname)) {
            return { allowed: false, code: "outbound_scheme_forbidden", reason: "http is allowed only for loopback development endpoints" };
        }
        requiresLoopbackAddresses = true;
    }

    if (policy.allowedPorts !== "any") {
        const port = url.port ? Number(url.port) : protocol === "http:" ? 80 : 443;
        if (!policy.allowedPorts.includes(port)) {
            return { allowed: false, code: "outbound_port_forbidden", reason: `port ${port} is not allowed by policy` };
        }
    }

    if (policy.address.kind === "privateAllowlist") {
        const allowed = policy.address.hostnames.some((candidate) => normalizeOutboundHostname(candidate) === hostname);
        if (!allowed) {
            return { allowed: false, code: "outbound_host_forbidden", reason: "hostname is not in the Home issuer allowlist" };
        }
    }

    return { allowed: true, hostname, requiresLoopbackAddresses };
}

export type OutboundAddressDecision =
    | Readonly<{ allowed: true; addresses: readonly IpAddressFacts[] }>
    | Readonly<{ allowed: false; code: OutboundIdentityDenialCode; reason: string }>;

/**
 * Every DNS answer must pass. A mixed safe/unsafe answer set is rejected outright
 * rather than filtered, so a rebinding resolver cannot hand us one good answer to
 * validate and one bad answer to connect to.
 */
export function evaluateOutboundAddresses(
    policy: OutboundNetworkPolicy,
    rawAddresses: readonly string[],
    input: Readonly<{ requiresLoopbackAddresses: boolean }>,
): OutboundAddressDecision {
    if (rawAddresses.length === 0) {
        return { allowed: false, code: "outbound_dns_unresolved", reason: "no A or AAAA answer" };
    }

    const cidrs = policy.address.kind === "privateAllowlist" ? parseCidrs(policy.address.cidrs) : null;
    if (policy.address.kind === "privateAllowlist" && cidrs === null) {
        return { allowed: false, code: "outbound_address_forbidden", reason: "Home issuer allowlist contains an invalid CIDR" };
    }
    if (cidrs && cidrs.length === 0) {
        return { allowed: false, code: "outbound_address_forbidden", reason: "Home issuer allowlist has no CIDR" };
    }

    const addresses: IpAddressFacts[] = [];
    for (const raw of rawAddresses) {
        const facts = parseIpAddress(raw);
        if (!facts) {
            return { allowed: false, code: "outbound_address_forbidden", reason: "unparseable resolved address" };
        }
        if (input.requiresLoopbackAddresses && !facts.categories.has("loopback")) {
            return { allowed: false, code: "outbound_address_forbidden", reason: "plaintext http endpoint did not resolve to loopback" };
        }
        switch (policy.address.kind) {
            case "publicOnly":
                if (!isGloballyRoutableAddress(facts)) {
                    return { allowed: false, code: "outbound_address_forbidden", reason: "resolved address is not public unicast" };
                }
                break;
            case "privateAllowlist":
                if (facts.embeddedIpv4 !== null) {
                    return { allowed: false, code: "outbound_address_forbidden", reason: "IPv4-in-IPv6 encoded address is not allowed" };
                }
                if (!cidrs?.some((cidr) => cidrContains(cidr, facts))) {
                    return { allowed: false, code: "outbound_address_forbidden", reason: "resolved address is outside the Home issuer allowlist" };
                }
                break;
            case "deploymentConfigured":
                break;
        }
        addresses.push(facts);
    }

    return { allowed: true, addresses };
}

function parseCidrs(raw: readonly string[]): IpCidr[] | null {
    const parsed: IpCidr[] = [];
    for (const candidate of raw) {
        const cidr = parseIpCidr(candidate);
        if (!cidr) return null;
        parsed.push(cidr);
    }
    return parsed;
}

export function normalizeOutboundHostname(raw: string): string {
    const trimmed = raw.trim().replace(/\.$/, "").toLowerCase();
    return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}
