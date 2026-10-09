import { randomUUID } from "node:crypto";
import { decodeBase64 } from "privacy-kit";
import type { Socket } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";

import { eventRouter } from "@/app/events/connectionEventRouter";
import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { removeMachineAccessGrantInTx, resolveEffectiveMachineRoleInTx } from "@/app/machines/machineAccess";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket } from "@/app/api/testkit/socketHarness";
import { applyTeamGroupContributionInTx } from "../groups/groupContributions";
import { withTeamSessionAccessEffectsInTx } from "./sessionAccessEffects";
import { setTeamMembershipStatusInTx } from "./membershipService";

describe("Machine effective access membership effects (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    const connections: ClientConnection[] = [];
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-membership-effects-", initAuth: false });
    }, 180_000);
    afterAll(async () => {
        for (const connection of connections) eventRouter.removeConnection(connection.userId, connection);
        if (harness) await harness.close();
    });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const member = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Machine membership effects" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Group", nameKey: "group" } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: "host", platform: "linux", happyCliVersion: "test", homeDir: "/home/test", happyHomeDir: "/home/test/.happier" }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
        } });
        await db.machineTeamGrant.create({ data: { machineId: machine.id, teamId: team.id, accessLevel: "view", createdByAccountId: owner.id } });
        await db.machineGroupGrant.create({ data: { machineId: machine.id, teamGroupId: group.id, accessLevel: "view", createdByAccountId: owner.id } });
        const session = await db.session.create({ data: { accountId: member.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        await db.accessKey.create({ data: { accountId: member.id, machineId: machine.id, sessionId: session.id, data: "retained-session-key" } });
        function connect(accountId: string, sessionId: string, machineId: string) {
            // Socket transport is the system boundary; the real event-router and access union remain active.
            const disconnect = vi.fn();
            const socket = Object.assign(createFakeSocket({ data: { clientType: "session-scoped" } }), { disconnect });
            const connection: ClientConnection = { connectionType: "session-scoped", userId: accountId, sessionId, machineId, socket: socket as unknown as Socket };
            eventRouter.addConnection(accountId, connection);
            connections.push(connection);
            return disconnect;
        }
        const disconnected = connect(member.id, session.id, machine.id);
        const unrelatedDisconnected = connect(owner.id, session.id, machine.id);
        const otherMachineDisconnected = connect(member.id, session.id, randomUUID());
        return { owner, member, team, membership, group, machine, session, disconnected, unrelatedDisconnected, otherMachineDisconnected };
    }

    it("preserves overlapping grants and evicts only the final-loss actor's exact Machine sockets, retaining history and keys", async () => {
        const f = await fixture();
        await inTx(tx => applyTeamGroupContributionInTx(tx, {
            teamId: f.team.id, teamGroupId: f.group.id, teamMembershipId: f.membership.id,
            contribution: { kind: "native" }, desired: "absent", historyAccess: "all_existing",
        }));
        expect(f.disconnected).not.toHaveBeenCalled();
        await inTx(tx => setTeamMembershipStatusInTx(tx, {
            teamId: f.team.id, membershipId: f.membership.id, accountId: f.member.id, status: "suspended",
        }));
        expect(f.disconnected).toHaveBeenCalledWith(true);
        expect(f.unrelatedDisconnected).not.toHaveBeenCalled();
        expect(f.otherMachineDisconnected).not.toHaveBeenCalled();
        expect(await db.accountChange.count({ where: { accountId: f.member.id, entityId: f.machine.id, kind: "machine" } })).toBe(1);
        expect(await db.session.findUnique({ where: { id: f.session.id } })).not.toBeNull();
        expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: { accountId: f.member.id, machineId: f.machine.id, sessionId: f.session.id } } })).toMatchObject({ data: "retained-session-key" });
        await inTx(tx => setTeamMembershipStatusInTx(tx, {
            teamId: f.team.id, membershipId: f.membership.id, accountId: f.member.id, status: "active",
        }));
        expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: f.member.id, machineId: f.machine.id }))).toBe("use");
    });

    it("uses the enclosing atomic mutation's final union for bulk loss and rolls all invalidation back on failure", async () => {
        const f = await fixture();
        await expect(inTx(tx => withTeamSessionAccessEffectsInTx(tx, {
            teamId: f.team.id, accountIds: [f.member.id], origin: "relationship_change",
        }, async () => {
            await tx.teamMembership.delete({ where: { id: f.membership.id } });
            throw new Error("rollback mutation");
        }))).rejects.toThrow("rollback mutation");
        expect(f.disconnected).not.toHaveBeenCalled();
        expect(await db.accountChange.count({ where: { accountId: f.member.id, entityId: f.machine.id } })).toBe(0);
        await inTx(tx => withTeamSessionAccessEffectsInTx(tx, {
            teamId: f.team.id, accountIds: [f.member.id], origin: "relationship_change",
        }, async impacts => {
            await setTeamMembershipStatusInTx(tx, { teamId: f.team.id, membershipId: f.membership.id, accountId: f.member.id, status: "suspended", sessionAccessImpacts: impacts });
            // Replacement independent authority is part of the same atomic bulk change.
            await tx.machineAccountGrant.create({ data: { machineId: f.machine.id, accountId: f.member.id, accessLevel: "view", createdByAccountId: f.owner.id } });
        }));
        expect(f.disconnected).not.toHaveBeenCalled();
        expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: f.member.id, machineId: f.machine.id }))).toBe("use");
    });

    it("publishes final Group loss and reconciles every Account in a bulk Team removal", async () => {
        const groupOnly = await fixture();
        await db.machineTeamGrant.deleteMany({ where: { machineId: groupOnly.machine.id } });
        await inTx(tx => applyTeamGroupContributionInTx(tx, {
            teamId: groupOnly.team.id, teamGroupId: groupOnly.group.id, teamMembershipId: groupOnly.membership.id,
            contribution: { kind: "native" }, desired: "absent", historyAccess: "all_existing",
        }));
        expect(groupOnly.disconnected).toHaveBeenCalledWith(true);
        const f = await fixture();
        const second = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        await db.teamMembership.create({ data: { teamId: f.team.id, accountId: second.id, role: "member" } });
        await inTx(tx => withTeamSessionAccessEffectsInTx(tx, { teamId: f.team.id, origin: "relationship_change" }, async () => {
            await tx.teamMembership.deleteMany({ where: { teamId: f.team.id } });
        }));
        expect(f.disconnected).toHaveBeenCalledWith(true);
        for (const accountId of [f.member.id, second.id]) {
            expect(await db.accountChange.count({ where: { accountId, entityId: f.machine.id, kind: "machine" } })).toBe(1);
            expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: accountId, machineId: f.machine.id }))).toBeNull();
        }
    });

    it("refreshes the manager's grant roster when a weaker grant is removed and stronger access survives", async () => {
        const f = await fixture();
        await db.machineAccountGrant.create({ data: { machineId: f.machine.id, accountId: f.member.id, accessLevel: "admin", createdByAccountId: f.owner.id } });
        await inTx(tx => removeMachineAccessGrantInTx(tx, {
            actorAccountId: f.owner.id, machineId: f.machine.id,
            principal: { kind: "group", teamId: f.team.id, groupId: f.group.id },
        }));
        expect(f.disconnected).not.toHaveBeenCalled();
        expect(await db.machineGroupGrant.count({ where: { machineId: f.machine.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: f.owner.id, entityId: f.machine.id, kind: "machine" } })).toBe(1);
    });

    it("applies the same exact requester loss after direct Leave without deleting the requester's history", async () => {
        const f = await fixture();
        await db.machineTeamGrant.deleteMany({ where: { machineId: f.machine.id } });
        await db.machineGroupGrant.deleteMany({ where: { machineId: f.machine.id } });
        await db.machineAccountGrant.create({ data: { machineId: f.machine.id, accountId: f.member.id, accessLevel: "view", createdByAccountId: f.owner.id } });
        expect(await inTx(tx => removeMachineAccessGrantInTx(tx, {
            actorAccountId: f.member.id, machineId: f.machine.id,
            principal: { kind: "account", accountId: f.member.id }, leave: true,
        }))).toMatchObject({ kind: "left", effectiveAccess: "none" });
        expect(f.disconnected).toHaveBeenCalledWith(true);
        expect(f.unrelatedDisconnected).not.toHaveBeenCalled();
        expect(f.otherMachineDisconnected).not.toHaveBeenCalled();
        expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
            accountId: f.member.id, machineId: f.machine.id, sessionId: f.session.id,
        } } })).toMatchObject({ data: "retained-session-key" });
        expect(await db.session.findUnique({ where: { id: f.session.id } })).not.toBeNull();
    });
});
