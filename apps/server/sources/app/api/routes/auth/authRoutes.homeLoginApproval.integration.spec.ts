import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { HOME_LOGIN_APPROVAL_DECISION_HTTP_PATH_V1, HOME_LOGIN_APPROVALS_HTTP_PATH_V1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { auth } from "@/app/auth/auth";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import type { Fastify as AppFastify } from "../../types";
import { authRoutes } from "./authRoutes";
import { createHomeApprovalGate } from "./homeApprovalGate";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { enableErrorHandlers } from "../../utils/enableErrorHandlers";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    enableErrorHandlers(typed);
    return trackApp(typed);
}

const APPROVAL_ENV = { HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: "1" } as const;

const baseRowFacts = {
    requesterBoxPublicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    approvalBindingProof: "approval-binding-proof-1",
    issuerServerIdentityId: "srv_issuer",
    issuerSubjectId: "issuer-subject-1",
    deviceLabel: "Pixel 9" as string | null,
};

async function createAssertionRow(overrides: Partial<{
    accountId: string;
    secretHash: string;
    requestedPublicKey: string | null;
    requestedDeviceLabel: string | null;
    expiresAt: Date;
    flow: string;
    requesterIssuerServerIdentityId: string | null;
    requesterIssuerSubjectId: string | null;
    approvalStatus: string | null;
    decidedAt: Date | null;
}> = {}) {
    return db.authPairingSession.create({
        data: {
            accountId: overrides.accountId ?? (await ensurePrimaryAccount()).id,
            secretHash: overrides.secretHash ?? "seeded-assertion-secret-hash",
            requestedPublicKey: overrides.requestedPublicKey ?? baseRowFacts.requesterBoxPublicKeyBase64,
            requestedBindingProof: baseRowFacts.approvalBindingProof,
            requestedDeviceLabel: overrides.requestedDeviceLabel ?? baseRowFacts.deviceLabel,
            requestedAt: new Date(),
            expiresAt: overrides.expiresAt ?? new Date(Date.now() + 120_000),
            flow: overrides.flow ?? "account_assertion",
            requesterIssuerServerIdentityId: overrides.requesterIssuerServerIdentityId ?? baseRowFacts.issuerServerIdentityId,
            requesterIssuerSubjectId: overrides.requesterIssuerSubjectId ?? baseRowFacts.issuerSubjectId,
            approvalStatus: overrides.approvalStatus ?? "pending",
            decidedAt: overrides.decidedAt ?? null,
        },
    });
}

let primaryAccount: { id: string } | null = null;
async function ensurePrimaryAccount() {
    if (!primaryAccount) {
        primaryAccount = await db.account.create({
            data: { publicKey: `pk-home-approval-${Date.now()}` },
            select: { id: true },
        });
    }
    return primaryAccount;
}

