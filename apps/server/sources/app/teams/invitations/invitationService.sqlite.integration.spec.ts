import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { registerAuthEntryRoute } from "@/app/api/routes/auth/registerAuthEntryRoute";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createTeamInvitationForActorInTx,
    listTeamInvitationsForActorInTx,
    previewTeamInvitationByTokenInTx,
    reissueTeamInvitationForActorInTx,
    resolveTeamInvitationAuthEntryContextInTx,
    revokeTeamInvitationForActorInTx,
} from "./invitationService";
import { digestTeamInvitationToken, mintTeamInvitationToken } from "./token";

const HOME = { serverId: "home-1", displayName: "Acme Home", storageMode: "plain", hosting: null } as const;

describe("Team invitation service authority (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-invitation-service-",
            initAuth: false,
            initFiles: true,
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function account(status: "active" | "suspended" | "disabled" = "active") {
        return db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", status } });
    }

    async function teamWith(role: "owner" | "admin" | "member" | "guest", options: Readonly<{
        archived?: boolean;
        accountStatus?: "active" | "suspended" | "disabled";
        membershipStatus?: "active" | "suspended";
    }> = {}) {
        const actor = await account(options.accountStatus ?? "active");
        const team = await db.team.create({
            data: { name: "Acme", archivedAt: options.archived === true ? new Date() : null },
        });
        await db.teamMembership.create({
            data: {
                teamId: team.id,
                accountId: actor.id,
                role,
                status: options.membershipStatus ?? "active",
            },
        });
        return { actor, team };
    }

    async function create(teamId: string, actorAccountId: string) {
        return inTx(async (tx) => createTeamInvitationForActorInTx(tx, {
            teamId,
            actorAccountId,
            role: "member",
            historyAccess: "from_membership",
            recipientEmailNormalized: null,
            emailDeliveryAvailable: true,
            requestKey: crypto.randomUUID(),
        }));
    }

    it("admits an owner or admin and refuses every other current membership state", async () => {
        for (const role of ["owner", "admin"] as const) {
            const f = await teamWith(role);
            const result = await create(f.team.id, f.actor.id);
            expect(result.ok).toBe(true);
        }
        for (const role of ["member", "guest"] as const) {
            const f = await teamWith(role);
            const result = await create(f.team.id, f.actor.id);
            expect(result).toEqual({ ok: false, error: "forbidden" });
        }
    });

    it("does not turn Home Team-detail administration into invitation authority", async () => {
        const f = await teamWith("owner");
        const homeAdmin = await db.account.create({
            data: {
                publicKey: crypto.randomUUID(),
                encryptionMode: "plain",
                homeRole: "admin",
            },
        });

        expect(await create(f.team.id, homeAdmin.id)).toEqual({ ok: false, error: "forbidden" });
    });

    it("withdraws invitation authority from a suspended membership and an inactive Account", async () => {
        const suspendedMembership = await teamWith("admin", { membershipStatus: "suspended" });
        expect(await create(suspendedMembership.team.id, suspendedMembership.actor.id))
            .toEqual({ ok: false, error: "forbidden" });

        for (const accountStatus of ["suspended", "disabled"] as const) {
            const f = await teamWith("admin", { accountStatus });
            expect(await create(f.team.id, f.actor.id)).toEqual({ ok: false, error: "forbidden" });
        }
    });

    it("tells a retained manager that the Team is archived and a stranger nothing at all", async () => {
        const archived = await teamWith("admin", { archived: true });
        expect(await create(archived.team.id, archived.actor.id)).toEqual({ ok: false, error: "team_archived" });

        const outsider = await account();
        expect(await create(archived.team.id, outsider.id)).toEqual({ ok: false, error: "forbidden" });
        expect(await create("team-that-does-not-exist", outsider.id)).toEqual({ ok: false, error: "team_not_found" });
    });

    it("returns the raw bearer once and never persists it", async () => {
        const f = await teamWith("owner");
        const result = await create(f.team.id, f.actor.id);
        if (!result.ok) throw new Error(`expected success, got ${result.error}`);

        // A fresh create always carries its bearer; only a replayed intent omits it.
        const token = result.value.token;
        if (token === null) throw new Error("a fresh create must return its bearer");
        expect(token).toMatch(/^[A-Za-z0-9]{43}$/);
        expect(result.value.invitation.state).toBe("active");
        expect(result.value.invitation.createdByAccountId).toBe(f.actor.id);

        const persisted = await db.teamInvitation.findUniqueOrThrow({ where: { id: result.value.invitation.id } });
        expect(Buffer.from(persisted.tokenHash).equals(digestTeamInvitationToken(token))).toBe(true);
        expect(JSON.stringify(persisted)).not.toContain(token);
        expect(JSON.stringify(result.value.invitation)).not.toContain(token);
    });

    it("enforces from-membership history when a Guest caller bypasses the route parser", async () => {
        const f = await teamWith("owner");
        const result = await inTx(async (tx) => createTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            role: "guest",
            historyAccess: "all_existing",
            recipientEmailNormalized: null,
            emailDeliveryAvailable: true,
            requestKey: crypto.randomUUID(),
        }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.invitation.historyAccess).toBe("from_membership");
        expect(await db.teamInvitation.findUniqueOrThrow({ where: { id: result.value.invitation.id } }))
            .toMatchObject({ role: "guest", historyAccess: "from_membership" });
    });

    it("publishes each committed invitation change and does not republish a replay or same-state revoke", async () => {
        const f = await teamWith("owner");
        const before = (await db.account.findUniqueOrThrow({ where: { id: f.actor.id }, select: { seq: true } })).seq;
        const requestKey = crypto.randomUUID();
        const created = await inTx((tx) => createTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            role: "member",
            historyAccess: "from_membership",
            recipientEmailNormalized: null,
            emailDeliveryAvailable: true,
            requestKey,
        }));
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect((await db.account.findUniqueOrThrow({ where: { id: f.actor.id }, select: { seq: true } })).seq)
            .toBe(before + 1);

        await inTx((tx) => createTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            role: "member",
            historyAccess: "from_membership",
            recipientEmailNormalized: null,
            emailDeliveryAvailable: true,
            requestKey,
        }));
        expect((await db.account.findUniqueOrThrow({ where: { id: f.actor.id }, select: { seq: true } })).seq)
            .toBe(before + 1);

        await inTx((tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            invitationId: created.value.invitation.id,
        }));
        expect((await db.account.findUniqueOrThrow({ where: { id: f.actor.id }, select: { seq: true } })).seq)
            .toBe(before + 2);
        await inTx((tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            invitationId: created.value.invitation.id,
        }));
        expect((await db.account.findUniqueOrThrow({ where: { id: f.actor.id }, select: { seq: true } })).seq)
            .toBe(before + 2);
    });

    it("mints expiry from the transaction database clock rather than a process sample", async () => {
        const f = await teamWith("owner");
        const before = Date.now();
        const result = await create(f.team.id, f.actor.id);
        if (!result.ok) throw new Error("expected success");
        const persisted = await db.teamInvitation.findUniqueOrThrow({ where: { id: result.value.invitation.id } });
        expect(persisted.expiresAt.getTime()).toBeGreaterThan(before);
    });

    it("keeps invitation-create replay live when the process clock is behind the database clock", async () => {
        const f = await teamWith("owner");
        const requestKey = crypto.randomUUID();
        const processClock = vi.spyOn(Date, "now").mockReturnValue(0);
        try {
            const invoke = (role: "member" | "guest") => inTx((tx) => createTeamInvitationForActorInTx(tx, {
                teamId: f.team.id,
                actorAccountId: f.actor.id,
                role,
                historyAccess: "from_membership",
                recipientEmailNormalized: null,
                emailDeliveryAvailable: true,
                requestKey,
            }));
            const first = await invoke("member");
            const replay = await invoke("member");
            expect(first.ok && replay.ok).toBe(true);
            if (!first.ok || !replay.ok) return;
            expect(replay.value.invitation.id).toBe(first.value.invitation.id);
            expect(replay.value.token).toBeNull();
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(1);
            expect(await invoke("guest")).toEqual({ ok: false, error: "request_conflict" });
        } finally {
            processClock.mockRestore();
        }
    });

    it("keeps invitation-reissue replay live when the process clock is behind the database clock", async () => {
        const f = await teamWith("owner");
        const created = await create(f.team.id, f.actor.id);
        if (!created.ok) throw new Error("expected invitation creation");
        const requestKey = crypto.randomUUID();
        const processClock = vi.spyOn(Date, "now").mockReturnValue(0);
        try {
            const invoke = (recipientEmail: string | null) => inTx((tx) => reissueTeamInvitationForActorInTx(tx, {
                teamId: f.team.id,
                actorAccountId: f.actor.id,
                invitationId: created.value.invitation.id,
                replacementRecipientEmailNormalized: recipientEmail,
                requestKey,
                emailDeliveryAvailable: true,
            }));
            const first = await invoke("person@example.test");
            const replay = await invoke("person@example.test");
            expect(first.ok && replay.ok).toBe(true);
            if (!first.ok || !replay.ok) return;
            expect(replay.value.replacement.id).toBe(first.value.replacement.id);
            expect(replay.value.token).toBeNull();
            expect(await db.teamInvitation.count({ where: { teamId: f.team.id } })).toBe(2);
            expect(await invoke("other@example.test")).toEqual({ ok: false, error: "request_conflict" });
        } finally {
            processClock.mockRestore();
        }
    });

    it("lists retained terminal provenance newest first and paginates by cursor", async () => {
        const f = await teamWith("owner");
        const created: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const result = await create(f.team.id, f.actor.id);
            if (!result.ok) throw new Error("expected success");
            created.push(result.value.invitation.id);
        }
        await inTx(async (tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: f.team.id, actorAccountId: f.actor.id, invitationId: created[0]!,
        }));

        const first = await inTx(async (tx) => listTeamInvitationsForActorInTx(tx, {
            teamId: f.team.id, actorAccountId: f.actor.id, cursor: null, limit: 2,
        }));
        if (!first.ok) throw new Error("expected success");
        expect(first.value.items).toHaveLength(2);
        expect(first.value.nextCursor).not.toBeNull();

        const second = await inTx(async (tx) => listTeamInvitationsForActorInTx(tx, {
            teamId: f.team.id, actorAccountId: f.actor.id, cursor: first.value.nextCursor, limit: 2,
        }));
        if (!second.ok) throw new Error("expected success");
        expect(second.value.items).toHaveLength(1);
        expect(second.value.nextCursor).toBeNull();

        const all = [...first.value.items, ...second.value.items];
        expect(new Set(all.map((row) => row.id)).size).toBe(3);
        expect(all.find((row) => row.id === created[0])?.state).toBe("revoked");
    });

    it("binds invitation cursors to the Team and derived state, including tied timestamps", async () => {
        const firstTeam = await teamWith("owner");
        const secondTeam = await teamWith("owner");
        const created: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const result = await create(firstTeam.team.id, firstTeam.actor.id);
            if (!result.ok) throw new Error("expected success");
            created.push(result.value.invitation.id);
        }
        const tiedAt = new Date("2026-01-01T00:00:00.000Z");
        await db.teamInvitation.updateMany({ where: { id: { in: created } }, data: { createdAt: tiedAt } });

        const first = await inTx((tx) => listTeamInvitationsForActorInTx(tx, {
            teamId: firstTeam.team.id, actorAccountId: firstTeam.actor.id, cursor: null, limit: 2,
        }));
        if (!first.ok) throw new Error("expected success");
        const second = await inTx((tx) => listTeamInvitationsForActorInTx(tx, {
            teamId: firstTeam.team.id, actorAccountId: firstTeam.actor.id, cursor: first.value.nextCursor, limit: 2,
        }));
        if (!second.ok) throw new Error("expected success");
        expect(new Set([...first.value.items, ...second.value.items].map((row) => row.id)).size).toBe(3);

        expect(await inTx((tx) => listTeamInvitationsForActorInTx(tx, {
            teamId: secondTeam.team.id,
            actorAccountId: secondTeam.actor.id,
            cursor: first.value.nextCursor,
            limit: 2,
        }))).toEqual({ ok: false, error: "invalid_team_cursor" });

        const revoked = await create(firstTeam.team.id, firstTeam.actor.id);
        if (!revoked.ok) throw new Error("expected success");
        await inTx((tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: firstTeam.team.id,
            actorAccountId: firstTeam.actor.id,
            invitationId: revoked.value.invitation.id,
        }));
        const all = await inTx((tx) => listTeamInvitationsForActorInTx(tx, {
            teamId: firstTeam.team.id, actorAccountId: firstTeam.actor.id, cursor: null, limit: 1,
        }));
        if (!all.ok || all.value.nextCursor === null) throw new Error("expected cursor");
        expect(await inTx((tx) => listTeamInvitationsForActorInTx(tx, {
            teamId: firstTeam.team.id,
            actorAccountId: firstTeam.actor.id,
            cursor: all.value.nextCursor,
            limit: 2,
            state: "revoked",
        }))).toEqual({ ok: false, error: "invalid_team_cursor" });
    });

    it("narrows the list to one derived state, using the same precedence the rows show", async () => {
        const f = await teamWith("owner");
        const active = await create(f.team.id, f.actor.id);
        const revoked = await create(f.team.id, f.actor.id);
        const expired = await create(f.team.id, f.actor.id);
        if (!active.ok || !revoked.ok || !expired.ok) throw new Error("expected success");
        await inTx(async (tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: f.team.id, actorAccountId: f.actor.id, invitationId: revoked.value.invitation.id,
        }));
        await db.teamInvitation.update({
            where: { id: expired.value.invitation.id },
            data: { expiresAt: new Date(Date.now() - 1_000) },
        });

        async function listState(state: "active" | "revoked" | "expired" | "accepted" | null) {
            const page = await inTx(async (tx) => listTeamInvitationsForActorInTx(tx, {
                teamId: f.team.id, actorAccountId: f.actor.id, cursor: null, limit: 50, state,
            }));
            if (!page.ok) throw new Error("expected success");
            return page.value.items;
        }

        expect((await listState("active")).map((row) => row.id)).toEqual([active.value.invitation.id]);
        expect((await listState("revoked")).map((row) => row.id)).toEqual([revoked.value.invitation.id]);
        expect((await listState("expired")).map((row) => row.id)).toEqual([expired.value.invitation.id]);
        expect(await listState("accepted")).toEqual([]);
        // No filter still means every retained row, terminal provenance included.
        expect((await listState(null)).length).toBe(3);

        // A revoked invitation that also passed its expiry is still revoked: the
        // filter must not disagree with the state the row itself reports.
        await db.teamInvitation.update({
            where: { id: revoked.value.invitation.id },
            data: { expiresAt: new Date(Date.now() - 1_000) },
        });
        expect((await listState("revoked")).map((row) => row.id)).toEqual([revoked.value.invitation.id]);
        expect((await listState("expired")).map((row) => row.id)).toEqual([expired.value.invitation.id]);
    });

    it("treats a repeated revoke as same-state rather than an error", async () => {
        const f = await teamWith("owner");
        const result = await create(f.team.id, f.actor.id);
        if (!result.ok) throw new Error("expected success");

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const revoked = await inTx(async (tx) => revokeTeamInvitationForActorInTx(tx, {
                teamId: f.team.id, actorAccountId: f.actor.id, invitationId: result.value.invitation.id,
            }));
            if (!revoked.ok) throw new Error(`expected success, got ${revoked.error}`);
            expect(revoked.value.state).toBe("revoked");
        }
    });

    it("refuses to reissue a terminal invitation and copies intent when it succeeds", async () => {
        const f = await teamWith("owner");
        const created = await inTx(async (tx) => createTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            role: "guest",
            historyAccess: "all_existing",
            recipientEmailNormalized: "person@example.test",
            emailDeliveryAvailable: true,
            requestKey: crypto.randomUUID(),
        }));
        if (!created.ok) throw new Error("expected success");

        const reissued = await inTx(async (tx) => reissueTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            invitationId: created.value.invitation.id,
            replacementRecipientEmailNormalized: "other@example.test",
            requestKey: crypto.randomUUID(),
            emailDeliveryAvailable: true,
        }));
        if (!reissued.ok) throw new Error(`expected success, got ${reissued.error}`);
        expect(reissued.value.replacement.role).toBe("guest");
        expect(reissued.value.replacement.historyAccess).toBe("from_membership");
        expect(reissued.value.replacement.recipientEmailMask).toBe("o•••@example.test");
        expect(reissued.value.previous.state).toBe("revoked");
        expect(reissued.value.token).not.toBe(created.value.token);

        const again = await inTx(async (tx) => reissueTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            invitationId: created.value.invitation.id,
            replacementRecipientEmailNormalized: null,
            requestKey: crypto.randomUUID(),
            emailDeliveryAvailable: true,
        }));
        expect(again).toEqual({ ok: false, error: "invitation_not_active" });
    });

    it("previews an active invitation without consuming or widening it", async () => {
        const f = await teamWith("owner");
        const created = await inTx(async (tx) => createTeamInvitationForActorInTx(tx, {
            teamId: f.team.id,
            actorAccountId: f.actor.id,
            role: "guest",
            historyAccess: "from_membership",
            recipientEmailNormalized: "person@example.test",
            emailDeliveryAvailable: true,
            requestKey: crypto.randomUUID(),
        }));
        if (!created.ok) throw new Error("expected success");

        const preview = await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: created.value.token, home: HOME,
        }));
        expect(preview.outcome).toBe("ok");
        if (preview.outcome !== "ok") return;
        expect(preview.preview.team.name).toBe("Acme");
        expect(preview.preview.team.accentSeed).toBe(f.team.id);
        expect(preview.preview.role).toBe("guest");
        expect(preview.preview.recipientEmailMask).toBe("p•••@example.test");
        expect(JSON.stringify(preview)).not.toContain(created.value.token);
        expect(JSON.stringify(preview)).not.toContain(f.actor.id);

        const authEntryContext = await inTx(async (tx) => resolveTeamInvitationAuthEntryContextInTx(tx, {
            token: created.value.token,
        }));
        expect(authEntryContext).toEqual({
            team: { teamId: f.team.id, name: "Acme", logo: null },
            authenticationPolicy: null,
            recipientEmailNormalized: "person@example.test",
        });
        expect(JSON.stringify(authEntryContext)).not.toContain(created.value.token);
        expect(JSON.stringify(authEntryContext)).not.toContain("guest");

        const unchanged = await db.teamInvitation.findUniqueOrThrow({ where: { id: created.value.invitation.id } });
        expect(unchanged.acceptedAt).toBeNull();
        expect(unchanged.revokedAt).toBeNull();
    });

    it("names the inviter with the one display label, never an actor identity", async () => {
        const f = await teamWith("owner");
        await db.account.update({
            where: { id: f.actor.id },
            data: { name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace", username: `ada-${crypto.randomUUID()}` },
        });
        const created = await create(f.team.id, f.actor.id);
        if (!created.ok) throw new Error("expected success");

        const preview = await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: created.value.token, home: HOME,
        }));
        expect(preview.outcome).toBe("ok");
        if (preview.outcome !== "ok") return;
        // Exactly the label the invitation email already shows this person.
        expect(preview.preview.inviterLabel).toBe("Ada Lovelace");
        // The label is the whole disclosure: no id and no address crosses the
        // unauthenticated boundary with it.
        expect(JSON.stringify(preview)).not.toContain(f.actor.id);

        // An Account with no name and no username has no label of its own, so the
        // preview says nothing rather than rendering an empty line.
        const anonymous = await teamWith("owner");
        const fromAnonymous = await create(anonymous.team.id, anonymous.actor.id);
        if (!fromAnonymous.ok) throw new Error("expected success");
        const anonymousPreview = await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: fromAnonymous.value.token, home: HOME,
        }));
        expect(anonymousPreview.outcome === "ok" && anonymousPreview.preview.inviterLabel).toBeNull();

        // An inviter whose Account no longer resolves reads the same way; nothing
        // is substituted for it.
        await db.teamInvitation.update({
            where: { id: created.value.invitation.id },
            data: { createdByAccountId: null },
        });
        const orphaned = await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: created.value.token, home: HOME,
        }));
        expect(orphaned.outcome === "ok" && orphaned.preview.inviterLabel).toBeNull();
    });

    it("previews a committed Team logo through the canonical Team-logo reader", async () => {
        const f = await teamWith("owner");
        const path = `public/teams/${f.team.id}/logo/committed.jpg`;
        await db.team.update({
            where: { id: f.team.id },
            data: { logo: { path, width: 512, height: 512, thumbhash: "thumb" } },
        });
        const created = await create(f.team.id, f.actor.id);
        if (!created.ok) throw new Error("expected success");

        const preview = await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: created.value.token, home: HOME,
        }));
        expect(preview.outcome).toBe("ok");
        if (preview.outcome !== "ok") return;
        expect(preview.preview.team.logo).toEqual({
            path, width: 512, height: 512, thumbhash: "thumb", url: expect.stringContaining(path),
        });

        const authEntryContext = await inTx(async (tx) => resolveTeamInvitationAuthEntryContextInTx(tx, {
            token: created.value.token,
        }));
        expect(authEntryContext?.team.logo?.url).toContain(path);

        // A stored path outside this Team's own logo prefix is not this Team's logo.
        await db.team.update({
            where: { id: f.team.id },
            data: { logo: { path: "public/teams/another/logo/x.jpg", width: 512, height: 512, thumbhash: "thumb" } },
        });
        const foreign = await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: created.value.token, home: HOME,
        }));
        expect(foreign.outcome).toBe("ok");
        if (foreign.outcome !== "ok") return;
        expect(foreign.preview.team.logo).toBeNull();
    });

    it("serves the active invitation through the public no-store auth-entry route", async () => {
        const f = await teamWith("owner");
        const created = await create(f.team.id, f.actor.id);
        if (!created.ok) throw new Error("expected success");

        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        registerAuthEntryRoute(app);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/entry",
                payload: { v: 1, scope: { kind: "invitation", token: created.value.token }, purpose: "home" },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.json()).toMatchObject({
                v: 1,
                state: "admission_required",
                scope: { kind: "invitation" },
                team: { teamId: f.team.id, name: "Acme", logo: null },
                autoRedirect: null,
            });
            expect(response.body).not.toContain(created.value.token);
        } finally {
            await app.close();
        }
    });

    it.each(['expired', 'used'] as const)("retains the %s bearer reason", async reason => {
        const f = await teamWith("owner");
        const created = await create(f.team.id, f.actor.id);
        if (!created.ok) throw new Error("expected success");
        await db.teamInvitation.update({ where: { id: created.value.invitation.id }, data: reason === 'expired'
            ? { expiresAt: new Date(0) } : { acceptedAt: new Date() } });
        expect(await inTx(tx => previewTeamInvitationByTokenInTx(tx, { token: created.value.token, home: HOME })))
            .toEqual({ outcome: 'unavailable', reason });
    });

    it("keeps unknown and malformed previews generic while retaining known bearer reasons", async () => {
        const f = await teamWith("owner");
        const created = await create(f.team.id, f.actor.id);
        if (!created.ok) throw new Error("expected success");

        for (const token of ["not-a-token", "", mintTeamInvitationToken()]) {
            expect(await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, { token, home: HOME })))
                .toEqual({ outcome: "unavailable" });
        }

        await inTx(async (tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: f.team.id, actorAccountId: f.actor.id, invitationId: created.value.invitation.id,
        }));
        expect(await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: created.value.token, home: HOME,
        }))).toEqual({ outcome: "unavailable", reason: "revoked" });

        const live = await teamWith("owner");
        const liveInvitation = await create(live.team.id, live.actor.id);
        if (!liveInvitation.ok) throw new Error("expected success");
        await db.team.update({ where: { id: live.team.id }, data: { archivedAt: new Date() } });
        expect(await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: liveInvitation.value.token, home: HOME,
        }))).toEqual({ outcome: "unavailable", reason: "team_archived" });
    });
});
