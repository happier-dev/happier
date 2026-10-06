import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { registerAccountDirectoryRoutes } from "@/app/accountDirectory/accountDirectoryRoutes";
import type { Fastify } from "@/app/api/types";
import {
    isRestrictedAuthTokenDeniedForRoute,
    isRestrictedAuthTokenKind,
    resolveOptionalPublicAuthDisposition,
} from "./apiTokenRouteAdmission";

type RecordedRoute = Readonly<{
    method: string;
    path: string;
    config: Readonly<Record<string, unknown>> | undefined;
    preHandler: unknown;
}>;

type DirectBearerConsumerDisposition = Readonly<{
    path: string;
    verifies: readonly ("auth.verifyToken" | "auth.verifyLegacyHomeToken" | "auth.verifyTokenForRoute" | "auth.verifyTokenDisposition")[];
    disposition: string;
}>;

const SERVER_SOURCE_ROOT = resolve(
    fileURLToPath(new URL("../../../", import.meta.url)),
);

const DIRECT_BEARER_CONSUMER_DISPOSITIONS = [
    {
        path: "app/api/socket.ts",
        verifies: ["auth.verifyTokenForRoute", "auth.verifyTokenForRoute"],
        disposition: "Socket.IO rejects Directory provenance and admits restricted PATs only through the canonical Session-viewer scope, origin, capability and final currentness boundary.",
    },
    {
        path: "app/api/utils/verifyRequestPrincipal.ts",
        verifies: ["auth.verifyTokenDisposition"],
        disposition: "Canonical HTTP bearer verification shared by Fastify route admission and the optional public auth-entry projection; Directory tokens still require allowAccountDirectoryToken, while PATs require either allowApiToken or a verified external Action proof at the route admission owner.",
    },
    {
        path: "app/api/utils/apiRateLimitPolicy.ts",
        verifies: ["auth.verifyTokenForRoute"],
        disposition: "Rate-limit key projection only; restricted Directory/PAT or invalid bearers fall back to the IP bucket and do not authorize a route.",
    },
    {
        path: "app/api/utils/optionalPublicAuth.ts",
        verifies: ["auth.verifyTokenDisposition"],
        disposition: "Canonical optional-public bearer verification; restricted Directory/PAT bearers remain anonymous-compatible while verified Runner bearers are rejected by every consumer.",
    },
    {
        path: "app/api/socket/socketCredentialCurrentness.ts",
        verifies: ["auth.verifyTokenForRoute"],
        disposition: "Canonical socket-operation credential currentness reuses the route verifier, including the access-key handler's final secret-disclosure check; admitted PAT viewers receive their freshly verified grant before an operation, while Directory and unadmitted restricted credentials remain forbidden.",
    },
] as const satisfies readonly DirectBearerConsumerDisposition[];

function listProductionTypeScriptFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) return listProductionTypeScriptFiles(absolutePath);
        if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
        if (/\.(?:spec|test)\.ts$/.test(entry.name)) return [];
        return [absolutePath];
    });
}

