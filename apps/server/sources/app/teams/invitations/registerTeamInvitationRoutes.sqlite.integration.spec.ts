import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bindHomeDomainActionHttpRequestV1, normalizeVerifiedEmail } from "@happier-dev/protocol";
import type {
    AuthEmailDelivery,
    AuthEmailMessage,
    AuthEmailDeliveryResult,
} from "@/app/auth/email/authEmailDelivery";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { claimTeamInvitationPostAuthContinuationInTx } from "./postAuthContinuation";
import { registerTeamInvitationRoutes } from "./registerTeamInvitationRoutes";

/**
 * The invitation transports as a Home actually exposes them.
 *
 * The mail transport is the one boundary stubbed here: it is a real external
 * system. Every decision beneath it — capability, normalization, token minting,
 * persistence, delivery recording — runs for real against the database.
 */
describe("Team invitation routes (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    let delivered: AuthEmailMessage[] = [];
    let deliveryResult: AuthEmailDeliveryResult = { status: "sent" };
    let deliveryReady = true;
    let applicationOrigin: string | null = "https://app.example.test";
    let homeTarget: string | null = "portable-home-target";

    const delivery: AuthEmailDelivery = {
        isReady: async () => true,
        deliver: async (message) => {
            delivered.push(message);
            return deliveryResult;
        },
    };

    function createApp() {
        const app = createAuthenticatedTestApp();
        registerTeamInvitationRoutes(app, {
            resolveJoinLinkTarget: async () => ({ applicationOrigin, homeTarget }),
            resolveJoinScreenHomeIdentity: async () => ({
                serverId: "home-1",
                displayName: "Acme Home",
                storageMode: "plain",
                hosting: null,
            }),
            email: { delivery, isDeliveryReady: () => deliveryReady },
        });
        return app;
    }

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-invitation-routes-", initAuth: false,
        });
    }, 180_000);
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delivered = [];
        deliveryResult = { status: "sent" };
        deliveryReady = true;
        applicationOrigin = "https://app.example.test";
        homeTarget = "portable-home-target";
        await db.teamInvitation.deleteMany();
        await db.repeatKey.deleteMany();
        await db.teamMembership.deleteMany();
        await db.team.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => { if (harness) await harness.close(); });

    async function teamWithOwner(encryptionMode: "plain" | "e2ee" = "plain") {
        const actor = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode, name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" },
        });
        const team = await db.team.create({ data: { name: "Acme" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: actor.id, role: "owner" },
        });
        return { actor, team };
    }

    function createBody(teamId: string, recipientEmail: string | null) {
        return {
            v: 1,
            teamId,
            role: "member",
            historyAccess: "from_membership",
            recipientEmail,
            requestKey: randomUUID(),
        };
    }

    function invitationTokenFromJoinUrl(joinUrl: string): string {
        return new URL(joinUrl).pathname.split("/").at(-1)!;
    }

    async function post(
        app: ReturnType<typeof createApp>,
        url: string,
        payload: unknown,
        userId?: string,
        authenticationEvidence?: "key_challenge",
    ) {
        return app.inject({
            method: "POST",
            url,
            payload: payload as Record<string, unknown>,
            ...(userId ? { headers: {
                "x-test-user-id": userId,
                ...(authenticationEvidence ? {
                    "x-test-authentication-evidence": JSON.stringify([
                        { kind: "home_method", methodId: authenticationEvidence },
                    ]),
                } : {}),
            } } : {}),
        });
    }

    it("returns the transferable bearer once, inside the join link and nowhere else", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const response = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            expect(response.statusCode, response.body).toBe(200);
            const body = response.json();
            expect(body.invitation.recipientEmailMask).toBeNull();
            expect(body.joinUrl).toMatch(
                /^https:\/\/app\.example\.test\/join\/[A-Za-z0-9]{43}\?target=portable-home-target&targetBinding=[A-Za-z0-9_-]{43}$/u,
            );

            // The stored row keeps only the digest: the bearer exists in the link
            // and in no persisted column.
            const stored = await db.teamInvitation.findFirstOrThrow();
            const token = invitationTokenFromJoinUrl(String(body.joinUrl));
            expect(JSON.stringify(stored)).not.toContain(token);
            expect(delivered).toHaveLength(0);
        } finally { await app.close(); }
    });

    it("never returns a non-portable transferable link when the Home target is unavailable", async () => {
        const f = await teamWithOwner();
        homeTarget = null;
        const app = createApp();
        await app.ready();
        try {
            const response = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().joinUrl).toBeNull();
        } finally { await app.close(); }
    });

    it("returns committed create and reissue results when the mail boundary rejects", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            // Per-send Home configuration reads may fail before SMTP begins.
            vi.spyOn(delivery, "deliver").mockRejectedValue(new Error("Home configuration unavailable"));
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, "invitee@example.test"), f.actor.id);
            const original = await db.teamInvitation.findFirstOrThrow({ where: { teamId: f.team.id } });
            expect(original.revokedAt).toBeNull();
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json().invitation.lastEmailDelivery).toBeNull();
            expect(created.json().joinUrl).toBeNull();

            const reissued = await post(app, "/v1/teams/invitations/reissue", {
                v: 1, teamId: f.team.id, invitationId: original.id,
                recipientEmail: "invitee@example.test", requestKey: randomUUID(),
            }, f.actor.id);
            expect(reissued.statusCode, reissued.body).toBe(200);
            expect(reissued.json().replacement.lastEmailDelivery).toBeNull();
            expect(reissued.json().joinUrl).toBeNull();
            expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: original.id } })).revokedAt).not.toBeNull();
            expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: reissued.json().replacement.id } })).revokedAt).toBeNull();
        } finally { await app.close(); }
    });

    it("returns the committed replacement when reissue mail rejects", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, "invitee@example.test"), f.actor.id);
            expect(created.statusCode, created.body).toBe(200);
            const originalId = created.json().invitation.id;
            vi.spyOn(delivery, "deliver").mockRejectedValue(new Error("Home configuration unavailable"));
            const reissued = await post(app, "/v1/teams/invitations/reissue", {
                v: 1, teamId: f.team.id, invitationId: originalId,
                recipientEmail: null, requestKey: randomUUID(),
            }, f.actor.id);
            expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: originalId } })).revokedAt).not.toBeNull();
            const replacement = await db.teamInvitation.findFirstOrThrow({ where: { teamId: f.team.id, revokedAt: null } });
            expect(replacement.id).not.toBe(originalId);
            expect(reissued.statusCode, reissued.body).toBe(200);
            expect(reissued.json().replacement).toMatchObject({ id: replacement.id, lastEmailDelivery: null });
        } finally { await app.close(); }
    });

    it("keeps a submitted invitation visible when its delivery result cannot be recorded", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        await db.$executeRawUnsafe(`CREATE TRIGGER reject_invitation_delivery_result
            BEFORE UPDATE OF "lastEmailDeliveryStatus" ON "TeamInvitation"
            BEGIN SELECT RAISE(ABORT, 'delivery result storage unavailable'); END`);
        try {
            const response = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, "invitee@example.test"), f.actor.id);
            expect(delivered).toHaveLength(1);
            expect(await db.teamInvitation.findFirst({ where: { teamId: f.team.id } }))
                .toMatchObject({ revokedAt: null, lastEmailDeliveryStatus: null });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().invitation.lastEmailDelivery).toBeNull();
            expect(await db.teamInvitation.findUnique({ where: { id: response.json().invitation.id } }))
                .toMatchObject({ revokedAt: null, lastEmailDeliveryStatus: null });
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER reject_invitation_delivery_result');
            await app.close();
        }
    });

    it("speaks the shared Team error vocabulary for every refusal", async () => {
        const f = await teamWithOwner();
        const stranger = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const app = createApp();
        await app.ready();
        try {
            const forbidden = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), stranger.id);
            expect(forbidden.statusCode).toBe(403);
            expect(forbidden.json()).toEqual({ error: "team_forbidden" });

            const missing = await post(app, "/v1/teams/invitations/create", createBody("no-such-team", null), f.actor.id);
            expect(missing.statusCode).toBe(404);
            expect(missing.json()).toEqual({ error: "team_not_found" });

            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const invitationId = created.json().invitation.id;
            await post(app, "/v1/teams/invitations/revoke", {
                v: 1, teamId: f.team.id, invitationId,
            }, f.actor.id);
            const terminal = await post(app, "/v1/teams/invitations/reissue", {
                v: 1, teamId: f.team.id, invitationId, recipientEmail: null, requestKey: randomUUID(),
            }, f.actor.id);
            expect(terminal.statusCode).toBe(409);
            expect(terminal.json()).toEqual({ error: "invitation_not_active" });
        } finally { await app.close(); }
    });

    it("qualifies invitation administration against a restricted Team without making qualification a join condition", async () => {
        const f = await teamWithOwner("e2ee");
        await db.team.update({
            where: { id: f.team.id },
            data: { authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } },
        });
        const joiner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const stranger = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const app = createApp();
        await app.ready();
        try {
            const structurallyDenied = await post(
                app,
                "/v1/teams/invitations/create",
                createBody(f.team.id, null),
                stranger.id,
            );
            expect(structurallyDenied.statusCode).toBe(403);
            expect(structurallyDenied.json()).toEqual({ error: "team_forbidden" });

            const deniedCreate = await post(
                app,
                "/v1/teams/invitations/create",
                createBody(f.team.id, null),
                f.actor.id,
            );
            expect(deniedCreate.statusCode).toBe(403);
            expect(deniedCreate.json()).toEqual({ error: "team_authentication_required" });

            const created = await post(
                app,
                "/v1/teams/invitations/create",
                createBody(f.team.id, null),
                f.actor.id,
                "key_challenge",
            );
            expect(created.statusCode, created.body).toBe(200);
            const invitationId = created.json().invitation.id as string;
            const token = new URL(created.json().joinUrl as string).pathname.split("/").at(-1)!;

            for (const [url, payload] of [
                ["/v1/teams/invitations/list", {
                    v: 1, teamId: f.team.id, state: null, cursor: null, limit: 50,
                }],
                ["/v1/teams/invitations/revoke", { v: 1, teamId: f.team.id, invitationId }],
                ["/v1/teams/invitations/reissue", {
                    v: 1, teamId: f.team.id, invitationId, recipientEmail: null, requestKey: randomUUID(),
                }],
            ] as const) {
                const denied = await post(app, url, payload, f.actor.id);
                expect(denied.statusCode).toBe(403);
                expect(denied.json()).toEqual({ error: "team_authentication_required" });
            }

            // Structural admission is deliberately separate: the accepting Account
            // needs an ordinary authenticated Home identity, not the manager's
            // restricted-Team credential qualification.
            const accepted = await post(app, "/v1/team-invitations/accept", {
                v: 1,
                token,
            }, joiner.id);
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toEqual({ outcome: "joined", teamId: f.team.id });
        } finally { await app.close(); }
    });

    it("refuses an email-bound invitation this Home could never deliver, and writes nothing", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            deliveryReady = false;
            const unavailable = await post(
                app, "/v1/teams/invitations/create", createBody(f.team.id, "person@example.test"), f.actor.id,
            );
            expect(unavailable.statusCode).toBe(409);
            expect(unavailable.json()).toEqual({ error: "invitation_email_unavailable" });

            // A Home that cannot render a link cannot deliver one either.
            deliveryReady = true;
            applicationOrigin = null;
            const unrenderable = await post(
                app, "/v1/teams/invitations/create", createBody(f.team.id, "person@example.test"), f.actor.id,
            );
            expect(unrenderable.statusCode).toBe(409);
            expect(unrenderable.json()).toEqual({ error: "invitation_email_unavailable" });

            applicationOrigin = "https://app.example.test";
            homeTarget = null;
            const nonPortable = await post(
                app, "/v1/teams/invitations/create", createBody(f.team.id, "person@example.test"), f.actor.id,
            );
            expect(nonPortable.statusCode).toBe(409);
            expect(nonPortable.json()).toEqual({ error: "invitation_email_unavailable" });

            expect(await db.teamInvitation.count()).toBe(0);
            expect(delivered).toHaveLength(0);
        } finally { await app.close(); }
    });

    it("publishes mail readiness on the manager page from the same two facts create enforces", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const listBody = { v: 1, teamId: f.team.id, state: null, cursor: null, limit: 50 };
            const ready = await post(app, "/v1/teams/invitations/list", listBody, f.actor.id);
            expect(ready.statusCode).toBe(200);
            expect(ready.json().emailDelivery).toBe("available");
            expect(ready.json().linkDelivery).toBe("available");

            // Each half of the create-time precondition, alone, must make the
            // offer disappear — otherwise the page would invite a manager into
            // a request the transaction is going to refuse.
            deliveryReady = false;
            const noMail = await post(app, "/v1/teams/invitations/list", listBody, f.actor.id);
            expect(noMail.json().emailDelivery).toBe("unavailable");
            // Mail is the only missing half here, so the link is still real.
            expect(noMail.json().linkDelivery).toBe("available");

            deliveryReady = true;
            applicationOrigin = null;
            const noLink = await post(app, "/v1/teams/invitations/list", listBody, f.actor.id);
            expect(noLink.json().emailDelivery).toBe("unavailable");
            expect(noLink.json().linkDelivery).toBe("unavailable");

            applicationOrigin = "https://app.example.test";
            homeTarget = null;
            const noPortableLink = await post(app, "/v1/teams/invitations/list", listBody, f.actor.id);
            expect(noPortableLink.json().emailDelivery).toBe("unavailable");
            expect(noPortableLink.json().linkDelivery).toBe("unavailable");
        } finally { await app.close(); }
    });

    it("rejects an address the normalization owner cannot accept", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const response = await post(
                app, "/v1/teams/invitations/create", createBody(f.team.id, "not-an-address"), f.actor.id,
            );
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "invalid_team_input" });
            expect(await db.teamInvitation.count()).toBe(0);
        } finally { await app.close(); }
    });

    it("stores the normalized recipient and hands the bearer only to the mail boundary", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const response = await post(
                app, "/v1/teams/invitations/create", createBody(f.team.id, "Person@Example.TEST"), f.actor.id,
            );
            expect(response.statusCode, response.body).toBe(200);
            const body = response.json();
            // The manager never receives an email-bound bearer.
            expect(body.joinUrl).toBeNull();
            expect(body.invitation.recipientEmailMask).toBe("p•••@example.test");
            expect(body.invitation.lastEmailDelivery).toMatchObject({ status: "sent" });

            // The persisted constraint is the normalized value acceptance compares,
            // never the address as typed.
            const stored = await db.teamInvitation.findFirstOrThrow();
            expect(stored.recipientEmailNormalized)
                .toBe(normalizeVerifiedEmail("Person@Example.TEST")?.normalizedEmail);
            expect(stored.lastEmailDeliveryStatus).toBe("sent");
            expect(stored.lastEmailDeliveryAttemptAt).not.toBeNull();

            expect(delivered).toHaveLength(1);
            const message = delivered[0]!;
            expect(message.kind).toBe("invitation");
            if (message.kind !== "invitation") throw new Error("expected invitation mail");
            expect(message.emailBound).toBe(true);
            expect(message.teamName).toBe("Acme");
            // The mail reaches only the invited mailbox, so it names the person
            // who invited them — the strongest trust signal in the message.
            expect(message.inviterLabel).toBe("Ada Lovelace");
            expect(message.joinUrl).toMatch(
                /\/join\/[A-Za-z0-9]{43}\?target=portable-home-target&targetBinding=[A-Za-z0-9_-]{43}$/u,
            );
            // The bearer that reached the mail boundary must appear nowhere in the
            // manager's answer.
            const token = invitationTokenFromJoinUrl(message.joinUrl);
            expect(response.body).not.toContain(token);
        } finally { await app.close(); }
    });

    it("reports a failed delivery truthfully and leaves the invitation usable", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            deliveryResult = { status: "failed", reason: "transport_failed", detail: "smtp" };
            const response = await post(
                app, "/v1/teams/invitations/create", createBody(f.team.id, "person@example.test"), f.actor.id,
            );
            expect(response.statusCode, response.body).toBe(200);
            const body = response.json();
            expect(body.invitation.state).toBe("active");
            expect(body.invitation.lastEmailDelivery).toMatchObject({ status: "failed" });

            const stored = await db.teamInvitation.findFirstOrThrow();
            expect(stored.revokedAt).toBeNull();
            expect(stored.lastEmailDeliveryStatus).toBe("failed");
        } finally { await app.close(); }
    });

    it("reissues to a replacement address and delivers only to the new bearer", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const created = await post(
                app, "/v1/teams/invitations/create", createBody(f.team.id, "first@example.test"), f.actor.id,
            );
            const firstJoinUrl = (delivered[0] as { joinUrl: string }).joinUrl;
            const invitationId = created.json().invitation.id;

            const reissued = await post(app, "/v1/teams/invitations/reissue", {
                v: 1,
                teamId: f.team.id,
                invitationId,
                recipientEmail: "Second@Example.test",
                requestKey: randomUUID(),
            }, f.actor.id);
            expect(reissued.statusCode, reissued.body).toBe(200);
            const body = reissued.json();
            expect(body.previous.state).toBe("revoked");
            expect(body.replacement.recipientEmailMask).toBe("s•••@example.test");
            expect(body.joinUrl).toBeNull();

            expect(delivered).toHaveLength(2);
            const second = delivered[1] as { joinUrl: string; to: { normalizedEmail: string } };
            expect(second.to.normalizedEmail).toBe("second@example.test");
            expect(second.joinUrl).not.toBe(firstJoinUrl);

            // A late result for the old bearer must never mark the replacement sent.
            const rows = await db.teamInvitation.findMany({ orderBy: { createdAt: "asc" } });
            expect(rows).toHaveLength(2);
            expect(rows[0]!.revokedAt).not.toBeNull();
            expect(rows[1]!.lastEmailDeliveryStatus).toBe("sent");
        } finally { await app.close(); }
    });

    it("previews without authentication and never consumes", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const token = invitationTokenFromJoinUrl(String(created.json().joinUrl));

            const preview = await post(app, "/v1/team-invitations/preview", { v: 1, token });
            expect(preview.statusCode, preview.body).toBe(200);
            expect(preview.json()).toMatchObject({
                outcome: "ok",
                preview: { home: { serverId: "home-1", displayName: "Acme Home" }, role: "member" },
            });

            const actionRequest = bindHomeDomainActionHttpRequestV1(
                "teams.invitations.preview",
                { v: 1, token },
            );
            const authenticatedPreview = await post(
                app,
                actionRequest.path,
                actionRequest.body,
                f.actor.id,
            );
            expect(authenticatedPreview.statusCode, authenticatedPreview.body).toBe(200);
            expect(authenticatedPreview.json()).toEqual(preview.json());

            const stored = await db.teamInvitation.findFirstOrThrow();
            expect(stored.acceptedAt).toBeNull();
        } finally { await app.close(); }
    });

    it("exchanges an active bearer for Account-bound approval custody without persisting the bearer", async () => {
        const f = await teamWithOwner();
        const joiner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const other = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const token = invitationTokenFromJoinUrl(String(created.json().joinUrl));
            const invitation = await db.teamInvitation.findFirstOrThrow();

            const prepareRequest = bindHomeDomainActionHttpRequestV1(
                "teams.invitations.accept.prepareApproval",
                { v: 1, token },
            );
            const prepared = await post(app, prepareRequest.path, prepareRequest.body, joiner.id);
            expect(prepared.statusCode, prepared.body).toBe(200);
            expect(prepared.json()).toMatchObject({
                outcome: "ok",
                continuation: {
                    v: 1,
                    kind: "post_auth_invitation",
                    teamId: f.team.id,
                },
                preview: { team: { teamId: f.team.id, name: "Acme" } },
            });
            const continuation = prepared.json().continuation;
            expect(prepared.body).not.toContain(token);
            expect(prepared.body).not.toContain("tokenHash");
            const stored = await db.repeatKey.findUniqueOrThrow({ where: { key: continuation.reference } });
            expect(stored.expiresAt.getTime()).toBe(invitation.expiresAt.getTime());
            expect(stored.value).not.toContain(token);
            expect(JSON.stringify(stored)).not.toContain(token);
            expect(JSON.parse(stored.value)).toEqual({
                v: 1,
                kind: "team_invitation_post_auth",
                accountId: joiner.id,
                teamId: f.team.id,
                invitationId: invitation.id,
                tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
            });

            const wrongAccount = await post(app, "/v1/team-invitations/accept", {
                v: 1,
                continuation,
            }, other.id);
            expect(wrongAccount.json()).toEqual({ outcome: "not_found" });

            const secondPrepared = await post(app, prepareRequest.path, prepareRequest.body, joiner.id);
            expect(secondPrepared.statusCode, secondPrepared.body).toBe(200);
            expect(secondPrepared.json().continuation.reference).not.toBe(continuation.reference);

            const firstAcceptance = await post(app, "/v1/team-invitations/accept", {
                v: 1,
                continuation,
            }, joiner.id);
            expect(firstAcceptance.json()).toEqual({ outcome: "joined", teamId: f.team.id });
            const duplicateAcceptance = await post(app, "/v1/team-invitations/accept", {
                v: 1,
                continuation: secondPrepared.json().continuation,
            }, joiner.id);
            expect(duplicateAcceptance.json()).toEqual({ outcome: "already_member", teamId: f.team.id });
            expect(await db.teamMembership.count({ where: { teamId: f.team.id, accountId: joiner.id } })).toBe(1);
        } finally { await app.close(); }
    });

    it("accepts a live continuation using database time when the process clock is ahead", async () => {
        const f = await teamWithOwner();
        const joiner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const token = invitationTokenFromJoinUrl(String(created.json().joinUrl));
            const preparation = bindHomeDomainActionHttpRequestV1(
                "teams.invitations.accept.prepareApproval",
                { v: 1, token },
            );
            const prepared = await post(app, preparation.path, preparation.body, joiner.id);
            expect(prepared.statusCode, prepared.body).toBe(200);

            const realNow = Date.now();
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(realNow + 365 * 24 * 60 * 60_000);
            const accepted = await post(app, "/v1/team-invitations/accept", {
                v: 1,
                continuation: prepared.json().continuation,
            }, joiner.id);
            vi.useRealTimers();
            expect(accepted.json()).toEqual({ outcome: "joined", teamId: f.team.id });
        } finally { await app.close(); }
    });

    it("treats an expired continuation as terminal using database time when the process clock is behind", async () => {
        const f = await teamWithOwner();
        const joiner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const token = invitationTokenFromJoinUrl(String(created.json().joinUrl));
            const preparation = bindHomeDomainActionHttpRequestV1(
                "teams.invitations.accept.prepareApproval",
                { v: 1, token },
            );
            const prepared = await post(app, preparation.path, preparation.body, joiner.id);
            expect(prepared.statusCode, prepared.body).toBe(200);
            const continuation = prepared.json().continuation;
            const expiredAt = new Date(Date.now() - 60_000);
            await db.$transaction([
                db.repeatKey.update({
                    where: { key: continuation.reference },
                    data: { expiresAt: expiredAt },
                }),
                db.teamInvitation.update({
                    where: { id: created.json().invitation.id },
                    data: { expiresAt: expiredAt },
                }),
            ]);

            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(0);
            const accepted = await post(app, "/v1/team-invitations/accept", {
                v: 1,
                continuation,
            }, joiner.id);
            vi.useRealTimers();
            expect(accepted.json()).toEqual({ outcome: "not_found" });
            await expect(db.repeatKey.findUnique({ where: { key: continuation.reference } }))
                .resolves.not.toBeNull();
        } finally { await app.close(); }
    });

    it("claims a pending continuation using database time in both process-clock directions", async () => {
        const realNow = Date.now();
        const invitation = {
            teamId: "team-clock",
            invitationId: "invitation-clock",
            tokenHash: "a".repeat(64),
        } as const;
        const liveKey = "oauth_pending_liveClockClaim";
        const liveValue = JSON.stringify({ purpose: "team_admission" });
        await db.repeatKey.create({
            data: { key: liveKey, value: liveValue, expiresAt: new Date(realNow + 60_000) },
        });

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(realNow + 365 * 24 * 60 * 60_000);
        const claimed = await inTx((tx) => claimTeamInvitationPostAuthContinuationInTx(tx, {
            reference: liveKey,
            expectedValue: liveValue,
            accountId: "account-clock",
            invitation,
        }));
        expect(claimed?.continuation.reference).toBe(liveKey);
        vi.useRealTimers();

        const expiredKey = "oauth_pending_expiredClockClaim";
        const expiredValue = JSON.stringify({ purpose: "team_admission" });
        await db.repeatKey.create({
            data: { key: expiredKey, value: expiredValue, expiresAt: new Date(realNow - 60_000) },
        });
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(0);
        await expect(inTx((tx) => claimTeamInvitationPostAuthContinuationInTx(tx, {
            reference: expiredKey,
            expectedValue: expiredValue,
            accountId: "account-clock",
            invitation,
        }))).resolves.toBeNull();
        vi.useRealTimers();
        await expect(db.repeatKey.findUniqueOrThrow({ where: { key: expiredKey } }))
            .resolves.toMatchObject({ value: expiredValue });
    });

    it("does not prepare approval custody for a terminal invitation", async () => {
        const f = await teamWithOwner();
        const joiner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const token = invitationTokenFromJoinUrl(String(created.json().joinUrl));
            await post(app, "/v1/teams/invitations/revoke", {
                v: 1,
                teamId: f.team.id,
                invitationId: created.json().invitation.id,
            }, f.actor.id);

            const request = bindHomeDomainActionHttpRequestV1(
                "teams.invitations.accept.prepareApproval",
                { v: 1, token },
            );
            const prepared = await post(app, request.path, request.body, joiner.id);
            expect(prepared.statusCode, prepared.body).toBe(200);
            expect(prepared.json()).toEqual({ outcome: "unavailable" });
            expect(await db.repeatKey.count({
                where: { value: { contains: "team_invitation_post_auth" } },
            })).toBe(0);
        } finally { await app.close(); }
    });

    it("answers a Teams-disabled capable server with the declared feature_unavailable preview", async () => {
        // Child 05 §9: "a capable server with Teams administratively disabled
        // returns the declared feature_unavailable"; §8 forbids presenting that
        // state as an old binary. The join screen reads exactly this body.
        const f = await teamWithOwner();
        const previousTeamsFlag = process.env.HAPPIER_FEATURE_TEAMS__ENABLED;
        process.env.HAPPIER_FEATURE_TEAMS__ENABLED = "0";
        const app = createApp();
        await app.ready();
        try {
            const preview = await post(app, "/v1/team-invitations/preview", { v: 1, token: "a".repeat(43) });
            expect(preview.statusCode, preview.body).toBe(200);
            expect(preview.json()).toEqual({ outcome: "feature_unavailable" });

            // Only the public join corridor speaks the typed outcome; the
            // authenticated family uses the shared Team error vocabulary.
            const create = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            expect(create.statusCode).toBe(404);
            expect(create.json()).toEqual({ error: "teams_unavailable" });
        } finally {
            await app.close();
            if (previousTeamsFlag === undefined) delete process.env.HAPPIER_FEATURE_TEAMS__ENABLED;
            else process.env.HAPPIER_FEATURE_TEAMS__ENABLED = previousTeamsFlag;
        }
    });

    it("joins an authenticated Account and refuses a second use of the same link", async () => {
        const f = await teamWithOwner();
        const joiner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const second = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const token = invitationTokenFromJoinUrl(String(created.json().joinUrl));

            const joined = await post(app, "/v1/team-invitations/accept", { v: 1, token }, joiner.id);
            expect(joined.statusCode, joined.body).toBe(200);
            expect(joined.json()).toEqual({ outcome: "joined", teamId: f.team.id });

            const replay = await post(app, "/v1/team-invitations/accept", { v: 1, token }, second.id);
            expect(replay.json()).toEqual({ outcome: "used" });
            expect(await db.teamMembership.count({ where: { teamId: f.team.id } })).toBe(2);

            // An unauthenticated acceptance is impossible: there is no GET carrier
            // and no anonymous accept.
            const anonymous = await post(app, "/v1/team-invitations/accept", { v: 1, token });
            expect(anonymous.statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it("answers a lost create response from the same key without minting a second bearer", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const body = createBody(f.team.id, null);
            const first = await post(app, "/v1/teams/invitations/create", body, f.actor.id);
            expect(first.statusCode, first.body).toBe(200);
            const created = first.json();
            const token = invitationTokenFromJoinUrl(String(created.joinUrl));

            // The client never saw the first answer and repeats the identical intent.
            const replay = await post(app, "/v1/teams/invitations/create", body, f.actor.id);
            expect(replay.statusCode, replay.body).toBe(200);
            const replayed = replay.json();

            // One invitation, one bearer. The replay identifies the committed row so
            // the manager is not left with two live links for one intent.
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(1);
            expect(replayed.invitation.id).toBe(created.invitation.id);

            // The bearer is not stored, so it cannot be replayed. The absent link is
            // exactly the signal that recovery is explicit reissue.
            expect(replayed.joinUrl).toBeNull();
            expect(replay.body).not.toContain(token);

            // The original bearer is untouched: a lost response must not invalidate
            // the link the first response already handed out.
            const preview = await post(app, "/v1/team-invitations/preview", { v: 1, token });
            expect(preview.json().outcome).toBe("ok");
        } finally { await app.close(); }
    });

    it("rejoins a committed email create when delivery later becomes unavailable", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const body = createBody(f.team.id, "person@example.test");
            const first = await post(app, "/v1/teams/invitations/create", body, f.actor.id);
            expect(first.statusCode, first.body).toBe(200);
            const invitationId = first.json().invitation.id;

            deliveryReady = false;
            const replay = await post(app, "/v1/teams/invitations/create", body, f.actor.id);

            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toMatchObject({ invitation: { id: invitationId }, joinUrl: null });
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(1);
            expect(delivered).toHaveLength(1);
        } finally { await app.close(); }
    });

    it("refuses the same create key carrying a different intent", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const body = createBody(f.team.id, null);
            expect((await post(app, "/v1/teams/invitations/create", body, f.actor.id)).statusCode).toBe(200);

            const altered = await post(
                app, "/v1/teams/invitations/create", { ...body, role: "admin" }, f.actor.id,
            );
            expect(altered.statusCode).toBe(409);
            expect(altered.json()).toEqual({ error: "team_conflict" });
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(1);
        } finally { await app.close(); }
    });

    it("scopes the create key to its actor so two managers never collide", async () => {
        const f = await teamWithOwner();
        const second = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        await db.teamMembership.create({
            data: { teamId: f.team.id, accountId: second.id, role: "admin" },
        });
        const app = createApp();
        await app.ready();
        try {
            const body = createBody(f.team.id, null);
            const mine = await post(app, "/v1/teams/invitations/create", body, f.actor.id);
            const theirs = await post(app, "/v1/teams/invitations/create", body, second.id);
            expect(mine.statusCode).toBe(200);
            expect(theirs.statusCode, theirs.body).toBe(200);
            expect(theirs.json().invitation.id).not.toBe(mine.json().invitation.id);
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(2);
        } finally { await app.close(); }
    });

    it("answers a lost reissue response without retiring a second bearer", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const invitationId = created.json().invitation.id;
            const reissueBody = {
                v: 1, teamId: f.team.id, invitationId, recipientEmail: null, requestKey: randomUUID(),
            };

            const first = await post(app, "/v1/teams/invitations/reissue", reissueBody, f.actor.id);
            expect(first.statusCode, first.body).toBe(200);
            const replacementId = first.json().replacement.id;

            // A retried reissue must not retire the replacement it just minted and
            // hand out a third link.
            const replay = await post(app, "/v1/teams/invitations/reissue", reissueBody, f.actor.id);
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json().replacement.id).toBe(replacementId);
            expect(replay.json().joinUrl).toBeNull();
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(2);

            const replacement = await db.teamInvitation.findUniqueOrThrow({ where: { id: replacementId } });
            expect(replacement.revokedAt).toBeNull();
        } finally { await app.close(); }
    });

    it("rejoins a committed email reissue even when delivery later becomes unavailable", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const created = await post(
                app,
                "/v1/teams/invitations/create",
                createBody(f.team.id, "person@example.test"),
                f.actor.id,
            );
            expect(created.statusCode, created.body).toBe(200);
            const invitationId = created.json().invitation.id;
            const reissueBody = {
                v: 1,
                teamId: f.team.id,
                invitationId,
                recipientEmail: "replacement@example.test",
                requestKey: randomUUID(),
            };

            const first = await post(app, "/v1/teams/invitations/reissue", reissueBody, f.actor.id);
            expect(first.statusCode, first.body).toBe(200);
            const replacementId = first.json().replacement.id;

            // The mutation and its one mail attempt committed, but the client lost
            // the response. Current mail readiness is irrelevant to resolving the
            // same retry identity: no second bearer or delivery is attempted.
            deliveryReady = false;
            const replay = await post(app, "/v1/teams/invitations/reissue", reissueBody, f.actor.id);

            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toMatchObject({
                replacement: { id: replacementId },
                joinUrl: null,
            });
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(2);
            expect(delivered).toHaveLength(2);
        } finally { await app.close(); }
    });

    it("treats a second distinct create key from one manager as a new intent", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const first = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const second = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            expect(first.statusCode, first.body).toBe(200);
            expect(second.statusCode, second.body).toBe(200);

            // Two deliberate invitations, each with its own live bearer. This is the
            // case that distinguishes a forwarded retry identity from a dropped one:
            // without the caller's key the dedupe owner sees one constant key per
            // actor and Team, so every later invite would answer with the first row
            // and a null link instead of the second link the manager asked for.
            expect(second.json().invitation.id).not.toBe(first.json().invitation.id);
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(2);

            const firstToken = invitationTokenFromJoinUrl(String(first.json().joinUrl));
            const secondToken = invitationTokenFromJoinUrl(String(second.json().joinUrl));
            expect(secondToken).not.toBe(firstToken);
            for (const token of [firstToken, secondToken]) {
                const preview = await post(app, "/v1/team-invitations/preview", { v: 1, token });
                expect(preview.json().outcome).toBe("ok");
            }
        } finally { await app.close(); }
    });

    it("treats a distinct reissue key as a new intent rather than a replay", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const invitationId = created.json().invitation.id;
            const reissue = (requestKey: string) => post(app, "/v1/teams/invitations/reissue", {
                v: 1, teamId: f.team.id, invitationId, recipientEmail: null, requestKey,
            }, f.actor.id);

            expect((await reissue(randomUUID())).statusCode).toBe(200);

            // The original bearer is already retired, so a genuinely new reissue
            // intent aimed at it is refused. A replayed 200 here would prove the
            // caller's key never reached the dedupe owner and that two distinct
            // intents were collapsed onto one record.
            const second = await reissue(randomUUID());
            expect(second.statusCode, second.body).toBe(409);
            expect(second.json()).toEqual({ error: "invitation_not_active" });
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(2);
        } finally { await app.close(); }
    });

    it("keeps an email-bound invitation email-bound when Retry sends no replacement address", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const created = await post(
                app, "/v1/teams/invitations/create", createBody(f.team.id, "person@example.test"), f.actor.id,
            );
            const invitationId = created.json().invitation.id;

            // Retry carries no address: it is the same offer to the same person, not
            // a conversion. Dropping the constraint here would silently turn a link
            // intended for one mailbox into one anybody signed in could accept.
            const retried = await post(app, "/v1/teams/invitations/reissue", {
                v: 1, teamId: f.team.id, invitationId, recipientEmail: null, requestKey: randomUUID(),
            }, f.actor.id);
            expect(retried.statusCode, retried.body).toBe(200);
            expect(retried.json().replacement.recipientEmailMask).toBe("p•••@example.test");
            expect(retried.json().joinUrl).toBeNull();

            const replacement = await db.teamInvitation.findUniqueOrThrow({
                where: { id: retried.json().replacement.id },
            });
            expect(replacement.recipientEmailNormalized).toBe("person@example.test");

            // Redelivery went to the preserved recipient, not to nobody.
            expect(delivered).toHaveLength(2);
            expect((delivered[1] as { to: { normalizedEmail: string } }).to.normalizedEmail)
                .toBe("person@example.test");
        } finally { await app.close(); }
    });

    it("keeps a transferable invitation transferable across Retry", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const created = await post(app, "/v1/teams/invitations/create", createBody(f.team.id, null), f.actor.id);
            const retried = await post(app, "/v1/teams/invitations/reissue", {
                v: 1,
                teamId: f.team.id,
                invitationId: created.json().invitation.id,
                recipientEmail: null,
                requestKey: randomUUID(),
            }, f.actor.id);
            expect(retried.statusCode, retried.body).toBe(200);
            expect(retried.json().replacement.recipientEmailMask).toBeNull();
            expect(retried.json().joinUrl).toMatch(
                /\/join\/[A-Za-z0-9]{43}\?target=portable-home-target&targetBinding=[A-Za-z0-9_-]{43}$/u,
            );
            expect(delivered).toHaveLength(0);
        } finally { await app.close(); }
    });

    it("answers malformed input with the one shared Team error envelope", async () => {
        const f = await teamWithOwner();
        const app = createApp();
        await app.ready();
        try {
            const response = await post(app, "/v1/teams/invitations/create", {
                v: 1, teamId: f.team.id, role: "owner", historyAccess: "from_membership",
                recipientEmail: null, requestKey: randomUUID(),
            }, f.actor.id);
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "invalid_team_input" });

            for (const [url, payload] of [
                ["/v1/teams/invitations/list", { v: 1, teamId: f.team.id, state: null, cursor: null, limit: 0 }],
                ["/v1/teams/invitations/revoke", { v: 1, teamId: f.team.id, invitationId: "" }],
                ["/v1/teams/invitations/reissue", { v: 1, teamId: f.team.id, invitationId: "", recipientEmail: null, requestKey: "" }],
            ] as const) {
                const invalid = await post(app, url, payload, f.actor.id);
                expect(invalid.statusCode).toBe(400);
                expect(invalid.json()).toEqual({ error: "invalid_team_input" });
            }

            const invalidCursor = await post(app, "/v1/teams/invitations/list", {
                v: 1, teamId: f.team.id, state: null, cursor: "not-a-team-cursor", limit: 10,
            }, f.actor.id);
            expect(invalidCursor.statusCode).toBe(400);
            expect(invalidCursor.json()).toEqual({ error: "invalid_team_cursor" });

            const preview = await post(app, "/v1/team-invitations/preview", { v: 1, token: "short" });
            expect(preview.statusCode).toBe(200);
            expect(preview.json()).toEqual({ outcome: "unavailable" });
            const accept = await post(app, "/v1/team-invitations/accept", { v: 1, token: "short" }, f.actor.id);
            // Authenticated operations use the shared strict Team transport
            // boundary. Only the public preview intentionally coarsens malformed
            // bearers to avoid turning validation into an enumeration oracle.
            expect(accept.statusCode).toBe(400);
            expect(accept.json()).toEqual({ error: "invalid_team_input" });
            expect(await db.teamInvitation.count()).toBe(0);
        } finally { await app.close(); }
    });
});
