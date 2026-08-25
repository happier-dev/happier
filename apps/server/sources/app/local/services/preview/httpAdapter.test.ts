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
                ...previewTunnelIdentity(),
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

    it("does not request additional tunnel response chunks until downstream HTTP writes drain", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        let releaseFirstWrite: () => void = () => {
            throw new Error("first downstream write promise was not created");
        };
        let secondTunnelChunkRequested = false;
        const sink = createSink();
        sink.write.mockImplementationOnce(() => new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
        }));

        const pending = mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/stream",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: async function* () {
                    yield new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\na");
                    secondTunnelChunkRequested = true;
                    yield new TextEncoder().encode("b");
                },
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        await flushAsyncWork();
        expect(sink.write).toHaveBeenCalledTimes(1);
        expect(secondTunnelChunkRequested).toBe(false);

        releaseFirstWrite();
        await expect(pending).resolves.toEqual({ ok: true });
        expect(secondTunnelChunkRequested).toBe(true);
        expect(sink.write).toHaveBeenCalledTimes(2);
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
                ...previewTunnelIdentity(),
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

    it("does not allow client-supplied forwarding headers to spoof preview authority", async () => {
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
                    host: "preview.example.test",
                    "x-happier-preview-hops": "1",
                    forwarded: "for=198.51.100.10;host=attacker.example;proto=https",
                    "x-forwarded-for": "198.51.100.10",
                    "x-forwarded-host": "attacker.example",
                    "x-forwarded-proto": "https",
                    "x-forwarded-port": "443",
                    "x-real-ip": "198.51.100.10",
                },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: (bytes) => {
                    writes.push(new TextDecoder().decode(bytes));
                },
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nok"]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        const serialized = writes.join("");
        expect(result).toEqual({ ok: true });
        expect(serialized).toContain("X-Forwarded-Host: preview.example.test\r\n");
        expect(serialized).toContain("X-Forwarded-Proto: http\r\n");
        expect(serialized).toContain("x-happier-preview-hops: 2\r\n");
        expect(serialized.match(/x-happier-preview-hops:/giu) ?? []).toHaveLength(1);
        expect(serialized).not.toContain("attacker.example");
        expect(serialized).not.toContain("198.51.100.10");
        expect(serialized).not.toContain("X-Forwarded-Port:");
        expect(serialized).not.toContain("X-Real-Ip:");
        expect(serialized).not.toContain("Forwarded:");
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
                ...previewTunnelIdentity(),
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
                ...previewTunnelIdentity(),
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

    it("isolates upstream cookies to the preview route when the policy requests isolation", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const isolateCookiePreview: LocalServicePreviewResourceV1 = {
            ...preview,
            policy: {
                ...preview.policy!,
                cookiePolicy: "isolate",
            },
        };
        const sink = createSink();

        await mod.proxyLocalServicePreviewHttpRequest({
            preview: isolateCookiePreview,
            request: {
                method: "GET",
                path: "/dashboard",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    "HTTP/1.1 200 OK\r\n",
                    "Set-Cookie: sid=raw; Domain=localhost; Path=/api; SameSite=None; HttpOnly\r\n",
                    "Content-Type: text/html\r\n\r\n",
                ]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(sink.writeHead).toHaveBeenCalledWith(200, "OK", expect.objectContaining({
            "set-cookie": "sid=raw; Path=/v1/local-services/preview/preview_1/; SameSite=Lax; HttpOnly",
        }));
        expect(JSON.stringify(sink.writeHead.mock.calls[0]?.[2])).not.toContain("Domain=");
        expect(JSON.stringify(sink.writeHead.mock.calls[0]?.[2])).not.toContain("SameSite=None");
    });

    it("rewrites upstream cookie paths under the path-mode preview route", async () => {
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
                path: "/api/session",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    "HTTP/1.1 200 OK\r\n",
                    "Set-Cookie: sid=raw; Domain=localhost; Path=/api; Secure\r\n",
                    "Content-Type: text/html\r\n\r\n",
                ]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(sink.writeHead).toHaveBeenCalledWith(200, "OK", expect.objectContaining({
            "set-cookie": "sid=raw; Path=/v1/local-services/preview/preview_1/api; SameSite=Lax; Secure",
        }));
        expect(JSON.stringify(sink.writeHead.mock.calls[0]?.[2])).not.toContain("Domain=");
    });

    it("rewrites multiple upstream set-cookie headers without comma-collapsing cookies", async () => {
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
                path: "/api/session",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    "HTTP/1.1 200 OK\r\n",
                    "Set-Cookie: sid=raw; Domain=localhost; Path=/api; HttpOnly\r\n",
                    "Set-Cookie: theme=dark; Path=/prefs; Secure\r\n",
                    "Content-Type: text/html\r\n\r\n",
                ]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(sink.writeHead).toHaveBeenCalledWith(200, "OK", expect.objectContaining({
            "set-cookie": [
                "sid=raw; Path=/v1/local-services/preview/preview_1/api; SameSite=Lax; HttpOnly",
                "theme=dark; Path=/v1/local-services/preview/preview_1/prefs; SameSite=Lax; Secure",
            ],
        }));
        expect(JSON.stringify(sink.writeHead.mock.calls[0]?.[2])).not.toContain("Domain=");
    });

    it("rewrites same-local-service redirect locations into path-mode preview URLs", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sink = createSink();

        await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/dashboard",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    "HTTP/1.1 302 Found\r\n",
                    "Location: http://127.0.0.1:5173/login?next=%2Fdashboard\r\n",
                    "Content-Type: text/plain\r\n\r\n",
                ]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(sink.writeHead).toHaveBeenCalledWith(302, "Found", expect.objectContaining({
            location: "/v1/local-services/preview/preview_1/login?next=%2Fdashboard",
        }));
    });

    it("preserves external redirect locations even when path-mode redirect rewriting is enabled", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sink = createSink();

        await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/oauth/start",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks([
                    "HTTP/1.1 302 Found\r\n",
                    "Location: https://auth.example.test/oauth/authorize\r\n",
                    "Content-Type: text/plain\r\n\r\n",
                ]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(sink.writeHead).toHaveBeenCalledWith(302, "Found", expect.objectContaining({
            location: "https://auth.example.test/oauth/authorize",
        }));
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
                ...previewTunnelIdentity(),
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

    it("emits redacted PMS observability request metadata without credentials or bodies", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const emitted: unknown[] = [];
        const sink = createSink();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "POST",
                path: "/submit",
                search: "?previewToken=raw-preview-token&ok=1",
                headers: {
                    authorization: "Bearer raw-session-token",
                    cookie: "happier_preview_token=raw-preview-token",
                    "content-type": "application/json",
                },
                body: chunks(["{\"secret\":\"body-secret\"}"]),
            },
            response: sink,
            openTunnel: async () => ({
                tunnelId: "preview_tunnel_1",
                substreamId: "preview_substream_1",
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}"]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        expect(result).toEqual({ ok: true });
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "http.request.started" }),
            expect.objectContaining({ kind: "http.request.finished" }),
        ]));
        const serialized = JSON.stringify(emitted);
        expect(serialized).not.toContain("raw-preview-token");
        expect(serialized).not.toContain("raw-session-token");
        expect(serialized).not.toContain("body-secret");
        expect(serialized).toContain("\"path\":\"/submit\"");
        expect(serialized).toContain("\"statusCode\":201");
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                flow: expect.objectContaining({
                    flowId: "preview_tunnel_1",
                    tunnelId: "preview_tunnel_1",
                    substreamId: "preview_substream_1",
                }),
                data: expect.objectContaining({
                    requestId: expect.stringContaining(`${preview.previewId}:http:`),
                }),
            }),
        ]));
    });

    it("emits PMS observability abort events for client-aborted HTTP flows", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const emitted: unknown[] = [];
        const sink = createSink();
        const abort = vi.fn();
        const controller = new AbortController();
        controller.abort();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "POST",
                path: "/submit",
                search: "",
                headers: { "content-type": "application/json" },
                body: chunks(["{\"ok\":true}"]),
                signal: controller.signal,
            },
            response: sink,
            openTunnel: async () => ({
                tunnelId: "preview_tunnel_1",
                substreamId: "preview_substream_1",
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nok"]),
                close: vi.fn(),
                abort,
            }),
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        expect(result).toEqual({ ok: false, reasonCode: "upstream_stream_failed" });
        expect(abort).toHaveBeenCalledWith("client_aborted");
        expect(sink.destroy).toHaveBeenCalled();
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "http.request.started" }),
            expect.objectContaining({
                kind: "http.request.aborted",
                data: expect.objectContaining({
                    reasonCode: "client_aborted",
                    requestId: expect.stringContaining(`${preview.previewId}:http:`),
                }),
            }),
        ]));
        expect(emitted).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "http.request.finished" }),
        ]));
    });

    // S-1 backstop. Every route entry point re-encodes the router-decoded wildcard before it gets
    // here, so this guard protects any OTHER caller. Removing it must make this fail.
    it("refuses to serialize a request whose target carries a raw CRLF", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sink = createSink();
        const openTunnel = vi.fn();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/index.html\r\nX-Injected: yes\r\n\r\nGET /admin HTTP/1.1",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: openTunnel as never,
        });

        expect(result).toEqual({ ok: false, reasonCode: "invalid_request_target" });
        // No tunnel is opened at all, so nothing can reach the user's service.
        expect(openTunnel).not.toHaveBeenCalled();
        expect(sink.writeHead).toHaveBeenCalledWith(400, "Bad Request", {});
    });

    // S-1 neighbouring case: a header value carrying a bare CRLF is dropped, never emitted.
    it("drops a forwarded header value that carries a raw CRLF instead of splitting the request", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const writes: string[] = [];
        const sink = createSink();

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/index.html",
                search: "",
                headers: {
                    host: "preview.example.test",
                    "x-custom": "fine",
                    "x-evil": "a\r\nX-Injected: yes",
                },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => ({
                ...previewTunnelIdentity(),
                write: (bytes: Uint8Array) => {
                    writes.push(new TextDecoder().decode(bytes));
                },
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"]),
                close: vi.fn(),
                abort: vi.fn(),
            }),
        });

        expect(result).toEqual({ ok: true });
        const upstream = writes.join("");
        expect(upstream).toContain("X-Custom: fine\r\n");
        expect(upstream).not.toContain("X-Injected");
        expect(upstream.split("\r\n\r\n")).toHaveLength(2);
    });

    it("classifies a tunnel that cannot be opened as a typed 503 instead of throwing an unhandled error", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const sink = createSink();
        const bodyWrites: string[] = [];
        sink.write.mockImplementation((chunk: Uint8Array) => {
            bodyWrites.push(new TextDecoder().decode(chunk));
        });

        const result = await mod.proxyLocalServicePreviewHttpRequest({
            preview,
            request: {
                method: "GET",
                path: "/index.html",
                search: "",
                headers: { host: "preview.example.test" },
                body: chunks([]),
            },
            response: sink,
            openTunnel: async () => {
                throw Object.assign(
                    new Error("local_service_preview_tunnel_unavailable:grant_signing_unavailable"),
                    { reasonCode: "grant_signing_unavailable" },
                );
            },
        });

        expect(result).toEqual({ ok: false, reasonCode: "preview_tunnel_unavailable" });
        expect(sink.writeHead).toHaveBeenCalledWith(503, "Service Unavailable", expect.objectContaining({
            "content-type": "application/json; charset=utf-8",
        }));
        expect(JSON.parse(bodyWrites.join(""))).toEqual({
            error: "preview_transport_unavailable",
            reasonCode: "pms_tunnel_unavailable",
        });
        expect(sink.end).toHaveBeenCalled();
        // The caller must never be told the request succeeded, and the connection must not be
        // reset: a typed 503 is the whole point.
        expect(sink.destroy).not.toHaveBeenCalled();
    });

    it("logs the specific tunnel reason code so an operator can see which prerequisite failed", async () => {
        const mod = await loadHttpAdapterModule();
        expect(mod?.proxyLocalServicePreviewHttpRequest).toBeTypeOf("function");
        if (!mod?.proxyLocalServicePreviewHttpRequest) return;

        const logModule = await import("@/utils/logging/log");
        const logSpy = vi.spyOn(logModule, "log").mockImplementation(() => undefined);
        try {
            await mod.proxyLocalServicePreviewHttpRequest({
                preview,
                request: {
                    method: "GET",
                    path: "/index.html",
                    search: "",
                    headers: { host: "preview.example.test" },
                    body: chunks([]),
                },
                response: createSink(),
                openTunnel: async () => {
                    throw Object.assign(
                        new Error("local_service_preview_tunnel_unavailable:grant_signing_unavailable"),
                        { reasonCode: "grant_signing_unavailable" },
                    );
                },
            });

            const entries = logSpy.mock.calls.filter(([context]) => (
                (context as { module?: unknown }).module === "local-service-preview"
            ));
            expect(entries).toHaveLength(1);
            expect(entries[0]?.[0]).toMatchObject({
                level: "error",
                previewId: "preview_1",
                machineId: "machine_1",
                reasonCode: "grant_signing_unavailable",
            });
            expect(String(entries[0]?.[1])).toContain("grant_signing_unavailable");
        } finally {
            logSpy.mockRestore();
        }
    });
});
