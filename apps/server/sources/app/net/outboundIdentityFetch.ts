import { lookup } from "node:dns/promises";

import { Agent, buildConnector, fetch as undiciFetch } from "undici";

import { parseIpAddress } from "@/app/net/addressPolicy";
import {
    evaluateOutboundAddresses,
    evaluateOutboundUrl,
    normalizeOutboundHostname,
    OutboundIdentityEndpointError,
    redactEndpoint,
    type OutboundIdentityNetworkPolicy,
} from "@/app/net/outboundIdentityNetworkPolicy";

/**
 * The single outbound HTTP boundary for administrator-defined identity endpoints.
 *
 * `createOutboundIdentityFetch` returns a Fetch-compatible function that is handed
 * to `openid-client` at discovery, which retains it for JWKS, token, refresh, and
 * UserInfo. No identity code performs its own `fetch`, so there is one place where
 * scheme, port, DNS answers, connected peer, redirects, response size, and the
 * cancellation-aware timeout are enforced.
 *
 * The peer pin is literal: the connector connects to a policy-approved resolved
 * address and passes the original hostname as TLS SNI, so certificate hostname
 * verification is unchanged and no second DNS lookup can select a different peer.
 */

export type OutboundIdentityFetch = Readonly<{
    fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
    close: () => Promise<void>;
}>;

export type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

export type CreateOutboundIdentityFetchInput = Readonly<{
    policy: OutboundIdentityNetworkPolicy;
    /** DNS boundary. Defaults to the server resolver returning every A and AAAA answer. */
    resolveAddresses?: ResolveAddresses;
    /** TLS trust boundary supplied by the real controlled-server test fixture. */
    tlsOptions?: Parameters<typeof buildConnector>[0];
}>;

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

export function createOutboundIdentityFetch(input: CreateOutboundIdentityFetchInput): OutboundIdentityFetch {
    const { policy } = input;
    const resolveAddresses = input.resolveAddresses ?? defaultResolveAddresses;
    const connect = buildConnector({ ...input.tlsOptions });
    /** canonical hostname -> this request's validated dial list and cancellation lifetime. */
    const pinnedAddresses = new Map<string, Readonly<{ addresses: readonly string[]; signal: AbortSignal }>>();
    let closed = false;

    const dispatcher = new Agent({
        maxHeaderSize: policy.maxHeaderBytes,
        connect(options, callback) {
            const originalHostname = String(options.hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
            const hostname = normalizeOutboundHostname(originalHostname);
            const authorization = pinnedAddresses.get(hostname);
            if (!authorization?.addresses.length) {
                callback(new OutboundIdentityEndpointError("outbound_address_forbidden", originalHostname, "address was not validated"), null);
                return;
            }

            let index = 0;
            const connectNext = (lastError?: Error): void => {
                if (closed || authorization.signal.aborted) {
                    callback(cancellationError(authorization.signal), null);
                    return;
                }
                const pinned = authorization.addresses[index];
                index += 1;
                if (!pinned) {
                    callback(lastError ?? new OutboundIdentityEndpointError("outbound_transport_failed", originalHostname), null);
                    return;
                }
                connect({ ...options, hostname: pinned, servername: options.servername ?? originalHostname }, (error, socket) => {
                    if (closed || authorization.signal.aborted) {
                        socket?.destroy();
                        callback(cancellationError(authorization.signal), null);
                        return;
                    }
                    if (error || !socket) {
                        connectNext(error ?? new OutboundIdentityEndpointError("outbound_transport_failed", originalHostname));
                        return;
                    }
                    const peer = parseIpAddress(socket.remoteAddress ?? "");
                    if (!peer || peer.address !== parseIpAddress(pinned)?.address) {
                        socket.destroy();
                        callback(new OutboundIdentityEndpointError("outbound_peer_mismatch", originalHostname, "connected peer is not the validated address"), null);
                        return;
                    }
                    callback(null, socket);
                });
            };
            connectNext();
        },
    });

    async function boundedFetch(target: string | URL, init?: RequestInit): Promise<Response> {
        const url = target instanceof URL ? target : safeParseUrl(target);
        const endpoint = redactEndpoint(url);

        const urlDecision = evaluateOutboundUrl(policy, url);
        if (!urlDecision.allowed) {
            throw new OutboundIdentityEndpointError(urlDecision.code, endpoint, urlDecision.reason);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort(new OutboundIdentityEndpointError("outbound_timeout", endpoint, `exceeded ${policy.timeoutMs}ms`));
        }, policy.timeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;

        try {
            const literal = parseIpAddress(urlDecision.hostname);
            const answers = literal
                ? [literal.address]
                : await resolveHostnameOrThrow(resolveAddresses, urlDecision.hostname, endpoint, signal);

            const addressDecision = evaluateOutboundAddresses(policy, answers, {
                requiresLoopbackAddresses: urlDecision.requiresLoopbackAddresses,
            });
            if (!addressDecision.allowed) {
                throw new OutboundIdentityEndpointError(addressDecision.code, endpoint, addressDecision.reason);
            }
            pinnedAddresses.set(urlDecision.hostname, {
                addresses: addressDecision.addresses.map((address) => address.address),
                signal,
            });

            const response = await undiciFetch(url, {
                ...(init as Record<string, unknown> | undefined),
                signal,
                redirect: "manual",
                dispatcher,
            } as Parameters<typeof undiciFetch>[1]);

            if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
                await response.body?.cancel();
                throw new OutboundIdentityEndpointError("outbound_unexpected_redirect", endpoint, "redirects are not followed for identity endpoints");
            }

            const body = await readBoundedBody(response, policy.maxResponseBytes, endpoint);
            // The dispatcher's `undici` instance is not the one backing the global
            // `Response`, so headers are copied as entries rather than handed over.
            return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
                status: response.status,
                statusText: response.statusText,
                headers: [...response.headers.entries()],
            });
        } catch (error) {
            throw toOutboundError(error, endpoint, controller.signal, init?.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    return Object.freeze({
        fetch: boundedFetch,
        close: async () => {
            closed = true;
            pinnedAddresses.clear();
            await dispatcher.destroy();
        },
    });
}

function cancellationError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new OutboundIdentityEndpointError("outbound_canceled", "<canceled>");
}

