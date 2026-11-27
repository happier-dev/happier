import { describe, expect, it, vi } from "vitest";

import {
    readExternalProviderApiCredential,
    registerExternalProviderApiRoutes,
} from "./registerExternalProviderApiRoutes";

describe("public external Provider API ingress", () => {
    it("accepts either supported credential header and requires duplicate credentials to agree", () => {
        expect(readExternalProviderApiCredential({ authorization: "Bearer token-1" })).toBe("token-1");
        expect(readExternalProviderApiCredential({ "x-api-key": "token-1" })).toBe("token-1");
        expect(readExternalProviderApiCredential({ authorization: "Bearer token-1", "x-api-key": "token-1" })).toBe("token-1");
        expect(readExternalProviderApiCredential({ authorization: "Bearer token-1", "x-api-key": "token-2" })).toBeNull();
        expect(readExternalProviderApiCredential({ authorization: "Bearer token-1", "x-api-key": "" })).toBeNull();
        expect(readExternalProviderApiCredential({ authorization: "Bearer token-1", "x-api-key": "   " })).toBeNull();
        expect(readExternalProviderApiCredential({ authorization: "Basic token-1" })).toBeNull();
    });

    it("rejects repeated authentication header lines even when Node collapsed their values", () => {
        expect(readExternalProviderApiCredential(
            { authorization: "Bearer token-1" },
            ["Authorization", "Bearer token-1", "authorization", "Bearer token-1"],
        )).toBeNull();
        expect(readExternalProviderApiCredential(
            { "x-api-key": "token-1" },
            ["X-Api-Key", "token-1", "x-api-key", "token-1"],
        )).toBeNull();
        expect(readExternalProviderApiCredential(
            { authorization: "Bearer token-1", "x-api-key": "token-1" },
            ["Authorization", "Bearer token-1", "X-Api-Key", "token-1"],
        )).toBe("token-1");
    });

    it("fails closed at the feature gate before credential verification", async () => {
        const routes: Record<string, unknown>[] = [];
        const dispatch = vi.fn();
        registerExternalProviderApiRoutes({ route: (route: Record<string, unknown>) => routes.push(route) } as never, {
            env: {},
            dispatch,
        });
        const selected = routes.find((route) => route.url === "/api/provider-broker/v1/models");
        const reply = {
            code: vi.fn(() => reply),
            send: vi.fn(),
        };

        await (selected?.preHandler as (request: unknown, reply: unknown) => Promise<unknown>)({}, reply);

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it.each([
        ['missing public ingress', undefined],
        ['plain HTTP ingress', 'http://home.example.test'],
        ['missing route-grant signer', 'https://home.example.test'],
    ])('fails closed before key verification when the bit is on but %s is not deployment-ready', async (_label, publicServerUrl) => {
        const routes: Record<string, unknown>[] = [];
        const dispatch = vi.fn();
        registerExternalProviderApiRoutes({ route: (route: Record<string, unknown>) => routes.push(route) } as never, {
            env: {
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: '1',
                ...(publicServerUrl ? { HAPPIER_PUBLIC_SERVER_URL: publicServerUrl } : {}),
            },
            dispatch,
        });
        const selected = routes.find((route) => route.url === "/api/provider-broker/v1/models");
        const reply = {
            code: vi.fn(() => reply),
            send: vi.fn(),
        };

        await (selected?.preHandler as (request: unknown, reply: unknown) => Promise<unknown>)({}, reply);

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: 'not_found' });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('keeps the feature gate open when public HTTPS and route-grant signing are ready', async () => {
        const routes: Record<string, unknown>[] = [];
        const dispatch = vi.fn();
        registerExternalProviderApiRoutes({ route: (route: Record<string, unknown>) => routes.push(route) } as never, {
            env: {
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: '1',
                HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'route-grant-key',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(new Uint8Array(32).fill(9)).toString('base64url'),
            },
            dispatch,
        });
        const selected = routes.find((route) => route.url === "/api/provider-broker/v1/models");
        const reply = {
            code: vi.fn(() => reply),
            send: vi.fn(),
        };

        await (selected?.preHandler as (request: unknown, reply: unknown) => Promise<unknown>)({}, reply);

        expect(reply.code).not.toHaveBeenCalled();
        expect(reply.send).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("registers only the explicit public matrix with the feature gate and IP limiter before dispatch", () => {
        const routes: Array<{ method: string; path: string; options: Record<string, unknown> }> = [];
        const app = {
            route: (options: Record<string, unknown>) => routes.push({
                method: String(options.method),
                path: String(options.url),
                options,
            }),
        };
        registerExternalProviderApiRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_ENABLED: "true",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API_ENABLED: "true",
            },
            dispatch: vi.fn(),
        });
        expect(routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
            "GET /api/provider-broker/v1/models",
            "POST /api/provider-broker/v1/chat/completions",
            "POST /api/provider-broker/v1/responses",
            "POST /api/provider-broker/v1/messages",
            "POST /api/provider-broker/v1/messages/count_tokens",
        ]);
        for (const route of routes) {
            expect(route.options).toMatchObject({
                config: { cors: false, rateLimit: { max: 600, timeWindow: "1 minute" } },
            });
            expect(route.options).not.toHaveProperty("bodyLimit");
            expect(route.options.preHandler).toEqual(expect.any(Function));
        }
    });

});
