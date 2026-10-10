import fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    ACTION_ID_FAMILIES_V1,
    HOME_DOMAIN_ACTION_IDS_V1,
    getActionSpec,
} from "@happier-dev/protocol/actions";

import { createFakeRouteApp } from "@/app/api/testkit/routeHarness";
import type { Fastify } from "@/app/api/types";
import {
    createSessionAccessProjectionRelations,
    resetSessionRouteMocks,
    sessionFindUnique,
} from "@/app/api/routes/session/sessionRoutes.testkit";
import { enableOptionalStatics } from "@/app/api/utils/enableOptionalStatics";
import { resolveApiRateLimitPluginOptions } from "@/app/api/utils/apiRateLimitPolicy";

import * as apiModule from "./api";

type FakeRouteApp = ReturnType<typeof createFakeRouteApp>;

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("registerApiRoutes", () => {
    it("mounts Home company-sign-in intents independently of the Team feature", () => {
        vi.stubEnv("HAPPIER_FEATURE_TEAMS__ENABLED", "0");
        const app = createFakeRouteApp();
        (apiModule.registerApiRoutes as unknown as (app: FakeRouteApp) => void)(app);
        for (const path of [
            "connections/list", "connections/create", "connections/settings/update", "connections/enable", "connections/disable",
            "connections/remove/preflight", "connections/remove",
            "connections/test/start", "connections/test/consume",
            "workos/connection/create", "workos/admin-portal-link/create",
            "workos/reconcile", "workos/connection/set",
        ]) {
            expect(app.routes.has(`POST /v1/home/identity/${path}`), path).toBe(true);
        }
    });

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
        expect(app.routes.has("POST /v1/plugins/data/account-erase")).toBe(true);
        expect(app.routes.has("POST /v1/plugins/data/get")).toBe(true);
        expect(app.routes.has("POST /v1/plugins/data/query")).toBe(true);
        expect(app.routes.has("POST /v1/plugins/data/mutate")).toBe(true);
        expect(app.routes.has("POST /v1/plugins/data/candidate-preparation/source-page")).toBe(true);
        expect(app.routes.has("POST /v1/plugins/data/candidate-preparation/stage")).toBe(true);
        expect(app.routes.has("POST /v1/plugins/data/candidate-preparation/retire")).toBe(true);
        expect(app.routes.has("POST /v1/plugins/data/ui-query")).toBe(true);
        expect(app.routes.has("GET /api/provider-broker/v1/models")).toBe(true);
        expect(app.routes.has("POST /api/provider-broker/v1/chat/completions")).toBe(true);
        expect(app.routes.has("POST /api/provider-broker/v1/responses")).toBe(true);
        expect(app.routes.has("POST /api/provider-broker/v1/messages")).toBe(true);
        expect(app.routes.has("POST /api/provider-broker/v1/messages/count_tokens")).toBe(true);
        expect(app.routes.has("POST /v1/daemon/plugins/webhooks/claim")).toBe(true);
        expect(app.routes.has("POST /v1/plugins/webhooks/:opaqueRouteId")).toBe(true);
        expect(app.routes.has("GET /v2/session-organization")).toBe(true);
        expect(app.routes.has("PUT /v2/session-organization/pins/:sessionId")).toBe(true);
        // Team invitation transports. Every one is a POST so a bearer never
        // reaches a URL, a referrer, or a browser history entry.
        expect(app.routes.has("POST /v1/teams/invitations/create")).toBe(true);
        expect(app.routes.has("POST /v1/teams/invitations/list")).toBe(true);
        expect(app.routes.has("POST /v1/teams/invitations/revoke")).toBe(true);
        expect(app.routes.has("POST /v1/teams/invitations/reissue")).toBe(true);
        expect(app.routes.has("POST /v1/team-invitations/preview")).toBe(true);
        expect(app.routes.has("POST /v1/team-invitations/accept")).toBe(true);
        for (const route of [
            "POST /v1/auth/email/prelogin",
            "POST /v1/auth/email/login",
            "POST /v1/auth/email/unlock",
            "POST /v1/auth/email/provision",
            "POST /v1/auth/email/verify/request",
            "POST /v1/auth/email/verify/preview",
            "POST /v1/auth/password/reset/request",
            "POST /v1/auth/password/reset/preview",
            "POST /v1/auth/password/reset/submit",
            "POST /v1/auth/password/mutation/challenge",
            "GET /v1/account/security",
            "POST /v1/account/password/enroll/email/request",
            "POST /v1/account/password/enroll",
            "POST /v1/account/password/change",
            "POST /v1/account/password/remove",
            "POST /v1/account/email/change/request",
            "POST /v1/account/email/change",
        ]) {
            expect(app.routes.has(route)).toBe(true);
        }

        const accountDirectoryOptIns = [...app.routes.entries()]
            .filter(([, route]) =>
                route.opts.config?.allowAccountDirectoryToken === true)
            .map(([route]) => route)
            .sort();
        expect(accountDirectoryOptIns).toEqual([
            "DELETE /v1/account-directory/homes/:homeServerIdentityId",
            "GET /v1/account-directory/homes",
            "GET /v1/account-directory/me",
            "PATCH /v1/account-directory/homes/preferred",
            "POST /v1/account-directory/homes/:homeServerIdentityId/login-assertion",
            "PUT /v1/account-directory/homes/:homeServerIdentityId",
        ]);
        for (const ordinaryRoute of [
            "GET /v1/auth/ping",
            "GET /v1/machines",
            "GET /v1/sessions",
            "GET /v1/artifacts",
            "POST /v1/auth/api-tokens/list",
        ]) {
            expect(app.routes.has(ordinaryRoute)).toBe(true);
            expect(
                app.routes.get(ordinaryRoute)?.opts.config
                    ?.allowAccountDirectoryToken,
            ).not.toBe(true);
        }

        // Lane 02 registration lint. The current API-token management surface
        // is one create/list/revoke/revoke-all family plus PAT-self retrieval;
        // the pre-release `/v2` create route must stay absent, and the
        // declared Account Security Action transports must name routes this
        // registrar actually mounts so the Action catalog and the server
        // route table cannot drift apart.
        expect(app.routes.has("POST /v1/auth/api-tokens/create")).toBe(true);
        expect(app.routes.has("POST /v1/auth/api-tokens/revoke")).toBe(true);
        expect(app.routes.has("POST /v1/auth/api-tokens/revoke-all")).toBe(true);
        expect(app.routes.has("POST /v1/auth/api-tokens/encryption-access")).toBe(true);
        expect(app.routes.has("POST /v2/auth/api-tokens/create")).toBe(false);
        for (const actionId of ACTION_ID_FAMILIES_V1.account_security) {
            const spec = getActionSpec(actionId);
            const transport = `${spec.serverTransport?.method} ${spec.serverTransport?.path}`;
            expect(app.routes.has(transport)).toBe(true);
        }

        // Machine Pool Actions use explicit domain routes mounted through the
        // existing Machine registrar. Keep the Action catalog and real API
        // composition root aligned without introducing a generic registrar.
        expect(ACTION_ID_FAMILIES_V1.machine_pools).toHaveLength(6);
        for (const actionId of ACTION_ID_FAMILIES_V1.machine_pools) {
            const spec = getActionSpec(actionId);
            const transport = `${spec.serverTransport?.method} ${spec.serverTransport?.path}`;
            expect(app.routes.has(transport)).toBe(true);
        }

        // The Home-family source catalog is the registration census. Handlers
        // remain explicit domain owners, but every declared method/path pair
        // must be mounted by this composition root.
        for (const actionId of HOME_DOMAIN_ACTION_IDS_V1) {
            const spec = getActionSpec(actionId);
            const transport = `${spec.serverTransport?.method} ${spec.serverTransport?.path}`;
            expect(app.routes.has(transport), actionId).toBe(true);
        }

        // Lane 03 route reachability is spec-driven: public auth entry is mounted
        // by the auth owner, and every managed identity Action names a transport
        // that this API registrar actually serves through the domain route owner.
        expect(app.routes.has("POST /v1/auth/entry")).toBe(true);
        for (const actionId of [
            "identity.providers.list",
            "identity.providers.create",
            "identity.providers.update",
            "identity.providers.secret.replace",
            "identity.providers.validate",
            "identity.providers.test.start",
            "identity.providers.test.consume",
            "identity.providers.enable",
            "identity.providers.disable",
            "identity.providers.remove.preview",
            "identity.providers.remove",
            "teams.identity.connections.list",
            "teams.identity.connections.create",
            "teams.identity.connections.settings.update",
            "teams.identity.connections.enable",
            "teams.identity.connections.disable",
            "teams.identity.connections.remove.preview",
            "teams.identity.connections.remove",
            "teams.identity.connections.test.start",
            "teams.identity.connections.test.consume",
            "teams.identity.workos.adminPortalLink.create",
            "teams.identity.workos.connection.create",
            "teams.identity.workos.reconcile",
            "teams.identity.workos.connection.set",
        ] as const) {
            const spec = getActionSpec(actionId);
            const transport = `${spec.serverTransport?.method} ${spec.serverTransport?.path}`;
            expect(app.routes.has(transport)).toBe(true);
        }

        // Native email operations are pre-auth public routes: none of them
        // may silently require an authenticated principal. Account Security,
        // password-mutation preparation, and PAT-self retrieval are the
        // opposite: each must be registered through the canonical
        // `app.authenticate` decoration, so a registrar refactor that drops
        // authentication fails here instead of serving an unauthenticated
        // security route.
        for (const publicRoute of [
            "POST /v1/auth/email/prelogin",
            "POST /v1/auth/email/login",
            "POST /v1/auth/email/unlock",
            "POST /v1/auth/email/provision",
            "POST /v1/auth/email/verify/request",
            "POST /v1/auth/email/verify/preview",
            "POST /v1/auth/password/reset/request",
            "POST /v1/auth/password/reset/preview",
        ]) {
            expect(app.routes.get(publicRoute)?.opts.preHandler).toBeUndefined();
        }
        for (const authenticatedRoute of [
            "POST /v1/auth/password/mutation/challenge",
            "GET /v1/account/security",
            "POST /v1/account/password/enroll/email/request",
            "POST /v1/account/password/enroll",
            "POST /v1/account/password/change",
            "POST /v1/account/password/remove",
            "POST /v1/account/email/change/request",
            "POST /v1/account/email/change",
            "POST /v1/auth/api-tokens/encryption-access",
        ]) {
            // Fastify admits either one handler or an array; both must carry
            // the canonical `app.authenticate` decoration.
            const registered = app.routes.get(authenticatedRoute)?.opts.preHandler;
            const preHandlers = Array.isArray(registered)
                ? (registered as readonly unknown[])
                : [registered];
            expect(preHandlers).toContain(app.authenticate);
        }
    });

    it("routes API requests on preview hosts to registered API handlers before local preview fallback", async () => {
        resetSessionRouteMocks();
        sessionFindUnique.mockResolvedValue({
            ...createSessionAccessProjectionRelations(),
            id: "session_1",
            accountId: "u1",
            metadata: "",
            metadataVersion: 0,
            metadataLayoutVersion: 0,
            ownerMetadata: null,
            agentState: null,
            agentStateVersion: 0,
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
        });
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
            await app.register(fastifyRateLimit, resolveApiRateLimitPluginOptions(process.env));
            app.setValidatorCompiler(validatorCompiler);
            app.setSerializerCompiler(serializerCompiler);
            app.decorate("authenticate", async (request: {
                userId?: string;
                authAuthority?: "present_user";
            }) => {
                request.userId = "u1";
                request.authAuthority = "present_user";
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

            expect(registration.statusCode, registration.body).toBe(201);
            const registered = registration.json<{ accessUrl: string }>();
            const previewHost = new URL(registered.accessUrl).host;

            const response = await app.inject({
                method: "GET",
                url: "/v2/session-organization?includeFolders=true",
                headers: { host: previewHost },
            });

            expect(response.statusCode, response.body).toBe(200);
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
