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
                write: (bytes) => {
                    tunnelWrites.push(new TextDecoder().decode(bytes));
                },
                endWrite: vi.fn(),
                read: () => chunks([
                    "HTTP/1.1 101 Switching Protocols\r\n",
                    "Upgrade: websocket\r\n",
                    "Connection: Upgrade\r\n",
                    "Sec-WebSocket-Protocol: vite-hmr\r\n",
                    "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n",
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
                write: vi.fn(),
                endWrite,
                read: () => chunks(["HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"]),
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
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"]),
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
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n",
                    "\r\n",
                    "abcd",
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
});
