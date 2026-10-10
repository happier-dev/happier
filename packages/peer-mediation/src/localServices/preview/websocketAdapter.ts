import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

import type {
    LocalServicePreviewHttpHeaders,
    LocalServicePreviewTunnelStream,
    OpenLocalServicePreviewTunnel,
} from "./httpAdapter.js";
import { isPreviewMethodAllowed } from "./httpAdapter.js";
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
const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const textEncoder = new TextEncoder();
let nextSocketSequence = 0;

export type LocalServicePreviewWebSocketClient = Readonly<{
    read(): AsyncIterable<Uint8Array>;
    write(chunk: Uint8Array): void | Promise<void>;
    end(): void | Promise<void>;
    destroy(error?: unknown): void;
}>;

export type LocalServicePreviewWebSocketUpgradeRequest = Readonly<{
    path: string;
    search: string;
    headers: LocalServicePreviewHttpHeaders;
    rawHeaders: readonly string[];
    head?: Uint8Array;
    client: LocalServicePreviewWebSocketClient;
    externalProtocol?: "http" | "https";
    signal?: AbortSignal;
}>;

export type ProxyLocalServicePreviewWebSocketUpgradeResult =
    | Readonly<{ ok: true }>
    | Readonly<{
          ok: false;
          reasonCode:
              | "invalid_request_target"
              | "method_not_allowed"
              | "preview_loop_detected"
              | "request_body_too_large"
              | "response_header_too_large"
              | "response_body_too_large"
              | "invalid_upgrade_request"
              | "upstream_response_invalid"
              | "upstream_stream_failed";
      }>;

export type ProxyLocalServicePreviewWebSocketUpgradeInput = Readonly<{
    preview: LocalServicePreviewResourceV1;
    request: LocalServicePreviewWebSocketUpgradeRequest;
    openTunnel: OpenLocalServicePreviewTunnel;
    maxProxyHops?: number;
    observability?: PreviewAdapterObservability;
    observabilityAccountId?: string;
    nowMs?: () => number;
}>;

function readHeader(headers: LocalServicePreviewHttpHeaders, name: string): string | undefined {
    return readPreviewHeader(headers, name);
}