async function defaultResolveAddresses(hostname: string): Promise<readonly string[]> {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((entry) => entry.address);
}

async function resolveHostnameOrThrow(
    resolveAddresses: ResolveAddresses,
    hostname: string,
    endpoint: string,
    signal: AbortSignal,
): Promise<readonly string[]> {
    try {
        return await settleBeforeAbort(resolveAddresses(hostname), signal);
    } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        throw new OutboundIdentityEndpointError("outbound_dns_unresolved", endpoint, "hostname could not be resolved");
    }
}

async function settleBeforeAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason;
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

function safeParseUrl(raw: string): URL {
    try {
        return new URL(raw);
    } catch {
        throw new OutboundIdentityEndpointError("outbound_scheme_forbidden", "<unparseable>", "target is not a valid absolute URL");
    }
}

async function readBoundedBody(
    response: Awaited<ReturnType<typeof undiciFetch>>,
    maxBytes: number,
    endpoint: string,
): Promise<Buffer<ArrayBuffer> | null> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new OutboundIdentityEndpointError("outbound_response_too_large", endpoint, `response exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** Safe transport diagnostics only: an uppercase system/TLS error code, never a message or payload. */
function extractSafeErrorCode(error: unknown): string | undefined {
    for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
        const record = current as { code?: unknown; cause?: unknown };
        if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(record.code)) return record.code;
        current = record.cause;
    }
    return undefined;
}

function toOutboundError(
    error: unknown,
    endpoint: string,
    timeoutSignal: AbortSignal,
    callerSignal: AbortSignal | null | undefined,
): OutboundIdentityEndpointError {
    if (error instanceof OutboundIdentityEndpointError) return error;
    for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
        const cause = (current as { cause?: unknown }).cause;
        if (cause instanceof OutboundIdentityEndpointError) return cause;
        current = cause;
    }
    if (timeoutSignal.aborted && timeoutSignal.reason instanceof OutboundIdentityEndpointError) {
        return timeoutSignal.reason;
    }
    if (callerSignal?.aborted) {
        return new OutboundIdentityEndpointError("outbound_canceled", endpoint);
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        return new OutboundIdentityEndpointError("outbound_canceled", endpoint);
    }
    const safeCode = extractSafeErrorCode(error);
    if (safeCode === "UND_ERR_HEADERS_OVERFLOW") {
        return new OutboundIdentityEndpointError("outbound_response_too_large", endpoint, "response headers exceeded the configured limit");
    }
    return new OutboundIdentityEndpointError("outbound_transport_failed", endpoint, safeCode);
}
