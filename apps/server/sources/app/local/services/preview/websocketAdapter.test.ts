import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";

type WebSocketAdapterModule = typeof import("./websocketAdapter");

async function loadWebSocketAdapterModule(): Promise<WebSocketAdapterModule | null> {
    return import("./websocketAdapter.js").catch(() => null) as Promise<WebSocketAdapterModule | null>;
}

const preview: LocalServicePreviewResourceV1 = {
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    owner: { kind: "session", id: "session_1" },
    target: { scheme: "http", host: "127.0.0.1", port: 5173 },
    initialPath: { pathname: "/", search: "" },
    display: {
        title: "Vite App",
        addressLabel: "127.0.0.1:5173",
    },
    originMode: "path",
    policy: {
        allowedMethods: ["GET", "HEAD", "POST", "OPTIONS"],
        cookiePolicy: "drop",
        compressionPolicy: "identity",
        redirectPolicy: "rewrite_path_mode",
        maxRequestBodyBytes: 16,
        maxResponseBodyBytes: 64,
    },
};

async function* chunks(values: readonly string[]): AsyncIterable<Uint8Array> {
    for (const value of values) {
        yield new TextEncoder().encode(value);
    }
}

const VALID_WEBSOCKET_ACCEPT = "3JXE6q0TVDdbiIJlVyvPfGkLkho=";

