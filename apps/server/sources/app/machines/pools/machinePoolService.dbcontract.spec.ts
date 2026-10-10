import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { deleteTeamCredentialResourceInTx } from "@/app/teams/credentials/resourceDelete";
import { updateTeamCredentialResourceInTx } from "@/app/teams/credentials/resourceUpdate";
import type { MachineDaemonPresenceSocketServer } from "../machineDaemonPresence";
import { createMachinePool, deleteMachinePool, updateMachinePool } from "./machinePoolService";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .toString()
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported contract provider: ${raw}`);
}

const disconnectedPresence: MachineDaemonPresenceSocketServer = {
    in: () => ({ fetchSockets: async () => [] }),
};

const TEST_AUTHENTICATION = {
    authenticationAuthority: "present_user",
    authenticationEvidence: [],
} as const;

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = () => settle();
    });
    return { promise, resolve };
}

describe("Machine Pool aggregate provider contract", () => {
    const provider = resolveContractProvider();
    const accountId = `machine-pool-scale-account-${randomUUID()}`;
    const poolId = randomUUID();
    const teamId = `machine-pool-provider-team-${randomUUID()}`;
    const members = Array.from({ length: 1_001 }, (_, index) => ({
        machineId: `machine-pool-scale-${accountId}-${index.toString().padStart(4, "0")}`,
        priorityTier: index % 3,
        enabled: true,
    }));
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        await db.machine.createMany({
            data: members.map((member) => ({ id: member.machineId, accountId, metadata: "{}" })),
        });
    }, 120_000);

    afterAll(async () => {
        if (!connected) return;
        await db.team.deleteMany({ where: { id: teamId } });
        await db.machine.deleteMany({ where: { accountId } });
        await db.account.deleteMany({ where: { id: accountId } });
        await db.$disconnect();
    });

    it(`keeps the large aggregate, CAS, and deletion semantics atomic on ${provider}`, async () => {
        const created = await createMachinePool({
            accountId,
            input: { poolId, name: "Provider-scale aggregate", members },
            io: disconnectedPresence,
        });
        expect(created).toMatchObject({ ok: true, value: { pool: { revision: 0 } } });
        expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(1_001);

        const replacement = members.map((member, index) => ({
            ...member,
            priorityTier: index % 5,
        }));
        const updated = await updateMachinePool({
            accountId,
            input: {
                poolId,
                expectedRevision: 0,
                name: "Provider-scale aggregate updated",
                members: replacement,
            },
            io: disconnectedPresence,
        });
        expect(updated).toMatchObject({ ok: true, value: { pool: { revision: 1 } } });
        expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(1_001);
        expect(await db.accountChange.count({ where: { accountId, kind: "machinePool" } })).toBe(1);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
            .toEqual({ seq: 2 });

        const stale = await updateMachinePool({
            accountId,
            input: {
                poolId,
                expectedRevision: 0,
                name: "Stale aggregate edit",
                members: replacement.slice(1),
            },
            io: disconnectedPresence,
        });
        expect(stale).toMatchObject({
            ok: false,
            error: {
                code: "pool_changed",
                current: { pool: { revision: 1, name: "Provider-scale aggregate updated" } },
            },
        });
        expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(1_001);

        await db.machine.delete({ where: { id: replacement[0]!.machineId } });
        expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(1_000);

        await expect(deleteMachinePool({
            accountId,
            input: { poolId, expectedRevision: 1 },
            io: disconnectedPresence,
        })).resolves.toEqual({ ok: true, value: { poolId, deleted: true } });
        expect(await db.machinePool.count({ where: { id: poolId } })).toBe(0);
        expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(0);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
            .toEqual({ seq: 3 });

        await expect(deleteMachinePool({
            accountId,
            input: { poolId, expectedRevision: 1 },
            io: disconnectedPresence,
        })).resolves.toEqual({ ok: true, value: { poolId, deleted: true } });
    }, 120_000);

    it(`serializes resource attachment and Pool deletion through the parent-row fence on ${provider}`, async () => {
        const attachedPoolId = randomUUID();
        const resourceId = randomUUID();
        await db.team.create({ data: { id: teamId, name: "Machine Pool provider contract" } });
        await db.teamMembership.create({
            data: { teamId, accountId, role: "owner" },
        });
        await db.teamCredentialResource.create({
            data: {
                id: resourceId,
                teamId,
                custodianAccountId: accountId,
                displayName: "Provider-contract resource",
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    v: 1,
                    kind: "provider_connection",
                    connectionId: "provider-contract",
                    connectionSecurityFingerprint: "connection-security:v1:provider-contract",
                    credentialSlotId: "apiKey",
                }),
            },
        });
        await expect(createMachinePool({
            accountId,
            input: { poolId: attachedPoolId, name: "Attached Pool", members: [] },
            io: disconnectedPresence,
        })).resolves.toMatchObject({ ok: true, value: { pool: { revision: 0 } } });

        const attachmentEntered = createDeferred();
        const allowAttachmentCommit = createDeferred();
        const attachment = inTx(async (tx) => {
            const result = await updateTeamCredentialResourceInTx(tx, {
                actorAccountId: accountId,
                authentication: TEST_AUTHENTICATION,
                patch: {
                    resourceId,
                    expectedRevision: 0,
                    brokerPlacement: { kind: "machine_pool", poolId: attachedPoolId },
                },
            });
            attachmentEntered.resolve();
            await allowAttachmentCommit.promise;
            return result;
        });
        await attachmentEntered.promise;

        let deletionSettled = false;
        const deletion = deleteMachinePool({
            accountId,
            input: { poolId: attachedPoolId, expectedRevision: 0 },
            io: disconnectedPresence,
        }).finally(() => {
            deletionSettled = true;
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(deletionSettled).toBe(false);
        } finally {
            allowAttachmentCommit.resolve();
        }
        await expect(attachment).resolves.toEqual({ ok: true, resourceId, revision: 1 });
        await expect(deletion).resolves.toEqual({
            ok: true,
            value: { poolId: attachedPoolId, deleted: true },
        });
        await expect(db.teamCredentialResource.findUniqueOrThrow({
            where: { id: resourceId },
            select: { brokerMachineId: true, brokerPoolId: true, revision: true },
        })).resolves.toEqual({ brokerMachineId: null, brokerPoolId: null, revision: 2 });

        await expect(inTx((tx) => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: accountId,
            authentication: TEST_AUTHENTICATION,
            patch: {
                resourceId,
                expectedRevision: 1,
                displayName: "Stale resource update",
            },
        }))).resolves.toEqual({ ok: false, error: "resource_changed" });
        await expect(inTx((tx) => deleteTeamCredentialResourceInTx(tx, {
            actorAccountId: accountId,
            resourceId,
            expectedRevision: 1,
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, error: "resource_changed" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({
            where: { id: resourceId },
            select: { displayName: true, brokerPoolId: true, revision: true },
        })).resolves.toEqual({
            displayName: "Provider-contract resource",
            brokerPoolId: null,
            revision: 2,
        });
    }, 120_000);
});
