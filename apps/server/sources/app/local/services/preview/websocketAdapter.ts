import { createHash } from "node:crypto";
import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

import type {
    LocalServicePreviewHttpHeaders,
    LocalServicePreviewTunnelStream,
    OpenLocalServicePreviewTunnel,
} from "@/app/local/services/preview/httpAdapter";
import { DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES } from "@/app/local/services/preview/limits";
import { isPreviewControlledForwardingHeader } from "@/app/local/services/preview/headers";
import {
    createPeerMediationWebSocketEvent,
    type PeerMediationObservabilityEmitter,
} from "@/app/api/socket/peer/mediation/observability/events";

const DEFAULT_PREVIEW_MAX_PROXY_HOPS = 5;
const PREVIEW_HOP_HEADER = "x-happier-preview-hops";
const HTTP_HEADER_TERMINATOR = "\r\n\r\n";
const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const headerTerminatorBytes = textEncoder.encode(HTTP_HEADER_TERMINATOR);
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
}>;

export type ProxyLocalServicePreviewWebSocketUpgradeResult =
    | Readonly<{ ok: true }>
    | Readonly<{
          ok: false;
          reasonCode:
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
    observability?: PeerMediationObservabilityEmitter;
    observabilityAccountId?: string;
    nowMs?: () => number;
}>;

function headerName(value: string): string {
    return value.trim().toLowerCase();
}

function headerValues(value: string | readonly string[] | undefined): readonly string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    return [];
}

function readHeader(headers: LocalServicePreviewHttpHeaders, name: string): string | null {
    const target = headerName(name);
    for (const [key, value] of Object.entries(headers)) {
        if (headerName(key) !== target) continue;
        return headerValues(value)[0] ?? null;
    }
    return null;
}

function parseProxyHopCount(headers: LocalServicePreviewHttpHeaders): number {
    const raw = readHeader(headers, PREVIEW_HOP_HEADER);
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function requestBodyLimit(preview: LocalServicePreviewResourceV1): number {
    return preview.policy?.maxRequestBodyBytes ?? Number.MAX_SAFE_INTEGER;
}

function responseBodyLimit(preview: LocalServicePreviewResourceV1): number {
    return preview.policy?.maxResponseBodyBytes ?? Number.MAX_SAFE_INTEGER;
}

function requestTargetPath(request: LocalServicePreviewWebSocketUpgradeRequest): string {
    const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
    return `${path}${request.search.startsWith("?") ? request.search : ""}`;
}

function shouldForwardRawHeader(name: string): boolean {
    const normalized = headerName(name);
    if (normalized === PREVIEW_HOP_HEADER) return false;
    if (isPreviewControlledForwardingHeader(normalized)) return false;
    return ![
        "authorization",
        "connection",
        "cookie",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ].includes(normalized);
}

function headersForObservability(request: LocalServicePreviewWebSocketUpgradeRequest): LocalServicePreviewHttpHeaders {
    const merged: Record<string, string | readonly string[] | undefined> = {
        ...request.headers,
    };
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        const value = request.rawHeaders[index + 1];
        if (typeof name !== "string" || typeof value !== "string") continue;
        const normalized = headerName(name);
        if (normalized === "sec-websocket-protocol") {
            merged[normalized] = value;
        }
    }
    return merged;
}

