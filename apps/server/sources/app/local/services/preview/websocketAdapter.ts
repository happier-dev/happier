import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

import type {
    LocalServicePreviewHttpHeaders,
    LocalServicePreviewTunnelStream,
    OpenLocalServicePreviewTunnel,
} from "@/app/local/services/preview/httpAdapter";
import { DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES } from "@/app/local/services/preview/limits";

const DEFAULT_PREVIEW_MAX_PROXY_HOPS = 5;
const PREVIEW_HOP_HEADER = "x-happier-preview-hops";
const HTTP_HEADER_TERMINATOR = "\r\n\r\n";
const textEncoder = new TextEncoder();
const headerTerminatorBytes = textEncoder.encode(HTTP_HEADER_TERMINATOR);

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
              | "upstream_stream_failed";
      }>;

export type ProxyLocalServicePreviewWebSocketUpgradeInput = Readonly<{
    preview: LocalServicePreviewResourceV1;
    request: LocalServicePreviewWebSocketUpgradeRequest;
    openTunnel: OpenLocalServicePreviewTunnel;
    maxProxyHops?: number;
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
        if (!handshakeComplete) {
            handshakeBuffer = concatBytes(handshakeBuffer, chunk);
            const headerEnd = findHeaderTerminator(handshakeBuffer);
            if (responseHeaderTooLarge(handshakeBuffer, headerEnd)) {
                await input.tunnel.abort("response_header_too_large");
                input.request.client.destroy(new Error("response_header_too_large"));
                return { ok: false, reasonCode: "response_header_too_large" };
            }
            if (headerEnd >= 0) {
                handshakeComplete = true;
                countedChunk = handshakeBuffer.subarray(headerEnd + headerTerminatorBytes.byteLength);
                handshakeBuffer = new Uint8Array();
            } else {
                countedChunk = new Uint8Array();
            }
        }
        responseBytes += countedChunk.byteLength;
        if (responseBytes > responseBodyLimit(input.preview)) {
            await input.tunnel.abort("response_body_too_large");
            input.request.client.destroy(new Error("response_body_too_large"));
            return { ok: false, reasonCode: "response_body_too_large" };
        }
        await input.request.client.write(chunk);
    }
    await input.request.client.end();
    return { ok: true };
}

function isWebSocketUpgrade(request: LocalServicePreviewWebSocketUpgradeRequest): boolean {
    return readHeader(request.headers, "upgrade")?.toLowerCase() === "websocket"
        && /(^|,\s*)upgrade(\s*,|$)/iu.test(readHeader(request.headers, "connection") ?? "");
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

    const tunnel = await input.openTunnel({ preview: input.preview });
    try {
        await tunnel.write(textEncoder.encode(serializeUpgradeRequest(input.preview, input.request)));
        const [clientToTunnel, tunnelToClient] = await Promise.all([
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

        if (!clientToTunnel.ok) return clientToTunnel;
        if (!tunnelToClient.ok) return tunnelToClient;
        return { ok: true };
    } catch (error) {
        input.request.client.destroy(error);
        await tunnel.abort("preview_websocket_adapter_error");
        return { ok: false, reasonCode: "upstream_stream_failed" };
    } finally {
        await tunnel.close();
    }
}
