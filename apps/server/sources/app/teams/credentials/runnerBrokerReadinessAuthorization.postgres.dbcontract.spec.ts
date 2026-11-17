import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerCredentialSelectionBindingV1 } from "@happier-dev/protocol/ephemeralRunner/review";

import { createQualifiedConnectedAccountGroupDigest, createQualifiedConnectedAccountServiceDigest } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { readRunnerBrokerReadinessProjectionInTx } from "./runnerBrokerReadinessAuthorization";
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Runner broker admitted Machine read cost (PostgreSQL)", () => {
    let client: PrismaClientType;
    let machineSelects = 0;
    beforeAll(async () => {
        client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        onDbClientQuery(client, event => { if (/^\s*SELECT\b/i.test(event.query) && /FROM "public"\."Machine"(?:\s|$)/.test(event.query)) machineSelects++; });
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); });

    it("reads the exact current Machine once per projection and refuses revoked or changed authority", async () => {
        const [creator, custodian, stranger] = await Promise.all([0, 1, 2].map(() => client.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
        const team = await client.team.create({ data: { name: `Runner cost ${randomUUID()}` } });
        try {
            const creatorMembership = await client.teamMembership.create({ data: { teamId: team.id, accountId: creator!.id, role: "member" } });
            await client.teamMembership.create({ data: { teamId: team.id, accountId: custodian!.id, role: "owner" } });
            const service = { pluginId: "runner.cost", localId: "source" };
            const groupId = randomUUID();
            const pool = await client.connectedServiceAuthGroup.create({ data: {
                accountId: custodian!.id, groupId, servicePluginId: service.pluginId, serviceLocalId: service.localId,
                qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
                qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }), policyJson: "{}",
            } });
            const endpointId = "a".repeat(64);
            const capabilities = { providerBrokerIngress: { protocolVersions: [1] }, irohMachineEndpoint: { protocolVersions: [1], endpointId } };
            const machine = await client.machine.create({ data: {
                id: randomUUID(), accountId: custodian!.id, metadata: "{}", kind: "persistent",
                operationProtocolCapabilities: capabilities, operationProtocolCapabilitiesRevision: 1,
            } });
            const resource = await client.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: custodian!.id, displayName: "Runner cost",
                disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed", brokerMachineId: machine.id,
                sourceBindingJson: JSON.stringify({ v: 1, kind: "connected_pool", target: { kind: "group", service, groupId }, poolIncarnation: pool.id }),
                memberGrants: { create: { teamMembershipId: creatorMembership.id, deliveryMode: "brokered" } },
            } });
            const activation = await client.ephemeralRunnerActivation.create({ data: {
                id: randomUUID(), creatorAccountId: creator!.id, creatorTokenEpoch: creator!.tokenEpoch,
                draftId: randomUUID(), sessionId: randomUUID(), machineId: randomUUID(), state: "pending",
                workspacePolicy: "choose_on_endpoint", activationExpiresAt: null, homeServerIdentityId: "srv_runner_cost",
                activationSigningPublicKey: "activation-key", authoringCommitment: "commitment", artifact: {},
                endpointFactsRecipient: { mode: "plain", creatorAccountId: creator!.id },
            } });
            const selection: RunnerCredentialSelectionBindingV1 = {
                v: 1, resourceId: resource.id, brokerMachineId: machine.id, revision: resource.revision, sourceRevision: "source-1",
                application: { agentTargetKey: "agent:happier.agent.codex/codex", implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" }, endpointTemplateId: "responses", protocol: "openai-responses" },
            };
            const read = () => client.$transaction(tx => readRunnerBrokerReadinessProjectionInTx(tx, { activationId: activation.id, selection }), { isolationLevel: "RepeatableRead" });
            machineSelects = 0;
            expect(await read()).toMatchObject({ target: { endpointId }, readiness: { kind: "available" } });
            console.info("RUNNER_BROKER_MACHINE_READ_COST", { machineSelects });
            expect(machineSelects).toBe(1);

            await client.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            expect(await read()).toBeNull();
            await client.machine.update({ where: { id: machine.id }, data: { revokedAt: null, accountId: stranger!.id } });
            expect(await read()).toBeNull();
            await client.machine.update({ where: { id: machine.id }, data: { accountId: custodian!.id, operationProtocolCapabilitiesRevision: 0 } });
            expect(await read()).toBeNull();
            await client.machine.update({ where: { id: machine.id }, data: { operationProtocolCapabilitiesRevision: 2, operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } } } });
            expect(await read()).toBeNull();
            await client.machine.update({ where: { id: machine.id }, data: { operationProtocolCapabilities: { ...capabilities, irohMachineEndpoint: { protocolVersions: [1], endpointId: "b".repeat(64) } } } });
            expect(await read()).toMatchObject({ target: { endpointId: "b".repeat(64) } });
            await client.teamMembership.update({ where: { id: creatorMembership.id }, data: { status: "suspended" } });
            expect(await read()).toBeNull();
            await client.teamMembership.delete({ where: { id: creatorMembership.id } });
            expect(await read()).toBeNull();
        } finally {
            await client.ephemeralRunnerActivation.deleteMany({ where: { creatorAccountId: creator!.id } });
            await client.team.delete({ where: { id: team.id } });
            await client.machine.deleteMany({ where: { accountId: { in: [custodian!.id, stranger!.id] } } });
            await client.account.deleteMany({ where: { id: { in: [creator!.id, custodian!.id, stranger!.id] } } });
        }
    });
});
