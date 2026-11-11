import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getMachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    resolveTeamCredentialBrokerMachineForOpenInTx,
    resolveTeamCredentialBrokerMachineForSaveInTx,
} from "./brokerMachineEligibility";

const endpointId = "a".repeat(64);
const capabilities = {
    providerBrokerIngress: { protocolVersions: [1] },
    irohMachineEndpoint: { protocolVersions: [1], endpointId },
};

describe("Team credential broker Machine eligibility", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-broker-machine-", initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(overrides: Partial<Prisma.MachineUncheckedCreateInput> = {}) {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: {
            id: `broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            active: false,
            operationProtocolCapabilities: capabilities,
            operationProtocolCapabilitiesRevision: 3,
            ...overrides,
        } });
        const target = { custodianAccountId: custodian.id, brokerMachineId: machine.id };
        const save = () => inTx(tx => resolveTeamCredentialBrokerMachineForSaveInTx(tx, target));
        // Socket.IO is the network boundary; the real presence owner still
        // filters authenticated Machine identities and adapter failures.
        const open = async (socketData: readonly unknown[]) => {
            const presence = await getMachineDaemonPresenceInventory({
                accountId: custodian.id,
                io: { in: () => ({ fetchSockets: async () => socketData.map(data => ({ data })) }) },
            });
            return inTx(tx => resolveTeamCredentialBrokerMachineForOpenInTx(tx, { ...target, presence }));
        };
        const socket = { clientType: "machine-scoped", userId: custodian.id, machineId: machine.id };
        return { custodian, machine, target, save, open, socket };
    }

    it("saves offline compatibility without requiring a live transport endpoint", async () => {
        const f = await fixture({ operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } } });
        await expect(f.save()).resolves.toEqual({ ok: true, machineId: f.machine.id });
        await expect(f.open([f.socket])).resolves.toEqual({ ok: false, error: "broker_unavailable", refusalReason: "placement_endpoint_missing" });
    });

    it.each([
        { kind: "ephemeral_session_runner" as const },
        { revokedAt: new Date(0) },
        { replacedByMachineId: "replacement" },
    ])("rejects an ineligible saved Machine %j even when its broker capability remains", async (overrides) => {
        const f = await fixture(overrides);
        await expect(f.save()).resolves.toEqual({ ok: false, error: "broker_unavailable" });
        await expect(f.open([f.socket])).resolves.toEqual({ ok: false, error: "broker_unavailable", refusalReason: "broker_ineligible" });
    });

    it("requires the exact Machine to belong to the source custodian", async () => {
        const f = await fixture();
        const other = await db.account.create({ data: { encryptionMode: "plain" } });
        for (const target of [
            { ...f.target, custodianAccountId: other.id },
            { ...f.target, brokerMachineId: null },
            { ...f.target, brokerMachineId: "missing" },
        ]) {
            await expect(inTx(tx => resolveTeamCredentialBrokerMachineForSaveInTx(tx, target)))
                .resolves.toEqual({ ok: false, error: "broker_unavailable" });
        }
    });

    it.each([
        {},
        { irohMachineEndpoint: capabilities.irohMachineEndpoint },
        { providerBrokerIngress: { protocolVersions: [2] } },
    ])("requires explicit valid broker protocol support for %j", async (projection) => {
        const f = await fixture({ operationProtocolCapabilities: projection });
        await expect(f.save()).resolves.toEqual({ ok: false, error: "update_required" });
        await expect(f.open([f.socket])).resolves.toEqual({ ok: false, error: "update_required" });
    });

    it("reads supported broker capability from retained metadata with an extra field", async () => {
        const f = await fixture({ operationProtocolCapabilities: {
            ...capabilities, providerBrokerIngress: { protocolVersions: [1], ready: true },
        } });
        await expect(f.save()).resolves.toEqual({ ok: true, machineId: f.machine.id });
        await expect(f.open([f.socket])).resolves.toEqual({
            ok: true, machineId: f.machine.id, endpointAuthority: { endpointId, revision: 3 },
        });
    });

    it("opens only against current authenticated presence and rereads endpoint and capability changes", async () => {
        const f = await fixture();
        await expect(f.save()).resolves.toEqual({ ok: true, machineId: f.machine.id });
        await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
        // BROKER-PRESENCE-1111: retained Home history can report a reconnect
        // whose clock precedes the disconnect. Neither timestamp nor revision
        // replaces authenticated transport presence for a new broker open.
        const transitions = JSON.stringify({
            v: 1, revision: 1952,
            offline: { revision: 1951, occurredAt: 1794418669240 },
            online: { revision: 1952, occurredAt: 1794418668763 },
        });
        await db.$executeRaw`UPDATE "Machine" SET "presenceTransitions" = ${transitions} WHERE "id" = ${f.machine.id}`;
        await expect(f.open([])).resolves.toEqual({ ok: false, error: "broker_unavailable", refusalReason: "broker_offline" });
        await expect(f.open([f.socket])).resolves.toEqual({
            ok: true, machineId: f.machine.id, endpointAuthority: { endpointId, revision: 3 },
        });
        await expect(f.open([{ ...f.socket, clientType: "user-scoped" }, { ...f.socket, userId: "other" }]))
            .resolves.toEqual({ ok: false, error: "broker_unavailable", refusalReason: "broker_offline" });

        await db.machine.update({ where: { id: f.machine.id }, data: { active: false } });
        await expect(f.open([f.socket])).resolves.toEqual({
            ok: true, machineId: f.machine.id, endpointAuthority: { endpointId, revision: 3 },
        });
        const replacementEndpoint = "b".repeat(64);
        await db.machine.update({ where: { id: f.machine.id }, data: {
            operationProtocolCapabilities: {
                ...capabilities,
                irohMachineEndpoint: { protocolVersions: [1], endpointId: replacementEndpoint },
            },
            operationProtocolCapabilitiesRevision: 4,
        } });
        await expect(f.open([f.socket])).resolves.toEqual({
            ok: true, machineId: f.machine.id, endpointAuthority: { endpointId: replacementEndpoint, revision: 4 },
        });
        await db.machine.update({ where: { id: f.machine.id }, data: {
            operationProtocolCapabilities: { irohMachineEndpoint: capabilities.irohMachineEndpoint },
        } });
        await expect(f.open([f.socket])).resolves.toEqual({ ok: false, error: "update_required" });
    });

    it("requires a current capability projection before save or open, then still fails closed on unknown presence", async () => {
        const f = await fixture({ operationProtocolCapabilitiesRevision: null });
        await expect(f.save()).resolves.toEqual({ ok: false, error: "update_required" });
        await expect(f.open([f.socket])).resolves.toEqual({ ok: false, error: "update_required" });
        await db.machine.update({ where: { id: f.machine.id }, data: { operationProtocolCapabilitiesRevision: 3 } });
        const presence = await getMachineDaemonPresenceInventory({
            accountId: f.custodian.id,
            io: { in: () => ({ fetchSockets: async () => { throw new Error("adapter unavailable"); } }) },
        });
        await expect(inTx(tx => resolveTeamCredentialBrokerMachineForOpenInTx(tx, { ...f.target, presence })))
            .resolves.toEqual({ ok: false, error: "broker_unavailable", refusalReason: "broker_presence_unknown" });
    });
});