function parseProxyHopCount(headers: LocalServicePreviewHttpHeaders): number {
    const value = Number.parseInt(readHeader(headers, PREVIEW_HOP_HEADER) ?? "0", 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function requestTargetPath(request: LocalServicePreviewWebSocketUpgradeRequest): string {
    return `${request.path.startsWith("/") ? request.path : `/${request.path}`}${request.search.startsWith("?") ? request.search : ""}`;
}

function headersForObservability(request: LocalServicePreviewWebSocketUpgradeRequest): LocalServicePreviewHttpHeaders {
    const headers = { ...request.headers };
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        const value = request.rawHeaders[index + 1];
        if (name && value !== undefined) headers[name.toLowerCase()] = value;
    }
    return headers;
}

async function writeClientError(client: LocalServicePreviewWebSocketClient, statusCode: number, statusMessage: string): Promise<void> {
    await client.write(textEncoder.encode(`HTTP/1.1 ${statusCode} ${statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`));
    client.destroy();
}

function isWebSocketUpgrade(request: LocalServicePreviewWebSocketUpgradeRequest): boolean {
    return readHeader(request.headers, "upgrade")?.toLowerCase() === "websocket"
        && (readHeader(request.headers, "connection") ?? "").split(",").some((token) => token.trim().toLowerCase() === "upgrade");
}

async function openUpstreamUpgrade(input: ProxyLocalServicePreviewWebSocketUpgradeInput, tunnel: LocalServicePreviewTunnelStream): Promise<Readonly<{ socket: Duplex; head: Uint8Array }>> {
    const socket = createPreviewUpstreamSocket(input.preview, tunnel);
    socket.on("error", () => undefined);
    const request = httpRequest({
        host: input.preview.target.host, port: input.preview.target.port,
        method: "GET", path: requestTargetPath(input.request),
        headers: buildPreviewRequestHeaders({ preview: input.preview, headers: headersForObservability(input.request),
            externalProtocol: input.request.externalProtocol, upgrade: true }),
        maxHeaderSize: DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES, createConnection: () => socket,
        signal: input.request.signal,
    });
    const upgraded = new Promise<Readonly<{ socket: Duplex; head: Uint8Array }>>((resolve, reject) => {
        request.once("error", reject);
        request.once("response", () => {
            request.destroy();
            reject(new Error("upstream_response_invalid"));
        });
        request.once("upgrade", (response, upgradedSocket, head) => {
            void (async () => {
                const key = readHeader(input.request.headers, "sec-websocket-key");
                const accept = key ? createHash("sha1").update(`${key.trim()}${WEBSOCKET_ACCEPT_GUID}`).digest("base64") : null;
                if (!accept || response.headers["sec-websocket-accept"] !== accept
                    || !response.headers.upgrade?.split(",").some((token) => token.trim().toLowerCase() === "websocket")
                    || !(response.headers.connection ?? "").split(",").some((token) => token.trim().toLowerCase() === "upgrade")) throw new Error("upstream_response_invalid");
                const headers = Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
                const rewritten = rewritePreviewResponseHeaders({ preview: input.preview, request: input.request, headers });
                const lines = ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade"];
                for (const [name, value] of Object.entries(rewritten)) {
                    for (const item of typeof value === "string" ? [value] : value) lines.push(`${name}: ${item}`);
                }
                await input.request.client.write(textEncoder.encode(`${lines.join("\r\n")}\r\n\r\n`));
                return { socket: upgradedSocket, head };
            })().then(resolve, (error) => { upgradedSocket.destroy(); reject(error); });
        });
    });
    request.end();
    try { return await upgraded; }
    catch (error) { request.destroy(); socket.destroy(); throw error; }
}

async function pumpClientToUpstream(input: ProxyLocalServicePreviewWebSocketUpgradeInput, socket: Duplex): Promise<void> {
    let bytes = 0;
    const write = async (chunk: Uint8Array) => {
        bytes += chunk.byteLength;
        if (input.preview.policy && bytes > input.preview.policy.maxRequestBodyBytes) throw new Error("request_body_too_large");
        await new Promise<void>((resolve, reject) => socket.write(chunk, (error) => error ? reject(error) : resolve()));
    };
    if (input.request.head?.byteLength) await write(input.request.head);
    for await (const chunk of input.request.client.read()) await write(chunk);
    await new Promise<void>((resolve, reject) => socket.end((error?: Error) => error ? reject(error) : resolve()));
}

async function pumpUpstreamToClient(input: ProxyLocalServicePreviewWebSocketUpgradeInput, socket: Duplex, head: Uint8Array): Promise<void> {
    let bytes = 0;
    const write = async (chunk: Uint8Array) => {
        bytes += chunk.byteLength;
        if (input.preview.policy && bytes > input.preview.policy.maxResponseBodyBytes) throw new Error("response_body_too_large");
        await input.request.client.write(chunk);
    };
    if (head.byteLength) await write(head);
    for await (const chunk of socket) await write(chunk);
    await input.request.client.end();
}

function nextSocketId(previewId: string): string {
    nextSocketSequence += 1;
    return `${previewId}:ws:${nextSocketSequence}`;
}

export async function proxyLocalServicePreviewWebSocketUpgrade(
    input: ProxyLocalServicePreviewWebSocketUpgradeInput,
): Promise<ProxyLocalServicePreviewWebSocketUpgradeResult> {
    // S-1 fail-closed backstop for the raw upgrade request line. The upgrade routes derive the
    // path from `URL.pathname`, which is canonical by construction, so this can only fire for a
    // caller that supplied a router-decoded path directly.
    if (!isSafeLocalServiceRequestTarget(requestTargetPath(input.request))) {
        await writeClientError(input.request.client, 400, "Bad Request");
        return { ok: false, reasonCode: "invalid_request_target" };
    }

    if (!isWebSocketUpgrade(input.request)) {
        await writeClientError(input.request.client, 400, "Bad Request");
        return { ok: false, reasonCode: "invalid_upgrade_request" };
    }

    if (!isPreviewMethodAllowed(input.preview, 'GET')) {
        await writeClientError(input.request.client, 405, 'Method Not Allowed');
        return { ok: false, reasonCode: 'method_not_allowed' };
    }

    if (parseProxyHopCount(input.request.headers) >= Math.max(1, input.maxProxyHops ?? DEFAULT_PREVIEW_MAX_PROXY_HOPS)) {
        await writeClientError(input.request.client, 508, "Loop Detected");
        return { ok: false, reasonCode: "preview_loop_detected" };
    }

    const nowMs = input.nowMs ?? Date.now;
    const startedAtMs = nowMs();
    const socketId = nextSocketId(input.preview.previewId);
    const observabilityAccountId = input.observabilityAccountId ?? "unknown";
    const tunnel = await input.openTunnel({ preview: input.preview });
    function emitWebSocketLifecycle(inputEvent: Readonly<{
        kind: "websocket.opened" | "websocket.closed" | "websocket.aborted" | "websocket.errored";
        reasonCode?: string;
        durationMs?: number;
    }>): void {
        input.observability?.createPeerMediationWebSocketEvent?.({
            kind: inputEvent.kind,
            accountId: observabilityAccountId,
            machineId: input.preview.machineId,
            previewId: input.preview.previewId,
            tunnelId: tunnel.tunnelId,
            substreamId: tunnel.substreamId,
            socketId,
            url: requestTargetPath(input.request),
            headers: headersForObservability(input.request),
            ...(inputEvent.durationMs !== undefined ? { durationMs: inputEvent.durationMs } : {}),
            ...(inputEvent.reasonCode ? { reasonCode: inputEvent.reasonCode } : {}),
            nowMs: nowMs(),
        });
    }
    emitWebSocketLifecycle({ kind: "websocket.opened" });
    try {
        const upstream = await openUpstreamUpgrade(input, tunnel);
        const abortUpstream = () => upstream.socket.destroy(new Error("client_aborted"));
        input.request.signal?.addEventListener("abort", abortUpstream, { once: true });
        try {
            if (input.request.signal?.aborted) abortUpstream();
            await Promise.all([
                pumpClientToUpstream(input, upstream.socket),
                pumpUpstreamToClient(input, upstream.socket, upstream.head),
            ]);
        } finally {
            input.request.signal?.removeEventListener("abort", abortUpstream);
            upstream.socket.destroy();
        }

        emitWebSocketLifecycle({
            kind: "websocket.closed",
            durationMs: Math.max(0, nowMs() - startedAtMs),
        });
        return { ok: true };
    } catch (error) {
        input.request.client.destroy(error);
        const code = readPreviewUpstreamResponseFailure(error) ?? (error instanceof Error ? error.message : "");
        const aborted = code === "upstream_response_invalid" || code === "request_body_too_large" || code === "response_body_too_large" || code === "response_header_too_large";
        const reasonCode = aborted ? code : "preview_websocket_adapter_error";
        await tunnel.abort(reasonCode);
        emitWebSocketLifecycle({
            kind: aborted ? "websocket.aborted" : "websocket.errored",
            reasonCode,
            durationMs: Math.max(0, nowMs() - startedAtMs),
        });
        return { ok: false, reasonCode: aborted ? code : "upstream_stream_failed" };
    } finally {
        await tunnel.close();
    }
}
