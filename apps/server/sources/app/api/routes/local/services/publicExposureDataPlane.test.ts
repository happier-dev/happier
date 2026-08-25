import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

import { peerMediationGrantSigningEnv } from "@/testkit/env";
import { registerLocalServiceRoutes } from "./registerRoutes";
import type { LocalServicePreviewTunnelStream } from "@/app/local/services/preview/httpAdapter";

/**
 * Composed data-plane coverage for the PUBLIC local-service exposure vertical (lane C1, R-4).
 *
 * Every other test on this corridor drives the route handlers directly with a synthetic params
 * bag, which cannot observe the defect S-1 actually exploits: Fastify's router percent-DECODES
 * the proxy wildcard, so `%0d%0a` becomes a real CRLF before any handler runs. These tests
 * therefore register the real composed route stack on a real Fastify instance and inject raw
 * URLs, so `find-my-way`'s decoding, `readWildcardPath`, `proxyLocalServicePreviewHttpRequest`
 * and the raw HTTP/1.1 serializer all run for real.
 *
 * The only faked collaborators are genuine system boundaries: the PMS tunnel (a socket to another
 * machine) and session-access authorization (a database read).
 */

const PREVIEW_PORT = 5173;

const preview: LocalServicePreviewResourceV1 = {
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    owner: { kind: "session", id: "session_1" },
    target: { scheme: "http", host: "127.0.0.1", port: PREVIEW_PORT },
    initialPath: { pathname: "/", search: "" },
    display: {
        title: "Vite App",
        addressLabel: `127.0.0.1:${PREVIEW_PORT}`,
    },
    originMode: "path",
};

function publicPreviewEnv(): NodeJS.ProcessEnv {
    return {
        ...peerMediationGrantSigningEnv(),
        NODE_ENV: "test",
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "300000",
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: "1",
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: "1",
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1",
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: String(PREVIEW_PORT),
        HAPPIER_PUBLIC_SERVER_URL: "https://app.example.test",
        HANDY_MASTER_SECRET: "public-exposure-data-plane-secret",
    } as NodeJS.ProcessEnv;
}

type UpstreamRecorder = Readonly<{ writes: string[] }>;

function createRecordingTunnel(recorder: UpstreamRecorder): LocalServicePreviewTunnelStream {
    return {
        tunnelId: "tunnel_1",
        substreamId: "substream_1",
        write: (bytes) => {
            recorder.writes.push(new TextDecoder().decode(bytes));
        },
        endWrite: () => undefined,
        read: async function* () {
            yield new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        },
        close: () => undefined,
        abort: () => undefined,
    };
}

async function buildPublicPreviewApp(recorder: UpstreamRecorder) {
    const app = Fastify({ logger: false });
    // The shared bearer preHandler; the public DATA plane is deliberately unauthenticated, so the
    // stub only needs to establish the actor identity the CONTROL routes read.
    (app as unknown as { authenticate: unknown }).authenticate = async (request: { userId?: string }) => {
        request.userId = "user_1";
    };

    registerLocalServiceRoutes(app as never, {
        env: publicPreviewEnv(),
        authorizeSessionAccess: async () => true,
        openTunnel: async () => createRecordingTunnel(recorder),
    });
    await app.ready();
    return app;
}

async function createExposure(app: Awaited<ReturnType<typeof buildPublicPreviewApp>>) {
    const registration = await app.inject({
        method: "POST",
        url: "/v1/local-services/preview",
        payload: preview,
    });
    expect(registration.statusCode).toBe(201);

    const created = await app.inject({
        method: "POST",
        url: "/v1/local-services/public",
        payload: {
            machineId: preview.machineId,
            sessionId: preview.sessionId,
            previewId: preview.previewId,
            mode: "secret_link",
            ttlMs: 120_000,
            rateLimitProfileId: "default",
            confirmation: { acknowledged: true },
        },
    });
    return created;
}

