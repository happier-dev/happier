import Fastify from "fastify";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbTransactionMock } from '../testkit/dbMocks';

const verifyToken = vi.fn();
const verifyTokenDisposition = vi.fn(async (token: string) => {
    const credential = await verifyToken(token);
    return credential
        ? { status: "verified" as const, credential }
        : { status: "invalid" as const };
});
const enforceLoginEligibility = vi.fn();
const log = vi.fn();

// Request-scoped configuration reads the real Home overlay over an unconfigured database.
vi.mock('@/storage/db', () => {
    const tables = {
        homeSettings: { findUnique: async () => null },
        homeGovernancePolicy: { findUnique: async () => null },
    };
    return { db: createDbTransactionMock(() => tables).wrapDb(tables) };
});

vi.mock("@/app/auth/auth", () => ({
    auth: { verifyToken, verifyTokenDisposition },
}));

vi.mock("@/app/auth/enforceLoginEligibility", () => ({
    enforceLoginEligibility,
}));

vi.mock("@/utils/logging/log", () => ({
    log,
}));

let enableAuthentication: typeof import("./enableAuthentication").enableAuthentication;

describe("enableAuthentication (defensive error handling)", () => {
    beforeAll(async () => {
        ({ enableAuthentication } = await import("./enableAuthentication"));
    }, 120_000);

    beforeEach(() => {
        verifyToken.mockReset();
        verifyTokenDisposition.mockClear();
        enforceLoginEligibility.mockReset();
        log.mockReset();
    });

    it("never responds with an undefined error when login eligibility rejects", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "u1", authTokenKind: "account", authority: "present_user" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: false, statusCode: 403 } as any);

        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer t" },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("keeps OAuth code and state query material out of auth decorator diagnostics", async () => {
        const code = "SENTINEL_OAUTH_CODE";
        const state = "SENTINEL_OAUTH_STATE";
        const diagnosticEnvNames = ["HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS", "HAPPY_AUTH_DECORATOR_DIAGNOSTIC_LOGS"] as const;
        const previousValues = diagnosticEnvNames.map((name) => process.env[name]);
        for (const name of diagnosticEnvNames) process.env[name] = "1";

        try {
            const app = Fastify({ logger: false }) as any;
            enableAuthentication(app);
            await app.ready();

            const reply = {
                code: vi.fn(() => reply),
                send: vi.fn(() => reply),
            };
            await app.authenticate(
                { headers: {}, url: `/v1/auth/external/github/callback?code=${code}&state=${state}` },
                reply,
            );

            const rendered = log.mock.calls.flat().map((value: unknown) => String(value)).join(" ");
            expect(rendered).not.toContain(code);
            expect(rendered).not.toContain(state);
            expect(rendered).toContain("/v1/auth/external/github/callback");

            await app.close();
        } finally {
            diagnosticEnvNames.forEach((name, index) => {
                const previous = previousValues[index];
                if (previous === undefined) delete process.env[name];
                else process.env[name] = previous;
            });
        }
    });

    it("keeps a disabled Account opaque when an already-issued credential is presented", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "u1", authTokenKind: "account", authority: "present_user" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: false, statusCode: 403, error: "account-disabled" } as any);

        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer t" },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "invalid_token" });

        await app.close();
    });

    it("returns opaque invalid_token when bearer token verification fails", async () => {
        verifyToken.mockResolvedValueOnce(null);

        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer bad-token" },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "invalid_token" });

        await app.close();
    });

    it("keeps route-specific connection failures distinct from an authenticated subject rejection", async () => {
        verifyToken.mockResolvedValueOnce(null);
        verifyToken.mockRejectedValueOnce(new Error("verification unavailable"));

        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get(
            "/subject-auth",
            {
                config: { connectionAuthFailureError: "authentication_failed" },
                preHandler: app.authenticate,
            },
            async () => ({ ok: true }),
        );
        await app.ready();

        const invalidCredential = await app.inject({
            method: "GET",
            url: "/subject-auth",
            headers: { authorization: "Bearer invalid-connection-token" },
        });
        const unavailableVerifier = await app.inject({
            method: "GET",
            url: "/subject-auth",
            headers: { authorization: "Bearer unavailable-verifier-token" },
        });
        const missingCredential = await app.inject({
            method: "GET",
            url: "/subject-auth",
        });

        expect(invalidCredential.statusCode).toBe(401);
        expect(invalidCredential.json()).toEqual({ error: "authentication_failed" });
        expect(unavailableVerifier.statusCode).toBe(401);
        expect(unavailableVerifier.json()).toEqual({ error: "authentication_failed" });
        expect(missingCredential.statusCode).toBe(401);
        expect(missingCredential.json()).toEqual({ error: "Missing authorization header" });

        await app.close();
    });

    it("lets a bearer-only route hide missing and malformed connection credentials behind invalid_token", async () => {
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get(
            "/public-action",
            {
                config: { connectionAuthFailureError: "invalid_token" },
                preHandler: app.authenticate,
            },
            async () => ({ ok: true }),
        );
        await app.ready();

        const [missingCredential, malformedCredential] = await Promise.all([
            app.inject({ method: "GET", url: "/public-action" }),
            app.inject({
                method: "GET",
                url: "/public-action",
                headers: { authorization: "Basic not-a-bearer" },
            }),
        ]);

        expect(missingCredential.statusCode).toBe(401);
        expect(missingCredential.json()).toEqual({ error: "invalid_token" });
        expect(malformedCredential.statusCode).toBe(401);
        expect(malformedCredential.json()).toEqual({ error: "invalid_token" });
        expect(verifyToken).not.toHaveBeenCalled();

        await app.close();
    });

    it("returns opaque invalid_token when a token's account cannot be found", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "missing-account", authTokenKind: "account", authority: "present_user" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: false, statusCode: 401, error: "invalid-token" } as any);

        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer good-signature-but-stale-account" },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "invalid_token" });

        await app.close();
    });

    it("does not emit per-request auth success logs by default", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "u1", authTokenKind: "account", authority: "present_user" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: true });

        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: { authorization: "Bearer t" },
        });

        expect(res.statusCode).toBe(200);
        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "auth-decorator" }),
            expect.stringContaining("Auth success"),
        );
        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "auth-decorator" }),
            expect.stringContaining("Auth check"),
        );

        await app.close();
    });

    it("stamps a current restricted Runner as account automation for canonical Session authorization", async () => {
        const sessionRuntimePrincipal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: "u1",
            activationId: "activation_1",
            sessionId: "session_1",
            machineId: "machine_1",
            installationId: "installation_1",
            installationPublicKey: "installation_public_key_1",
            creatorTokenEpoch: 1,
        };
        verifyToken.mockResolvedValueOnce({
            userId: "u1",
            authTokenKind: "ephemeral_session_runner",
            authority: "session_runtime",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            ephemeralSessionRunnerPrincipal: sessionRuntimePrincipal,
        });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: true });

        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get(
            "/runner/:sessionId",
            {
                config: { restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } },
                preHandler: app.authenticate,
            },
            async (request: any) => ({
                authAuthority: request.authAuthority,
                authenticationEvidence: request.authTokenAuthenticationEvidence,
                sessionRuntimePrincipal: request.sessionRuntimePrincipal,
            }),
        );
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/runner/session_1",
            headers: { authorization: "Bearer runner-token" },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            authAuthority: "account_automation",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            sessionRuntimePrincipal,
        });

        await app.close();
    });

    it.each([
        {
            label: "missing typed principal",
            verified: {
                userId: "u1",
                authTokenKind: "ephemeral_session_runner" as const,
                authority: "session_runtime" as const,
            },
            expectedStatus: 401,
            expectedBody: { error: "invalid_token" },
        },
        {
            label: "principal for a different Account",
            verified: {
                userId: "u1",
                authTokenKind: "ephemeral_session_runner" as const,
                authority: "session_runtime" as const,
                ephemeralSessionRunnerPrincipal: {
                    kind: "ephemeral_session_runner" as const,
                    authority: "session_runtime" as const,
                    accountId: "u2",
                    activationId: "activation_1",
                    sessionId: "session_1",
                    machineId: "machine_1",
                    installationId: "installation_1",
                    installationPublicKey: "installation_public_key_1",
                    creatorTokenEpoch: 1,
                },
            },
            expectedStatus: 401,
            expectedBody: { error: "invalid_token" },
        },
    ])("does not downgrade a presented Runner credential with $label", async ({ verified, expectedStatus, expectedBody }) => {
        verifyToken.mockResolvedValueOnce(verified);
        enforceLoginEligibility.mockResolvedValueOnce({ ok: true });

        const handler = vi.fn(async () => ({ ok: true }));
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get(
            "/runner/:sessionId",
            {
                config: { restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } },
                preHandler: app.authenticate,
            },
            handler,
        );
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/runner/session_1",
            headers: { authorization: "Bearer runner-token" },
        });

        expect(res.statusCode).toBe(expectedStatus);
        expect(res.json()).toEqual(expectedBody);
        expect(handler).not.toHaveBeenCalled();
        expect(enforceLoginEligibility).not.toHaveBeenCalled();

        await app.close();
    });

    it("captures the account stored-content HTTP declaration once on the authenticated request", async () => {
        verifyToken.mockResolvedValueOnce({ userId: "u1", authTokenKind: "account", authority: "present_user" });
        enforceLoginEligibility.mockResolvedValueOnce({ ok: true });

        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get(
            "/private",
            { preHandler: app.authenticate },
            async (request: any) => request.accountStoredContentCompatibility,
        );
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/private",
            headers: {
                authorization: "Bearer t",
                "x-happier-account-stored-content-protocol": "2",
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            supportsCurrentProtocol: true,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            supportsMachinePoolChangeProtocol: false,
            supportsSavedSecretResourceChangeProtocol: false,
            outcome: "accepted",
            declaration: { v: 1, protocolVersion: 2 },
            upgradeRequired: null,
        });

        await app.close();
    });
});
