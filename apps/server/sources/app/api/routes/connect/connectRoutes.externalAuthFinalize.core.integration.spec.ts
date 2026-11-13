import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The GitHub endpoints and avatar host are faked through the global fetch stub below.
vi.mock("@/app/net/outboundIdentityFetch", () => import("@/testkit/outboundFetchViaGlobalFetch"));
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { db } from "@/storage/db";
import { connectAuthExternalRoutes } from "./connectRoutes.authExternal";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { auth } from "@/app/auth/auth";
import { encryptString } from "@/modules/encrypt";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { registerTeamInvitationRoutes } from "@/app/teams/invitations/registerTeamInvitationRoutes";
import { digestTeamInvitationToken, mintTeamInvitationToken } from "@/app/teams/invitations/token";
import { eventRouter } from "@/app/events/connectionEventRouter";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


function createTestApp() {
    const app = Fastify({ logger: false, trustProxy: true });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return trackApp(typed);
}

function createAuthBody(seedByte = 7) {
    const seed = new Uint8Array(32).fill(seedByte);
    const kp = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = new Uint8Array(32).fill(9);
    const signature = tweetnacl.sign.detached(challenge, kp.secretKey);
    return {
        publicKeyHex: privacyKit.encodeHex(new Uint8Array(kp.publicKey)),
        signingKeyPair: kp,
        body: {
            publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
            challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
            signature: privacyKit.encodeBase64(new Uint8Array(signature)),
        },
    };
}

function applyGithubExternalAuthFinalizeEnv(
    harness: LightSqliteHarness,
    overrides: Record<string, string | undefined> = {},
): void {
    harness.resetEnv({
        AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
        AUTH_SIGNUP_PROVIDERS: "github",
        GITHUB_CLIENT_ID: "test_client",
        GITHUB_CLIENT_SECRET: "test_secret",
        GITHUB_REDIRECT_URL: "https://home.example.test/v1/oauth/github/callback",
        ...overrides,
    });
}

const ONE_BY_ONE_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z9e8AAAAASUVORK5CYII=",
    "base64",
);

