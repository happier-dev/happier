import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

import { DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES } from "@/app/local/services/preview/limits";

const DEFAULT_PREVIEW_MAX_PROXY_HOPS = 5;
const PREVIEW_HOP_HEADER = "x-happier-preview-hops";
const HTTP_HEADER_TERMINATOR = "\r\n\r\n";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type LocalServicePreviewHttpHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export type LocalServicePreviewHttpRequest = Readonly<{
    method: string;
    path: string;
    search: string;
    headers: LocalServicePreviewHttpHeaders;
    body?: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
}>;

export type LocalServicePreviewHttpResponseSink = Readonly<{
    writeHead(statusCode: number, statusMessage: string, headers: Readonly<Record<string, string>>): void;
    write(chunk: Uint8Array): void | Promise<void>;
    end(): void | Promise<void>;
    destroy(error?: unknown): void;
}>;

export type LocalServicePreviewTunnelStream = Readonly<{
    write(chunk: Uint8Array): void | Promise<void>;
    endWrite(): void | Promise<void>;
    read(): AsyncIterable<Uint8Array>;
    close(): void | Promise<void>;
    abort(reasonCode: string): void | Promise<void>;
}>;

export type OpenLocalServicePreviewTunnel = (input: Readonly<{
    preview: LocalServicePreviewResourceV1;
}>) => Promise<LocalServicePreviewTunnelStream>;

export type ProxyLocalServicePreviewHttpRequestResult =
    | Readonly<{ ok: true }>
    | Readonly<{
          ok: false;
          reasonCode:
              | "method_not_allowed"
              | "preview_loop_detected"
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
}>;

type ParsedHeaderBlock = Readonly<{
    statusCode: number;
    statusMessage: string;
    headers: Readonly<Record<string, string>>;
    bodyStart: Uint8Array<ArrayBufferLike>;
}>;

type WriteRequestResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: "client_aborted" | "request_body_too_large" }>;

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

function isMethodAllowed(preview: LocalServicePreviewResourceV1, method: string): boolean {
    const normalized = method.toUpperCase();
    const allowed = preview.policy?.allowedMethods ?? ["GET", "HEAD", "OPTIONS"];
    return allowed.includes(normalized as (typeof allowed)[number]);
}

function requestBodyLimit(preview: LocalServicePreviewResourceV1): number {
    return preview.policy?.maxRequestBodyBytes ?? Number.MAX_SAFE_INTEGER;
}

function responseBodyLimit(preview: LocalServicePreviewResourceV1): number {
    return preview.policy?.maxResponseBodyBytes ?? Number.MAX_SAFE_INTEGER;
}

function contentLengthExceedsLimit(preview: LocalServicePreviewResourceV1, request: LocalServicePreviewHttpRequest): boolean {
    const raw = readHeader(request.headers, "content-length");
    if (!raw) return false;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > requestBodyLimit(preview);
}

function requestTargetPath(request: LocalServicePreviewHttpRequest): string {
    const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
    return `${path}${request.search.startsWith("?") ? request.search : ""}`;
}

