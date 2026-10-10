import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { createHash } from "node:crypto";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { registerMtlsAuthRoutes } from "@/app/auth/providers/mtls/registerMtlsAuthRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { readAuthMtlsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { inTx } from "@/storage/inTx";
import {
    consumeAccountEncryptionFirstKeyExternalAuthProofInTx,
} from "@/app/auth/accountEncryptionFirstKeyExternalAuthProof";
import { digestTeamInvitationToken, mintTeamInvitationToken } from "@/app/teams/invitations/token";
import { isEffectiveHomeAuthMethodActionEnabled } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveTeamAuthenticationPolicyInTx } from "@/app/auth/entry/resolveTeamAuthenticationPolicy";
import { qualifyTeamAuthenticationInTx } from "@/app/auth/entry/qualifyTeamAuthentication";

const { trackApp, closeTrackedApps } = createAppCloseTracker();


function createTestApp() {
    const app = Fastify({ logger: false, trustProxy: true });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    return trackApp(typed);
}

describe("authRoutes (mTLS) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-mtls-",
            initAuth: true,
        });
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS mtls_invitation_mint_failure');
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.teamInvitation.deleteMany().catch(() => {});
        await db.teamMembership.deleteMany().catch(() => {});
        await db.team.deleteMany().catch(() => {});
        await db.repeatKey.deleteMany().catch(() => {});
        await db.homeGovernancePolicy.deleteMany().catch(() => {});
        await db.homeSettings.deleteMany();
        await db.accountIdentity.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("auto-provisions with saved Home mTLS policy and refuses provisioning after it is disabled", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });
        delete process.env.HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION;
        await db.homeSettings.create({ data: {
            id: "home",
            values: { HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: true },
        } });
        expect(readAuthMtlsFeatureEnv(process.env).allowedIssuers).toEqual(["cn=example root ca"]);

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "  CN=Example Root CA  ",
            },
        });

        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as any;
        expect(body.success).toBe(true);
        expect(typeof body.token).toBe("string");
        expect(body.token.length).toBeGreaterThan(10);

        const accounts = await db.account.findMany({
            include: { AccountIdentity: { orderBy: { provider: "asc" } } },
            orderBy: { createdAt: "asc" },
        });
        expect(accounts).toHaveLength(1);
        expect(accounts[0]?.publicKey).toBeNull();
        expect(accounts[0]?.AccountIdentity?.[0]?.provider).toBe("mtls");
        expect(accounts[0]?.AccountIdentity?.[0]?.providerUserId).toBe("alice@example.com");

        await db.homeSettings.update({ where: { id: "home" }, data: {
            values: { HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: false },
        } });
        const disabledProvisioning = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "bob@example.com",
                "x-happier-client-cert-sha256": "sha256:bob",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(disabledProvisioning.statusCode).toBe(403);
        expect(disabledProvisioning.json()).toEqual({ error: "not-eligible" });
        expect(await db.account.count()).toBe(1);

        await db.account.update({ where: { id: accounts[0]!.id }, data: { status: "suspended" } });
        const inactive = await app.inject({ method: "POST", url: "/v1/auth/mtls", headers: {
            "x-happier-client-cert-email": "alice@example.com",
            "x-happier-client-cert-sha256": "sha256:abc123",
            "x-happier-client-cert-issuer": "CN=Example Root CA",
        } });
        expect(inactive.statusCode).toBe(403);
        expect(inactive.json()).toEqual({ error: "account-disabled" });
        const invalidProof = await app.inject({ method: "POST", url: "/v1/auth/mtls" });
        expect(invalidProof.statusCode).toBe(401);
        expect(invalidProof.json().error).not.toBe("account-disabled");

        await app.close();
    });

    it.each(["mtls", "key_challenge"] as const)("uses one exact Team invitation to atomically provision an mTLS Account without requiring %s qualification", async (acceptedMethod) => {
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                authenticationPolicy: {
                    v: 1,
                    enabledMethodIds: ["mtls"],
                    admission: "invitation_only",
                },
            },
        });
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: {
            name: "mTLS invitation Team",
            admissionMode: "invite_only",
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: acceptedMethod }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const invitationToken = mintTeamInvitationToken();
        const invitation = await db.teamInvitation.create({ data: {
            teamId: team.id,
            tokenHash: Buffer.from(digestTeamInvitationToken(invitationToken)),
            role: "member",
            historyAccess: "from_membership",
            createdByAccountId: owner.id,
            expiresAt: new Date(Date.now() + 60_000),
        } });
        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();
        await expect(isEffectiveHomeAuthMethodActionEnabled({
            env: process.env,
            methodId: "mtls",
            actionId: "provision",
            mode: "keyless",
            admission: { kind: "team_invitation" },
        })).resolves.toBe(true);
        await expect(inTx((tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: process.env,
            teamId: team.id,
            policy: team.authenticationPolicy,
            admission: { kind: "team_invitation" },
        }))).resolves.toMatchObject({
            resolution: {
                status: "restricted",
                choices: [expect.objectContaining({
                    reference: { kind: "home_method", methodId: acceptedMethod },
                })],
            },
        });
        const headers = {
            "x-happier-client-cert-email": "joiner@example.com",
            "x-happier-client-cert-sha256": "sha256:team-joiner",
            "x-happier-client-cert-issuer": "CN=Example Root CA",
        };

        process.env.HAPPIER_BUILD_FEATURES_DENY = "teams";
        const featureDenied = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers,
            payload: { admission: { kind: "team_invitation", token: invitationToken } },
        });
        expect(featureDenied.statusCode, featureDenied.body).toBe(403);
        expect(featureDenied.json()).toEqual({ error: "not-eligible" });
        expect(await db.accountIdentity.findFirst({
            where: { provider: "mtls", providerUserId: "joiner@example.com" },
        })).toBeNull();
        expect(await db.account.count()).toBe(1);
        expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(1);
        await expect(db.teamInvitation.findUniqueOrThrow({
            where: { id: invitation.id },
            select: { acceptedAt: true, acceptedByAccountId: true },
        })).resolves.toEqual({ acceptedAt: null, acceptedByAccountId: null });
        delete process.env.HAPPIER_BUILD_FEATURES_DENY;

        // The database boundary changes the newly admitted Account before the
        // real token owner revalidates it. No internal finalizer is mocked out.
        await db.$executeRawUnsafe(`CREATE TRIGGER mtls_invitation_mint_failure
            AFTER INSERT ON TeamMembership WHEN NEW.role = 'member'
            BEGIN UPDATE Account SET status = 'suspended' WHERE id = NEW.accountId; END`);
        const failed = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers,
            payload: { admission: { kind: "team_invitation", token: invitationToken } },
        });
        expect(failed.statusCode).toBe(403);
        expect(await db.accountIdentity.findFirst({
            where: { provider: "mtls", providerUserId: "joiner@example.com" },
        })).toBeNull();
        expect(await db.account.count()).toBe(1);
        expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(1);
        await expect(db.teamInvitation.findUniqueOrThrow({
            where: { id: invitation.id },
            select: { acceptedAt: true, acceptedByAccountId: true },
        })).resolves.toEqual({ acceptedAt: null, acceptedByAccountId: null });

        await db.$executeRawUnsafe('DROP TRIGGER mtls_invitation_mint_failure');
        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers,
            payload: { admission: { kind: "team_invitation", token: invitationToken } },
        });

        expect(response.statusCode, JSON.stringify({
            body: response.body,
            accounts: await db.account.count(),
            identities: await db.accountIdentity.count(),
            invitations: await db.teamInvitation.findMany({
                select: { acceptedAt: true, acceptedByAccountId: true },
            }),
        })).toBe(200);
        const account = await db.accountIdentity.findFirstOrThrow({
            where: { provider: "mtls", providerUserId: "joiner@example.com" },
        });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.accountId } },
        })).resolves.toMatchObject({ role: "member" });

        if (acceptedMethod === "key_challenge") {
            const principal = await auth.verifyToken(response.json().token);
            expect(principal).not.toBeNull();
            const qualification = await inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
                env: process.env,
                team,
                accountId: account.accountId,
                verifiedCredentialEvidence: principal?.authenticationEvidence,
                operationContext: { kind: "present_user" },
            }));
            expect(qualification.status).not.toBe("satisfied");
        }

        const replay = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: { ...headers, "x-happier-client-cert-email": "other@example.com" },
            payload: { admission: { kind: "team_invitation", token: invitationToken } },
        });
        expect(replay.statusCode).toBe(403);
        await expect(db.accountIdentity.findFirst({
            where: { provider: "mtls", providerUserId: "other@example.com" },
        })).resolves.toBeNull();
        await app.close();
    });

    it("rejects direct mTLS login when persisted Home policy disables mTLS", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "0",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
        });
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "mtls",
            providerUserId: "policy-disabled@example.com",
            profile: {},
        } });
        await db.homeGovernancePolicy.create({ data: {
            id: "home",
            authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
        } });
        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: { "x-happier-client-cert-email": "policy-disabled@example.com" },
        });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toEqual({ error: "not-eligible" });
    });

    it("authenticates an existing forwarded-mTLS Account without silently accepting its Team invitation", async () => {
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
        });
        await db.homeGovernancePolicy.create({ data: {
            id: "home",
            authenticationPolicy: {
                v: 1,
                enabledMethodIds: ["mtls"],
                admission: "invitation_only",
            },
        } });
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "mtls",
            providerUserId: "forwarded-existing@example.com",
            profile: {},
        } });
        const team = await db.team.create({ data: {
            name: "Forwarded existing Team",
            admissionMode: "invite_only",
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "mtls" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const invitationToken = mintTeamInvitationToken();
        const invitation = await db.teamInvitation.create({ data: {
            teamId: team.id,
            tokenHash: Buffer.from(digestTeamInvitationToken(invitationToken)),
            role: "member",
            historyAccess: "from_membership",
            createdByAccountId: owner.id,
            expiresAt: new Date(Date.now() + 60_000),
        } });
        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: { "x-happier-client-cert-email": "forwarded-existing@example.com" },
            payload: { admission: { kind: "team_invitation", token: invitationToken } },
        });

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
            success: true,
            token: expect.any(String),
        });
        const responseToken = (response.json() as { token: string }).token;
        expect((await auth.verifyToken(responseToken))?.authenticationEvidence).toEqual([
            { kind: "home_method", methodId: "mtls" },
        ]);
        expect(response.json()).not.toHaveProperty("teamInvitationContinuation");
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();
        await expect(db.teamInvitation.findUniqueOrThrow({
            where: { id: invitation.id },
            select: { acceptedAt: true, acceptedByAccountId: true },
        })).resolves.toEqual({ acceptedAt: null, acceptedByAccountId: null });
    });

    it("rolls back a fresh Account when the identity write fails", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
        });
        // Inject a storage failure at the real database boundary, keeping the
        // authentication, admission and identity lifecycle implementations real.
        await db.$executeRawUnsafe(`CREATE TRIGGER fail_mtls_identity_insert
            BEFORE INSERT ON AccountIdentity WHEN NEW.provider = 'mtls'
            BEGIN SELECT RAISE(ABORT, 'identity storage unavailable'); END`);
        try {
            const app = createTestApp();
            enableAuthentication(app);
            registerMtlsAuthRoutes(app);
            await app.ready();
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/mtls",
                headers: { "x-happier-client-cert-email": "alice@example.com" },
            });
            expect(response.statusCode).toBe(500);
            expect(await db.account.count()).toBe(0);
            expect(await db.accountIdentity.count()).toBe(0);
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER fail_mtls_identity_insert");
        }
    });

    it.each([
        ["account_encryption_first_key", `aemrb1_${"A".repeat(43)}`],
        ["account_password_enrollment", "A".repeat(43)],
    ] as const)("uses the existing mTLS claim lifecycle for request-bound %s", async (purpose, requestDigest) => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "0",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "mtls",
                providerUserId: "alice@example.com",
                profile: {},
            },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const proof = "fresh-mtls-browser-proof";
        const proofHash = createHash("sha256")
            .update(proof, "utf8")
            .digest("hex");
        const app = createTestApp();
        enableAuthentication(app);
        registerMtlsAuthRoutes(app);
        await app.ready();

        const missingBearer = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
            payload: {
                purpose,
                proofHash,
                requestDigest,
            },
        });
        expect(missingBearer.statusCode).toBe(401);

        const malformedStepUp = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                authorization: `Bearer ${token}`,
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
            payload: {
                purpose,
                proofHash,
            },
        });
        expect(malformedStepUp.statusCode, malformedStepUp.body).toBe(400);
        expect(malformedStepUp.json()).toEqual({
            error: "invalid-step-up-request",
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                authorization: `Bearer ${token}`,
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
            payload: {
                purpose,
                proofHash,
                requestDigest,
            },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            pending: expect.any(String),
        });
        const pending = response.json().pending as string;
        const row = await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${pending}` },
        });
        expect(JSON.parse(row!.value)).toEqual({
            userId: account.id,
            purpose,
            providerUserId: "alice@example.com",
            proofHash,
            securityBinding: expect.stringMatching(/^[0-9a-f]{64}$/),
            requestDigest,
        });
        const proofOwner = await import("@/app/auth/accountEncryptionFirstKeyExternalAuthProof");
        const consume = purpose === "account_password_enrollment"
            ? proofOwner.consumeAccountPasswordEnrollmentExternalAuthProofInTx
            : consumeAccountEncryptionFirstKeyExternalAuthProofInTx;
        await expect(inTx(async (tx) =>
            await consume(
                tx,
                {
                    accountId: account.id,
                    requestDigest,
                    externalAuthProof: {
                        provider: "mtls",
                        pending,
                        proof,
                    },
                },
            ))).resolves.toEqual({
            ok: true,
            provider: "mtls",
            providerUserId: "alice@example.com",
        });
        await expect(inTx(async (tx) =>
            await consume(
                tx,
                {
                    accountId: account.id,
                    requestDigest,
                    externalAuthProof: {
                        provider: "mtls",
                        pending,
                        proof,
                    },
                },
            ))).resolves.toEqual({
            ok: false,
            reason: "invalid_or_consumed",
        });

        await app.close();
    });

    it("returns restore-required when the mTLS identity maps to an e2ee account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "0",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const account = await db.account.create({
            data: {
                publicKey: "pk-mtls-e2ee",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "mtls",
                providerUserId: "alice@example.com",
                providerLogin: "alice@example.com",
                profile: { issuer: "CN=Example Root CA" } as any,
                showOnProfile: false,
            },
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });

        expect(res.statusCode, res.body).toBe(409);
        expect(res.json()).toEqual({ error: "restore-required" });

        await db.account.update({ where: { id: account.id }, data: { status: "suspended" } });
        const inactive = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(inactive.statusCode).toBe(403);
        expect(inactive.json()).toEqual({ error: "account-disabled" });

        await app.close();
    });

    it("returns not-eligible when public provisioning denylist blocks mTLS auto-provision", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "mtls",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "keyless",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
                "x-forwarded-for": "203.0.113.10",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("rejects a forwarded identity when an issuer allowlist is configured and the issuer does not match", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=trusted ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "CN=Untrusted CA",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("accepts an issuer allowlist match when the forwarded issuer is a full DN (CN extracted)", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "Example Root CA",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "C=US, O=Example Corp, CN=Example Root CA",
            },
        });

        expect(res.statusCode, res.body).toBe(200);

        await app.close();
    });

    it("rejects issuer allowlist entries that are full DNs when the forwarded issuer has the same CN but a different DN", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            // Full DN allowlist entry (intended to be exact-match, not just CN-match).
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "C=US, O=Example Corp, CN=Example Root CA",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                // Same CN but different organization.
                "x-happier-client-cert-issuer": "C=US, O=Other Corp, CN=Example Root CA",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("enforces allowed email domains when identitySource=san_upn", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_upn",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_UPN_HEADER: "x-happier-client-cert-upn",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-upn": "alice@evil.example",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("supports browser handoff via /start -> /complete -> /claim with saved Home mTLS policy", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "happier://",
        });
        delete process.env.HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION;
        await db.homeSettings.create({ data: {
            id: "home",
            values: { HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: true },
        } });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const startRes = await app.inject({
            method: "GET",
            url: "/v1/auth/mtls/start?returnTo=" + encodeURIComponent("happier://auth/return"),
        });
        expect(startRes.statusCode).toBe(302);
        const completeUrl = String(startRes.headers.location ?? "");
        expect(completeUrl).toContain("/v1/auth/mtls/complete");

        const completeRes = await app.inject({
            method: "GET",
            url: completeUrl,
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(completeRes.statusCode, completeRes.body).toBe(302);
        const returnUrl = String(completeRes.headers.location ?? "");
        const parsed = new URL(returnUrl);
        expect(parsed.protocol).toBe("happier:");
        const code = parsed.searchParams.get("code");
        expect(typeof code).toBe("string");
        expect(code?.length ?? 0).toBeGreaterThan(10);

        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code },
        });
        expect(claimRes.statusCode).toBe(200);
        const claimBody = claimRes.json() as any;
        expect(claimBody.success).toBe(true);
        expect(typeof claimBody.token).toBe("string");

        // Claim codes must be single-use to avoid replay within the TTL window.
        const claimRes2 = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code },
        });
        expect(claimRes2.statusCode).toBe(401);
        expect(claimRes2.json()).toEqual({ error: "invalid-code" });

        const nextComplete = await app.inject({
            method: "GET",
            url: completeUrl,
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(nextComplete.statusCode).toBe(302);
        const pendingCode = new URL(String(nextComplete.headers.location)).searchParams.get("code");
        expect(pendingCode).toBeTruthy();
        const identity = await db.accountIdentity.findFirstOrThrow({ where: { provider: "mtls", providerUserId: "alice@example.com" } });
        await db.account.update({ where: { id: identity.accountId }, data: { status: "suspended" } });
        const inactiveClaim = await app.inject({ method: "POST", url: "/v1/auth/mtls/claim", payload: { code: pendingCode } });
        expect(inactiveClaim.statusCode).toBe(403);
        expect(inactiveClaim.json()).toEqual({ error: "account-disabled" });
        const retainedClaim = await app.inject({ method: "POST", url: "/v1/auth/mtls/claim", payload: { code: pendingCode } });
        expect(retainedClaim.statusCode).toBe(403);
        expect(retainedClaim.json()).toEqual({ error: "account-disabled" });
        expect(await db.repeatKey.findUnique({ where: { key: `mtls_claim_${pendingCode}` } })).not.toBeNull();
        await db.account.update({ where: { id: identity.accountId }, data: { status: "active" } });
        const recoveredClaim = await app.inject({ method: "POST", url: "/v1/auth/mtls/claim", payload: { code: pendingCode } });
        expect(recoveredClaim.statusCode, recoveredClaim.body).toBe(200);
        await db.account.update({ where: { id: identity.accountId }, data: { status: "suspended" } });

        const inactiveComplete = await app.inject({
            method: "GET",
            url: completeUrl,
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(inactiveComplete.statusCode).toBe(302);
        const inactiveReturn = new URL(String(inactiveComplete.headers.location));
        expect(inactiveReturn.searchParams.has("error")).toBe(false);
        const inactiveCompleteCode = inactiveReturn.searchParams.get("code");
        expect(inactiveCompleteCode).toBeTruthy();
        const inactiveCompleteClaim = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code: inactiveCompleteCode },
        });
        expect(inactiveCompleteClaim.statusCode).toBe(403);
        expect(inactiveCompleteClaim.json()).toEqual({ error: "account-disabled" });
        expect(await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${inactiveCompleteCode}` },
        })).not.toBeNull();
        const missingCertificate = await app.inject({ method: "GET", url: completeUrl });
        expect(missingCertificate.statusCode).toBe(401);
        expect(missingCertificate.json()).toEqual({ error: "mtls-required" });

        await app.close();
    });

    it("prepares a native Team invitation handoff without placing its bearer in the browser URL", async () => {
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "happier://",
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                authenticationPolicy: {
                    v: 1,
                    enabledMethodIds: ["mtls"],
                    admission: "invitation_only",
                },
            },
        });
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: {
            name: "Native mTLS Team",
            admissionMode: "invite_only",
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const invitationToken = mintTeamInvitationToken();
        await db.teamInvitation.create({ data: {
            teamId: team.id,
            tokenHash: Buffer.from(digestTeamInvitationToken(invitationToken)),
            role: "member",
            historyAccess: "from_membership",
            createdByAccountId: owner.id,
            expiresAt: new Date(Date.now() + 60_000),
        } });
        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        process.env.HAPPIER_BUILD_FEATURES_DENY = "teams";
        const deniedPreparation = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/start",
            payload: {
                returnTo: "happier://auth/return",
                teamId: team.id,
                admission: { kind: "team_invitation", token: invitationToken },
            },
        });
        expect(deniedPreparation.statusCode, deniedPreparation.body).toBe(403);
        expect(deniedPreparation.json()).toEqual({ error: "not-eligible" });
        await expect(db.teamInvitation.findFirstOrThrow({
            where: { teamId: team.id },
            select: { acceptedAt: true, acceptedByAccountId: true },
        })).resolves.toEqual({ acceptedAt: null, acceptedByAccountId: null });
        delete process.env.HAPPIER_BUILD_FEATURES_DENY;

        await db.team.update({ where: { id: team.id }, data: { admissionMode: "jit" } });
        const admissionPolicyDeniedPreparation = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/start",
            payload: {
                returnTo: "happier://auth/return",
                teamId: team.id,
                admission: { kind: "team_invitation", token: invitationToken },
            },
        });
        expect(admissionPolicyDeniedPreparation.statusCode, admissionPolicyDeniedPreparation.body).toBe(403);
        await db.team.update({ where: { id: team.id }, data: { admissionMode: "invite_only" } });

        const prepared = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/start",
            payload: {
                returnTo: "happier://auth/return",
                teamId: team.id,
                admission: { kind: "team_invitation", token: invitationToken },
            },
        });
        expect(prepared.statusCode, prepared.body).toBe(200);
        const preparation = prepared.json() as { startUrl: string; admissionReference: string };
        expect(preparation.admissionReference.length).toBeGreaterThan(10);
        expect(new URL(preparation.startUrl).protocol).toBe("http:");
        expect(preparation.startUrl).not.toContain(invitationToken);
        expect(preparation.startUrl).toContain(encodeURIComponent(preparation.admissionReference));

        const preparedStartUrl = new URL(preparation.startUrl);
        const started = await app.inject({ method: "GET", url: `${preparedStartUrl.pathname}${preparedStartUrl.search}` });
        expect(started.statusCode, started.body).toBe(302);
        const completeUrl = String(started.headers.location);
        expect(completeUrl).not.toContain(invitationToken);
        process.env.HAPPIER_BUILD_FEATURES_DENY = "teams";
        const deniedAfterStart = await app.inject({
            method: "GET",
            url: completeUrl,
            headers: {
                "x-happier-client-cert-email": "native-joiner@example.com",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(deniedAfterStart.statusCode, deniedAfterStart.body).toBe(302);
        const code = new URL(String(deniedAfterStart.headers.location)).searchParams.get("code");
        expect(code).toBe(preparation.admissionReference);
        expect(await db.accountIdentity.findFirst({
            where: { provider: "mtls", providerUserId: "native-joiner@example.com" },
        })).toBeNull();
        expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(1);
        await expect(db.teamInvitation.findFirstOrThrow({
            where: { teamId: team.id },
            select: { acceptedAt: true, acceptedByAccountId: true },
        })).resolves.toEqual({ acceptedAt: null, acceptedByAccountId: null });
        const deniedClaim = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: preparation.admissionReference },
        });
        expect(deniedClaim.statusCode, deniedClaim.body).toBe(401);
        expect(await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${code}` },
        })).not.toBeNull();
        delete process.env.HAPPIER_BUILD_FEATURES_DENY;

        process.env.HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS = "cn=another root ca";
        const deniedByCurrentMtlsPolicy = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: preparation.admissionReference },
        });
        expect(deniedByCurrentMtlsPolicy.statusCode, deniedByCurrentMtlsPolicy.body).toBe(401);
        expect(await db.accountIdentity.findFirst({
            where: { provider: "mtls", providerUserId: "native-joiner@example.com" },
        })).toBeNull();
        expect(await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${code}` },
        })).not.toBeNull();
        process.env.HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS = "cn=example root ca";

        await db.team.update({
            where: { id: team.id },
            data: { admissionMode: "jit" },
        });
        const deniedByCurrentAdmission = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: preparation.admissionReference },
        });
        expect(deniedByCurrentAdmission.statusCode, deniedByCurrentAdmission.body).toBe(401);
        expect(await db.accountIdentity.findFirst({
            where: { provider: "mtls", providerUserId: "native-joiner@example.com" },
        })).toBeNull();
        expect(await db.account.count()).toBe(1);
        expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(1);
        expect(await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${code}` },
        })).not.toBeNull();
        await db.team.update({
            where: { id: team.id },
            data: { admissionMode: "invite_only" },
        });

        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        // Protected-operation qualification is independent of this exact
        // invitation's structural admission, even after policy changes.
        const claimed = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: preparation.admissionReference },
        });
        expect(claimed.statusCode, claimed.body).toBe(200);
        expect(claimed.json()).toMatchObject({ success: true, token: expect.any(String), teamId: team.id });
        const identity = await db.accountIdentity.findFirstOrThrow({
            where: { provider: "mtls", providerUserId: "native-joiner@example.com" },
        });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: identity.accountId } },
        })).resolves.toMatchObject({ role: "member" });
        expect(await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${code}` },
        })).toBeNull();
        const replay = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: preparation.admissionReference },
        });
        expect(replay.statusCode).toBe(401);
    });

    it("binds native invitation references exactly for an existing Account and rejects expiry, revocation, mismatch, and replay", async () => {
        harness.resetEnv({
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "happier://",
        });
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "mtls",
            providerUserId: "existing@example.com",
            profile: {},
        } });
        const team = await db.team.create({ data: { name: "Existing Account Team", admissionMode: "invite_only" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();
        const createInvitation = async () => {
            const token = mintTeamInvitationToken();
            const invitation = await db.teamInvitation.create({ data: {
                teamId: team.id,
                tokenHash: Buffer.from(digestTeamInvitationToken(token)),
                role: "member",
                historyAccess: "from_membership",
                createdByAccountId: owner.id,
                expiresAt: new Date(Date.now() + 60_000),
            } });
            return { invitation, token };
        };
        const prepare = async (token: string) => app.inject({
            method: "POST",
            url: "/v1/auth/mtls/start",
            payload: { returnTo: "happier://auth/return", teamId: team.id, admission: { kind: "team_invitation", token } },
        });
        const headers = {
            "x-happier-client-cert-email": "existing@example.com",
            "x-happier-client-cert-issuer": "CN=Example Root CA",
        };

        const expiring = (await prepare((await createInvitation()).token)).json() as { startUrl: string; admissionReference: string };
        await db.repeatKey.update({
            where: { key: `mtls_claim_${expiring.admissionReference}` },
            data: { expiresAt: new Date(Date.now() - 1) },
        });
        const expiringStartUrl = new URL(expiring.startUrl);
        const expired = await app.inject({ method: "GET", url: `${expiringStartUrl.pathname}${expiringStartUrl.search}` });
        expect(expired.statusCode).toBe(400);
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();

        const revokedSource = await createInvitation();
        const revokedPreparation = (await prepare(revokedSource.token)).json() as { startUrl: string; admissionReference: string };
        const revokedStartUrl = new URL(revokedPreparation.startUrl);
        const revokedStart = await app.inject({ method: "GET", url: `${revokedStartUrl.pathname}${revokedStartUrl.search}` });
        await db.teamInvitation.update({ where: { id: revokedSource.invitation.id }, data: { revokedAt: new Date() } });
        const accountCountBeforeRevokedCompletion = await db.account.count();
        const revokedHeaders = {
            ...headers,
            "x-happier-client-cert-email": "revoked-new@example.com",
        };
        const revokedComplete = await app.inject({
            method: "GET",
            url: String(revokedStart.headers.location),
            headers: revokedHeaders,
        });
        expect(revokedComplete.statusCode, revokedComplete.body).toBe(302);
        const revokedCode = new URL(String(revokedComplete.headers.location)).searchParams.get("code");
        expect(revokedCode).toBe(revokedPreparation.admissionReference);
        expect(await db.account.count()).toBe(accountCountBeforeRevokedCompletion);
        expect(await db.accountIdentity.findFirst({
            where: { provider: "mtls", providerUserId: "revoked-new@example.com" },
        })).toBeNull();
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();
        const revokedClaim = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code: revokedCode, admissionReference: revokedPreparation.admissionReference },
        });
        expect(revokedClaim.statusCode).toBe(401);
        expect(await db.account.count()).toBe(accountCountBeforeRevokedCompletion);
        expect(await db.accountIdentity.findFirst({
            where: { provider: "mtls", providerUserId: "revoked-new@example.com" },
        })).toBeNull();
        expect(await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${revokedCode}` },
        })).not.toBeNull();

        const active = await createInvitation();
        const prepared = (await prepare(active.token)).json() as { startUrl: string; admissionReference: string };
        const started = await app.inject({ method: "GET", url: prepared.startUrl });
        expect((await app.inject({ method: "GET", url: prepared.startUrl })).statusCode).toBe(400);
        const completed = await app.inject({ method: "GET", url: String(started.headers.location), headers });
        expect(completed.statusCode).toBe(302);
        const code = new URL(String(completed.headers.location)).searchParams.get("code");
        expect(code).toBe(prepared.admissionReference);
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();
        await expect(db.teamInvitation.findUniqueOrThrow({
            where: { id: active.invitation.id },
            select: { acceptedAt: true, acceptedByAccountId: true },
        })).resolves.toEqual({ acceptedAt: null, acceptedByAccountId: null });
        const wrongClaim = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: "wrong-reference" },
        });
        expect(wrongClaim.statusCode).toBe(401);
        const claim = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: prepared.admissionReference },
        });
        expect(claim.statusCode, claim.body).toBe(200);
        expect(claim.json()).toMatchObject({
            teamId: team.id,
            token: expect.any(String),
            teamInvitationContinuation: {
                v: 1,
                kind: "post_auth_invitation",
                reference: `mtls_claim_${code}`,
                teamId: team.id,
            },
        });
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();
        await expect(db.teamInvitation.findUniqueOrThrow({
            where: { id: active.invitation.id },
            select: { acceptedAt: true, acceptedByAccountId: true },
        })).resolves.toEqual({ acceptedAt: null, acceptedByAccountId: null });
        const replay = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: prepared.admissionReference },
        });
        expect(replay.statusCode).toBe(401);
        expect(await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${code}` },
        })).not.toBeNull();
    });

    it("returns direct Team navigation context without manufacturing membership authority", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "0",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "happier://",
        });
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        await db.accountIdentity.create({ data: {
            accountId: account.id,
            provider: "mtls",
            providerUserId: "direct@example.com",
            profile: {},
        } });
        const team = await db.team.create({ data: { name: "Direct Team", admissionMode: "invite_only" } });
        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        const policyDeniedStart = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/start",
            payload: { returnTo: "happier://auth/return", teamId: team.id },
        });
        expect(policyDeniedStart.statusCode).toBe(403);
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: null } });
        const prepared = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/start",
            payload: { returnTo: "happier://auth/return", teamId: team.id },
        });
        expect(prepared.statusCode, prepared.body).toBe(200);
        const preparation = prepared.json() as { startUrl: string; admissionReference: string };
        const directStartUrl = new URL(preparation.startUrl);
        const started = await app.inject({ method: "GET", url: `${directStartUrl.pathname}${directStartUrl.search}` });
        expect(started.statusCode, started.body).toBe(302);
        const completed = await app.inject({
            method: "GET",
            url: String(started.headers.location),
            headers: { "x-happier-client-cert-email": "direct@example.com" },
        });
        expect(completed.statusCode, completed.body).toBe(302);
        const code = new URL(String(completed.headers.location)).searchParams.get("code");
        expect(code).toBe(preparation.admissionReference);
        const claimed = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls/claim",
            payload: { code, admissionReference: preparation.admissionReference },
        });
        expect(claimed.statusCode, claimed.body).toBe(200);
        expect(claimed.json()).toMatchObject({ teamId: team.id, token: expect.any(String) });
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();
    });

    it("allows only one successful /claim even under concurrent attempts", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=example root ca",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "happier://",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const startRes = await app.inject({
            method: "GET",
            url: "/v1/auth/mtls/start?returnTo=" + encodeURIComponent("happier://auth/return"),
        });
        expect(startRes.statusCode).toBe(302);

        const completeRes = await app.inject({
            method: "GET",
            url: String(startRes.headers.location ?? ""),
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-issuer": "CN=Example Root CA",
            },
        });
        expect(completeRes.statusCode).toBe(302);

        const returnUrl = new URL(String(completeRes.headers.location ?? ""));
        const code = returnUrl.searchParams.get("code");
        expect(code).toBeTruthy();

        const [c1, c2] = await Promise.all([
            app.inject({ method: "POST", url: "/v1/auth/mtls/claim", payload: { code } }),
            app.inject({ method: "POST", url: "/v1/auth/mtls/claim", payload: { code } }),
        ]);

        const statuses = [c1.statusCode, c2.statusCode].sort();
        expect(statuses).toEqual([200, 401]);

        await app.close();
    });

    it("rejects returnTo values that only match by string prefix but do not match the allowed origin", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",

            // A common operator config: "only allow returnTo into the webapp origin".
            HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES: "https://app.happier.dev",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url:
                "/v1/auth/mtls/start?returnTo=" +
                encodeURIComponent("https://app.happier.dev.evil.com/oauth/mtls"),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-returnTo" });

        await app.close();
    });

    it("does not register mTLS routes when server storagePolicy=required_e2ee", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
                "x-happier-client-cert-sha256": "sha256:abc123",
            },
        });

        expect(res.statusCode).toBe(404);

        await app.close();
    });

    it("rejects identities that do not match allowed email domains", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            AUTH_ANONYMOUS_SIGNUP_ENABLED: "0",
            AUTH_SIGNUP_PROVIDERS: "",

            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",

            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "1",
            HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
            HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: "1",
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: "x-happier-client-cert-sha256",
        });

        const app = createTestApp();
        registerMtlsAuthRoutes(app);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/mtls",
            headers: {
                "x-happier-client-cert-email": "alice@evil.example",
                "x-happier-client-cert-sha256": "sha256:abc123",
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });
});
