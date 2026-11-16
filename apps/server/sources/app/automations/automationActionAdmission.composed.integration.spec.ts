import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { automationRoutes } from "@/app/api/routes/automations/automationRoutes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createDatabaseIntegrationHarness } from "@/testkit/databaseIntegrationHarness";
import { createAutomationWorkflowRecipeFixture } from "@/testkit/automationWorkflowRecipe";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { automationSubjectKeyV1 } from "@happier-dev/protocol/automations/automationSubjectV1";
import { AutomationTriggerIdSchema, sealAutomationTriggerDefinitionStoredEnvelopeV1,
    createAccountScopedCryptoMaterialSnapshotV1 } from "@happier-dev/protocol";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

describe("Action occurrence admission through the real router", () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: "action-occurrence-admission-",
            initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: "1", HAPPIER_FEATURE_WORKFLOWS__ENABLED: "1" } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("derives plain subject reach from the Machine grant owner at every write", async () => {
        const ownerId = randomUUID();
        const viewerId = randomUUID();
        const machineId = randomUUID();
        const serverId = await getOrCreateServerIdentityId();
        await db.account.createMany({ data: [ownerId, viewerId].map(id => ({ id, encryptionMode: "plain" })) });
        await db.machine.create({ data: { id: machineId, accountId: ownerId, metadata: "{}", installationId: randomUUID() } });
        await db.machineGrant.create({ data: { machineId, principalKind: "account", accountId: viewerId,
            accessLevel: "view", createdByAccountId: ownerId } });
        const app = createAuthenticatedTestApp();
        automationRoutes(app);
        try {
            for (const accountId of [ownerId, viewerId]) {
                const automationId = randomUUID();
                await db.automation.create({ data: { id: automationId, accountId, name: "Subject reach", enabled: true,
                    templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                        directory: "/tmp/reach", prompt: "Check" })), templateVersion: 1 } });
                const authored = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                    headers: { "x-test-user-id": accountId }, payload: { triggerId: randomUUID(), trigger: {
                        kind: "action", phase: "after", actionIds: ["scm.commit.create"], enabled: true,
                        subject: { kind: "machine", serverId, machineId },
                    } } });
                expect(authored.statusCode, authored.body).toBe(200);
                expect(authored.json().triggers[0]).toMatchObject({ reachesOthers: accountId === ownerId });
            }
            const automationId = randomUUID();
            const triggerId = randomUUID();
            await db.machineGrant.update({ where: { machineId_accountId: { machineId, accountId: viewerId } },
                data: { accessLevel: "admin" } });
            await db.automation.create({ data: { id: automationId, accountId: viewerId, name: "Admitted manager", enabled: true,
                templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                    directory: "/tmp/reach", prompt: "Check" })), templateVersion: 1 } });
            const authored = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": viewerId }, payload: { triggerId, trigger: {
                    kind: "action", phase: "after", actionIds: ["scm.commit.create"], enabled: true,
                    subject: { kind: "machine", serverId, machineId },
                } } });
            expect(authored.statusCode, authored.body).toBe(200);
            expect(authored.json().triggers[0]).toMatchObject({ reachesOthers: true });
            await db.machineGrant.update({ where: { machineId_accountId: { machineId, accountId: viewerId } },
                data: { accessLevel: "view" } });
            const changed = await app.inject({ method: "PATCH", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": viewerId }, payload: { triggerId, expectedRevision: 0, enabled: false } });
            expect(changed.statusCode, changed.body).toBe(200);
            expect(changed.json().triggers[0]).toMatchObject({ enabled: false, reachesOthers: false });
        } finally { await app.close(); }
    });

    it("rejects unproved encrypted reach while preserving own-only encrypted authoring", async () => {
        const accountId = randomUUID();
        const automationId = randomUUID();
        const serverId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        await db.automation.create({ data: { id: automationId, accountId, name: "Private reach", enabled: true,
            templateCiphertext: JSON.stringify({ ...createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                directory: "/tmp/reach", prompt: "Check" }), workflow: { t: "encrypted", c: "private-workflow" } }),
            templateVersion: 1 } });
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: "e2ee",
            material: { type: "legacy", secret: new Uint8Array(32).fill(7) } }).material;
        const app = createAuthenticatedTestApp();
        automationRoutes(app);
        try {
            for (const reachesOthers of [true, false]) {
                for (const scoped of [true, false]) {
                    const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
                    const subject = { kind: "machine" as const, serverId, machineId: randomUUID() };
                    const definition = { kind: "action", phase: "after", actionIds: ["scm.commit.create"],
                        ...(scoped ? { subject } : {}) };
                    const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: "e2ee", material,
                        randomBytes: length => new Uint8Array(length).fill(1),
                        binding: { v: 1, automationId, triggerId, triggerRevision: 0, triggerKind: "action" }, definition });
                    const response = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                        headers: { "x-test-user-id": accountId }, payload: { triggerId, trigger: {
                            kind: "action", phase: "after", actionIds: definition.actionIds, enabled: true,
                            ...(scoped ? { subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject) } : {}),
                            reachesOthers, triggerDefinitionEnvelope: envelope,
                        } } });
                    expect(response.statusCode, response.body).toBe(reachesOthers ? 409 : 200);
                    if (reachesOthers) expect(response.json()).toEqual({ error: "automation_stored_content_unavailable" });
                    else expect(response.json().triggers.find((trigger: { id: string }) => trigger.id === triggerId))
                        .toMatchObject({ reachesOthers: false });
                }
            }
            expect(await db.automationTrigger.count({ where: { automationId } })).toBe(2);
        } finally { await app.close(); }
    });

});
