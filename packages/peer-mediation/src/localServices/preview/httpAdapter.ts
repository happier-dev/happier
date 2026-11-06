import { request as httpRequest } from "node:http";
import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

import { DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES } from "./limits.js";
import { buildPreviewRequestHeaders, readPreviewHeader } from "./headers.js";
import { createPreviewUpstreamSocket, readPreviewUpstreamResponseFailure } from "./upstreamSocket.js";
import { rewritePreviewResponseHeaders } from "./rewrites.js";
import {
    isSafeLocalServiceRequestTarget,
} from "./requestTarget.js";
import type { PreviewAdapterObservability } from "./observability.js";

const DEFAULT_PREVIEW_MAX_PROXY_HOPS = 5;
const PREVIEW_HOP_HEADER = "x-happier-preview-hops";
const textEncoder = new TextEncoder();
let nextRequestSequence = 0;

export type LocalServicePreviewHttpHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;
export type LocalServicePreviewHttpResponseHeaders = Readonly<Record<string, string | readonly string[]>>;

export type LocalServicePreviewHttpRequest = Readonly<{
    method: string;
    path: string;
    search: string;
    headers: LocalServicePreviewHttpHeaders;
    body?: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
    externalProtocol?: "http" | "https";
}>;

export type LocalServicePreviewHttpResponseSink = Readonly<{
    writeHead(statusCode: number, statusMessage: string, headers: LocalServicePreviewHttpResponseHeaders): void;
    write(chunk: Uint8Array): void | Promise<void>;
    end(): void | Promise<void>;
    destroy(error?: unknown): void;
}>;

export type LocalServicePreviewTunnelStream = Readonly<{
    tunnelId: string;
    substreamId: string;
    write(chunk: Uint8Array): void | Promise<void>;
    endWrite(): void | Promise<void>;
    read(): AsyncIterable<Uint8Array>;
    close(): void | Promise<void>;
    abort(reasonCode: string): void | Promise<void>;
}>;

export type OpenLocalServicePreviewTunnel = (input: Readonly<{
    preview: LocalServicePreviewResourceV1;
}>) => Promise<LocalServicePreviewTunnelStream>;

/** The admitted viewer learns only the refused port, never the sharing policy's contents. */
export function createLocalServicePreviewPortPolicyRefusal(port: number): Readonly<{
    error: 'preview_access_denied'; reasonCode: 'destination_port_not_allowed'; port: number;
}> {
    return { error: 'preview_access_denied', reasonCode: 'destination_port_not_allowed', port };
}

export type ProxyLocalServicePreviewHttpRequestResult =
    | Readonly<{ ok: true }>
    | Readonly<{
          ok: false;
          reasonCode:
              | "invalid_request_target"
              | "method_not_allowed"
              | "preview_loop_detected"
              | "preview_tunnel_unavailable"
              | "request_body_too_large"
              | "response_header_too_large"
              | "response_body_too_large"
              | "upstream_response_invalid"
              | "upstream_stream_failed";
      }>;

export type ProxyLocalServicePreviewHttpRequestInput = Readonly<{
    preview: LocalServicePreviewResourceV1;
    request: LocalServicePreviewHttpRequest;
    response: LocalServicePreviewHttpResponseSink;
    openTunnel: OpenLocalServicePreviewTunnel;
    maxProxyHops?: number;
    observability?: PreviewAdapterObservability;
    observabilityAccountId?: string;
    nowMs?: () => number;
    onTransportUnavailable?: (input: Readonly<{ previewId: string; machineId: string; requestId: string; method: string; url: string; reasonCode: string; module: string; level: string }>) => void;
}>;

function readHeader(headers: LocalServicePreviewHttpHeaders, name: string): string | null {
    return readPreviewHeader(headers, name) ?? null;
}

