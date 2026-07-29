import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeRouteApp } from "@/app/api/testkit/routeHarness";
import type { Fastify } from "@/app/api/types";
import { resetSessionRouteMocks } from "@/app/api/routes/session/sessionRoutes.testkit";
import { enableOptionalStatics } from "@/app/api/utils/enableOptionalStatics";

import * as apiModule from "./api";

type FakeRouteApp = ReturnType<typeof createFakeRouteApp>;

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("registerApiRoutes", () => {
    it("mounts review comment routes on the API app", () => {
        const registerApiRoutes = (apiModule as unknown as Readonly<{
            registerApiRoutes?: (app: FakeRouteApp) => void;
        }>).registerApiRoutes;
        expect(registerApiRoutes).toEqual(expect.any(Function));

        const app = createFakeRouteApp();
        registerApiRoutes?.(app);

        expect(app.routes.has("GET /v1/reviews/comments")).toBe(true);
        expect(app.routes.has("POST /v1/reviews/comments")).toBe(true);
        expect(app.routes.has("POST /v1/local-services/preview")).toBe(true);
        expect(app.routes.has("GET /v1/local-services/public/:exposureId")).toBe(true);
        expect(app.routes.has("GET /v1/local-services/public/:exposureId/*")).toBe(true);
        expect(app.routes.has("GET /v2/session-organization")).toBe(true);
        expect(app.routes.has("PUT /v2/session-organization/pins/:sessionId")).toBe(true);
    });

    it("routes API requests on preview hosts to registered API handlers before local preview fallback", async () => {
        resetSessionRouteMocks();
        const uiDir = await mkdtemp(join(tmpdir(), "happier-api-route-shadow-"));
        vi.stubEnv("HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED", "1");
        vi.stubEnv("HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN", "preview.example.test");
        vi.stubEnv("HAPPIER_PUBLIC_SERVER_URL", "https://app.happier.test");
        vi.stubEnv("HANDY_MASTER_SECRET", "master-secret");
        vi.stubEnv("HAPPIER_SERVER_UI_DIR", uiDir);
        vi.stubEnv("HAPPIER_SERVER_UI_PREFIX", "/");
        await writeFile(join(uiDir, "index.html"), "<!doctype html><html><body>ui</body></html>\n", "utf8");

        const app = fastify({ logger: false });
        try {
            app.setValidatorCompiler(validatorCompiler);
            app.setSerializerCompiler(serializerCompiler);
            app.decorate("authenticate", async (request: { userId?: string }) => {
                request.userId = "u1";
            });

            enableOptionalStatics(app);
            const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
            apiModule.registerApiRoutes(typed);

            const registration = await app.inject({
                method: "POST",
                url: "/v1/local-services/preview",
                payload: {
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
                    originMode: "host",
                },
            });

            expect(registration.statusCode).toBe(201);
            const registered = registration.json<{ accessUrl: string }>();
            const previewHost = new URL(registered.accessUrl).host;

            const response = await app.inject({
                method: "GET",
                url: "/v2/session-organization?includeFolders=true",
                headers: { host: previewHost },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                snapshot: expect.objectContaining({
                    folders: [],
                    pins: [],
                    tags: [],
                }),
            });
        } finally {
            await app.close();
            await rm(uiDir, { recursive: true, force: true });
        }
    });
});
