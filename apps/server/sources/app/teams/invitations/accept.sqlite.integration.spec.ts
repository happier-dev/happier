import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { TEAM_CHANGE_ENTITY_ID } from "../teamChanges";
import {
    acceptTeamInvitationInTx,
    requireAcceptedTeamInvitationInTx,
    TeamInvitationAcceptanceAbort,
} from "./accept";
import {
    createTeamInvitationForActorInTx,
    reissueTeamInvitationForActorInTx,
    revokeTeamInvitationForActorInTx,
} from "./invitationService";

describe("Team invitation acceptance (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-team-invitation-accept-", initAuth: false });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function account(status: "active" | "suspended" | "disabled" = "active") {
        return db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", status } });
    }

    async function invitedTeam(options: Readonly<{
        role?: "admin" | "member" | "guest";
        historyAccess?: "all_existing" | "from_membership";
        recipientEmailNormalized?: string | null;
    }> = {}) {
        const owner = await account();
        const team = await db.team.create({ data: { name: "Acme" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const created = await inTx(async (tx) => createTeamInvitationForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: owner.id,
            role: options.role ?? "member",
            historyAccess: options.historyAccess ?? "from_membership",
            recipientEmailNormalized: options.recipientEmailNormalized ?? null,
            emailDeliveryAvailable: true,
            requestKey: crypto.randomUUID(),
        }));
        if (!created.ok) throw new Error(`invitation setup failed: ${created.error}`);
        return { owner, team, invitation: created.value.invitation, token: created.value.token };
    }

    function accept(token: unknown, accountId: string) {
        return inTx(async (tx) => acceptTeamInvitationInTx(tx, {
            token, accountId,
        }));
    }

    it("joins the exact Team and mints the membership in the same transaction", async () => {
        const f = await invitedTeam();
        const joiner = await account();

        expect(await accept(f.token, joiner.id)).toEqual({ outcome: "joined", teamId: f.team.id });

        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: f.team.id, accountId: joiner.id } },
        });
        expect(membership.role).toBe("member");
        // `from_membership` mints a real cutoff from the transaction clock.
        expect(membership.sessionAccessStartsAt).not.toBeNull();

        const consumed = await db.teamInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } });
        expect(consumed.acceptedByAccountId).toBe(joiner.id);
        expect(consumed.acceptedAt).not.toBeNull();
    });

    it("refuses an outstanding invitation at the Home cap and keeps it available for a retry", async () => {
        const f = await invitedTeam();
        const joiner = await account();
        vi.stubEnv("HAPPIER_TEAMS__MAX_MEMBERS", "1");
        try {
            await expect(accept(f.token, joiner.id)).rejects.toMatchObject({
                result: { outcome: "team_member_limit_reached" },
            });
            await expect(db.teamInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } }))
                .resolves.toMatchObject({ acceptedAt: null });
            await expect(accept(f.token, f.owner.id)).resolves.toEqual({ outcome: "already_member", teamId: f.team.id });
            vi.stubEnv("HAPPIER_TEAMS__MAX_MEMBERS", "2");
            await expect(accept(f.token, joiner.id)).resolves.toEqual({ outcome: "joined", teamId: f.team.id });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("stores no cutoff when the invitation offered all existing Team history", async () => {
        const f = await invitedTeam({ historyAccess: "all_existing" });
        const joiner = await account();
        expect((await accept(f.token, joiner.id)).outcome).toBe("joined");

        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: f.team.id, accountId: joiner.id } },
        });
        expect(membership.sessionAccessStartsAt).toBeNull();
    });

    it("carries the offered Guest role through to the membership", async () => {
        const f = await invitedTeam({ role: "guest" });
        const joiner = await account();
        expect((await accept(f.token, joiner.id)).outcome).toBe("joined");
        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: f.team.id, accountId: joiner.id } },
        });
        expect(membership.role).toBe("guest");
    });

    it("does not apply all-existing history from a legacy malformed Guest invitation", async () => {
        const f = await invitedTeam({ role: "guest", historyAccess: "all_existing" });
        await db.teamInvitation.update({
            where: { id: f.invitation.id }, data: { historyAccess: "all_existing" },
        });
        const joiner = await account();
        expect((await accept(f.token, joiner.id)).outcome).toBe("joined");
        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: f.team.id, accountId: joiner.id } },
        });
        expect(membership.role).toBe("guest");
        expect(membership.sessionAccessStartsAt).not.toBeNull();
    });

    it("answers an existing member without burning a still-transferable link", async () => {
        const f = await invitedTeam();
        const joiner = await account();

        expect(await accept(f.token, f.owner.id)).toEqual({ outcome: "already_member", teamId: f.team.id });
        const untouched = await db.teamInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } });
        expect(untouched.acceptedAt).toBeNull();

        // The link is still usable by somebody else, which is the whole point of R10.
        expect(await accept(f.token, joiner.id)).toEqual({ outcome: "joined", teamId: f.team.id });
    });

    it("lets exactly one of two concurrent joiners become a member", async () => {
        const f = await invitedTeam();
        const first = await account();
        const second = await account();

        const results = await Promise.all([
            accept(f.token, first.id),
            accept(f.token, second.id),
        ]);
        const outcomes: string[] = results.map((result: { outcome: string }) => result.outcome);

        expect(outcomes.filter((outcome: string) => outcome === "joined")).toHaveLength(1);
        expect(outcomes.filter((outcome: string) => outcome === "used")).toHaveLength(1);
        expect(await db.teamMembership.count({ where: { teamId: f.team.id } })).toBe(2); // owner + one joiner
    });

    it("lets exactly one complete acceptance-or-reissue transition win", async () => {
        const f = await invitedTeam();
        const joiner = await account();

        const [accepted, reissued] = await Promise.all([
            accept(f.token, joiner.id),
            inTx((tx) => reissueTeamInvitationForActorInTx(tx, {
                teamId: f.team.id,
                actorAccountId: f.owner.id,
                invitationId: f.invitation.id,
                replacementRecipientEmailNormalized: null,
                requestKey: crypto.randomUUID(),
                emailDeliveryAvailable: true,
            })),
        ]);

        const membership = await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: f.team.id, accountId: joiner.id } },
        });
        const invitations = await db.teamInvitation.findMany({ where: { teamId: f.team.id } });
        if (accepted.outcome === "joined") {
            expect(reissued).toEqual({ ok: false, error: "invitation_not_active" });
            expect(membership).not.toBeNull();
            expect(invitations).toHaveLength(1);
            expect(invitations[0]).toMatchObject({ acceptedByAccountId: joiner.id, revokedAt: null });
        } else {
            expect(accepted).toEqual({ outcome: "revoked" });
            expect(reissued.ok).toBe(true);
            expect(membership).toBeNull();
            expect(invitations).toHaveLength(2);
            expect(invitations.filter((row) => row.acceptedAt !== null)).toHaveLength(0);
            expect(invitations.filter((row) => row.revokedAt === null)).toHaveLength(1);
        }
    });

    it("lets exactly one recipient consume an email-bound invitation and attaches evidence only to the winner", async () => {
        const f = await invitedTeam({ recipientEmailNormalized: "winner@example.test" });
        const first = await account();
        const second = await account();

        const results = await Promise.all([
            accept(f.token, first.id),
            accept(f.token, second.id),
        ]);
        const joinedIndex = results.findIndex((result) => result.outcome === "joined");
        expect(joinedIndex).toBeGreaterThanOrEqual(0);
        expect(results.filter((result) => result.outcome === "used")).toHaveLength(1);

        expect(await db.accountEmail.count({
            where: { normalizedEmail: "winner@example.test" },
        })).toBe(1);
        const winnerAccountId = joinedIndex === 0 ? first.id : second.id;
        expect(await db.accountEmail.findUnique({
            where: {
                accountId_normalizedEmail: {
                    accountId: winnerAccountId,
                    normalizedEmail: "winner@example.test",
                },
            },
        })).not.toBeNull();
    });

    it("gives every terminal state its own answer with no membership side effect", async () => {
        const joiner = await account();

        const used = await invitedTeam();
        expect((await accept(used.token, (await account()).id)).outcome).toBe("joined");
        expect(await accept(used.token, joiner.id)).toEqual({ outcome: "used" });

        const revoked = await invitedTeam();
        await inTx(async (tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: revoked.team.id, actorAccountId: revoked.owner.id, invitationId: revoked.invitation.id,
        }));
        expect(await accept(revoked.token, joiner.id)).toEqual({ outcome: "revoked" });

        const expired = await invitedTeam();
        await db.teamInvitation.update({
            where: { id: expired.invitation.id },
            data: { expiresAt: new Date(Date.now() - 60_000) },
        });
        expect(await accept(expired.token, joiner.id)).toEqual({ outcome: "expired" });

        const archived = await invitedTeam();
        await db.team.update({ where: { id: archived.team.id }, data: { archivedAt: new Date() } });
        expect(await accept(archived.token, joiner.id)).toEqual({ outcome: "team_archived" });

        expect(await accept("not-a-token", joiner.id)).toEqual({ outcome: "not_found" });

        // None of the refused paths created a membership anywhere.
        expect(await db.teamMembership.count({ where: { accountId: joiner.id } })).toBe(0);
    });

    it("refuses an inactive Account before consuming anything", async () => {
        for (const status of ["suspended", "disabled"] as const) {
            const f = await invitedTeam();
            const joiner = await account(status);
            expect(await accept(f.token, joiner.id)).toEqual({ outcome: "account_inactive" });
            const untouched = await db.teamInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } });
            expect(untouched.acceptedAt).toBeNull();
        }
    });

    it("refuses a stale invitation after the Team changes its admission mode without consuming it", async () => {
        for (const admissionMode of ["provisioned", "jit"] as const) {
            const f = await invitedTeam();
            const joiner = await account();
            await db.team.update({ where: { id: f.team.id }, data: { admissionMode } });

            expect(await accept(f.token, joiner.id)).toEqual({ outcome: "not_found" });
            expect(await db.teamInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } }))
                .toMatchObject({ acceptedAt: null, acceptedByAccountId: null });
            expect(await db.teamMembership.findUnique({
                where: { teamId_accountId: { teamId: f.team.id, accountId: joiner.id } },
            })).toBeNull();
        }
    });

    it("keeps terminal invitation outcomes distinct after the Team changes admission mode", async () => {
        const joiner = await account();

        const used = await invitedTeam();
        expect((await accept(used.token, (await account()).id)).outcome).toBe("joined");

        const revoked = await invitedTeam();
        await inTx((tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: revoked.team.id,
            actorAccountId: revoked.owner.id,
            invitationId: revoked.invitation.id,
        }));

        const expired = await invitedTeam();
        await db.teamInvitation.update({
            where: { id: expired.invitation.id },
            data: { expiresAt: new Date(Date.now() - 60_000) },
        });

        for (const fixture of [used, revoked, expired]) {
            await db.team.update({
                where: { id: fixture.team.id },
                data: { admissionMode: "provisioned" },
            });
        }

        expect(await accept(used.token, joiner.id)).toEqual({ outcome: "used" });
        expect(await accept(revoked.token, joiner.id)).toEqual({ outcome: "revoked" });
        expect(await accept(expired.token, joiner.id)).toEqual({ outcome: "expired" });
        expect(await db.teamMembership.count({ where: { accountId: joiner.id } })).toBe(0);
    });

    it("atomically attaches an email-bound invitation's exact mailbox evidence to the accepting Account", async () => {
        const f = await invitedTeam({ recipientEmailNormalized: "invited@example.test" });
        const invited = await account();

        expect(await accept(f.token, invited.id)).toEqual({ outcome: "joined", teamId: f.team.id });
        expect(await db.accountEmail.findUnique({
            where: {
                accountId_normalizedEmail: {
                    accountId: invited.id,
                    normalizedEmail: "invited@example.test",
                },
            },
        })).toMatchObject({
            accountId: invited.id,
            address: "invited@example.test",
            normalizedEmail: "invited@example.test",
        });
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: f.team.id, accountId: invited.id } },
        })).not.toBeNull();
        expect(await db.teamInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } }))
            .toMatchObject({ acceptedByAccountId: invited.id });
    });

    it("rolls the acceptance and the membership back together when the transaction fails", async () => {
        const f = await invitedTeam();
        const joiner = await account();

        await expect(inTx(async (tx) => {
            const result = await acceptTeamInvitationInTx(tx, {
                token: f.token, accountId: joiner.id,
            });
            expect(result).toEqual({ outcome: "joined", teamId: f.team.id });
            throw new Error("injected failure after admission");
        })).rejects.toThrow("injected failure after admission");

        const invitation = await db.teamInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } });
        expect(invitation.acceptedAt).toBeNull();
        expect(invitation.acceptedByAccountId).toBeNull();
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: f.team.id, accountId: joiner.id } },
        })).toBeNull();
    });

    it("rolls an email-bound invitation consumption and membership back together", async () => {
        const f = await invitedTeam({ recipientEmailNormalized: "rollback@example.test" });
        const joiner = await account();

        await expect(inTx(async (tx) => {
            const result = await acceptTeamInvitationInTx(tx, {
                token: f.token, accountId: joiner.id,
            });
            expect(result).toEqual({ outcome: "joined", teamId: f.team.id });
            throw new Error("injected failure after email-bound admission");
        })).rejects.toThrow("injected failure after email-bound admission");

        expect((await db.teamInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } })).acceptedAt).toBeNull();
        expect(await db.accountEmail.count({ where: { accountId: joiner.id } })).toBe(0);
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: f.team.id, accountId: joiner.id } },
        })).toBeNull();
    });

    it("throws a typed abort so a fresh Account cannot commit after a normal acceptance failure", async () => {
        const f = await invitedTeam();
        const first = await account();
        expect((await accept(f.token, first.id)).outcome).toBe("joined");
        const freshAccountId = crypto.randomUUID();

        let caught: unknown;
        try {
            await inTx(async (tx) => {
                await tx.account.create({
                    data: { id: freshAccountId, publicKey: crypto.randomUUID(), encryptionMode: "plain" },
                });
                await requireAcceptedTeamInvitationInTx(tx, {
                    token: f.token,
                    accountId: freshAccountId,
                });
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(TeamInvitationAcceptanceAbort);
        expect(caught).toMatchObject({
            name: "TeamInvitationAcceptanceAbort",
            result: { outcome: "used" },
        });
        expect(await db.account.findUnique({ where: { id: freshAccountId } })).toBeNull();
    });

    it("wakes the Team's people through the canonical Team change publisher, and only on a join", async () => {
        const f = await invitedTeam();
        const joiner = await account();
        await db.accountChange.deleteMany();

        expect(await accept(f.token, joiner.id)).toEqual({ outcome: "joined", teamId: f.team.id });

        // The joiner's own Team list and every existing member's roster changed;
        // both are woken by the one Team publisher rather than by an
        // invitation-specific event of its own.
        const woken = await db.accountChange.findMany({ where: { entityId: TEAM_CHANGE_ENTITY_ID } });
        expect(new Set(woken.map((row) => row.accountId)))
            .toEqual(new Set([f.owner.id, joiner.id]));

        // A refused acceptance changes nothing, so it must wake nobody.
        await db.accountChange.deleteMany();
        const stranger = await account();
        expect(await accept(f.token, stranger.id)).toEqual({ outcome: "used" });
        expect(await db.accountChange.count({ where: { entityId: TEAM_CHANGE_ENTITY_ID } })).toBe(0);
    });
});