function switchingProtocolsResponse(extraHeaders: readonly string[] = []): string {
    return [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${VALID_WEBSOCKET_ACCEPT}`,
        ...extraHeaders,
        "",
        "",
    ].join("\r\n");
}

function createClient(overrides: Partial<{
    headers: Record<string, string | readonly string[] | undefined>;
    rawHeaders: readonly string[];
    read: () => AsyncIterable<Uint8Array>;
}> = {}) {
    return {
        headers: overrides.headers ?? {
            host: "preview.example.test",
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "client-key",
            "sec-websocket-version": "13",
            "sec-websocket-protocol": "vite-hmr, custom",
            "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
        },
        rawHeaders: overrides.rawHeaders ?? [
            "Host", "preview.example.test",
            "Upgrade", "websocket",
            "Connection", "Upgrade",
            "Sec-WebSocket-Key", "client-key",
            "Sec-WebSocket-Version", "13",
            "Sec-WebSocket-Protocol", "vite-hmr, custom",
            "Sec-WebSocket-Extensions", "permessage-deflate; client_max_window_bits",
        ],
        head: new Uint8Array(),
        read: overrides.read ?? (() => chunks([])),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
    };
}

function previewTunnelIdentity() {
    return {
        tunnelId: "preview_tunnel_test",
        substreamId: "preview_substream_test",
    } as const;
}

async function flushAsyncWork(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

describe("local service preview WebSocket adapter", () => {
    it("preserves WebSocket subprotocol and extension headers through the PMS tunnel", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const tunnelWrites: string[] = [];
        const client = createClient();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/@vite/client",
                search: "?v=1",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: (bytes) => {
                    tunnelWrites.push(new TextDecoder().decode(bytes));
                },
                endWrite: vi.fn(),
                read: () => chunks([
                    switchingProtocolsResponse([
                        "Sec-WebSocket-Protocol: vite-hmr",
                        "Sec-WebSocket-Extensions: permessage-deflate",
                    ]),
                ]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(result).toEqual({ ok: true });
        expect(tunnelWrites.join("")).toContain("GET /@vite/client?v=1 HTTP/1.1\r\n");
        expect(tunnelWrites.join("")).toContain("Sec-WebSocket-Protocol: vite-hmr, custom\r\n");
        expect(tunnelWrites.join("")).toContain("Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n");
        expect(client.write).toHaveBeenCalledWith(expect.any(Uint8Array));
        expect(client.write.mock.calls.map((call) => new TextDecoder().decode(call[0])).join("")).toContain(
            "Sec-WebSocket-Protocol: vite-hmr\r\n",
        );
    });

    it("does not request additional tunnel response chunks until downstream WebSocket writes drain", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        let releaseFirstWrite: () => void = () => {
            throw new Error("first downstream WebSocket write promise was not created");
        };
        let secondTunnelChunkRequested = false;
        const client = createClient();
        client.write.mockImplementationOnce(() => new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
        }));

        const pending = mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/@vite/client",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: async function* () {
                    yield new TextEncoder().encode(`${switchingProtocolsResponse()}a`);
                    secondTunnelChunkRequested = true;
                    yield new TextEncoder().encode("b");
                },
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        await flushAsyncWork();
        expect(client.write).toHaveBeenCalledTimes(1);
        expect(secondTunnelChunkRequested).toBe(false);

        releaseFirstWrite();
        await expect(pending).resolves.toEqual({ ok: true });
        expect(secondTunnelChunkRequested).toBe(true);
        expect(client.write).toHaveBeenCalledTimes(2);
        expect(client.end).toHaveBeenCalled();
    });

    it("does not allow client-supplied forwarding headers to spoof preview WebSocket authority", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const tunnelWrites: string[] = [];
        const client = createClient({
            headers: {
                host: "preview.example.test",
                upgrade: "websocket",
                connection: "Upgrade",
                "sec-websocket-key": "client-key",
                "sec-websocket-version": "13",
                "x-happier-preview-hops": "1",
                forwarded: "for=198.51.100.10;host=attacker.example;proto=https",
                "x-forwarded-for": "198.51.100.10",
                "x-forwarded-host": "attacker.example",
                "x-forwarded-proto": "https",
                "x-forwarded-port": "443",
                "x-real-ip": "198.51.100.10",
            },
            rawHeaders: [
                "Host", "preview.example.test",
                "Upgrade", "websocket",
                "Connection", "Upgrade",
                "Sec-WebSocket-Key", "client-key",
                "Sec-WebSocket-Version", "13",
                "X-Happier-Preview-Hops", "1",
                "Forwarded", "for=198.51.100.10;host=attacker.example;proto=https",
                "X-Forwarded-For", "198.51.100.10",
                "X-Forwarded-Host", "attacker.example",
                "X-Forwarded-Proto", "https",
                "X-Forwarded-Port", "443",
                "X-Real-IP", "198.51.100.10",
            ],
        });

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: (bytes) => {
                    tunnelWrites.push(new TextDecoder().decode(bytes));
                },
                endWrite: vi.fn(),
                read: () => chunks([switchingProtocolsResponse()]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        const serialized = tunnelWrites.join("");
        expect(result).toEqual({ ok: true });
        expect(serialized).toContain("X-Forwarded-Host: preview.example.test\r\n");
        expect(serialized).toContain("X-Forwarded-Proto: http\r\n");
        expect(serialized).toContain("x-happier-preview-hops: 2\r\n");
        expect(serialized.match(/x-happier-preview-hops:/giu) ?? []).toHaveLength(1);
        expect(serialized).not.toContain("attacker.example");
        expect(serialized).not.toContain("198.51.100.10");
        expect(serialized).not.toContain("X-Forwarded-Port:");
        expect(serialized).not.toContain("X-Real-IP:");
        expect(serialized).not.toContain("Forwarded:");
    });

    it("treats an incomplete upstream WebSocket handshake as a failed upgrade", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const client = createClient();
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"]),
                close: vi.fn(),
                abort,
            }),
        });

        expect(result).toEqual({ ok: false, reasonCode: "upstream_response_invalid" });
        expect(abort).toHaveBeenCalledWith("upstream_response_invalid");
        expect(client.write).not.toHaveBeenCalled();
        expect(client.end).not.toHaveBeenCalled();
        expect(client.destroy).toHaveBeenCalled();
    });

    it("rejects upstream WebSocket handshakes that do not return switching protocols", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const client = createClient();
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"]),
                close: vi.fn(),
                abort,
            }),
        });

        expect(result).toEqual({ ok: false, reasonCode: "upstream_response_invalid" });
        expect(abort).toHaveBeenCalledWith("upstream_response_invalid");
        expect(client.write).not.toHaveBeenCalled();
        expect(client.end).not.toHaveBeenCalled();
        expect(client.destroy).toHaveBeenCalled();
    });

    it("rejects upstream WebSocket handshakes missing required upgrade headers", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        for (const response of [
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n",
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n",
        ]) {
            const client = createClient();
            const abort = vi.fn();

            const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
                preview,
                request: {
                    path: "/socket",
                    search: "",
                    headers: client.headers,
                    rawHeaders: client.rawHeaders,
                    head: client.head,
                    client,
                },
                openTunnel: async () => ({
                    ...previewTunnelIdentity(),
                    write: vi.fn(),
                    endWrite: vi.fn(),
                    read: () => chunks([response]),
                    close: vi.fn(),
                    abort,
                }),
            });

            expect(result).toEqual({ ok: false, reasonCode: "upstream_response_invalid" });
            expect(abort).toHaveBeenCalledWith("upstream_response_invalid");
            expect(client.write).not.toHaveBeenCalled();
            expect(client.end).not.toHaveBeenCalled();
            expect(client.destroy).toHaveBeenCalled();
        }
    });

    it("rejects upstream WebSocket handshakes with missing or incorrect accept headers", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        for (const response of [
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
        ]) {
            const client = createClient();
            const abort = vi.fn();

            const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
                preview,
                request: {
                    path: "/socket",
                    search: "",
                    headers: client.headers,
                    rawHeaders: client.rawHeaders,
                    head: client.head,
                    client,
                },
                openTunnel: async () => ({
                    ...previewTunnelIdentity(),
                    write: vi.fn(),
                    endWrite: vi.fn(),
                    read: () => chunks([response]),
                    close: vi.fn(),
                    abort,
                }),
            });

            expect(result).toEqual({ ok: false, reasonCode: "upstream_response_invalid" });
            expect(abort).toHaveBeenCalledWith("upstream_response_invalid");
            expect(client.write).not.toHaveBeenCalled();
            expect(client.end).not.toHaveBeenCalled();
            expect(client.destroy).toHaveBeenCalled();
        }
    });

    it("preserves invalid upstream handshake reason when downstream socket iteration throws after teardown", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        let destroyed = false;
        const emitted: unknown[] = [];
        const client = createClient({
            read: async function* () {
                while (!destroyed) {
                    await new Promise<void>((resolve) => {
                        setImmediate(resolve);
                    });
                }
                throw new Error("socket destroyed");
            },
        });
        client.destroy.mockImplementation(() => {
            destroyed = true;
        });
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"]),
                close: vi.fn(),
                abort,
            }),
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        expect(result).toEqual({ ok: false, reasonCode: "upstream_response_invalid" });
        expect(abort).toHaveBeenCalledWith("upstream_response_invalid");
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "websocket.aborted",
                data: expect.objectContaining({ reasonCode: "upstream_response_invalid" }),
            }),
        ]));
        expect(emitted).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "websocket.errored" }),
        ]));
    });

    it("accepts fragmented upstream WebSocket handshakes with mixed-case upgrade headers", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const client = createClient();
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    switchingProtocolsResponse([
                        "uPgRaDe: WebSocket",
                        "Connection: keep-alive, UpGrAdE",
                    ]),
                    "server-frame",
                ]),
                close: vi.fn(),
                abort,
            }),
        });

        expect(result).toEqual({ ok: true });
        expect(abort).not.toHaveBeenCalled();
        expect(client.write.mock.calls.map((call) => new TextDecoder().decode(call[0])).join("")).toContain("server-frame");
        expect(client.end).toHaveBeenCalled();
    });

    it("propagates client close to the upstream tunnel write side", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const endWrite = vi.fn();
        const client = createClient({
            read: () => chunks(["client-frame"]),
        });

        await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite,
                read: () => chunks([switchingProtocolsResponse()]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(endWrite).toHaveBeenCalled();
    });

    it("rejects preview proxy loops before opening a tunnel", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const client = createClient({
            headers: {
                host: "preview.example.test",
                upgrade: "websocket",
                connection: "Upgrade",
                "x-happier-preview-hops": "5",
            },
            rawHeaders: [
                "Host", "preview.example.test",
                "Upgrade", "websocket",
                "Connection", "Upgrade",
                "X-Happier-Preview-Hops", "5",
            ],
        });
        const openTunnel = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel,
            maxProxyHops: 5,
        });

        expect(result).toEqual({ ok: false, reasonCode: "preview_loop_detected" });
        expect(openTunnel).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(client.write.mock.calls[0]?.[0])).toContain("508 Loop Detected");
        expect(client.destroy).toHaveBeenCalled();
    });

    it("aborts both sides when client WebSocket bytes exceed the preview policy", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const client = createClient({
            read: () => chunks(["01234567890123456"]),
        });
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([switchingProtocolsResponse()]),
                close: vi.fn(),
                abort,
            }),
        });

        expect(result).toEqual({ ok: false, reasonCode: "request_body_too_large" });
        expect(abort).toHaveBeenCalledWith("request_body_too_large");
        expect(client.destroy).toHaveBeenCalled();
    });

    it("counts response WebSocket bytes after a split upgrade header terminator", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const responseLimitedPreview: LocalServicePreviewResourceV1 = {
            ...preview,
            policy: {
                ...preview.policy!,
                maxResponseBodyBytes: 3,
            },
        };
        const client = createClient();
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview: responseLimitedPreview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    `${switchingProtocolsResponse()}abcd`,
                ]),
                close: vi.fn(),
                abort,
            }),
        });

        expect(result).toEqual({ ok: false, reasonCode: "response_body_too_large" });
        expect(abort).toHaveBeenCalledWith("response_body_too_large");
        expect(client.destroy).toHaveBeenCalled();
    });

    it("aborts upstream WebSocket upgrades whose response header block exceeds the preview header cap", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const client = createClient();
        const abort = vi.fn();
        const oversizedHeader = `HTTP/1.1 101 Switching Protocols\r\nX-Oversized: ${"a".repeat(70 * 1024)}`;

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([oversizedHeader]),
                close: vi.fn(),
                abort,
            }),
        });

        expect(result).toEqual({ ok: false, reasonCode: "response_header_too_large" });
        expect(abort).toHaveBeenCalledWith("response_header_too_large");
        expect(client.destroy).toHaveBeenCalled();
    });

    it("emits redacted PMS observability websocket metadata without payload bytes", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const emitted: unknown[] = [];
        const client = createClient({
            headers: {
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-key": "client-key",
                "sec-websocket-version": "13",
                authorization: "Bearer raw-session-token",
                cookie: "happier_preview_token=raw-preview-token",
            },
            rawHeaders: [
                "Connection", "Upgrade",
                "Upgrade", "websocket",
                "Sec-WebSocket-Key", "client-key",
                "Sec-WebSocket-Version", "13",
                "Sec-WebSocket-Protocol", "vite-hmr, bearer.raw-secret-subprotocol",
                "Authorization", "Bearer raw-session-token",
                "Cookie", "happier_preview_token=raw-preview-token",
            ],
            read: () => chunks(["secret-client"]),
        });

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/hmr",
                search: "?previewToken=raw-preview-token&ok=1",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                tunnelId: "preview_tunnel_1",
                substreamId: "preview_substream_1",
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    switchingProtocolsResponse(["Sec-WebSocket-Protocol: vite-hmr"]),
                    "secret-server-frame",
                ]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        expect(result).toEqual({ ok: true });
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "websocket.opened" }),
            expect.objectContaining({ kind: "websocket.closed" }),
        ]));
        const serialized = JSON.stringify(emitted);
        expect(serialized).not.toContain("raw-preview-token");
        expect(serialized).not.toContain("raw-session-token");
        expect(serialized).not.toContain("raw-secret-subprotocol");
        expect(serialized).not.toContain("secret-client");
        expect(serialized).not.toContain("secret-server-frame");
        expect(serialized).toContain("\"path\":\"/hmr\"");
        expect(serialized).not.toContain("vite-hmr");
        expect(serialized).toContain("\"subprotocolCount\":2");
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                flow: expect.objectContaining({
                    flowId: "preview_tunnel_1",
                    tunnelId: "preview_tunnel_1",
                    substreamId: "preview_substream_1",
                }),
                data: expect.objectContaining({
                    socketId: expect.stringContaining(`${preview.previewId}:ws:`),
                }),
            }),
        ]));
    });

    it("emits PMS observability aborted lifecycle when the upstream WebSocket handshake fails", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const emitted: unknown[] = [];
        const client = createClient();
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/hmr",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                tunnelId: "preview_tunnel_1",
                substreamId: "preview_substream_1",
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"]),
                close: vi.fn(),
                abort,
            }),
            observability: {
                emit: (event) => emitted.push(event),
            },
            nowMs: () => 2_000,
        });

        expect(result).toEqual({ ok: false, reasonCode: "upstream_response_invalid" });
        expect(abort).toHaveBeenCalledWith("upstream_response_invalid");
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "websocket.opened" }),
            expect.objectContaining({
                kind: "websocket.aborted",
                data: expect.objectContaining({
                    reasonCode: "upstream_response_invalid",
                    socketId: expect.stringContaining(`${preview.previewId}:ws:`),
                }),
            }),
        ]));
        expect(emitted).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "websocket.closed" }),
        ]));
    });

    it("emits PMS observability errored lifecycle when the WebSocket adapter throws", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const emitted: unknown[] = [];
        const client = createClient();
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/hmr",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: async () => ({
                tunnelId: "preview_tunnel_1",
                substreamId: "preview_substream_1",
                write: vi.fn(() => {
                    throw new Error("write failed");
                }),
                endWrite: vi.fn(),
                read: () => chunks([switchingProtocolsResponse()]),
                close: vi.fn(),
                abort,
            }),
            observability: {
                emit: (event) => emitted.push(event),
            },
            nowMs: () => 2_000,
        });

        expect(result).toEqual({ ok: false, reasonCode: "upstream_stream_failed" });
        expect(abort).toHaveBeenCalledWith("preview_websocket_adapter_error");
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "websocket.opened" }),
            expect.objectContaining({
                kind: "websocket.errored",
                data: expect.objectContaining({
                    reasonCode: "preview_websocket_adapter_error",
                    socketId: expect.stringContaining(`${preview.previewId}:ws:`),
                }),
            }),
        ]));
        expect(emitted).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "websocket.closed" }),
        ]));
    });

    // S-1 backstop. The upgrade routes derive the path from `URL.pathname`, which is canonical by
    // construction, so this guard exists for any OTHER caller. Removing it must make this fail.
    it("refuses to serialize an upgrade request whose target carries a raw CRLF", async () => {
        const mod = await loadWebSocketAdapterModule();
        expect(mod?.proxyLocalServicePreviewWebSocketUpgrade).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewWebSocketUpgrade) return;

        const tunnelWrites: string[] = [];
        const client = createClient();
        const openTunnel = vi.fn();

        const result = await mod.proxyLocalServicePreviewWebSocketUpgrade({
            preview,
            request: {
                path: "/socket\r\nX-Injected: yes\r\n\r\nGET /admin HTTP/1.1",
                search: "",
                headers: client.headers,
                rawHeaders: client.rawHeaders,
                head: client.head,
                client,
            },
            openTunnel: openTunnel as never,
        });

        expect(result).toEqual({ ok: false, reasonCode: "invalid_request_target" });
        // No tunnel is opened at all, so nothing can reach the user's service.
        expect(openTunnel).not.toHaveBeenCalled();
        expect(tunnelWrites).toEqual([]);
        expect(new TextDecoder().decode(client.write.mock.calls[0]?.[0])).toContain("400 Bad Request");
    });
});