describe("Home login approval (gate + routes) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-home-approval-",
            initAuth: true,
            initEncrypt: true,
            env: {
                HAPPIER_FEATURE_AUTH_PAIRING__DESKTOP_QR_MOBILE_SCAN_ENABLED: "1",
            },
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.authPairingSession.deleteMany().catch(() => {});
        primaryAccount = null;
        await db.accountDirectoryLink?.deleteMany?.().catch(() => {});
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    describe("HomeApprovalGate policy and pending lifecycle", () => {
        it("publishes one content-free Account wake per actual approval transition, never for unchanged evaluation or a denied decision", async () => {
            const account = await ensurePrimaryAccount();
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            const created = await gate.evaluate({ accountId: account.id, ...baseRowFacts });
            if (created.kind !== 'approval_required') throw new Error('Expected pending approval');
            const publication = await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'account', entityId: HOME_LOGIN_APPROVALS_HTTP_PATH_V1 } });
            expect(publication).toMatchObject({ cursor: before.seq + 1, hint: null });
            await gate.evaluate({ accountId: account.id, ...baseRowFacts });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq + 1);
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const app = createTestApp();
            authRoutes(app);
            await app.ready();
            const decide = () => app.inject({ method: 'POST', url: `/v1/auth/home-login/approvals/${created.request.approvalId}/decision`, headers: { authorization: `Bearer ${token}` }, payload: { decision: 'approve' } });
            expect((await decide()).json()).toEqual({ status: 'approved' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq + 2);
            expect((await decide()).json()).toEqual({ status: 'already_decided' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq + 2);
        });
        it("allows redemption immediately when the Home-local approval policy is disabled", async () => {
            const account = await ensurePrimaryAccount();
            const gate = createHomeApprovalGate({});
            const decision = await gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
            });
            expect(decision).toEqual({ kind: "allowed" });
            expect(await db.authPairingSession.count()).toBe(0);
        });

        it("creates one bounded pending request when the policy is enabled, without reusing a static secret", async () => {
            const account = await ensurePrimaryAccount();
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            const decision = await gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
            });
            expect(decision.kind).toBe("approval_required");
            if (decision.kind !== "approval_required") return;
            expect(decision.request.deviceLabel).toBe(baseRowFacts.deviceLabel);
            const ttlMs = decision.request.expiresAtMs - Date.now();
            expect(ttlMs).toBeGreaterThanOrEqual(25_000);
            expect(ttlMs).toBeLessThanOrEqual(605_000);

            const row = await db.authPairingSession.findUnique({ where: { id: decision.request.approvalId } });
            expect(row).toMatchObject({
                accountId: account.id,
                flow: "account_assertion",
                requestedPublicKey: baseRowFacts.requesterBoxPublicKeyBase64,
                requesterIssuerServerIdentityId: baseRowFacts.issuerServerIdentityId,
                requesterIssuerSubjectId: baseRowFacts.issuerSubjectId,
                approvalStatus: "pending",
            });
            // The assertion flow never receives the QR secret; the stored hash must be a
            // per-row server-generated value, not a shared constant.
            expect(row!.secretHash).not.toBe("account-assertion");
            expect(row!.secretHash.length).toBeGreaterThanOrEqual(16);

            const second = await createHomeApprovalGate(APPROVAL_ENV).evaluate({
                accountId: account.id,
                ...baseRowFacts,
                requesterBoxPublicKeyBase64: "second-requester-box-key-base64",
            });
            expect(second.kind).toBe("approval_required");
            if (second.kind !== "approval_required") return;
            const secondRow = await db.authPairingSession.findUnique({ where: { id: second.request.approvalId } });
            expect(secondRow!.secretHash).not.toBe(row!.secretHash);
        });

        it("honors the existing pairing TTL policy for pending expiry", async () => {
            const account = await ensurePrimaryAccount();
            const gate = createHomeApprovalGate({ ...APPROVAL_ENV, AUTH_PAIRING_TTL_SECONDS: "45" });
            const decision = await gate.evaluate({ accountId: account.id, ...baseRowFacts });
            expect(decision.kind).toBe("approval_required");
            if (decision.kind !== "approval_required") return;
            const ttlMs = decision.request.expiresAtMs - Date.now();
            expect(ttlMs).toBeGreaterThan(38_000);
            expect(ttlMs).toBeLessThanOrEqual(52_000);
        });

        it("never lets a pending approval outlive the assertion that authorized it", async () => {
            const account = await ensurePrimaryAccount();
            const assertionExpiresAtMs = Date.now() + 12_000;
            const gate = createHomeApprovalGate({ ...APPROVAL_ENV, AUTH_PAIRING_TTL_SECONDS: "45" });
            const decision = await gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
                assertionExpiresAtMs,
            });
            expect(decision.kind).toBe("approval_required");
            if (decision.kind !== "approval_required") return;
            expect(decision.request.expiresAtMs).toBeLessThanOrEqual(assertionExpiresAtMs);

            const reused = await gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
                assertionExpiresAtMs: assertionExpiresAtMs - 2_000,
            });
            expect(reused.kind).toBe("approval_required");
            if (reused.kind !== "approval_required") return;
            expect(reused.request.approvalId).toBe(decision.request.approvalId);
            expect(reused.request.expiresAtMs).toBeLessThanOrEqual(assertionExpiresAtMs - 2_000);
        });

        it("resolves the same pending request for identical requester facts instead of stacking rows", async () => {
            const account = await ensurePrimaryAccount();
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            const first = await gate.evaluate({ accountId: account.id, ...baseRowFacts });
            const second = await gate.evaluate({ accountId: account.id, ...baseRowFacts });
            expect(first.kind).toBe("approval_required");
            expect(second.kind).toBe("approval_required");
            if (first.kind !== "approval_required" || second.kind !== "approval_required") return;
            expect(second.request.approvalId).toBe(first.request.approvalId);
            expect(await db.authPairingSession.count({ where: { flow: "account_assertion" } })).toBe(1);
        });

        it("serializes concurrent identical requests onto one pending approval", async () => {
            const account = await ensurePrimaryAccount();
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            const decisions = await Promise.all([
                gate.evaluate({ accountId: account.id, ...baseRowFacts }),
                gate.evaluate({ accountId: account.id, ...baseRowFacts }),
            ]);
            expect(decisions.every((decision) => decision.kind === "approval_required")).toBe(true);
            const approvalIds = decisions.flatMap((decision) => (
                decision.kind === "approval_required" ? [decision.request.approvalId] : []
            ));
            expect(new Set(approvalIds).size).toBe(1);
            expect(await db.authPairingSession.count({ where: { flow: "account_assertion" } })).toBe(1);
        });

        it("starts a fresh request when the previously resolved one expired", async () => {
            const account = await ensurePrimaryAccount();
            const expired = await createAssertionRow({ expiresAt: new Date(Date.now() - 1_000) });
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            const decision = await gate.evaluate({ accountId: account.id, ...baseRowFacts });
            expect(decision.kind).toBe("approval_required");
            if (decision.kind !== "approval_required") return;
            expect(decision.request.approvalId).not.toBe(expired.id);
        });

        it("opportunistically removes an expired assertion request before creating its replacement", async () => {
            const account = await ensurePrimaryAccount();
            const expired = await createAssertionRow({ expiresAt: new Date(Date.now() - 5_000) });
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            await gate.evaluate({ accountId: account.id, ...baseRowFacts });
            await expect(db.authPairingSession.findUnique({ where: { id: expired.id } })).resolves.toBeNull();
        });
    });

    describe("redemption revalidation before token sealing", () => {
        it("keeps an undecided request pending when the requester retries with its approvalId", async () => {
            const account = await ensurePrimaryAccount();
            const row = await createAssertionRow();
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            const decision = await gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
                approvalId: row.id,
            });
            expect(decision).toEqual({
                kind: "approval_required",
                request: { approvalId: row.id, deviceLabel: baseRowFacts.deviceLabel, expiresAtMs: row.expiresAt.getTime() },
            });
        });

        it("allows redemption only for an approved row with the exact account, assertion binding, issuer, subject, and requester key", async () => {
            const account = await ensurePrimaryAccount();
            const row = await createAssertionRow({ approvalStatus: "approved", decidedAt: new Date() });
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            await expect(gate.evaluate({ accountId: account.id, ...baseRowFacts, approvalId: row.id })).resolves.toEqual({
                kind: "allowed",
                approvedRequest: { approvalId: row.id, bindingProof: baseRowFacts.approvalBindingProof },
            });

            await expect(gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
                approvalBindingProof: "different-signed-assertion-binding",
                approvalId: row.id,
            })).resolves.toEqual({ kind: "invalid" });

            await expect(gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
                requesterBoxPublicKeyBase64: "attacker-key-base64",
                approvalId: row.id,
            })).resolves.toEqual({ kind: "invalid" });

            await expect(gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
                issuerSubjectId: "other-subject",
                approvalId: row.id,
            })).resolves.toEqual({ kind: "invalid" });

            await expect(gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
                issuerServerIdentityId: "srv_other_issuer",
                approvalId: row.id,
            })).resolves.toEqual({ kind: "invalid" });

            const otherAccount = await db.account.create({ data: { publicKey: "pk-other" }, select: { id: true } });
            await expect(gate.evaluate({ accountId: otherAccount.id, ...baseRowFacts, approvalId: row.id })).resolves.toEqual({ kind: "invalid" });
        });

        it("never returns the decision-command already_decided outcome from the evaluator", async () => {
            const account = await ensurePrimaryAccount();
            const row = await createAssertionRow({ approvalStatus: "approved", decidedAt: new Date() });
            const gate = createHomeApprovalGate(APPROVAL_ENV);
            const decision = await gate.evaluate({ accountId: account.id, ...baseRowFacts, approvalId: row.id });
            expect(JSON.stringify(decision)).not.toContain("already_decided");
        });

        it("maps explicit rejection to rejected and identity/binding/currentness failures to invalid", async () => {
            const account = await ensurePrimaryAccount();
            const gate = createHomeApprovalGate(APPROVAL_ENV);

            const rejected = await createAssertionRow({ approvalStatus: "rejected", decidedAt: new Date() });
            await expect(gate.evaluate({ accountId: account.id, ...baseRowFacts, approvalId: rejected.id })).resolves.toEqual({ kind: "rejected" });

            const expiredApproved = await createAssertionRow({ approvalStatus: "approved", decidedAt: new Date(), expiresAt: new Date(Date.now() - 1_000) });
            await expect(gate.evaluate({ accountId: account.id, ...baseRowFacts, approvalId: expiredApproved.id })).resolves.toEqual({ kind: "expired" });
            await expect(gate.evaluate({
                accountId: account.id,
                ...baseRowFacts,
                requesterBoxPublicKeyBase64: "wrong-key",
                approvalId: expiredApproved.id,
            })).resolves.toEqual({ kind: "invalid" });

            const directQr = await createAssertionRow({ flow: "direct_qr", requesterIssuerServerIdentityId: null, requesterIssuerSubjectId: null });
            await expect(gate.evaluate({ accountId: account.id, ...baseRowFacts, approvalId: directQr.id })).resolves.toEqual({ kind: "invalid" });

            const unknownState = await createAssertionRow({ approvalStatus: "corrupted" });
            await expect(gate.evaluate({ accountId: account.id, ...baseRowFacts, approvalId: unknownState.id })).resolves.toEqual({ kind: "invalid" });

            await expect(gate.evaluate({ accountId: account.id, ...baseRowFacts, approvalId: "missing-id" })).resolves.toEqual({ kind: "invalid" });
        });
    });

    describe("approval routes admission", () => {
        it.each(["approve", "reject"] as const)(
            "refuses an admitted %s decision after suspension and allows fresh approval after re-enable",
            async (decision) => {
                const account = await ensurePrimaryAccount();
                const owner = await db.account.create({
                    data: { publicKey: `pk-approval-owner-${crypto.randomUUID()}`, homeRole: "owner" },
                    select: { id: true },
                });
                const pending = await createAssertionRow();
                const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
                const app = createTestApp();
                let suspendAfterAdmission = true;
                // Pause at the real HTTP lifecycle boundary after the registered
                // authentication handlers, keeping auth and lifecycle logic real.
                app.addHook("onRoute", (route) => {
                    if (route.url !== HOME_LOGIN_APPROVAL_DECISION_HTTP_PATH_V1) return;
                    const preHandlers = route.preHandler
                        ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler])
                        : [];
                    route.preHandler = [...preHandlers, async () => {
                        if (!suspendAfterAdmission) return;
                        suspendAfterAdmission = false;
                        await expect(inTx((tx) => setAccountStatusInTx(tx, {
                            actorAccountId: owner.id,
                            targetAccountId: account.id,
                            status: "suspended",
                            authority: "home_administration",
                        }))).resolves.toEqual({ status: "applied" });
                    }];
                });
                authRoutes(app);
                await app.ready();

                const response = await app.inject({
                    method: "POST",
                    url: `/v1/auth/home-login/approvals/${pending.id}/decision`,
                    headers: { authorization: `Bearer ${token}` },
                    payload: { decision },
                });
                await expect(db.account.findUniqueOrThrow({
                    where: { id: account.id },
                    select: { status: true },
                })).resolves.toEqual({ status: "suspended" });
                expect(response.statusCode).toBe(401);
                expect(response.json()).toEqual({ error: "invalid_token" });
                await expect(db.authPairingSession.findUniqueOrThrow({
                    where: { id: pending.id },
                    select: { approvalStatus: true, decidedAt: true },
                })).resolves.toEqual({ approvalStatus: "pending", decidedAt: null });

                await expect(inTx((tx) => setAccountStatusInTx(tx, {
                    actorAccountId: owner.id,
                    targetAccountId: account.id,
                    status: "active",
                    authority: "home_administration",
                }))).resolves.toEqual({ status: "applied" });
                expect(await auth.verifyToken(token)).toBeNull();
                const freshToken = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
                const fresh = await app.inject({
                    method: "POST",
                    url: `/v1/auth/home-login/approvals/${pending.id}/decision`,
                    headers: { authorization: `Bearer ${freshToken}` },
                    payload: { decision: "approve" },
                });
                expect(fresh.statusCode).toBe(200);
                expect(fresh.json()).toEqual({ status: "approved" });
            },
        );

        it("admits only a full present-user Home credential and rejects restricted kinds on list and decision", async () => {
            const account = await ensurePrimaryAccount();
            const pending = await createAssertionRow();
            const [accountToken, terminalToken, directoryToken, pat] = await Promise.all([
                auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" }),
                auth.createToken(account.id, { session: "approval-terminal" }, { kind: "terminal", authority: "account_automation" }),
                auth.createToken(account.id, undefined, { kind: "account_directory", authority: "present_user" }),
                auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: "approval PAT" }),
            ]);

            const app = createTestApp();
            authRoutes(app);
            await app.ready();

            const list = async (token: string | null) => app.inject({
                method: "GET",
                url: "/v1/auth/home-login/approvals",
                ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
            });
            const decide = async (token: string | null) => app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${pending.id}/decision`,
                ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
                payload: { decision: "approve" },
            });

            expect((await list(accountToken)).statusCode).toBe(200);
            expect((await list(null)).statusCode).toBe(401);
            expect((await list("invalid-token")).statusCode).toBe(401);
            // Terminal and PAT credentials must not even list pending approvals.
            expect((await list(terminalToken)).statusCode).toBe(403);
            expect((await list(pat.token)).statusCode).toBe(403);
            // Account Service directory credentials never authorize Home approval.
            expect((await list(directoryToken)).statusCode).toBe(403);

            expect((await decide(accountToken)).statusCode).toBe(200);
            expect((await decide(null)).statusCode).toBe(401);
            expect((await decide(terminalToken)).statusCode).toBe(403);
            expect((await decide(pat.token)).statusCode).toBe(403);
            expect((await decide(directoryToken)).statusCode).toBe(403);

            await app.close();
        });
    });

    describe("approval list and decision routes", () => {
        it("lists only own-account pending unexpired assertion requests with typed fields and no secrets", async () => {
            const account = await ensurePrimaryAccount();
            const pending = await createAssertionRow();
            await createAssertionRow({ approvalStatus: "approved", decidedAt: new Date() });
            await createAssertionRow({ expiresAt: new Date(Date.now() - 1_000) });
            const otherAccount = await db.account.create({ data: { publicKey: "pk-list-other" }, select: { id: true } });
            await createAssertionRow({ accountId: otherAccount.id });

            const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
            const app = createTestApp();
            authRoutes(app);
            await app.ready();

            const res = await app.inject({
                method: "GET",
                url: "/v1/auth/home-login/approvals",
                headers: { authorization: `Bearer ${token}` },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body).toEqual([
                {
                    approvalId: pending.id,
                    accountId: account.id,
                    flow: "account_assertion",
                    requesterBoxPublicKeyBase64: baseRowFacts.requesterBoxPublicKeyBase64,
                    issuerServerIdentityId: baseRowFacts.issuerServerIdentityId,
                    issuerSubjectId: baseRowFacts.issuerSubjectId,
                    deviceLabel: baseRowFacts.deviceLabel,
                    status: "pending",
                    expiresAtMs: pending.expiresAt.getTime(),
                    decidedAtMs: null,
                },
            ]);
            expect(JSON.stringify(body)).not.toContain("secretHash");
            expect(JSON.stringify(body)).not.toContain("seeded-assertion-secret-hash");

            await app.close();
        });

        it("decides a pending request atomically and treats duplicate decisions as typed no-ops", async () => {
            const account = await ensurePrimaryAccount();
            const approveRow = await createAssertionRow();
            const rejectRow = await createAssertionRow({ requestedDeviceLabel: null });

            const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
            const app = createTestApp();
            authRoutes(app);
            await app.ready();

            const winApprove = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${approveRow.id}/decision`,
                headers: { authorization: `Bearer ${token}` },
                payload: { decision: "approve" },
            });
            expect(winApprove.statusCode).toBe(200);
            expect(winApprove.json()).toEqual({ status: "approved" });

            const decided = await db.authPairingSession.findUnique({ where: { id: approveRow.id } });
            expect(decided).toMatchObject({ approvalStatus: "approved" });
            expect(decided!.decidedAt).toBeTruthy();

            const duplicateApprove = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${approveRow.id}/decision`,
                headers: { authorization: `Bearer ${token}` },
                payload: { decision: "approve" },
            });
            expect(duplicateApprove.statusCode).toBe(200);
            expect(duplicateApprove.json()).toEqual({ status: "already_decided" });

            const conflictingReject = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${approveRow.id}/decision`,
                headers: { authorization: `Bearer ${token}` },
                payload: { decision: "reject" },
            });
            expect(conflictingReject.statusCode).toBe(200);
            expect(conflictingReject.json()).toEqual({ status: "already_decided" });
            expect((await db.authPairingSession.findUnique({ where: { id: approveRow.id } }))!.approvalStatus).toBe("approved");

            const winReject = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${rejectRow.id}/decision`,
                headers: { authorization: `Bearer ${token}` },
                payload: { decision: "reject" },
            });
            expect(winReject.statusCode).toBe(200);
            expect(winReject.json()).toEqual({ status: "rejected" });

            await app.close();
        });

        it("allows only one winner when conflicting decisions race", async () => {
            const account = await ensurePrimaryAccount();
            const row = await createAssertionRow();
            const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
            const app = createTestApp();
            authRoutes(app);
            await app.ready();

            const decide = (decision: "approve" | "reject") => app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${row.id}/decision`,
                headers: { authorization: `Bearer ${token}` },
                payload: { decision },
            });
            const responses = await Promise.all([decide("approve"), decide("reject")]);
            expect(responses.every((response) => response.statusCode === 200)).toBe(true);
            const statuses = responses.map((response) => response.json<{ status: string }>().status);
            expect(statuses.filter((status) => status === "already_decided")).toHaveLength(1);
            const winningStatus = statuses.find((status) => status !== "already_decided");
            expect(winningStatus === "approved" || winningStatus === "rejected").toBe(true);
            expect((await db.authPairingSession.findUnique({ where: { id: row.id } }))!.approvalStatus).toBe(winningStatus);

            await app.close();
        });

        it("never decides expired, foreign-account, or foreign-flow rows", async () => {
            const account = await ensurePrimaryAccount();
            const expired = await createAssertionRow({ expiresAt: new Date(Date.now() - 1_000) });
            const directQr = await createAssertionRow({ flow: "direct_qr", requesterIssuerServerIdentityId: null, requesterIssuerSubjectId: null });
            const otherAccount = await db.account.create({ data: { publicKey: "pk-decide-other" }, select: { id: true } });
            const foreign = await createAssertionRow({ accountId: otherAccount.id });

            const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
            const app = createTestApp();
            authRoutes(app);
            await app.ready();

            for (const row of [expired, directQr, foreign]) {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/auth/home-login/approvals/${row.id}/decision`,
                    headers: { authorization: `Bearer ${token}` },
                    payload: { decision: "approve" },
                });
                expect(res.statusCode).toBe(404);
                expect(res.json()).toEqual({ error: "not_found" });
            }
            expect((await db.authPairingSession.findUnique({ where: { id: expired.id } }))!.approvalStatus).toBe("pending");
            expect((await db.authPairingSession.findUnique({ where: { id: directQr.id } }))!.approvalStatus).toBe("pending");
            expect((await db.authPairingSession.findUnique({ where: { id: foreign.id } }))!.approvalStatus).toBe("pending");

            await app.close();
        });

        it("fails closed on malformed decision bodies and unknown approval ids", async () => {
            const account = await ensurePrimaryAccount();
            await createAssertionRow();
            const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
            const app = createTestApp();
            authRoutes(app);
            await app.ready();

            const rows = await db.authPairingSession.findMany({ where: { flow: "account_assertion" } });
            const target = rows[0].id;

            const unknownField = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${target}/decision`,
                headers: { authorization: `Bearer ${token}` },
                payload: { decision: "approve", force: true },
            });
            expect(unknownField.statusCode).toBe(400);

            const missingDecision = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${target}/decision`,
                headers: { authorization: `Bearer ${token}` },
                payload: {},
            });
            expect(missingDecision.statusCode).toBe(400);

            const invalidDecision = await app.inject({
                method: "POST",
                url: `/v1/auth/home-login/approvals/${target}/decision`,
                headers: { authorization: `Bearer ${token}` },
                payload: { decision: "maybe" },
            });
            expect(invalidDecision.statusCode).toBe(400);

            const missingRow = await app.inject({
                method: "POST",
                url: "/v1/auth/home-login/approvals/nonexistent/decision",
                headers: { authorization: `Bearer ${token}` },
                payload: { decision: "approve" },
            });
            expect(missingRow.statusCode).toBe(404);

            expect(await db.authPairingSession.count({ where: { approvalStatus: "pending" } })).toBe(1);

            await app.close();
        });
    });
});