function parseProxyHopCount(headers: LocalServicePreviewHttpHeaders): number {
    const value = Number.parseInt(readHeader(headers, PREVIEW_HOP_HEADER) ?? "0", 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isPreviewMethodAllowed(preview: LocalServicePreviewResourceV1, method: string): boolean {
    return !preview.policy || preview.policy.allowedMethods.some((allowed) => allowed === method.toUpperCase());
}

function contentLengthExceedsLimit(preview: LocalServicePreviewResourceV1, request: LocalServicePreviewHttpRequest): boolean {
    const length = Number(readHeader(request.headers, "content-length"));
    return preview.policy !== undefined && Number.isFinite(length) && length > preview.policy.maxRequestBodyBytes;
}

function requestTargetPath(request: LocalServicePreviewHttpRequest): string {
    const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
    return `${path}${request.search.startsWith("?") ? request.search : ""}`;
}

async function forwardNativeHttp(input: ProxyLocalServicePreviewHttpRequestInput, tunnel: LocalServicePreviewTunnelStream, onResponse: () => void): Promise<Readonly<{ statusCode: number; responseBytes: number }>> {
    const socket = createPreviewUpstreamSocket(input.preview, tunnel);
    socket.on("error", () => undefined);
    const requestHeaders = buildPreviewRequestHeaders({ preview: input.preview, headers: input.request.headers, externalProtocol: input.request.externalProtocol });
    if (input.request.body && readHeader(input.request.headers, "content-length") === null) requestHeaders["Transfer-Encoding"] = "chunked";
    const request = httpRequest({
        host: input.preview.target.host,
        port: input.preview.target.port,
        method: input.request.method.toUpperCase(),
        path: requestTargetPath(input.request),
        headers: requestHeaders,
        createConnection: () => socket,
        maxHeaderSize: DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES,
    });
    const abort = () => request.destroy(new Error("client_aborted"));
    input.request.signal?.addEventListener("abort", abort, { once: true });
    if (input.request.signal?.aborted) abort();
    const responseDone = new Promise<Readonly<{ statusCode: number; responseBytes: number }>>((resolve, reject) => {
        request.on("error", reject);
        request.on("response", (response) => {
            void (async () => {
                onResponse();
                const headers = Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
                input.response.writeHead(response.statusCode ?? 502, response.statusMessage ?? "", rewritePreviewResponseHeaders({
                    preview: input.preview, request: input.request, headers,
                }));
                let responseBytes = 0;
                for await (const chunk of response) {
                    responseBytes += chunk.byteLength;
                    if (input.preview.policy && responseBytes > input.preview.policy.maxResponseBodyBytes) throw new Error("response_body_too_large");
                    await input.response.write(chunk);
                }
                await input.response.end();
                return { statusCode: response.statusCode ?? 502, responseBytes };
            })().then(resolve, reject);
        });
    });
    const upload = (async () => {
        let requestBytes = 0;
        for await (const chunk of input.request.body ?? []) {
            requestBytes += chunk.byteLength;
            if (input.preview.policy && requestBytes > input.preview.policy.maxRequestBodyBytes) throw new Error("request_body_too_large");
            if (input.request.signal?.aborted) throw new Error("client_aborted");
            await new Promise<void>((resolve, reject) => request.write(chunk, (error) => error ? reject(error) : resolve()));
        }
        request.end();
    })();
    // Keep upload and response concurrent: streamed/early responses must not wait for body EOF.
    void upload.catch((error) => request.destroy(error instanceof Error ? error : new Error(String(error))));
    try {
        const response = await responseDone;
        await upload;
        return response;
    } finally {
        input.request.signal?.removeEventListener("abort", abort);
        request.destroy();
        socket.destroy();
    }
}
function nextRequestId(previewId: string): string {
    nextRequestSequence += 1;
    return `${previewId}:http:${nextRequestSequence}`;
}

/**
 * `createLocalServicePreviewTunnelOpener` tags its rejections with the prerequisite that failed
 * (`grant_signing_unavailable`, `preview_account_missing`, the relay-authorization mint's own
 * reason code). Read it structurally so the adapter stays free of a `tunnel.ts` value import —
 * that module imports this one for its types, and a value edge would close the cycle.
 */
function readTunnelUnavailableReasonCode(error: unknown): string {
    const raw = (error as { reasonCode?: unknown } | null | undefined)?.reasonCode;
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "preview_tunnel_open_failed";
}

/**
 * A tunnel that cannot be opened is a transport failure, not a server fault. `registerRoutes`
 * already defines the typed shape for that situation
 * (`503 preview_transport_unavailable / pms_tunnel_unavailable`) for the case where no transport is
 * configured at all; emit the same one here so the two ways of having no transport read alike.
 *
 * The wire reason stays generic on purpose: the specific prerequisite is server configuration, and
 * it belongs in the operator's log rather than in a preview visitor's response body.
 */
async function writePreviewTransportUnavailable(
    response: LocalServicePreviewHttpResponseSink,
    body: string,
): Promise<number> {
    const payload = textEncoder.encode(body);
    response.writeHead(503, "Service Unavailable", {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(payload.byteLength),
        "cache-control": "no-store",
    });
    await response.write(payload);
    await response.end();
    return payload.byteLength;
}

export async function proxyLocalServicePreviewHttpRequest(
    input: ProxyLocalServicePreviewHttpRequestInput,
): Promise<ProxyLocalServicePreviewHttpRequestResult> {
    const nowMs = input.nowMs ?? Date.now;
    const startedAtMs = nowMs();
    const requestId = nextRequestId(input.preview.previewId);
    const observabilityAccountId = input.observabilityAccountId ?? "unknown";
    const refuseTransport = async (reasonCode: string) => {
        input.onTransportUnavailable?.({
            module: "local-service-preview", level: "error", previewId: input.preview.previewId,
            machineId: input.preview.machineId, requestId, method: input.request.method,
            url: requestTargetPath(input.request), reasonCode,
        });
        return await writePreviewTransportUnavailable(input.response, JSON.stringify({
            error: "preview_transport_unavailable", reasonCode: "pms_tunnel_unavailable",
        }));
    };

    // S-1 fail-closed backstop for the raw request line. Every route entry point re-encodes the
    // router-decoded path (`requestTarget.ts`) and `URL.pathname` is canonical by construction, so
    // this can only fire for a caller that bypassed both.
    if (!isSafeLocalServiceRequestTarget(requestTargetPath(input.request))) {
        input.response.writeHead(400, "Bad Request", {});
        await input.response.end();
        return { ok: false, reasonCode: "invalid_request_target" };
    }

    if (!isPreviewMethodAllowed(input.preview, input.request.method)) {
        input.response.writeHead(405, "Method Not Allowed", {});
        await input.response.end();
        return { ok: false, reasonCode: "method_not_allowed" };
    }

    if (parseProxyHopCount(input.request.headers) >= Math.max(1, input.maxProxyHops ?? DEFAULT_PREVIEW_MAX_PROXY_HOPS)) {
        input.response.writeHead(508, "Loop Detected", {});
        await input.response.end();
        return { ok: false, reasonCode: "preview_loop_detected" };
    }

    if (contentLengthExceedsLimit(input.preview, input.request)) {
        input.response.writeHead(413, "Payload Too Large", {});
        await input.response.end();
        return { ok: false, reasonCode: "request_body_too_large" };
    }

    let tunnel: LocalServicePreviewTunnelStream;
    try {
        tunnel = await input.openTunnel({ preview: input.preview });
    } catch (error) {
        // Every other failure this adapter knows about is written to the sink and returned as a
        // typed result. Opening the tunnel used to be the one that escaped as an exception, which
        // Fastify's global handler turned into an untyped `500 An unexpected error occurred` with
        // no product vocabulary attached (`F-PREVIEW-1`).
        await refuseTransport(readTunnelUnavailableReasonCode(error));
        return { ok: false, reasonCode: "preview_tunnel_unavailable" };
    }
    if (input.observability) {
        input.observability?.createPeerMediationHttpRequestStartedEvent?.({
            accountId: observabilityAccountId,
            machineId: input.preview.machineId,
            previewId: input.preview.previewId,
            requestId,
            tunnelId: tunnel.tunnelId,
            substreamId: tunnel.substreamId,
            method: input.request.method,
            url: requestTargetPath(input.request),
            headers: input.request.headers,
            nowMs: startedAtMs,
        });
    }
    let responseStarted = false;
    const observeFinished = (statusCode: number, responseBytes: number) => {
        input.observability?.createPeerMediationHttpRequestFinishedEvent?.({
            accountId: observabilityAccountId, machineId: input.preview.machineId,
            previewId: input.preview.previewId, requestId, tunnelId: tunnel.tunnelId,
            substreamId: tunnel.substreamId, method: input.request.method, url: requestTargetPath(input.request),
            statusCode, responseBytes,
            durationMs: Math.max(0, nowMs() - startedAtMs), nowMs: nowMs(),
        });
    };
    const observeAborted = (reasonCode: string) => {
        input.observability?.createPeerMediationHttpRequestAbortedEvent?.({
            accountId: observabilityAccountId, machineId: input.preview.machineId,
            previewId: input.preview.previewId, requestId, tunnelId: tunnel.tunnelId,
            substreamId: tunnel.substreamId, method: input.request.method, url: requestTargetPath(input.request),
            reasonCode, durationMs: Math.max(0, nowMs() - startedAtMs), nowMs: nowMs(),
        });
    };
    try {
        const finished = await forwardNativeHttp(input, tunnel, () => { responseStarted = true; });
        observeFinished(finished.statusCode, finished.responseBytes);
        return { ok: true };
    } catch (error) {
        const code = readPreviewUpstreamResponseFailure(error) ?? (error instanceof Error ? error.message : "");
        if (code === "request_body_too_large" || code === "response_body_too_large") {
            await tunnel.abort(code);
            if (code === "request_body_too_large" && !responseStarted) {
                input.response.writeHead(413, "Payload Too Large", {});
                await input.response.end();
                observeFinished(413, 0);
            } else {
                input.response.destroy(error);
                observeAborted(code);
            }
            return { ok: false, reasonCode: code };
        }
        // PMS admits its byte stream before the destination connects. A refused/stopped
        // listener (including EOF without headers) must answer the same state probe as
        // a tunnel-open refusal, rather than resetting the browser's document request.
        if (!responseStarted && code !== "client_aborted" && code !== "response_header_too_large") {
            await tunnel.abort("preview_upstream_unavailable");
            const responseBytes = await refuseTransport("preview_upstream_unavailable");
            observeFinished(503, responseBytes);
            return { ok: false, reasonCode: code === "upstream_response_invalid"
                ? code : "upstream_stream_failed" };
        }
        if (code === "client_aborted" || code === "response_header_too_large" || code === "upstream_response_invalid") {
            input.response.destroy(error);
            await tunnel.abort(code);
            observeAborted(code);
            return { ok: false, reasonCode: code === "client_aborted" ? "upstream_stream_failed" : code };
        }
        input.response.destroy(error);
        await tunnel.abort("preview_adapter_error");
        input.observability?.createPeerMediationFlowEvent?.({
            accountId: observabilityAccountId,
            machineId: input.preview.machineId,
            flowKind: "tcp_tunnel",
            flowId: tunnel.tunnelId,
            kind: "flow.errored",
            reasonCode: "preview_adapter_error",
            nowMs: nowMs(),
            metadata: { requestId },
        });
        return { ok: false, reasonCode: "upstream_stream_failed" };
    } finally {
        await tunnel.close();
    }
}