function serializeUpgradeRequest(
    preview: LocalServicePreviewResourceV1,
    request: LocalServicePreviewWebSocketUpgradeRequest,
): string {
    const lines = [
        `GET ${requestTargetPath(request)} HTTP/1.1`,
        `Host: ${preview.target.host}:${preview.target.port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `${PREVIEW_HOP_HEADER}: ${parseProxyHopCount(request.headers) + 1}`,
    ];

    const forwardedHost = readHeader(request.headers, "host");
    if (forwardedHost) {
        lines.push(`X-Forwarded-Host: ${forwardedHost}`);
    }
    lines.push(`X-Forwarded-Proto: ${preview.target.scheme}`);

    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        const value = request.rawHeaders[index + 1];
        if (typeof name !== "string" || typeof value !== "string") continue;
        if (!shouldForwardRawHeader(name)) continue;
        lines.push(`${name}: ${value}`);
    }

    return `${lines.join("\r\n")}${HTTP_HEADER_TERMINATOR}`;
}

function concatBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
    if (left.byteLength === 0) return right;
    const out = new Uint8Array(left.byteLength + right.byteLength);
    out.set(left, 0);
    out.set(right, left.byteLength);
    return out;
}

function findHeaderTerminator(buffer: Uint8Array): number {
    for (let index = 0; index <= buffer.byteLength - headerTerminatorBytes.byteLength; index += 1) {
        if (headerTerminatorBytes.every((byte, markerIndex) => buffer[index + markerIndex] === byte)) {
            return index;
        }
    }
    return -1;
}

function responseHeaderTooLarge(buffer: Uint8Array, headerEnd: number): boolean {
    if (headerEnd >= 0) {
        return headerEnd > DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES;
    }
    return buffer.byteLength > DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES;
}

function headerTokenIncludes(values: readonly string[], token: string): boolean {
    const expected = token.toLowerCase();
    return values.some((value) => value
        .split(",")
        .some((item) => item.trim().toLowerCase() === expected));
}

function parseResponseHeaderBlock(headerBlock: Uint8Array): Readonly<{
    statusCode: number | null;
    headers: Map<string, string[]>;
}> {
    const lines = textDecoder.decode(headerBlock).split("\r\n");
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/u.exec(lines[0] ?? "");
    const headers = new Map<string, string[]>();
    for (const line of lines.slice(1)) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) continue;
        const name = headerName(line.slice(0, separatorIndex));
        const value = line.slice(separatorIndex + 1).trim();
        headers.set(name, [...(headers.get(name) ?? []), value]);
    }
    return {
        statusCode: statusMatch ? Number.parseInt(statusMatch[1], 10) : null,
        headers,
    };
}

function isValidUpstreamWebSocketHandshake(headerBlock: Uint8Array): boolean {
    const response = parseResponseHeaderBlock(headerBlock);
    return response.statusCode === 101
        && headerTokenIncludes(response.headers.get("upgrade") ?? [], "websocket")
        && headerTokenIncludes(response.headers.get("connection") ?? [], "upgrade");
}

function expectedWebSocketAccept(request: LocalServicePreviewWebSocketUpgradeRequest): string | null {
    const key = readHeader(request.headers, "sec-websocket-key")?.trim();
    if (!key) return null;
    return createHash("sha1").update(`${key}${WEBSOCKET_ACCEPT_GUID}`).digest("base64");
}

function isValidUpstreamWebSocketAccept(
    request: LocalServicePreviewWebSocketUpgradeRequest,
    headerBlock: Uint8Array,
): boolean {
    const expected = expectedWebSocketAccept(request);
    if (!expected) return false;
    const response = parseResponseHeaderBlock(headerBlock);
    return headerValues(response.headers.get("sec-websocket-accept")).some((value) => value.trim() === expected);
}

async function writeClientError(
    client: LocalServicePreviewWebSocketClient,
    statusCode: number,
    statusMessage: string,
): Promise<void> {
    await client.write(textEncoder.encode([
        `HTTP/1.1 ${statusCode} ${statusMessage}`,
        "Connection: close",
        "Content-Length: 0",
        "",
        "",
    ].join("\r\n")));
    client.destroy();
}

async function pumpClientToTunnel(input: Readonly<{
    preview: LocalServicePreviewResourceV1;
    request: LocalServicePreviewWebSocketUpgradeRequest;
    tunnel: LocalServicePreviewTunnelStream;
}>): Promise<ProxyLocalServicePreviewWebSocketUpgradeResult> {
    let requestBytes = 0;
    async function writeClientChunk(chunk: Uint8Array): Promise<ProxyLocalServicePreviewWebSocketUpgradeResult | null> {
        requestBytes += chunk.byteLength;
        if (requestBytes > requestBodyLimit(input.preview)) {
            await input.tunnel.abort("request_body_too_large");
            input.request.client.destroy(new Error("request_body_too_large"));
            return { ok: false, reasonCode: "request_body_too_large" };
        }
        await input.tunnel.write(chunk);
        return null;
    }

    if (input.request.head && input.request.head.byteLength > 0) {
        const headResult = await writeClientChunk(input.request.head);
        if (headResult) return headResult;
    }

    for await (const chunk of input.request.client.read()) {
        const result = await writeClientChunk(chunk);
        if (result) return result;
    }

    await input.tunnel.endWrite();
    return { ok: true };
}

async function pumpTunnelToClient(input: Readonly<{
    preview: LocalServicePreviewResourceV1;
    request: LocalServicePreviewWebSocketUpgradeRequest;
    tunnel: LocalServicePreviewTunnelStream;
}>): Promise<ProxyLocalServicePreviewWebSocketUpgradeResult> {
    let responseBytes = 0;
    let handshakeComplete = false;
    let handshakeBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
    for await (const chunk of input.tunnel.read()) {
        let countedChunk = chunk;
        let clientChunk = chunk;
        if (!handshakeComplete) {
            handshakeBuffer = concatBytes(handshakeBuffer, chunk);
            const headerEnd = findHeaderTerminator(handshakeBuffer);
            if (responseHeaderTooLarge(handshakeBuffer, headerEnd)) {
                await input.tunnel.abort("response_header_too_large");
                input.request.client.destroy(new Error("response_header_too_large"));
                return { ok: false, reasonCode: "response_header_too_large" };
            }
            if (headerEnd >= 0) {
                const headerBlock = handshakeBuffer.subarray(0, headerEnd);
                if (
                    !isValidUpstreamWebSocketHandshake(headerBlock)
                    || !isValidUpstreamWebSocketAccept(input.request, headerBlock)
                ) {
                    await input.tunnel.abort("upstream_response_invalid");
                    input.request.client.destroy(new Error("upstream_response_invalid"));
                    return { ok: false, reasonCode: "upstream_response_invalid" };
                }
                handshakeComplete = true;
                countedChunk = handshakeBuffer.subarray(headerEnd + headerTerminatorBytes.byteLength);
                clientChunk = handshakeBuffer;
                handshakeBuffer = new Uint8Array();
            } else {
                countedChunk = new Uint8Array();
                continue;
            }
        }
        responseBytes += countedChunk.byteLength;
        if (responseBytes > responseBodyLimit(input.preview)) {
            await input.tunnel.abort("response_body_too_large");
            input.request.client.destroy(new Error("response_body_too_large"));
            return { ok: false, reasonCode: "response_body_too_large" };
        }
        await input.request.client.write(clientChunk);
    }
    if (!handshakeComplete) {
        await input.tunnel.abort("upstream_response_invalid");
        input.request.client.destroy(new Error("upstream_response_invalid"));
        return { ok: false, reasonCode: "upstream_response_invalid" };
    }
    await input.request.client.end();
    return { ok: true };
}

function isWebSocketUpgrade(request: LocalServicePreviewWebSocketUpgradeRequest): boolean {
    return readHeader(request.headers, "upgrade")?.toLowerCase() === "websocket"
        && /(^|,\s*)upgrade(\s*,|$)/iu.test(readHeader(request.headers, "connection") ?? "");
}

function nextSocketId(previewId: string): string {
    nextSocketSequence += 1;
    return `${previewId}:ws:${nextSocketSequence}`;
}

export async function proxyLocalServicePreviewWebSocketUpgrade(
    input: ProxyLocalServicePreviewWebSocketUpgradeInput,
): Promise<ProxyLocalServicePreviewWebSocketUpgradeResult> {
    if (!isWebSocketUpgrade(input.request)) {
        await writeClientError(input.request.client, 400, "Bad Request");
        return { ok: false, reasonCode: "invalid_upgrade_request" };
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
        input.observability?.emit(createPeerMediationWebSocketEvent({
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
        }));
    }
    try {
        emitWebSocketLifecycle({ kind: "websocket.opened" });
        await tunnel.write(textEncoder.encode(serializeUpgradeRequest(input.preview, input.request)));
        const [clientToTunnel, tunnelToClient] = await Promise.allSettled([
            pumpClientToTunnel({
                preview: input.preview,
                request: input.request,
                tunnel,
            }),
            pumpTunnelToClient({
                preview: input.preview,
                request: input.request,
                tunnel,
            }),
        ]);

        const failedPump = [clientToTunnel, tunnelToClient].find((result) => (
            result.status === "fulfilled" && !result.value.ok
        ));
        if (failedPump?.status === "fulfilled" && !failedPump.value.ok) {
            emitWebSocketLifecycle({
                kind: "websocket.aborted",
                reasonCode: failedPump.value.reasonCode,
                durationMs: Math.max(0, nowMs() - startedAtMs),
            });
            return failedPump.value;
        }

        const rejectedPump = [clientToTunnel, tunnelToClient].find((result) => result.status === "rejected");
        if (rejectedPump?.status === "rejected") {
            input.request.client.destroy(rejectedPump.reason);
            await tunnel.abort("preview_websocket_adapter_error");
            emitWebSocketLifecycle({
                kind: "websocket.errored",
                reasonCode: "preview_websocket_adapter_error",
                durationMs: Math.max(0, nowMs() - startedAtMs),
            });
            return { ok: false, reasonCode: "upstream_stream_failed" };
        }

        emitWebSocketLifecycle({
            kind: "websocket.closed",
            durationMs: Math.max(0, nowMs() - startedAtMs),
        });
        return { ok: true };
    } catch (error) {
        input.request.client.destroy(error);
        await tunnel.abort("preview_websocket_adapter_error");
        emitWebSocketLifecycle({
            kind: "websocket.errored",
            reasonCode: "preview_websocket_adapter_error",
            durationMs: Math.max(0, nowMs() - startedAtMs),
        });
        return { ok: false, reasonCode: "upstream_stream_failed" };
    } finally {
        await tunnel.close();
    }
}
