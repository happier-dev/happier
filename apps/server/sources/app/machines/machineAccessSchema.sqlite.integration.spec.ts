import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("Machine sharing relational constraints (real SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-sharing-schema-" });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it("enforces each principal tuple, Use/Manage roles and parent lifetimes", async () => {
        const owner = await db.account.create({ data: {} });
        const recipient = await db.account.create({ data: {} });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "{}" } });
        const team = await db.team.create({ data: { name: "Machine schema" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Group", nameKey: crypto.randomUUID() } });
        for (const [table, principalColumn, principalId] of [
            ["MachineAccountGrant", "accountId", recipient.id],
            ["MachineTeamGrant", "teamId", team.id],
            ["MachineGroupGrant", "teamGroupId", group.id],
        ] as const) {
            const insert = (machineId: string, principal: string, role: string, creator = owner.id) =>
                db.$executeRawUnsafe(`INSERT INTO "${table}" ("machineId", "${principalColumn}", "accessLevel", "createdByAccountId") VALUES (?, ?, ?, ?)`, machineId, principal, role, creator);
            await expect(insert(machine.id, principalId, "edit")).rejects.toThrow();
            await expect(insert("missing-machine", principalId, "view")).rejects.toThrow();
            await expect(insert(machine.id, "missing-principal", "view")).rejects.toThrow();
            await expect(insert(machine.id, principalId, "view", "missing-creator")).rejects.toThrow();
            await expect(insert(machine.id, principalId, "view")).resolves.toBe(1);
            await expect(insert(machine.id, principalId, "admin")).rejects.toThrow();
            await db.$executeRawUnsafe(`UPDATE "${table}" SET "accessLevel" = ? WHERE "machineId" = ?`, "admin", machine.id);
            expect(await db.$queryRawUnsafe(`SELECT "accessLevel", "createdAt" FROM "${table}" WHERE "machineId" = ?`, machine.id))
                .toEqual([{ accessLevel: "admin", createdAt: expect.any(Date) }]);
        }
        await db.machine.delete({ where: { id: machine.id } });
        for (const table of ["MachineAccountGrant", "MachineTeamGrant", "MachineGroupGrant"]) {
            expect(await db.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "machineId" = ?`, machine.id)).toEqual([]);
        }
    });

    it("binds one recipient envelope to its machine and both currentness fingerprints", async () => {
        const owner = await db.account.create({ data: {} });
        const recipient = await db.account.create({ data: {} });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "{}" } });
        const insert = (machineId: string, accountId: string) => db.$executeRawUnsafe(
            'INSERT INTO "MachineKeyEnvelope" ("machineId", "recipientAccountId", "encryptedDataKey", "machineOwnerEnvelopeFingerprint", "recipientContentPublicKeyFingerprint", "updatedAt") VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            machineId, accountId, new Uint8Array([1, 2]), "owner-envelope", "recipient-binding",
        );
        await expect(insert("missing-machine", recipient.id)).rejects.toThrow();
        await expect(insert(machine.id, "missing-recipient")).rejects.toThrow();
        await expect(insert(machine.id, recipient.id)).resolves.toBe(1);
        await expect(insert(machine.id, recipient.id)).rejects.toThrow();
        expect(await db.$queryRawUnsafe('SELECT "machineOwnerEnvelopeFingerprint", "recipientContentPublicKeyFingerprint" FROM "MachineKeyEnvelope" WHERE "machineId" = ?', machine.id))
            .toEqual([{ machineOwnerEnvelopeFingerprint: "owner-envelope", recipientContentPublicKeyFingerprint: "recipient-binding" }]);
        await db.account.delete({ where: { id: recipient.id } });
        expect(await db.$queryRawUnsafe('SELECT * FROM "MachineKeyEnvelope" WHERE "machineId" = ?', machine.id)).toEqual([]);
    });
});