describe("public local-service exposure data plane (composed Fastify)", () => {
    it("mints the exposure on an isolated per-exposure origin, never the API origin", async () => {
        const recorder: UpstreamRecorder = { writes: [] };
        const app = await buildPublicPreviewApp(recorder);
        try {
            const created = await createExposure(app);
            expect(created.statusCode).toBe(201);
            const body = created.json() as { exposure: { publicUrl: string; exposureId: string } };
            const origin = new URL(body.exposure.publicUrl).origin;

            expect(origin).not.toBe("https://app.example.test");
            expect(origin).toMatch(/^https:\/\/[a-z0-9-]+\.preview\.example\.test$/u);
            expect(origin).toContain(
                body.exposure.exposureId.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").slice(0, 63),
            );
        } finally {
            await app.close();
        }
    });

    it("does not smuggle a second upstream request when the router decodes %0d%0a in the proxy path", async () => {
        const recorder: UpstreamRecorder = { writes: [] };
        const app = await buildPublicPreviewApp(recorder);
        try {
            const created = await createExposure(app);
            expect(created.statusCode).toBe(201);
            const { exposure } = created.json() as {
                exposure: { exposureId: string; publicUrl: string };
            };
            const publicToken = new URL(exposure.publicUrl).searchParams.get("publicToken");
            expect(typeof publicToken).toBe("string");

            // The URL->cookie exchange. Its `Location` is the second CRLF-terminated sink.
            const exchanged = await app.inject({
                method: "GET",
                url: `/v1/local-services/public/${exposure.exposureId}/foo%0d%0aX-Injected:%20yes%0d%0a%0d%0aGET%20/admin%20HTTP/1.1?publicToken=${encodeURIComponent(publicToken ?? "")}`,
            });
            expect(exchanged.statusCode).toBe(303);
            const location = exchanged.headers.location;
            expect(typeof location).toBe("string");
            expect(String(location)).not.toMatch(/[\r\n]/u);

            const setCookie = String(exchanged.headers["set-cookie"] ?? "").split(";")[0] ?? "";
            expect(setCookie).toContain("happier_public_token=");

            // The data-plane request. Its raw HTTP/1.1 request line is the first sink.
            const proxied = await app.inject({
                method: "GET",
                url: String(location),
                headers: { cookie: setCookie },
            });
            expect(proxied.statusCode).toBe(200);

            const upstream = recorder.writes.join("");
            expect(upstream.length).toBeGreaterThan(0);
            // Exactly one header block, exactly one request line, no injected header.
            expect(upstream.split("\r\n\r\n")).toHaveLength(2);
            expect(upstream.split("\r\n").filter((line) => /\sHTTP\/1\.1$/u.test(line))).toHaveLength(1);
            expect(upstream).not.toMatch(/\r\nX-Injected:/u);
            expect(upstream.split("\r\n")[0]).toBe(
                "GET /foo%0D%0AX-Injected:%20yes%0D%0A%0D%0AGET%20/admin%20HTTP/1.1 HTTP/1.1",
            );
        } finally {
            await app.close();
        }
    });

    it("keeps the public data plane 404 when the exposure feature gate is off", async () => {
        const recorder: UpstreamRecorder = { writes: [] };
        const app = Fastify({ logger: false });
        // The shared bearer preHandler; the public DATA plane is deliberately unauthenticated, so the
    // stub only needs to establish the actor identity the CONTROL routes read.
    (app as unknown as { authenticate: unknown }).authenticate = async (request: { userId?: string }) => {
        request.userId = "user_1";
    };
        registerLocalServiceRoutes(app as never, {
            // DEC-7: default configuration keeps public preview disabled.
            env: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
            authorizeSessionAccess: async () => true,
            openTunnel: async () => createRecordingTunnel(recorder),
        });
        await app.ready();
        try {
            const response = await app.inject({
                method: "GET",
                url: "/v1/local-services/public/any_exposure/index.html",
            });
            expect(response.statusCode).toBe(404);
            expect(recorder.writes).toHaveLength(0);
        } finally {
            await app.close();
        }
    });
});