function directVerifierCalls(source: string): ("auth.verifyToken" | "auth.verifyLegacyHomeToken" | "auth.verifyTokenForRoute" | "auth.verifyTokenDisposition")[] {
    return [...source.matchAll(/auth\.(verifyTokenDisposition|verifyTokenForRoute|verifyLegacyHomeToken|verifyToken)\s*\(/g)]
        .map((match) => match[1] === "verifyTokenForRoute"
            ? "auth.verifyTokenForRoute"
            : match[1] === "verifyTokenDisposition"
                ? "auth.verifyTokenDisposition"
            : match[1] === "verifyLegacyHomeToken"
                ? "auth.verifyLegacyHomeToken"
            : "auth.verifyToken");
}

describe("Account Directory central route admission", () => {
    it("keeps the Directory opt-in inventory closed to exactly the six identity routes", () => {
        const registrations: RecordedRoute[] = [];
        const record = (method: string) => (
            path: string,
            options: Readonly<{
                config?: Readonly<Record<string, unknown>>;
                preHandler?: unknown;
            }>,
        ) => {
            registrations.push({
                method,
                path,
                config: options.config,
                preHandler: options.preHandler,
            });
        };
        const fakeApp = {
            authenticate: vi.fn(),
            get: record("GET"),
            put: record("PUT"),
            delete: record("DELETE"),
            patch: record("PATCH"),
            post: record("POST"),
        } as unknown as Fastify;

        registerAccountDirectoryRoutes(fakeApp);

        const optedIn = registrations
            .filter((route) => route.config?.allowAccountDirectoryToken === true)
            .map((route) => `${route.method} ${route.path}`)
            .sort();
        expect(optedIn).toEqual([
            "DELETE /v1/account-directory/homes/:homeServerIdentityId",
            "GET /v1/account-directory/homes",
            "GET /v1/account-directory/me",
            "PATCH /v1/account-directory/homes/preferred",
            "POST /v1/account-directory/homes/:homeServerIdentityId/login-assertion",
            "PUT /v1/account-directory/homes/:homeServerIdentityId",
        ].sort());
        expect(registrations
            .filter((route) => route.config?.allowAccountDirectoryToken === true)
            .every((route) => Array.isArray(route.preHandler)
                && route.preHandler.length === 1
                && route.preHandler[0] === fakeApp.authenticate))
            .toBe(true);
    });

    it("keeps a test-only exhaustive inventory of direct production bearer verification consumers", () => {
        const expectedByPath = new Map(
            DIRECT_BEARER_CONSUMER_DISPOSITIONS.map((entry) => [entry.path, entry]),
        );
        const actual = listProductionTypeScriptFiles(SERVER_SOURCE_ROOT)
            .map((absolutePath) => ({
                path: relative(SERVER_SOURCE_ROOT, absolutePath).replace(/\\/g, "/"),
                verifies: directVerifierCalls(readFileSync(absolutePath, "utf8")),
            }))
            .filter((entry) => entry.verifies.length > 0)
            .sort((left, right) => left.path.localeCompare(right.path));

        expect(actual).toEqual([...expectedByPath.values()]
            .map(({ path, verifies }) => ({ path, verifies: [...verifies] }))
            .sort((left, right) => left.path.localeCompare(right.path)));
        for (const entry of DIRECT_BEARER_CONSUMER_DISPOSITIONS) {
            expect(entry.disposition.trim().length).toBeGreaterThan(40);
            expect(entry.disposition).toMatch(/Directory|restricted|Canonical/);
        }
    });

    it("fails closed for undefined or non-Directory provenance at the one admission owner", () => {
        expect(isRestrictedAuthTokenKind("account_directory")).toBe(true);
        expect(isRestrictedAuthTokenKind("api_token")).toBe(true);
        expect(isRestrictedAuthTokenKind("ephemeral_session_runner")).toBe(true);
        expect(isRestrictedAuthTokenKind("account")).toBe(false);
        expect(isRestrictedAuthTokenKind("terminal")).toBe(false);
        expect(isRestrictedAuthTokenKind("future_kind")).toBe(true);
        expect(isRestrictedAuthTokenKind(undefined)).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "account_directory",
            routeOptions: { config: {} },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "account_directory",
            routeOptions: { config: { allowAccountDirectoryToken: true } },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "account_directory",
            externalActionExecutionAuthorized: true,
            externalActionEffectActionId: "session.list",
            routeOptions: { config: {} },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "api_token",
            externalActionExecutionAuthorized: true,
            externalActionEffectActionId: "session.list",
            routeOptions: { config: {} },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "api_token",
            routeOptions: { config: {} },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "api_token",
            externalActionExecutionAuthorized: true,
            externalActionEffectActionId: "session.activity.get",
            routeOptions: { config: {} },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "api_token",
            externalActionExecutionAuthorized: true,
            externalActionEffectActionId: "session.list",
            routeOptions: { config: {} },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "api_token",
            externalActionExecutionAuthorized: true,
            externalActionEffectActionId: "session.follow.sources.set",
            routeOptions: { config: {} },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "api_token",
            externalActionExecutionAuthorized: true,
            externalActionEffectActionId: "session.follow.sourceKey.prepare",
            routeOptions: { config: {} },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "api_token",
            externalActionExecutionAuthorized: true,
            routeOptions: { config: { allowApiToken: true } },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "account",
            routeOptions: { config: { allowAccountDirectoryToken: true } },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            routeOptions: { config: {} },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            externalActionExecutionAuthorized: true,
            externalActionEffectActionId: "session.list",
            routeOptions: { config: {} },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "account" } } },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "another-account",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "account" } } },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            params: { sessionId: "session-1" },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } } },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            params: { sessionId: "session-2" },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } } },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            body: { sessionId: "session-1", machineId: "machine-1" },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "body.sessionId", machine: "body.machineId", machineOptional: true } } },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            body: { sessionId: "session-1", machineId: null },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "body.sessionId", machine: "body.machineId", machineOptional: true } } },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            body: { sessionId: "session-1" },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "body.sessionId", machine: "body.machineId", machineOptional: true } } },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            body: { sessionId: "session-1", machineId: "machine-2" },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "body.sessionId", machine: "body.machineId", machineOptional: true } } },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            body: { sessionId: "session-2", machineId: "machine-1" },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "body.sessionId", machine: "body.machineId", machineOptional: true } } },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            body: {
                initiatorMachineId: "machine-1",
                consumer: { kind: "session", sessionId: "session-1" },
            },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "body.consumer.sessionId", machine: "body.initiatorMachineId" } } },
        })).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "ephemeral_session_runner",
            userId: "account-1",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "account-1",
                activationId: "activation-1",
                sessionId: "session-1",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: "public-key-1",
                creatorTokenEpoch: 0,
            },
            body: {
                initiatorMachineId: "machine-2",
                consumer: { kind: "session", sessionId: "session-1" },
            },
            routeOptions: { config: { restrictedCredentialBinding: { scope: "session", session: "body.consumer.sessionId", machine: "body.initiatorMachineId" } } },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "terminal",
            routeOptions: { config: { allowAccountDirectoryToken: true } },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: undefined,
            routeOptions: { config: { allowAccountDirectoryToken: true } },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: "future_kind",
            routeOptions: { config: {} },
        })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({
            authTokenKind: undefined,
            routeOptions: { config: {} },
        })).toBe(true);
    });

    it("centrally distinguishes public-compatible, anonymous-compatible, and forbidden Runner bearers", () => {
        expect(resolveOptionalPublicAuthDisposition(null)).toEqual({ status: "anonymous" });
        expect(resolveOptionalPublicAuthDisposition({
            userId: "account-1",
            authTokenKind: "account",
            authority: "present_user",
        })).toMatchObject({ status: "authenticated", principal: { userId: "account-1" } });
        expect(resolveOptionalPublicAuthDisposition({
            userId: "account-1",
            authTokenKind: "terminal",
            authority: "present_user",
        })).toMatchObject({ status: "authenticated", principal: { userId: "account-1" } });
        expect(resolveOptionalPublicAuthDisposition({
            userId: "account-1",
            authTokenKind: "api_token",
            authority: "account_automation",
        })).toEqual({ status: "anonymous" });
        expect(resolveOptionalPublicAuthDisposition({
            userId: "account-1",
            authTokenKind: "account_directory",
            authority: "present_user",
        })).toEqual({ status: "anonymous" });
        expect(resolveOptionalPublicAuthDisposition({
            userId: "account-1",
            authTokenKind: "ephemeral_session_runner",
            authority: "session_runtime",
        })).toEqual({ status: "session_runtime_forbidden" });
        expect(resolveOptionalPublicAuthDisposition({
            status: "rejected_restricted",
            authTokenKind: "ephemeral_session_runner",
        })).toEqual({ status: "session_runtime_forbidden" });
    });
});