describe("connectRoutes (external auth finalize) (integration)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-external-finalize-",
            initAuth: true,
            initEncrypt: true,
            initFiles: true,
        });
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        globalThis.fetch = originalFetch;
        await db.userFeedItem.deleteMany();
        await db.userRelationship.deleteMany();
        await db.repeatKey.deleteMany();
        await db.uploadedFile.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.teamMembership.deleteMany();
        await db.team.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
    });

    it("POST /v1/auth/external/:provider/finalize returns 404 unsupported-provider for unknown providers", async () => {
        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/unknown/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending: "p",
                publicKey: "k",
                challenge: "c",
                signature: "s",
            },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "unsupported-provider" });

        await app.close();
    });

    it("DELETE /v1/auth/external/github/pending/:pending deletes valid oauth_pending records (idempotent)", async () => {
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_deleteAA1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: "pk",
                    profileEnc: "p",
                    accessTokenEnc: "t",
                    suggestedUsername: null,
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "DELETE",
            url: "/v1/auth/external/github/pending/oauth_pending_deleteAA1",
        });

        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({ success: true });

        const row = await db.repeatKey.findUnique({ where: { key: "oauth_pending_deleteAA1" } });
        expect(row).toBeNull();

        // Second delete should still succeed.
        const res2 = await app.inject({
            method: "DELETE",
            url: "/v1/auth/external/github/pending/oauth_pending_deleteAA1",
        });
        expect(res2.statusCode).toBe(200);

        await app.close();
    });

    it("DELETE /v1/auth/external/github/pending/:pending does not delete non-oauth_pending keys", async () => {
        await db.repeatKey.create({
            data: {
                key: "not_oauth_pending_delete_1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: "pk",
                    profileEnc: "p",
                    accessTokenEnc: "t",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "DELETE",
            url: "/v1/auth/external/github/pending/not_oauth_pending_delete_1",
        });

        expect(res.statusCode).toBe(200);
        const row = await db.repeatKey.findUnique({ where: { key: "not_oauth_pending_delete_1" } });
        expect(row).not.toBeNull();

        await app.close();
    });

    it("DELETE /v1/auth/external/github/pending/:pending does not delete oauth_pending records for other providers", async () => {
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_deleteOtherProviderA1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "google",
                    publicKeyHex: "pk",
                    profileEnc: "p",
                    accessTokenEnc: "t",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "DELETE",
            url: "/v1/auth/external/github/pending/oauth_pending_deleteOtherProviderA1",
        });

        expect(res.statusCode).toBe(200);
        const row = await db.repeatKey.findUnique({ where: { key: "oauth_pending_deleteOtherProviderA1" } });
        expect(row).not.toBeNull();

        await app.close();
    });

    it("POST /v1/auth/external/github/finalize creates an account and returns a token", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody();

        const pending = "oauth_pending_pendingCreateA1";
        const githubProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_1"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                ...body,
            },
        });

        expect(res.statusCode, res.body).toBe(200);
        const json = res.json() as any;
        expect(json.success).toBe(true);
        expect(typeof json.token).toBe("string");
        expect(json.token.length).toBeGreaterThan(10);
        // Legacy pending records authenticate normally without inventing a
        // runtime fingerprint that was never bound by their OAuth attempt.
        const verified = await auth.verifyToken(json.token);
        expect(verified).toMatchObject({ authTokenKind: "account", authority: "present_user", legacy: false });
        expect(verified?.authenticationEvidence).toBeUndefined();

        const account = await db.account.findFirst({ where: { publicKey: publicKeyHex } });
        expect(account).toBeTruthy();
        expect(account?.username).toBe("octocat");

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account!.id, provider: "github" },
            select: { providerUserId: true, providerLogin: true },
        });
        expect(identity?.providerUserId).toBe(String(githubProfile.id));
        expect(identity?.providerLogin).toBe("octocat");

        await app.close();
    });

    it("atomically provisions an exact Team invitation when ordinary public keyed signup is denied", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "github",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "keyed",
        });
        const { body, publicKeyHex } = createAuthBody(41);
        const pending = "oauth_pending_teamInviteFresh1";
        const invitationToken = "team-invitation-fresh-account";
        const tokenHash = createHash("sha256").update(invitationToken, "utf8").digest();
        const team = await db.team.create({ data: { name: "Invited Fresh Account", admissionMode: "invite_only" } });
        const invitation = await db.teamInvitation.create({
            data: {
                teamId: team.id,
                tokenHash,
                role: "member",
                historyAccess: "from_membership",
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const resolved = await resolveOAuthRuntimeById(process.env, "github");
        expect(resolved?.reference.context).toEqual({ kind: "home" });
        const githubProfile = { id: 7001, login: "invited-fresh", avatar_url: "", name: "Invited Fresh" };
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    securityBinding: {
                        provider: resolved!.reference,
                        connection: null,
                        admission: {
                            kind: "team_invitation",
                            teamId: team.id,
                            providerId: "github",
                            providerOrigin: "home",
                            connectionId: null,
                            connectionRevision: null,
                            admissionMode: "invite_only",
                            invitationId: invitation.id,
                            tokenHash: tokenHash.toString("hex"),
                        },
                        purpose: "team_admission",
                    },
                    publicKeyHex,
                    profileEnc: privacyKit.encodeBase64(encryptString(
                        ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                        JSON.stringify(githubProfile),
                    )),
                    accessTokenEnc: privacyKit.encodeBase64(encryptString(
                        ["auth", "external", "github", "pending", pending, publicKeyHex],
                        "team_invitation_access_token",
                    )),
                    suggestedUsername: githubProfile.login,
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();
        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
            payload: { pending, ...body },
        });

        expect(response.statusCode, response.body).toBe(200);
        const account = await db.account.findUniqueOrThrow({ where: { publicKey: publicKeyHex } });
        await expect(auth.verifyToken(response.json().token)).resolves.toMatchObject({
            userId: account.id, authTokenKind: "account", authority: "present_user",
        });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).resolves.toMatchObject({ status: "active", role: "member" });
        await expect(db.teamInvitation.findUnique({ where: { id: invitation.id } }))
            .resolves.toMatchObject({ acceptedByAccountId: account.id });
        await expect(db.repeatKey.findUnique({ where: { key: pending } })).resolves.toBeNull();
        await app.close();
    });

    it("authenticates an existing Account without consuming its Team invitation, then joins only through the explicit action", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);
        const { body, publicKeyHex } = createAuthBody(43);
        const pending = "oauth_pending_teamInviteExisting1";
        const invitationToken = mintTeamInvitationToken();
        const tokenHash = new Uint8Array(digestTeamInvitationToken(invitationToken));
        const account = await db.account.create({
            data: { publicKey: publicKeyHex, encryptionMode: "e2ee", username: "existing-invitee" },
        });
        const team = await db.team.create({ data: { name: "Invited Existing Account", admissionMode: "invite_only" } });
        const invitation = await db.teamInvitation.create({
            data: {
                teamId: team.id,
                tokenHash,
                role: "member",
                historyAccess: "from_membership",
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const resolved = await resolveOAuthRuntimeById(process.env, "github");
        const githubProfile = { id: 7003, login: "existing-invitee", avatar_url: "", name: "Existing Invitee" };
        const pendingValue = JSON.stringify({
            flow: "auth",
            provider: "github",
            securityBinding: {
                provider: resolved!.reference,
                connection: null,
                admission: {
                    kind: "team_invitation",
                    teamId: team.id,
                    providerId: "github",
                    providerOrigin: "home",
                    connectionId: null,
                    connectionRevision: null,
                    admissionMode: "invite_only",
                    invitationId: invitation.id,
                    tokenHash: Buffer.from(tokenHash).toString("hex"),
                },
                purpose: "team_admission",
            },
            publicKeyHex,
            profileEnc: privacyKit.encodeBase64(encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            )),
            accessTokenEnc: privacyKit.encodeBase64(encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex],
                "team_invitation_existing_access_token",
            )),
            suggestedUsername: githubProfile.login,
            usernameRequired: false,
            usernameReason: null,
        });
        await db.repeatKey.create({
            data: {
                key: pending,
                value: pendingValue,
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        registerTeamInvitationRoutes(app, {
            resolveJoinLinkTarget: async () => ({ applicationOrigin: "https://app.example.test", homeTarget: null }),
            resolveJoinScreenHomeIdentity: async () => ({
                serverId: "home-1",
                displayName: "Test Home",
                storageMode: "encrypted",
                hosting: null,
            }),
            email: {
                delivery: { isReady: async () => true, deliver: async () => ({ status: "sent" as const }) },
                isDeliveryReady: () => true,
            },
        });
        await app.ready();

        const cancelled = await app.inject({
            method: "DELETE",
            url: `/v1/auth/external/github/pending/${pending}`,
        });
        expect(cancelled.statusCode, cancelled.body).toBe(200);
        await expect(db.teamInvitation.findUnique({ where: { id: invitation.id } }))
            .resolves.toMatchObject({ acceptedAt: null, acceptedByAccountId: null });
        await db.repeatKey.create({
            data: {
                key: pending,
                value: pendingValue,
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const authenticated = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending, ...body },
        });
        expect(authenticated.statusCode, authenticated.body).toBe(200);
        const continuation = authenticated.json().teamInvitationContinuation;
        expect(continuation).toEqual({
            v: 1,
            kind: "post_auth_invitation",
            reference: pending,
            teamId: team.id,
        });
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();
        await expect(db.teamInvitation.findUnique({ where: { id: invitation.id } }))
            .resolves.toMatchObject({ acceptedAt: null, acceptedByAccountId: null });

        const joined = await app.inject({
            method: "POST",
            url: "/v1/team-invitations/accept",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${authenticated.json().token}`,
            },
            payload: { v: 1, continuation },
        });
        expect(joined.statusCode, joined.body).toBe(200);
        expect(joined.json()).toEqual({ outcome: "joined", teamId: team.id });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).resolves.toMatchObject({ status: "active", role: "member" });
        const replay = await app.inject({
            method: "POST",
            url: "/v1/team-invitations/accept",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${authenticated.json().token}`,
            },
            payload: { v: 1, continuation },
        });
        expect(replay.json()).toEqual({ outcome: "not_found" });
        await app.close();
    });

    it("rolls back a revoked invitation admission even when ordinary public keyed signup is denied", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "github",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "keyed",
        });
        const { body, publicKeyHex } = createAuthBody(42);
        const pending = "oauth_pending_teamInviteRollback1";
        const tokenHash = createHash("sha256").update("rollback-invitation", "utf8").digest();
        const team = await db.team.create({ data: { name: "Rejected Fresh Account", admissionMode: "invite_only" } });
        const invitation = await db.teamInvitation.create({
            data: {
                teamId: team.id,
                tokenHash,
                recipientEmailNormalized: "required@example.test",
                role: "member",
                historyAccess: "from_membership",
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const resolved = await resolveOAuthRuntimeById(process.env, "github");
        const githubProfile = { id: 7002, login: "rejected-fresh", avatar_url: "", name: "Rejected Fresh" };
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    securityBinding: {
                        provider: resolved!.reference,
                        connection: null,
                        admission: {
                            kind: "team_invitation",
                            teamId: team.id,
                            providerId: "github",
                            providerOrigin: "home",
                            connectionId: null,
                            connectionRevision: null,
                            admissionMode: "invite_only",
                            invitationId: invitation.id,
                            tokenHash: tokenHash.toString("hex"),
                        },
                        purpose: "team_admission",
                    },
                    publicKeyHex,
                    profileEnc: privacyKit.encodeBase64(encryptString(
                        ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                        JSON.stringify(githubProfile),
                    )),
                    accessTokenEnc: privacyKit.encodeBase64(encryptString(
                        ["auth", "external", "github", "pending", pending, publicKeyHex],
                        "team_invitation_rollback_token",
                    )),
                    suggestedUsername: githubProfile.login,
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        await db.teamInvitation.update({
            where: { id: invitation.id },
            data: { revokedAt: new Date() },
        });

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();
        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
            payload: { pending, ...body },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: "team_authentication_required" });
        await expect(db.account.findUnique({ where: { publicKey: publicKeyHex } })).resolves.toBeNull();
        await expect(db.accountIdentity.findFirst({ where: { provider: "github", providerUserId: "7002" } }))
            .resolves.toBeNull();
        await expect(db.teamMembership.count({ where: { teamId: team.id } })).resolves.toBe(0);
        await expect(db.repeatKey.findUnique({ where: { key: pending } })).resolves.not.toBeNull();
        await app.close();
    });

    it("POST /v1/auth/external/github/finalize rejects a Directory continuation bound to keyless finalization", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody(17);
        const proof = "directory_new_account_proof";
        const proofHash = createHash("sha256")
            .update(proof, "utf8")
            .digest("hex");
        const pending = "oauth_pending_DirectoryKeyedCreateA1";
        const githubProfile = {
            id: 321,
            login: "directory-new-user",
            avatar_url: "",
            name: "Directory New User",
        };
        const pendingPrefix = [
            "auth",
            "external",
            "github",
            "pending_v2",
            pending,
        ];
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    v: 2,
                    flow: "auth",
                    authMode: "keyless",
                    purpose: "account_directory",
                    provider: "github",
                    endpointUrl: "https://accounts.example.test",
                    endpointServerIdentityId: "srv_accounts_1",
                    canonicalServerUrl: "https://accounts.example.test",
                    proofHash,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            [...pendingPrefix, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(
                            [...pendingPrefix, "token"],
                            "directory_new_account_token",
                        ),
                    ),
                    suggestedUsername: "directory-new-user",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                proof,
                ...body,
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-pending" });
        const account = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
            select: { id: true, encryptionMode: true },
        });
        expect(account).toBeNull();

        await app.close();
    });

    it("rejects a different signed content key for an existing keyed account without mutating it", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const {
            body,
            publicKeyHex,
            signingKeyPair,
        } = createAuthBody(61);
        const originalContentKey = tweetnacl.box.keyPair();
        const replacementContentKey = tweetnacl.box.keyPair();

        const originalSignature = signAccountContentKeyBindingV1({
            accountSigningSecretKey: signingKeyPair.secretKey,
            contentPublicKey: originalContentKey.publicKey,
        });

        const replacementSignature = signAccountContentKeyBindingV1({
            accountSigningSecretKey: signingKeyPair.secretKey,
            contentPublicKey: replacementContentKey.publicKey,
        });
        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                username: "existing-oauth-user",
                contentPublicKey: new Uint8Array(originalContentKey.publicKey),
                contentPublicKeySig: new Uint8Array(originalSignature),
            },
            select: { id: true, updatedAt: true },
        });

        const pending = "oauth_pending_contentKeyMismatchA1";
        const githubProfile = {
            id: 6123,
            login: "oauth-mismatch",
            avatar_url: "https://avatars.example.test/content-key-mismatch.png",
            name: "Content Key Mismatch",
        };
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending, publicKeyHex],
                            "tok_content_key_mismatch",
                        ),
                    ),
                    suggestedUsername: "oauth-mismatch",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                ...body,
                contentPublicKey: privacyKit.encodeBase64(
                    new Uint8Array(replacementContentKey.publicKey),
                ),
                contentPublicKeySig: privacyKit.encodeBase64(
                    new Uint8Array(replacementSignature),
                ),
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
            error: "content_public_key_mismatch",
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                username: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            username: "existing-oauth-user",
            contentPublicKey: new Uint8Array(originalContentKey.publicKey),
            contentPublicKeySig: new Uint8Array(originalSignature),
            updatedAt: account.updatedAt,
        });
        await expect(db.accountIdentity.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);

        await app.close();
    });

    it.each([
        { contentKeyOutcome: "different" as const, expectedStatus: 409 },
        { contentKeyOutcome: "equal" as const, expectedStatus: 200 },
    ])("resolves a raced OAuth Account winner with a $contentKeyOutcome content key", async ({
        contentKeyOutcome,
        expectedStatus,
    }) => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const {
            body,
            publicKeyHex,
            signingKeyPair,
        } = createAuthBody(62);
        const winnerContentKey = tweetnacl.box.keyPair();
        const requestedContentKey = contentKeyOutcome === "equal"
            ? winnerContentKey
            : tweetnacl.box.keyPair();
        const winnerSignature = signAccountContentKeyBindingV1({
            accountSigningSecretKey: signingKeyPair.secretKey,
            contentPublicKey: winnerContentKey.publicKey,
        });
        const requestedSignature = signAccountContentKeyBindingV1({
            accountSigningSecretKey: signingKeyPair.secretKey,
            contentPublicKey: requestedContentKey.publicKey,
        });
        const pending = "oauth_pending_contentKeyRaceA1";
        const githubProfile = {
            id: 6223,
            login: "oauth-race",
            avatar_url: "https://avatars.example.test/content-key-race.png",
            name: "Content Key Race",
        };
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending, publicKeyHex],
                            "tok_content_key_race",
                        ),
                    ),
                    suggestedUsername: "oauth-race",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        // Test-only scheduling wrapper around the real Prisma boundary.
        const accountDelegate = db.account as any;
        const originalFindUnique = accountDelegate.findUnique;
        let racedAccount:
            | Readonly<{ id: string; updatedAt: Date }>
            | undefined;
        let injectedRaceWinner = false;
        accountDelegate.findUnique = async (args: any) => {
            const result = await originalFindUnique.call(
                accountDelegate,
                args,
            );
            if (
                !injectedRaceWinner
                && args?.where?.publicKey === publicKeyHex
                && result === null
            ) {
                injectedRaceWinner = true;
                racedAccount = await db.account.create({
                    data: {
                        publicKey: publicKeyHex,
                        username: "race-winner",
                        contentPublicKey:
                            new Uint8Array(winnerContentKey.publicKey),
                        contentPublicKeySig:
                            new Uint8Array(winnerSignature),
                    },
                    select: { id: true, updatedAt: true },
                });
            }
            return result;
        };

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();
        let response;
        try {
            response = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload: {
                    pending,
                    ...body,
                    contentPublicKey: privacyKit.encodeBase64(
                        new Uint8Array(requestedContentKey.publicKey),
                    ),
                    contentPublicKeySig: privacyKit.encodeBase64(
                        new Uint8Array(requestedSignature),
                    ),
                },
            });
        } finally {
            accountDelegate.findUnique = originalFindUnique;
        }

        expect(response!.statusCode, response!.body).toBe(expectedStatus);
        expect(racedAccount).toBeDefined();
        await expect(db.account.findUniqueOrThrow({
            where: { id: racedAccount!.id },
            select: {
                username: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                updatedAt: true,
            },
        })).resolves.toMatchObject({
            username: "race-winner",
            contentPublicKey:
                new Uint8Array(winnerContentKey.publicKey),
            contentPublicKeySig:
                new Uint8Array(winnerSignature),
            ...(contentKeyOutcome === "different"
                ? { updatedAt: racedAccount!.updatedAt }
                : {}),
        });

        if (contentKeyOutcome === "different") {
            expect(response!.json()).toEqual({
                error: "content_public_key_mismatch",
            });
            await expect(db.accountIdentity.count({
                where: { accountId: racedAccount!.id },
            })).resolves.toBe(0);
        } else {
            expect(response!.json()).toMatchObject({ success: true });
            await expect(auth.verifyToken(response!.json().token)).resolves.toMatchObject({
                userId: racedAccount!.id,
                authTokenKind: "account",
                authority: "present_user",
            });
            await expect(db.accountIdentity.findFirst({
                where: { accountId: racedAccount!.id, provider: "github" },
                select: { providerUserId: true },
            })).resolves.toEqual({ providerUserId: String(githubProfile.id) });
            await expect(db.repeatKey.findUnique({ where: { key: pending } })).resolves.toBeNull();
        }

        await app.close();
    });

    it("POST /v1/auth/external/github/finalize returns 403 forbidden when keyed provisioning is denied for public requests", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "github",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "keyed",
        });

        const { body, publicKeyHex } = createAuthBody();

        const pending = "oauth_pending_publicBlockedA1";
        const githubProfile = {
            id: 223,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_public"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
            payload: {
                pending,
                ...body,
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "forbidden" });
        expect(await db.account.findFirst({ where: { publicKey: publicKeyHex } })).toBeNull();

        await app.close();
    });

    it("returns 400 username-required when pending indicates username is required and no username is provided", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody(9);

        const pending = "oauth_pending_usernameRequiredA1";
        const githubProfile = {
            id: 124,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_2"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: true,
                    usernameReason: "login_taken",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                ...body,
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "username-required" });

        const accounts = await db.account.findMany({ where: { publicKey: publicKeyHex } });
        expect(accounts.length).toBe(0);

        await app.close();
    });

    it("creates an account when username is provided for a username-required pending", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody(10);

        const pending = "oauth_pending_usernameRequiredA2";
        const githubProfile = {
            id: 125,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_3"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: true,
                    usernameReason: "login_taken",
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending,
                username: "octocat_2",
                ...body,
            },
        });

        expect(res.statusCode).toBe(200);

        const account = await db.account.findFirst({ where: { publicKey: publicKeyHex } });
        expect(account?.username).toBe("octocat_2");
        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account!.id, provider: "github" },
            select: { providerUserId: true, providerLogin: true },
        });
        expect(identity?.providerUserId).toBe(String(githubProfile.id));
        expect(identity?.providerLogin).toBe("octocat");

        await app.close();
    });

    it("returns 409 provider-already-linked when an identity is linked to another account", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(7);
        const { body: body2, publicKeyHex: pk2 } = createAuthBody(8);

        const githubProfile = {
            id: 777,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        // First finalize connects GitHub identity to pk1.
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_pendingAuthA1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk1,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", "oauth_pending_pendingAuthA1", pk1, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", "oauth_pending_pendingAuthA1", pk1], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const ok = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: "oauth_pending_pendingAuthA1", ...body1 },
        });
        expect(ok.statusCode).toBe(200);

        // Second finalize attempts to connect same GitHub identity to pk2.
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_pendingAuthA2",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk2,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", "oauth_pending_pendingAuthA2", pk2, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", "oauth_pending_pendingAuthA2", pk2], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: "oauth_pending_pendingAuthA2", ...body2 },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "provider-already-linked", provider: "github" });

        const stillOne = await db.accountIdentity.findMany({
            where: { provider: "github", providerUserId: String(githubProfile.id) },
            select: { accountId: true },
        });
        expect(stillOne.length).toBe(1);

        await app.close();
    });

    it("resets the account and migrates social relationships when reset=true and the provider identity is already linked", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        });

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(21);
        const {
            body: body2,
            publicKeyHex: pk2,
            signingKeyPair: resetSigningKeyPair,
        } = createAuthBody(22);
        const resetContentKey = tweetnacl.box.keyPair();
        const resetContentKeySignature = signAccountContentKeyBindingV1({
            accountSigningSecretKey: resetSigningKeyPair.secretKey,
            contentPublicKey: resetContentKey.publicKey,
        });

        const githubProfile = {
            id: 888,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        // First finalize links identity to pk1 (username should become "octocat").
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_pendingResetA1",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk1,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", "oauth_pending_pendingResetA1", pk1, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", "oauth_pending_pendingResetA1", pk1], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const ok = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: "oauth_pending_pendingResetA1", ...body1 },
        });
        expect(ok.statusCode).toBe(200);

        const oldAccount = await db.account.findFirst({ where: { publicKey: pk1 }, select: { id: true, username: true } });
        expect(oldAccount?.username).toBe("octocat");

        // Socket disconnection is an external transport boundary. Keep the
        // provider reset, disablement and credential revocation path real.
        const disconnectAccountSockets = vi.spyOn(eventRouter, "disconnectAccountSockets");
        const oldPat = await auth.createApiToken({ accountId: oldAccount!.id, tokenId: crypto.randomUUID(), label: 'Before provider reset' });

        // Add some social data to be migrated.
        const friend = await db.account.create({ data: { publicKey: "pk_friend_reset", username: "friend1" } });
        await db.userRelationship.createMany({
            data: [
                { fromUserId: oldAccount!.id, toUserId: friend.id, status: "friend" },
                { fromUserId: friend.id, toUserId: oldAccount!.id, status: "friend" },
            ],
        });
        await db.userFeedItem.create({
            data: {
                userId: oldAccount!.id,
                counter: BigInt(1),
                body: { t: "friend_accepted", v: 1 },
            } as any,
        });
        await db.account.update({
            where: { id: oldAccount!.id },
            data: { feedSeq: BigInt(1) },
        });

        // Second finalize uses a new device key and requests a reset.
        await db.repeatKey.create({
            data: {
                key: "oauth_pending_pendingResetA2",
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk2,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", "oauth_pending_pendingResetA2", pk2, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", "oauth_pending_pendingResetA2", pk2], "tok_2"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: {
                pending: "oauth_pending_pendingResetA2",
                reset: true,
                ...body2,
                contentPublicKey: privacyKit.encodeBase64(
                    new Uint8Array(resetContentKey.publicKey),
                ),
                contentPublicKeySig: privacyKit.encodeBase64(
                    new Uint8Array(resetContentKeySignature),
                ),
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(expect.objectContaining({ success: true, token: expect.any(String) }));

        const newAccount = await db.account.findFirst({
            where: { publicKey: pk2 },
            select: {
                id: true,
                username: true,
                feedSeq: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        expect(newAccount?.username).toBe("octocat");
        expect(disconnectAccountSockets).toHaveBeenCalledWith(oldAccount!.id);
        expect(await auth.verifyPat(oldPat.token)).toEqual({ ok: false, reason: 'invalid_token' });
        expect(await auth.listApiTokens(newAccount!.id)).toEqual([]);
        expect(newAccount?.feedSeq?.toString()).toBe("1");
        expect(newAccount?.contentPublicKey).toEqual(
            new Uint8Array(resetContentKey.publicKey),
        );
        expect(newAccount?.contentPublicKeySig).toEqual(
            new Uint8Array(resetContentKeySignature),
        );

        // Social relationships moved to the new account.
        const rels = await db.userRelationship.findMany({
            where: {
                OR: [{ fromUserId: newAccount!.id }, { toUserId: newAccount!.id }],
            },
            select: { fromUserId: true, toUserId: true },
        });
        expect(rels.length).toBeGreaterThan(0);
        const oldRels = await db.userRelationship.findMany({
            where: {
                OR: [{ fromUserId: oldAccount!.id }, { toUserId: oldAccount!.id }],
            },
            select: { fromUserId: true },
        });
        expect(oldRels.length).toBe(0);

        const feedMoved = await db.userFeedItem.findMany({
            where: { userId: newAccount!.id },
            select: { id: true },
        });
        expect(feedMoved.length).toBeGreaterThan(0);

        await app.close();
    });

    it("provider reset transfers Home role and Team membership lifetimes and retires the replaced Account through the canonical lifecycle", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        });

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(41);
        const { body: body2, publicKeyHex: pk2 } = createAuthBody(42);
        const githubProfile = { id: 909, login: "ownercat", avatar_url: null, name: "Owner Cat" };

        const writePending = async (key: string, publicKeyHex: string) => {
            await db.repeatKey.create({
                data: {
                    key,
                    value: JSON.stringify({
                        flow: "auth",
                        provider: "github",
                        publicKeyHex,
                        profileEnc: privacyKit.encodeBase64(encryptString(
                            ["auth", "external", "github", "pending", key, publicKeyHex, "profile"],
                            JSON.stringify(githubProfile),
                        )),
                        accessTokenEnc: privacyKit.encodeBase64(encryptString(
                            ["auth", "external", "github", "pending", key, publicKeyHex], "tok",
                        )),
                        suggestedUsername: "ownercat",
                        usernameRequired: false,
                        usernameReason: null,
                    }),
                    expiresAt: new Date(Date.now() + 60_000),
                },
            });
        };

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();
        app.disconnectAccountSockets = () => {};

        await writePending("oauth_pending_pendingResetOwner1", pk1);
        expect((await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: "oauth_pending_pendingResetOwner1", ...body1 },
        })).statusCode).toBe(200);

        const oldAccount = await db.account.findFirstOrThrow({ where: { publicKey: pk1 }, select: { id: true } });

        // The replaced Account is this Home's only owner and holds a Team
        // membership lifetime that downstream Group rows and grants key on.
        await db.account.update({ where: { id: oldAccount.id }, data: { homeRole: "owner" } });
        const team = await db.team.create({ data: { name: "Platform" }, select: { id: true } });
        const historyCutoff = new Date("2026-01-01T00:00:00.000Z");
        const membership = await db.teamMembership.create({
            data: {
                teamId: team.id,
                accountId: oldAccount.id,
                role: "owner",
                sessionAccessStartsAt: historyCutoff,
            },
            select: { id: true },
        });

        await writePending("oauth_pending_pendingResetOwner2", pk2);
        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: "oauth_pending_pendingResetOwner2", reset: true, ...body2 },
        });
        expect(res.statusCode).toBe(200);

        const newAccount = await db.account.findFirstOrThrow({
            where: { publicKey: pk2 },
            select: { id: true, homeRole: true, status: true },
        });
        // The replacement inherits Home authority, so the Home is never left
        // ownerless by the retirement that follows in the same transaction.
        expect(newAccount.homeRole).toBe("owner");
        expect(newAccount.status).toBe("active");

        // The replaced Account is retired through the canonical lifecycle
        // column, not only an expiring disable marker, so it can no longer
        // satisfy an active-owner check.
        const retired = await db.account.findUniqueOrThrow({
            where: { id: oldAccount.id },
            select: { status: true, homeRole: true },
        });
        expect(retired.status).toBe("disabled");
        expect(await db.account.count({ where: { homeRole: "owner", status: "active" } })).toBe(1);

        // Only accountId moves: the membership lifetime identity and its
        // history horizon are preserved for Group rows and grants.
        const moved = await db.teamMembership.findUniqueOrThrow({
            where: { id: membership.id },
            select: { accountId: true, teamId: true, role: true, sessionAccessStartsAt: true },
        });
        expect(moved).toEqual({
            accountId: newAccount.id,
            teamId: team.id,
            role: "owner",
            sessionAccessStartsAt: historyCutoff,
        });
        expect(await db.teamMembership.count({ where: { accountId: oldAccount.id } })).toBe(0);

        await app.close();
    });

    it("does not migrate social data when provider reset disableAccount fails (restores old identity, keeps pending)", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        });

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(31);
        const { body: body2, publicKeyHex: pk2 } = createAuthBody(32);

        const githubProfile = {
            id: 889,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const pending1 = "oauth_pending_disableFailResetA1";
        await db.repeatKey.create({
            data: {
                key: pending1,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk1,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending1, pk1, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", pending1, pk1], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const ok = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: pending1, ...body1 },
        });
        expect(ok.statusCode).toBe(200);

        const oldAccount = await db.account.findFirst({ where: { publicKey: pk1 }, select: { id: true, username: true } });
        expect(oldAccount?.username).toBe("octocat");
        const oldIdentityBefore = await db.accountIdentity.findMany({
            where: { accountId: oldAccount!.id, provider: "github" },
            select: { id: true },
        });
        expect(oldIdentityBefore.length).toBe(1);

        // Add social data to ensure it does not migrate.
        const friend = await db.account.create({ data: { publicKey: "pk_friend_disable_reset", username: "friend1" } });
        await db.userRelationship.createMany({
            data: [
                { fromUserId: oldAccount!.id, toUserId: friend.id, status: "friend" },
                { fromUserId: friend.id, toUserId: oldAccount!.id, status: "friend" },
            ],
        });
        await db.userFeedItem.create({
            data: {
                userId: oldAccount!.id,
                counter: BigInt(1),
                body: { t: "friend_accepted", v: 1 },
            } as any,
        });
        await db.account.update({
            where: { id: oldAccount!.id },
            data: { feedSeq: BigInt(1) },
        });

        const pending2 = "oauth_pending_disableFailResetA2";
        await db.repeatKey.create({
            data: {
                key: pending2,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk2,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending2, pk2, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", pending2, pk2], "tok_2"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        // The canonical lifecycle status write must fail inside the real
        // caller-owned replacement transaction. RepeatKey is intentionally no
        // longer a lifecycle writer.
        await db.$executeRawUnsafe(`CREATE TRIGGER fail_provider_reset_disable
            BEFORE UPDATE OF status ON Account
            WHEN OLD.id = '${oldAccount!.id}' AND NEW.status = 'disabled'
            BEGIN SELECT RAISE(ABORT, 'disable failed'); END`);
        try {
            const res = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload: { pending: pending2, reset: true, ...body2 },
            });

            expect(res.statusCode).toBe(500);

            const newAccount = await db.account.findFirst({ where: { publicKey: pk2 }, select: { id: true } });
            expect(newAccount).toBeNull();

            const oldAccountAfter = await db.account.findUnique({
                where: { id: oldAccount!.id },
                select: { username: true },
            });
            expect(oldAccountAfter?.username).toBe("octocat");

            const oldIdentityAfter = await db.accountIdentity.findMany({
                where: { accountId: oldAccount!.id, provider: "github" },
                select: { id: true },
            });
            expect(oldIdentityAfter.length).toBe(1);

            const relsForOld = await db.userRelationship.findMany({
                where: { OR: [{ fromUserId: oldAccount!.id }, { toUserId: oldAccount!.id }] },
                select: { fromUserId: true, toUserId: true },
            });
            expect(relsForOld.length).toBeGreaterThan(0);

            const feedForOld = await db.userFeedItem.findMany({ where: { userId: oldAccount!.id }, select: { id: true } });
            expect(feedForOld.length).toBeGreaterThan(0);

            const stillPending = await db.repeatKey.findUnique({ where: { key: pending2 } });
            expect(stillPending).toBeTruthy();
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER fail_provider_reset_disable");
        }

        await app.close();
    });

    it("rolls back replacement Account creation when identity transfer fails without compensating erasure", async () => {
        applyGithubExternalAuthFinalizeEnv(harness, {
            HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: "1",
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "secret",
            GITHUB_REDIRECT_URL: "https://server.example.test/v1/oauth/github/callback",
        });

        const { body: body1, publicKeyHex: pk1 } = createAuthBody(41);
        const { body: body2, publicKeyHex: pk2 } = createAuthBody(42);

        const githubProfile = {
            id: 890,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        vi.stubGlobal("fetch", (async (url: any) => {
            if (url === githubProfile.avatar_url) {
                return {
                    arrayBuffer: async () =>
                        ONE_BY_ONE_PNG.buffer.slice(
                            ONE_BY_ONE_PNG.byteOffset,
                            ONE_BY_ONE_PNG.byteOffset + ONE_BY_ONE_PNG.byteLength,
                        ),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }) as any);

        const app = createTestApp();
        connectAuthExternalRoutes(app);
        await app.ready();

        const pending1 = "oauth_pending_detachFailResetA1";
        await db.repeatKey.create({
            data: {
                key: pending1,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk1,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending1, pk1, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", pending1, pk1], "tok_1"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        const ok = await app.inject({
            method: "POST",
            url: "/v1/auth/external/github/finalize",
            headers: { "content-type": "application/json" },
            payload: { pending: pending1, ...body1 },
        });
        expect(ok.statusCode).toBe(200);

        const oldAccount = await db.account.findFirst({ where: { publicKey: pk1 }, select: { id: true } });
        expect(oldAccount).toBeTruthy();

        const pending2 = "oauth_pending_detachFailResetA2";
        await db.repeatKey.create({
            data: {
                key: pending2,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex: pk2,
                    profileEnc: privacyKit.encodeBase64(
                        encryptString(
                            ["auth", "external", "github", "pending", pending2, pk2, "profile"],
                            JSON.stringify(githubProfile),
                        ),
                    ),
                    accessTokenEnc: privacyKit.encodeBase64(
                        encryptString(["auth", "external", "github", "pending", pending2, pk2], "tok_2"),
                    ),
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        await db.$executeRawUnsafe(`CREATE TRIGGER fail_provider_reset_detach
            BEFORE DELETE ON AccountIdentity
            BEGIN SELECT RAISE(ABORT, 'detach failed'); END`);
        // A database boundary failure also prevents compensating Account erasure.
        // Atomic rollback must leave no replacement row without relying on that cleanup.
        await db.$executeRawUnsafe(`CREATE TRIGGER fail_provider_reset_compensating_erasure
            BEFORE DELETE ON Account
            BEGIN SELECT RAISE(ABORT, 'erasure unavailable'); END`);
        try {
            const res = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload: { pending: pending2, reset: true, ...body2 },
            });

            expect(res.statusCode).toBe(500);

            const newAccount = await db.account.findFirst({ where: { publicKey: pk2 }, select: { id: true } });
            expect(newAccount).toBeNull();

            const oldIdentity = await db.accountIdentity.findMany({
                where: { accountId: oldAccount!.id, provider: "github" },
                select: { id: true },
            });
            expect(oldIdentity.length).toBe(1);

            const stillPending = await db.repeatKey.findUnique({ where: { key: pending2 } });
            expect(stillPending).toBeTruthy();
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER fail_provider_reset_detach");
            await db.$executeRawUnsafe("DROP TRIGGER fail_provider_reset_compensating_erasure");
        }

        await app.close();
    });

    it("cleans up newly created account when GitHub connect fails, leaving the pending key for retry", async () => {
        applyGithubExternalAuthFinalizeEnv(harness);

        const { body, publicKeyHex } = createAuthBody(11);

        const pending = "oauth_pending_connectFailureA1";
        const githubProfile = {
            id: 999,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo-fail.png",
            name: "Octo Cat",
        };

        const tokenEnc = privacyKit.encodeBase64(
            encryptString(["auth", "external", "github", "pending", pending, publicKeyHex], "tok_9"),
        );
        const profileEnc = privacyKit.encodeBase64(
            encryptString(
                ["auth", "external", "github", "pending", pending, publicKeyHex, "profile"],
                JSON.stringify(githubProfile),
            ),
        );
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    flow: "auth",
                    provider: "github",
                    publicKeyHex,
                    profileEnc,
                    accessTokenEnc: tokenEnc,
                    suggestedUsername: "octocat",
                    usernameRequired: false,
                    usernameReason: null,
                }),
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        // Fail at the database boundary while exercising the real finalizer and identity lifecycle.
        await db.$executeRawUnsafe(`CREATE TRIGGER fail_identity_connect
            BEFORE INSERT ON AccountIdentity
            BEGIN SELECT RAISE(ABORT, 'connect failed'); END`);

        let app: ReturnType<typeof createTestApp> | null = null;
        try {
            app = createTestApp();
            connectAuthExternalRoutes(app);
            await app.ready();

            const res = await app.inject({
                method: "POST",
                url: "/v1/auth/external/github/finalize",
                headers: { "content-type": "application/json" },
                payload: { pending, ...body },
            });
            expect(res.statusCode).toBe(500);

            const account = await db.account.findFirst({ where: { publicKey: publicKeyHex }, select: { id: true } });
            expect(account).toBeNull();

            const stillPending = await db.repeatKey.findUnique({ where: { key: pending } });
            expect(stillPending).toBeTruthy();
        } finally {
            if (app) {
                await app.close();
            }
            await db.$executeRawUnsafe("DROP TRIGGER fail_identity_connect");
        }
    });
});