function shouldForwardRequestHeader(name: string): boolean {
    const normalized = headerName(name);
    return ![
        "accept-encoding",
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

function formatForwardedHeaderName(name: string): string {
    return name
        .split("-")
        .filter((part) => part.length > 0)
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
        .join("-");
}

function serializeRequestHeaders(preview: LocalServicePreviewResourceV1, request: LocalServicePreviewHttpRequest): string {
    const lines = [
        `${request.method.toUpperCase()} ${requestTargetPath(request)} HTTP/1.1`,
        `Host: ${preview.target.host}:${preview.target.port}`,
        "Connection: close",
        "Accept-Encoding: identity",
        `${PREVIEW_HOP_HEADER}: ${parseProxyHopCount(request.headers) + 1}`,
    ];

    const forwardedHost = readHeader(request.headers, "host");
    if (forwardedHost) {
        lines.push(`X-Forwarded-Host: ${forwardedHost}`);
    }
    lines.push(`X-Forwarded-Proto: ${preview.target.scheme}`);

    for (const [name, value] of Object.entries(request.headers)) {
        if (!shouldForwardRequestHeader(name)) continue;
        for (const item of headerValues(value)) {
            lines.push(`${formatForwardedHeaderName(name)}: ${item}`);
        }
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
    const marker = textEncoder.encode(HTTP_HEADER_TERMINATOR);
    for (let index = 0; index <= buffer.byteLength - marker.byteLength; index += 1) {
        if (marker.every((byte, markerIndex) => buffer[index + markerIndex] === byte)) {
            return index;
        }
    }
    return -1;
}

function parseHeaderBlock(buffer: Uint8Array): ParsedHeaderBlock | null {
    const headerEnd = findHeaderTerminator(buffer);
    if (headerEnd < 0) return null;

    const headerText = textDecoder.decode(buffer.subarray(0, headerEnd));
    const [statusLine, ...headerLines] = headerText.split("\r\n");
    const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/u.exec(statusLine ?? "");
    if (!match) return null;

    const headers: Record<string, string> = {};
    for (const line of headerLines) {
        const separator = line.indexOf(":");
        if (separator <= 0) continue;
        const name = headerName(line.slice(0, separator));
        const value = line.slice(separator + 1).trim();
        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }

    return {
        statusCode: Number.parseInt(match[1]!, 10),
        statusMessage: match[2]?.trim() || "",
        headers,
        bodyStart: buffer.subarray(headerEnd + HTTP_HEADER_TERMINATOR.length),
    };
}

function responseHeaderTooLarge(buffer: Uint8Array): boolean {
    const headerEnd = findHeaderTerminator(buffer);
    if (headerEnd >= 0) {
        return headerEnd > DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES;
    }
    return buffer.byteLength > DEFAULT_PREVIEW_MAX_RESPONSE_HEADER_BYTES;
}

function responseHeadersForPreview(
    _preview: LocalServicePreviewResourceV1,
    headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (name === "connection" || name === "transfer-encoding") continue;
        if (name === "set-cookie") continue;
        out[name] = value;
    }
    return out;
}

async function writeRequest(input: Readonly<{
    preview: LocalServicePreviewResourceV1;
    request: LocalServicePreviewHttpRequest;
    tunnel: LocalServicePreviewTunnelStream;
}>): Promise<WriteRequestResult> {
    await input.tunnel.write(textEncoder.encode(serializeRequestHeaders(input.preview, input.request)));
    let requestBodyBytes = 0;
    for await (const chunk of input.request.body ?? []) {
        if (input.request.signal?.aborted) {
            await input.tunnel.abort("client_aborted");
            return { ok: false, reasonCode: "client_aborted" };
        }
        requestBodyBytes += chunk.byteLength;
        if (requestBodyBytes > requestBodyLimit(input.preview)) {
            await input.tunnel.abort("request_body_too_large");
            return { ok: false, reasonCode: "request_body_too_large" };
        }
        await input.tunnel.write(chunk);
    }
    await input.tunnel.endWrite();
    return { ok: true };
}

async function forwardResponse(input: Readonly<{
    preview: LocalServicePreviewResourceV1;
    request: LocalServicePreviewHttpRequest;
    response: LocalServicePreviewHttpResponseSink;
    tunnel: LocalServicePreviewTunnelStream;
}>): Promise<ProxyLocalServicePreviewHttpRequestResult> {
    let parsed: ParsedHeaderBlock | null = null;
    let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let responseBodyBytes = 0;
    async function writeBody(chunk: Uint8Array<ArrayBufferLike>): Promise<boolean> {
        if (input.request.method.toUpperCase() === "HEAD" || chunk.byteLength === 0) {
            return true;
        }
        responseBodyBytes += chunk.byteLength;
        if (responseBodyBytes > responseBodyLimit(input.preview)) {
            await input.tunnel.abort("response_body_too_large");
            input.response.destroy(new Error("response_body_too_large"));
            return false;
        }
        await input.response.write(chunk);
        return true;
    }

    for await (const chunk of input.tunnel.read()) {
        if (input.request.signal?.aborted) {
            await input.tunnel.abort("client_aborted");
            return { ok: false, reasonCode: "upstream_stream_failed" };
        }

        if (!parsed) {
            buffered = concatBytes(buffered, chunk);
            if (responseHeaderTooLarge(buffered)) {
                await input.tunnel.abort("response_header_too_large");
                input.response.destroy(new Error("response_header_too_large"));
                return { ok: false, reasonCode: "response_header_too_large" };
            }
            parsed = parseHeaderBlock(buffered);
            if (!parsed) continue;
            input.response.writeHead(
                parsed.statusCode,
                parsed.statusMessage,
                responseHeadersForPreview(input.preview, parsed.headers),
            );
            if (!(await writeBody(parsed.bodyStart))) {
                return { ok: false, reasonCode: "response_body_too_large" };
            }
            continue;
        }

        if (!(await writeBody(chunk))) {
            return { ok: false, reasonCode: "response_body_too_large" };
        }
    }

    if (!parsed) {
        input.response.writeHead(502, "Bad Gateway", {});
        await input.response.end();
        return { ok: false, reasonCode: "upstream_response_invalid" };
    }

    await input.response.end();
    return { ok: true };
}

export async function proxyLocalServicePreviewHttpRequest(
    input: ProxyLocalServicePreviewHttpRequestInput,
): Promise<ProxyLocalServicePreviewHttpRequestResult> {
    if (!isMethodAllowed(input.preview, input.request.method)) {
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

    const tunnel = await input.openTunnel({ preview: input.preview });
    try {
        const writeResult = await writeRequest({
            preview: input.preview,
            request: input.request,
            tunnel,
        });
        if (!writeResult.ok) {
            if (writeResult.reasonCode === "request_body_too_large") {
                input.response.writeHead(413, "Payload Too Large", {});
                await input.response.end();
                return { ok: false, reasonCode: "request_body_too_large" };
            }
            input.response.destroy(new Error(writeResult.reasonCode));
            return { ok: false, reasonCode: "upstream_stream_failed" };
        }
        return await forwardResponse({
            preview: input.preview,
            request: input.request,
            response: input.response,
            tunnel,
        });
    } catch (error) {
        input.response.destroy(error);
        await tunnel.abort("preview_adapter_error");
        return { ok: false, reasonCode: "upstream_stream_failed" };
    } finally {
        await tunnel.close();
    }
}
