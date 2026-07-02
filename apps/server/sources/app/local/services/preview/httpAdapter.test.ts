import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";

type HttpAdapterModule = typeof import("./httpAdapter");

async function loadHttpAdapterModule(): Promise<HttpAdapterModule | null> {
    return import("./httpAdapter.js").catch(() => null) as Promise<HttpAdapterModule | null>;
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
        maxRequestBodyBytes: 1024 * 1024,
        maxResponseBodyBytes: 1024 * 1024,
    },
};

async function* chunks(values: readonly string[]): AsyncIterable<Uint8Array> {
    for (const value of values) {
        yield new TextEncoder().encode(value);
    }
}

function createSink() {
    return {
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
    };
}

describe("local service preview HTTP adapter", () => {
    it("streams a request over a PMS tunnel and preserves upstream range responses", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const writes: string[] = [];
        const sink = createSink();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/assets/app.js",
                search: "?v=1",
                headers: {
                    range: "bytes=0-3",
                    host: "preview.example.test",
                    "accept-encoding": "br,gzip",
                },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                write: (bytes) => {
                    writes.push(new TextDecoder().decode(bytes));
                },
                endWrite: vi.fn(),
                read: () => chunks([
                    "HTTP/1.1 206 Partial Content\r\n",
                    "Content-Type: application/javascript\r\nContent-Range: bytes 0-3/10\r\n",
                    "Set-Cookie: sid=upstream; Path=/\r\n\r\n",
                    "abcd",
                ]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(result).toEqual({ ok: true });
        expect(writes.join("")).toContain("GET /assets/app.js?v=1 HTTP/1.1\r\n");
        expect(writes.join("")).toContain("Range: bytes=0-3\r\n");
        expect(writes.join("")).toContain("Accept-Encoding: identity\r\n");
        expect(writes.join("")).toContain("X-Forwarded-Host: preview.example.test\r\n");
        expect(sink.writeHead).toHaveBeenCalledWith(206, "Partial Content", expect.objectContaining({
            "content-range": "bytes 0-3/10",
            "content-type": "application/javascript",
        }));
        expect(JSON.stringify(sink.writeHead.mock.calls[0]?.[2])).not.toContain("set-cookie");
        expect(sink.write).toHaveBeenCalledWith(new TextEncoder().encode("abcd"));
        expect(sink.end).toHaveBeenCalled();
    });

    it("does not forward preview credentials to the upstream local service", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const writes: string[] = [];
        const sink = createSink();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/",
                search: "",
                headers: {
                    authorization: "Bearer server-session-token",
                    cookie: "happier_preview_token=preview-token; app_session=app-token",
                    host: "preview.example.test",
                },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                write: (bytes) => {
                    writes.push(new TextDecoder().decode(bytes));
                },
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nok"]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(result).toEqual({ ok: true });
        expect(writes.join("")).not.toContain("Authorization:");
        expect(writes.join("")).not.toContain("Cookie:");
        expect(writes.join("")).not.toContain("preview-token");
        expect(writes.join("")).not.toContain("server-session-token");
    });

    it("does not forward a response body for HEAD", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sink = createSink();
        await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "HEAD",
                path: "/",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(sink.writeHead).toHaveBeenCalledWith(200, "OK", expect.objectContaining({
            "content-length": "5",
        }));
        expect(sink.write).not.toHaveBeenCalled();
        expect(sink.end).toHaveBeenCalled();
    });

    it("allows OPTIONS preflight by default when no explicit method policy is present", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const defaultPolicyPreview: LocalServicePreviewResourceV1 = {
            ...preview,
            policy: undefined,
        };
        const sink = createSink();
        const writes: string[] = [];

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview: defaultPolicyPreview,
            request: {
                method: "OPTIONS",
                path: "/api/data",
                search: "",
                headers: {
                    origin: "https://app.happier.test",
                    "access-control-request-method": "PUT",
                },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                write: (bytes) => {
                    writes.push(new TextDecoder().decode(bytes));
                },
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Methods: PUT\r\n\r\n"]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(result).toEqual({ ok: true });
        expect(writes.join("")).toContain("OPTIONS /api/data HTTP/1.1\r\n");
        expect(sink.writeHead).toHaveBeenCalledWith(204, "No Content", expect.objectContaining({
            "access-control-allow-methods": "PUT",
        }));
    });

    it("drops upstream cookies when rewrite semantics are not implemented", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const rewriteCookiePreview: LocalServicePreviewResourceV1 = {
            ...preview,
            policy: {
                ...preview.policy!,
                cookiePolicy: "rewrite",
            },
        };
        const sink = createSink();

        await mod.proxyLocalServicePreviewHttpRequest({
            preview: rewriteCookiePreview,
            request: {
                method: "GET",
                path: "/",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nSet-Cookie: sid=raw; Path=/\r\nContent-Type: text/html\r\n\r\n"]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(JSON.stringify(sink.writeHead.mock.calls[0]?.[2])).not.toContain("set-cookie");
    });

    it("rejects request bodies that exceed the preview policy before opening a tunnel", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sizeLimitedPreview: LocalServicePreviewResourceV1 = {
            ...preview,
            policy: {
                ...preview.policy!,
                maxRequestBodyBytes: 4,
            },
        };
        const sink = createSink();
        const openTunnel = vi.fn();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview: sizeLimitedPreview,
            request: {
                method: "POST",
                path: "/submit",
                search: "",
                headers: { "content-length": "5" },
                body: chunks(["hello"]),
            },
            response: sink,
            openTunnel,
        });

        expect(result).toEqual({ ok: false, reasonCode: "request_body_too_large" });
        expect(openTunnel).not.toHaveBeenCalled();
        expect(sink.writeHead).toHaveBeenCalledWith(413, "Payload Too Large", expect.any(Object));
        expect(sink.end).toHaveBeenCalled();
    });

    it("aborts upstream response streams that exceed the preview policy", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sizeLimitedPreview: LocalServicePreviewResourceV1 = {
            ...preview,
            policy: {
                ...preview.policy!,
                maxResponseBodyBytes: 3,
            },
        };
        const sink = createSink();
        const abort = vi.fn();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview: sizeLimitedPreview,
            request: {
                method: "GET",
                path: "/large",
                search: "",
                headers: {},
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nabcd"]),
                close: vi.fn(),
                abort,
            }),
        });

        expect(result).toEqual({ ok: false, reasonCode: "response_body_too_large" });
        expect(abort).toHaveBeenCalledWith("response_body_too_large");
        expect(sink.write).not.toHaveBeenCalled();
        expect(sink.destroy).toHaveBeenCalled();
    });

    it("aborts upstream responses whose header block exceeds the preview header cap", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sink = createSink();
        const abort = vi.fn();
        const oversizedHeader = `HTTP/1.1 200 OK\r\nX-Oversized: ${"a".repeat(70 * 1024)}`;

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/large-header",
                search: "",
                headers: {},
                body: chunks([]),
            },
            response: sink,
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
        expect(sink.writeHead).not.toHaveBeenCalled();
        expect(sink.destroy).toHaveBeenCalled();
    });

    it("rejects preview proxy loops before opening a tunnel", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sink = createSink();
        const openTunnel = vi.fn();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/",
                search: "",
                headers: {
                    host: "preview.example.test",
                    "x-happier-preview-hops": "5",
                },
                body: chunks([]),
            },
            response: sink,
            openTunnel,
            maxProxyHops: 5,
        });

        expect(result).toEqual({ ok: false, reasonCode: "preview_loop_detected" });
        expect(openTunnel).not.toHaveBeenCalled();
        expect(sink.writeHead).toHaveBeenCalledWith(508, "Loop Detected", expect.any(Object));
        expect(sink.end).toHaveBeenCalled();
    });
});
