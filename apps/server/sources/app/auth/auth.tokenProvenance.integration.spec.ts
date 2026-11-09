import * as privacyKit from "privacy-kit";
import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { registerAuthEntryRoute } from "@/app/api/routes/auth/registerAuthEntryRoute";
import { SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

const MASTER_SECRET = "auth-provenance-integration-secret";

// Golden bearer produced with privacy-kit@0.0.25 using the exact call shape in
// immutable server-v0.2.11 (98ea8fb76733b1dd785d38c31360179cafa84824): its
// terminal routes called createToken(accountId, { session: requestId }). The
// decoded signed payload intentionally has no tokenEpoch or provenance marker.
const SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH =
    "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJyZWxlYXNlZC10ZXJtaW5hbC1hdXRoLW5vLWVwb2NoIiwic2Vzc2lvbiI6InRlcm1pbmFsLWF1dGgtcmVxdWVzdC1yZWxlYXNlZC0wLjIuMTEiLCJpYXQiOjE3ODkxOTU1MDEsIm5iZiI6MTc4OTE5NTUwMSwiaXNzIjoiaGFuZHkiLCJqdGkiOiJlM2QyZTFiOC04NGI0LTQxOWEtODVjMS1kZGYwMTIwMmE1ZWEifQ.jL7qNonZslnbKL-fpL3fLvpbp5H8HER8TLoN3sGkrCqPoGqaN1MPArOsP_Fi2EqUDObB4PgkE3FUo_BWrWpCBw";

function decodeJwtPayload(token: string): Record<string, unknown> {
    const encoded = token.split(".")[1];
    if (!encoded) throw new Error("token has no payload");
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
}

describe("auth token provenance (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-provenance-",
            initAuth: true,
            env: {
                HANDY_MASTER_SECRET: MASTER_SECRET,
                AUTH_TOKEN_CACHE_MAX_ENTRIES: "64",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accessKey.deleteMany(),
            () => db.ephemeralRunnerActivation.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        await harness.close();
    });

    it("keeps the signed terminal floor while verifying a terminal as the person", async () => {
        const account = await db.account.create({ data: { publicKey: "terminal-person-currentness" } });
        const token = await auth.createToken(account.id, undefined, { kind: "terminal", authority: "account_automation" });
        expect(decodeJwtPayload(token)).toMatchObject({ provenance: { kind: "terminal", authority: "account_automation" } });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ authTokenKind: "terminal",
            authTokenMintedAuthority: "account_automation", authority: "present_user" });
    });

    it("mints provenance as a signed top-level claim and projects every closed kind", async () => {
        const account = await db.account.create({
            data: { publicKey: "auth-provenance-all-kinds" },
            select: { id: true },
        });
        const cases = [
            { kind: "account" as const, authority: "present_user" as const, authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }] },
            { kind: "terminal" as const, authority: "account_automation" as const, authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }] },
            { kind: "account_directory" as const, authority: "present_user" as const, authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }] },
        ];

        for (const expected of cases) {
            const token = await auth.createToken(account.id, { source: expected.kind }, expected);
            const payload = decodeJwtPayload(token);
            expect(payload).toMatchObject({
                sub: account.id,
                provenance: {
                    v: 2,
                    kind: expected.kind,
                    authority: expected.authority,
                    evidence: expected.authenticationEvidence,
                },
            });
            expect(payload.extras).toBeUndefined();
            expect(typeof payload.tokenEpoch).toBe("number");

            await expect(auth.verifyToken(token)).resolves.toMatchObject({
                userId: account.id,
                authTokenKind: expected.kind,
                authority: expected.kind === "terminal" ? "present_user" : expected.authority,
                authenticationEvidence: expected.authenticationEvidence,
                extras: { source: expected.kind },
                legacy: false,
            });
        }
    });

    it("accepts the immutable server-v0.2.11 terminal bearer that omits tokenEpoch", async () => {
        const accountId = "released-terminal-auth-no-epoch";
        await db.account.create({
            data: { id: accountId, publicKey: "released-terminal-auth-no-epoch-key" },
        });

        expect(decodeJwtPayload(SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH)).toMatchObject({
            sub: accountId,
            session: "terminal-auth-request-released-0.2.11",
        });
        expect(decodeJwtPayload(SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH)).not.toHaveProperty("tokenEpoch");
        expect(decodeJwtPayload(SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH)).not.toHaveProperty("provenance");
        await expect(auth.verifyToken(SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH)).resolves.toBeNull();
        await expect(auth.verifyLegacyHomeToken(SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH)).resolves.toMatchObject({
            userId: accountId,
            extras: { session: "terminal-auth-request-released-0.2.11" },
            authTokenKind: "terminal",
            authority: "present_user",
            legacy: true,
        });
        await expect(auth.verifyTokenForRoute(SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH)).resolves.toMatchObject({
            userId: accountId,
            authTokenKind: "terminal",
            authority: "present_user",
            legacy: true,
        });

        await db.account.update({
            where: { id: accountId },
            data: { tokenEpoch: { increment: 1 } },
        });
        await expect(auth.verifyLegacyHomeToken(SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH)).resolves.toBeNull();
        await expect(auth.verifyTokenForRoute(SERVER_V0_2_11_TERMINAL_TOKEN_WITHOUT_EPOCH)).resolves.toBeNull();
    });

    it("admits a Runner credential only while its exact materialized scope remains current", async () => {
        const account = await db.account.create({ data: { publicKey: "runner-principal-account", encryptionMode: "plain" } });
        const activationId = randomUUID();
        const sessionId = "runner-principal-session";
        const machineId = "runner-principal-machine";
        const installationId = "runner-principal-installation";
        const installation = tweetnacl.sign.keyPair();
        const installationPublicKey = privacyKit.encodeBase64(Uint8Array.from(installation.publicKey), "base64url").replace(/=+$/u, "");
        await db.session.create({ data: { id: sessionId, accountId: account.id, tag: "runner-principal", metadata: "{}", encryptionMode: "plain", metadataLayoutVersion: 1 } });
        await db.machine.create({ data: {
            id: machineId,
            accountId: account.id,
            kind: "ephemeral_session_runner",
            metadata: "{}",
            installationId,
            installationPublicKey: Buffer.from(installation.publicKey),
        } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId, machineId, data: "runner-scoped-access" } });
        await db.ephemeralRunnerActivation.create({ data: {
            id: activationId,
            creatorAccountId: account.id,
            creatorTokenEpoch: account.tokenEpoch,
            draftId: "runner-principal-draft",
            sessionId,
            machineId,
            state: "materialized",
            workspacePolicy: "choose_on_endpoint",
            homeServerIdentityId: "srv_runner_principal",
            activationSigningPublicKey: installationPublicKey,
            authoringCommitment: "a".repeat(43),
            artifact: {},
            endpointFactsRecipient: { mode: "plain", creatorAccountId: account.id },
        } });
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: account.id,
            activationId,
            sessionId,
            machineId,
            installationId,
            installationPublicKey,
            creatorTokenEpoch: account.tokenEpoch,
        };
        const token = await auth.createToken(account.id, { ephemeralSessionRunnerPrincipal: principal }, {
            kind: "ephemeral_session_runner",
            authority: "session_runtime",
        });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({
            authTokenKind: "ephemeral_session_runner",
            authority: "session_runtime",
            ephemeralSessionRunnerPrincipal: principal,
        });

        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        registerAuthEntryRoute(app, { isEmailDeliveryReady: () => false });
        try {
            const entry = () => app.inject({ method: "POST", url: "/v1/auth/entry",
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, scope: { kind: "home" } } });
            const active = await entry();
            expect(active.statusCode, active.body).toBe(403);
            expect(active.headers["cache-control"]).toBe("no-store");
            expect(active.json()).toEqual({ error: SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR });
            await db.accessKey.delete({ where: { accountId_machineId_sessionId: { accountId: account.id, machineId, sessionId } } });
            await expect(auth.verifyToken(token)).resolves.toBeNull();
            const revoked = await entry();
            expect(revoked.statusCode, revoked.body).toBe(403);
            expect(revoked.json()).toEqual({ error: SESSION_RUNTIME_PUBLIC_AUTH_FORBIDDEN_ERROR });
        } finally {
            await app.close();
        }
    });

    it("self-attests the restored Home signing secret without exporting the temporary token", async () => {
        const account = await db.account.create({
            data: { id: "a-readiness-inactive", publicKey: "auth-personal-home-readiness", homeRole: "owner" },
            select: { id: true },
        });

        await expect(auth.attestPresentUserTokenRoundTrip()).resolves.toEqual({
            authenticated: true,
        });

        await db.account.update({ where: { id: account.id }, data: { status: "suspended" } });
        await expect(auth.attestPresentUserTokenRoundTrip()).rejects.toThrow();
        await db.account.create({ data: { id: "z-readiness-active", publicKey: "active-member-readiness" } });
        await expect(auth.attestPresentUserTokenRoundTrip()).resolves.toEqual({ authenticated: true });
        await db.account.deleteMany();
        await expect(auth.attestPresentUserTokenRoundTrip()).rejects.toThrow();
    });

    it("mints evidence-free credentials as V1 and rejects an explicitly empty V2 evidence set", async () => {
        const account = await db.account.create({
            data: { publicKey: "auth-provenance-authentication-methods" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        expect(decodeJwtPayload(token).provenance).toEqual({
            v: 1,
            kind: "account",
            authority: "present_user",
        });
        expect((await auth.verifyToken(token))?.authenticationEvidence).toBeUndefined();

        await expect(auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [],
        })).rejects.toThrow();
    });

    it("round-trips exact authentication evidence through the V2 marker", async () => {
        const account = await db.account.create({
            data: { publicKey: "auth-provenance-evidence" },
            select: { id: true },
        });
        const evidence = [{ kind: "home_method" as const, methodId: "key_challenge" }];
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: evidence,
        });
        expect(decodeJwtPayload(token).provenance).toEqual({
            v: 2,
            kind: "account",
            authority: "present_user",
            evidence,
        });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({
            userId: account.id,
            authenticationEvidence: evidence,
            legacy: false,
        });

        const sibling = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }],
        });
        expect((await auth.verifyToken(token))?.authenticationEvidence).toEqual(evidence);
        expect((await auth.verifyToken(sibling))?.authenticationEvidence).toEqual([
            { kind: "home_method", methodId: "email_password" },
        ]);
    });

    it("requires an explicit complete provenance decision and rejects non-canonical pairings at mint time", async () => {
        const account = await db.account.create({
            data: { publicKey: "auth-provenance-explicit-mint" },
            select: { id: true },
        });
        // Loosely typed alias: a legacy caller omitting the mint decision must
        // fail closed at runtime even though TypeScript now rejects the call.
        const mintWithoutRequiredDecision = auth.createToken.bind(auth) as (
            userId: string,
            extras?: unknown,
            options?: unknown,
        ) => Promise<string>;

        await expect(mintWithoutRequiredDecision(account.id)).rejects.toThrow();
        // The historical extras.session inference must no longer mint anything.
        await expect(mintWithoutRequiredDecision(account.id, { session: "terminal-session" })).rejects.toThrow();
        await expect(mintWithoutRequiredDecision(account.id, undefined, undefined)).rejects.toThrow();

        // The canonical kind/authority mapping is enforced at mint time.
        await expect(auth.createToken(account.id, undefined, {
            kind: "terminal",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        })).rejects.toThrow();
        await expect(auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "account_automation",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        })).rejects.toThrow();
        await expect(auth.createToken(account.id, undefined, {
            kind: "account_directory",
            authority: "account_automation",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        })).rejects.toThrow();
        // API tokens remain exclusively database-minted.
        await expect(auth.createToken(account.id, undefined, {
            kind: "api_token",
            authority: "account_automation",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        })).rejects.toThrow(/createApiToken/);
    });

    it("rejects missing, stripped, unknown, future, malformed, and semantically invalid markers on the strict verifier", async () => {
        const account = await db.account.create({
            data: { publicKey: "auth-provenance-invalid-markers" },
            select: { id: true },
        });
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: MASTER_SECRET,
        });
        const candidates: readonly Record<string, unknown>[] = [
            { tokenEpoch: 0 },
            { provenance: { v: 1, kind: "account", authority: "present_user" } },
            { tokenEpoch: 0, provenance: { v: 2, kind: "account", authority: "present_user" } },
            { tokenEpoch: 0, provenance: { v: 3, kind: "account", authority: "present_user", evidence: [{ kind: "home_method", methodId: "key_challenge" }] } },
            { tokenEpoch: 0, provenance: { v: 1, kind: "unknown", authority: "present_user" } },
            { tokenEpoch: 0, provenance: { v: 1, kind: "account" } },
            { tokenEpoch: 0, provenance: { v: 1, kind: "account", authority: "present_user", mintOrigin: "unexpected" } },
            { tokenEpoch: 0, provenance: "not-a-provenance-marker" },
            { tokenEpoch: 0, provenance: null },
            // Semantically invalid pairings fail closed even though both fields
            // are individually known.
            { tokenEpoch: 0, provenance: { v: 1, kind: "terminal", authority: "present_user" } },
            { tokenEpoch: 0, provenance: { v: 1, kind: "account", authority: "account_automation" } },
            { tokenEpoch: 0, provenance: { v: 2, kind: "account", authority: "account_automation", evidence: [{ kind: "home_method", methodId: "key_challenge" }] } },
            // `api_token` is a database-backed bearer credential; a signed
            // token claiming that kind is always rejected.
            { tokenEpoch: 0, provenance: { v: 1, kind: "api_token", authority: "account_automation" } },
            { tokenEpoch: 0, provenance: { v: 2, kind: "api_token", authority: "account_automation", evidence: [{ kind: "home_method", methodId: "key_challenge" }] } },
        ];

        for (const extras of candidates) {
            const token = await generator.new({ user: account.id, extras });
            await expect(auth.verifyToken(token)).resolves.toBeNull();
        }

        // The explicit compatibility reader accepts only the pre-marker shape;
        // it must not become a second path for malformed/new restricted tokens.
        const legacyToken = await generator.new({
            user: account.id,
            extras: { tokenEpoch: 0 },
        });
        await expect(auth.verifyToken(legacyToken)).resolves.toBeNull();
        await expect(auth.verifyLegacyHomeToken(legacyToken)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "account",
            authority: "present_user",
            legacy: true,
        });
        await expect(auth.verifyTokenForRoute(legacyToken)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "account",
            authority: "present_user",
            legacy: true,
        });

        // A malformed new marker is never reinterpreted as a legacy credential.
        const futureMarkerToken = await generator.new({
            user: account.id,
            extras: { tokenEpoch: 0, provenance: { v: 2, kind: "account", authority: "present_user" } },
        });
        await expect(auth.verifyLegacyHomeToken(futureMarkerToken)).resolves.toBeNull();
        const nonCanonicalPairingToken = await generator.new({
            user: account.id,
            extras: { tokenEpoch: 0, provenance: { v: 1, kind: "terminal", authority: "present_user" } },
        });
        await expect(auth.verifyLegacyHomeToken(nonCanonicalPairingToken)).resolves.toBeNull();
        // String-valued library metadata is part of the released pre-marker
        // shape, not a current provenance marker or authentication evidence.
        const legacyTokenWithOpaqueProvenanceMetadata = await generator.new({
            user: account.id,
            extras: { tokenEpoch: 0, provenance: "opaque-library-build-metadata" },
        });
        await expect(auth.verifyToken(legacyTokenWithOpaqueProvenanceMetadata)).resolves.toBeNull();
        await expect(auth.verifyLegacyHomeToken(legacyTokenWithOpaqueProvenanceMetadata)).resolves.toMatchObject({
            userId: account.id,
            extras: { provenance: "opaque-library-build-metadata" },
            authTokenKind: "account",
            authority: "present_user",
            legacy: true,
        });

        const directoryToken = await auth.createToken(account.id, undefined, {
            kind: "account_directory",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        const currentHomeToken = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        await expect(auth.verifyLegacyHomeToken(currentHomeToken)).resolves.toBeNull();
        await expect(auth.verifyLegacyHomeToken(directoryToken)).resolves.toBeNull();
        await expect(auth.verifyTokenForRoute(directoryToken)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "account_directory",
            legacy: false,
        });
    });

    it("rejects a cached Directory projection specifically when its epoch becomes stale", async () => {
        const account = await db.account.create({
            data: { publicKey: "auth-provenance-directory-epoch" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, {
            kind: "account_directory",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });

        await expect(auth.verifyToken(token)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "account_directory",
        });
        expect(auth.getCacheStats().size).toBeGreaterThan(0);

        await db.account.update({
            where: { id: account.id },
            data: { tokenEpoch: { increment: 1 } },
        });

        const currentToken = await auth.createToken(account.id, undefined, {
            kind: "account_directory",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        await expect(auth.verifyToken(currentToken)).resolves.toMatchObject({
            userId: account.id,
            authTokenKind: "account_directory",
        });

        await expect(auth.verifyToken(token)).resolves.toBeNull();
        await expect(auth.verifyLegacyHomeToken(token)).resolves.toBeNull();
    });
});
