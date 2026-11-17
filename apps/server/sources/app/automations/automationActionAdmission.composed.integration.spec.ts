import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { automationRoutes } from "@/app/api/routes/automations/automationRoutes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createDatabaseIntegrationHarness } from "@/testkit/databaseIntegrationHarness";
import { createAutomationWorkflowRecipeFixture } from "@/testkit/automationWorkflowRecipe";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { automationSubjectKeyV1 } from "@happier-dev/protocol/automations/automationSubjectV1";
import { DatabaseManualTargetV1Schema, DatabaseWorktreeTargetV1Schema } from "@happier-dev/protocol/databases/databaseTargetIdentityV1";
import { AutomationTriggerIdSchema, sealAutomationTriggerDefinitionStoredEnvelopeV1,
    createAccountScopedCryptoMaterialSnapshotV1 } from "@happier-dev/protocol";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { PluginManifestV2Schema } from "@happier-dev/protocol/plugins/manifest/v2";
import { createReleaseLessDeclarationV1 } from "@/app/plugins/availability/currentDeclaration";
import { formatQualifiedPluginActionId } from "@happier-dev/protocol/plugins/actions/qualifiedActionId";

describe("Action occurrence admission through the real router", () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: "action-occurrence-admission-",
            initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: "1", HAPPIER_FEATURE_WORKFLOWS__ENABLED: "1" } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("validates declared plugin subject identities at public Action trigger writes", async () => {
        const accountId = randomUUID();
        const automationId = randomUUID();
        const triggerId = randomUUID();
        const serverId = await getOrCreateServerIdentityId();
        const pluginId = "fixture.action-subject-ingress";
        const actionId = formatQualifiedPluginActionId({ pluginId, localId: "close-ticket" });
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: "1.0.0",
            displayName: "Ticket subject ingress", engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 },
            contributes: { subjectKinds: [{ id: "ticket", label: "Ticket", listAction: "list-tickets",
                identitySchema: { type: "object", properties: { ticketId: { type: "string" } },
                    required: ["ticketId"], additionalProperties: false } }], actions: [
                { id: "list-tickets", title: "List tickets", surfaces: ["plugin"], scopes: ["global"],
                    dangerLevel: "safe", readOnly: true, execution: { target: "daemon" } },
                { id: "close-ticket", title: "Close ticket", surfaces: ["plugin"], scopes: ["global"],
                    dangerLevel: "writesRemote", execution: { target: "daemon" },
                    approvalScope: { kind: "plugin", subjectKindId: "ticket", identityField: "ticket" } },
            ] } });
        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        await db.accountPluginIntent.create({ data: { accountId, pluginId, enabled: true,
            desiredVersion: null, writableCollections: [], releaseLessDeclaration: createReleaseLessDeclarationV1(manifest) } });
        await db.automation.create({ data: { id: automationId, accountId, name: "Ticket checks", enabled: false,
            templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                directory: "/tmp/ticket-check", prompt: "Check ticket" })), templateVersion: 1 } });
        const definition = (identity: unknown, subjectKindId = "ticket") => ({
            kind: "action", phase: "after", actionIds: [actionId],
            subject: { kind: "plugin", serverId, pluginId, subjectKindId, identity },
        });
        const app = createAuthenticatedTestApp();
        automationRoutes(app);
        try {
            const created = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": accountId }, payload: { triggerId,
                    trigger: { ...definition({ ticketId: "ticket-1" }), enabled: true } } });
            expect(created.statusCode, created.body).toBe(200);
            for (const [identity, subjectKindId, error] of [
                [{ ticketId: 17 }, "ticket", "invalid_subject_identity"],
                [{ ticketId: "ticket-1" }, "missing-kind", "subject_kind_unavailable"],
            ] as const) {
                const rejected = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                    headers: { "x-test-user-id": accountId }, payload: { triggerId: randomUUID(),
                        trigger: { ...definition(identity, subjectKindId), enabled: true } } });
                expect(rejected.statusCode, rejected.body).toBe(400);
                expect(rejected.json()).toEqual({ error });
            }
            const unrelatedAction = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": accountId }, payload: { triggerId: randomUUID(),
                    trigger: { ...definition({ ticketId: "ticket-1" }), enabled: true,
                        actionIds: [formatQualifiedPluginActionId({ pluginId, localId: "list-tickets" })] } } });
            expect(unrelatedAction.statusCode, unrelatedAction.body).toBe(400);
            expect(unrelatedAction.json()).toEqual({ error: "subject_kind_unavailable" });
            const patched = await app.inject({ method: "PATCH", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": accountId }, payload: { triggerId, expectedRevision: 0,
                    trigger: definition({ ticketId: 17 }) } });
            expect(patched.statusCode, patched.body).toBe(400);
            expect(patched.json()).toEqual({ error: "invalid_subject_identity" });
            const reconciled = await app.inject({ method: "PUT", url: `/v3/automations/${automationId}`,
                headers: { "x-test-user-id": accountId }, payload: { expectedTemplateVersion: created.json().templateVersion,
                    name: "Ticket checks", description: null, enabled: false, assignments: [], removedTriggers: [],
                    triggers: [{ kind: "existing", triggerId, expectedRevision: 0,
                        trigger: definition({ ticketId: 17 }) }] } });
            expect(reconciled.statusCode, reconciled.body).toBe(400);
            expect(reconciled.json()).toEqual({ error: "invalid_subject_identity" });
            const rejectedDefinition = await app.inject({ method: "POST", url: "/v3/automations",
                headers: { "x-test-user-id": accountId }, payload: { automationId: randomUUID(), name: "Invalid ticket",
                    enabled: false, executionRecipe: createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                        directory: "/tmp/ticket-check", prompt: "Check ticket" }),
                    triggers: [{ triggerId: randomUUID(), trigger: { ...definition({ ticketId: 17 }), enabled: true } }] } });
            expect(rejectedDefinition.statusCode, rejectedDefinition.body).toBe(400);
            expect(rejectedDefinition.json()).toEqual({ error: "invalid_subject_identity" });
            expect(await db.automationTrigger.count({ where: { automationId } })).toBe(1);
        } finally { await app.close(); }
    });

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

    it("keeps private Database bindings own-only at public trigger writes", async () => {
        const accountId = randomUUID();
        const automationId = randomUUID();
        const serverId = await getOrCreateServerIdentityId();
        const context = { accountId, workspace: { serverId, machineId: randomUUID(),
            workspaceId: randomUUID(), rootPath: "/private/database-worktree" },
            installationId: randomUUID(), projectKey: "database-project" };
        const targets = [
            DatabaseWorktreeTargetV1Schema.parse({ kind: "worktree", ...context,
                source: { kind: "env_file", path: ".env.local", variable: "DATABASE_URL" } }),
            DatabaseManualTargetV1Schema.parse({ kind: "manual", ...context, savedSecretId: randomUUID() }),
        ];
        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        await db.automation.create({ data: { id: automationId, accountId, name: "Private database checks", enabled: false,
            templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                directory: "/tmp/database-check", prompt: "Check database" })), templateVersion: 1 } });
        const app = createAuthenticatedTestApp();
        automationRoutes(app);
        try {
            for (const target of targets) {
                const triggerId = randomUUID();
                const authored = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                    headers: { "x-test-user-id": accountId }, payload: { triggerId, trigger: {
                        kind: "action", phase: "after", actionIds: ["scm.commit.create"], enabled: true,
                        subject: { kind: "database", serverId, target },
                    } } });
                expect(authored.statusCode, authored.body).toBe(200);
                expect(authored.json().triggers[0]).toMatchObject({ reachesOthers: false });
                expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: triggerId } }))
                    .toMatchObject({ reachesOthers: false });
            }
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

    it("matches an owned Action subject using the canonical structural key", async () => {
        const accountId = randomUUID();
        const machineId = randomUUID();
        const automationId = randomUUID();
        const triggerId = randomUUID();
        const serverId = await getOrCreateServerIdentityId();
        const subject = { kind: "machine" as const, serverId, machineId };
        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        await db.machine.create({ data: { id: machineId, accountId, metadata: "{}", installationId: randomUUID() } });
        await db.automation.create({ data: { id: automationId, accountId, name: "Scoped commit review", enabled: true,
            templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                directory: "/tmp/review", prompt: "Review" })), templateVersion: 1,
            assignments: { create: { machineId, enabled: true, priority: 0 } } } });
        const app = createAuthenticatedTestApp();
        automationRoutes(app);
        try {
            const authored = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": accountId }, payload: { triggerId,
                    trigger: { kind: "action", enabled: true, phase: "after", actionIds: ["scm.commit.create"], subject } } });
            expect(authored.statusCode, authored.body).toBe(200);
            const input = { evidence: { v: 1, kind: "action", actionId: "scm.commit.create", requestId: randomUUID(),
                phase: "after", occurredAt: 42, status: "succeeded", subjects: [{ role: "operand", kind: "machine",
                    key: automationSubjectKeyV1({ ...subject, machineId: randomUUID() }) }] },
                triggers: [{ automationId, triggerId, triggerRevision: 0 }] };
            const mismatched = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: input });
            expect(mismatched.statusCode, mismatched.body).toBe(200);
            expect(mismatched.json().results[0]).toMatchObject({ kind: "skipped", reason: "subjectMismatch" });
            expect(await db.automationRun.count({ where: { automationId } })).toBe(0);
            const matched = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: { ...input,
                    evidence: { ...input.evidence, subjects: [{ role: "operand", kind: "machine", key: automationSubjectKeyV1(subject) }] } } });
            expect(matched.statusCode, matched.body).toBe(200);
            expect(matched.json().results[0]).toMatchObject({ kind: "admitted" });
            expect(await db.automationRun.count({ where: { automationId } })).toBe(1);
        } finally { await app.close(); }
    });

    it("places a reference-only consent Run on the invoking Machine without definition assignments", async () => {
        const accountId = randomUUID();
        const machineId = randomUUID();
        const automationId = randomUUID();
        const triggerId = randomUUID();
        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        await db.machine.create({ data: { id: machineId, accountId, metadata: "{}", installationId: randomUUID() } });
        // B2 owns consent/step admission. This fixture starts with its actor-owned definition.
        await db.automation.create({ data: { id: automationId, accountId, name: "Consented review", enabled: true,
            templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                directory: "/tmp/review", prompt: "Review" })), templateVersion: 1 } });
        const app = createAuthenticatedTestApp();
        automationRoutes(app);
        try {
            const authored = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": accountId }, payload: { triggerId, trigger: { kind: "action", enabled: true,
                    consentFor: { automationId: randomUUID(), triggerId: randomUUID() }, consentedWorkflowRevision: 1 } } });
            expect(authored.statusCode, authored.body).toBe(200);
            const input = { evidence: { v: 1, kind: "action", actionId: "scm.commit.create", requestId: randomUUID(),
                phase: "after", occurredAt: 42, status: "succeeded", subjects: [] },
                triggers: [{ automationId, triggerId, triggerRevision: 0 }] };
            const noMachine = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: input });
            expect(noMachine.statusCode, noMachine.body).toBe(200);
            expect(noMachine.json().results[0]).toMatchObject({ kind: "skipped", reason: "machineRequired" });
            expect(await db.automationRun.count({ where: { automationId } })).toBe(0);
            const admitted = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: { ...input, evidence: { ...input.evidence, machineId } } });
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json().results[0]).toMatchObject({ kind: "admitted" });
            expect(await db.automationAssignment.count({ where: { automationId } })).toBe(0);
            expect(await db.automationRunAssignment.findMany({ where: { runId: admitted.json().results[0].runId },
                select: { machineId: true } })).toEqual([{ machineId }]);
        } finally { await app.close(); }
    });

    it("admits each Action occurrence once and preserves the actor's own assignment", async () => {
        const accountId = randomUUID();
        const machineId = randomUUID();
        const invokingMachineId = randomUUID();
        const automationId = randomUUID();
        const triggerId = randomUUID();
        await db.account.create({ data: { id: accountId, encryptionMode: "plain" } });
        await db.machine.create({ data: { id: machineId, accountId, metadata: "{}", installationId: randomUUID() } });
        await db.machine.create({ data: { id: invokingMachineId, accountId, metadata: "{}", installationId: randomUUID() } });
        await db.automation.create({ data: { id: automationId, accountId, name: "Review commit", enabled: true,
            templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                directory: "/tmp/review", prompt: "Review the commit" })), templateVersion: 1,
            assignments: { create: { machineId, enabled: true, priority: 0 } },
        } });
        const app = createAuthenticatedTestApp();
        automationRoutes(app);
        try {
            const authored = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": accountId }, payload: { triggerId,
                    trigger: { kind: "action", enabled: true, phase: "after", actionIds: ["scm.commit.create"] } } });
            expect(authored.statusCode, authored.body).toBe(200);
            const input = { evidence: { v: 1, kind: "action", actionId: "scm.commit.create", requestId: randomUUID(),
                phase: "after", occurredAt: 42, status: "succeeded", machineId: invokingMachineId, subjects: [] },
                triggers: [{ automationId, triggerId, triggerRevision: 0 }] };
            const response = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: input });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().results[0]?.kind).toBe("admitted");
            const runId = response.json().results[0].runId as string;
            const detail = await app.inject({ method: "GET", url: `/v3/automations/${automationId}/runs/${runId}`,
                headers: { "x-test-user-id": accountId } });
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json().cause).toMatchObject({ kind: "trigger", triggerKind: "action", triggerId,
                occurredAt: input.evidence.occurredAt, evidence: { actionId: input.evidence.actionId,
                    requestId: input.evidence.requestId, phase: "after", status: "succeeded", machineId: invokingMachineId } });
            const replay = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: input });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json().results[0]).toMatchObject({ kind: "rejoined", runId });
            const reconstructedReplay = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: { ...input,
                    evidence: { ...input.evidence, occurredAt: input.evidence.occurredAt + 1 } } });
            expect.soft(reconstructedReplay.statusCode, reconstructedReplay.body).toBe(200);
            expect.soft(reconstructedReplay.json().results?.[0]).toMatchObject({ kind: "rejoined", runId });
            expect(await db.automationRun.count({ where: { automationId } })).toBe(1);
            const target = await db.automationRunAssignment.findMany({ where: { runId }, select: { machineId: true } });
            expect.soft(target).toEqual([{ machineId }]);
            const foreign = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": randomUUID() }, payload: input });
            expect(foreign.statusCode, foreign.body).toBe(200);
            expect(foreign.json().results[0]).toMatchObject({ kind: "skipped", reason: "triggerNotFound" });
            const otherTriggerId = randomUUID();
            const otherAuthored = await app.inject({ method: "POST", url: `/v3/automations/${automationId}/triggers`,
                headers: { "x-test-user-id": accountId }, payload: { triggerId: otherTriggerId,
                    trigger: { kind: "action", enabled: true, phase: "after", actionIds: ["scm.commit.create"] } } });
            expect(otherAuthored.statusCode, otherAuthored.body).toBe(200);
            const recursive = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: { ...input,
                    evidence: { ...input.evidence, requestId: randomUUID(), originRunId: runId },
                    triggers: [...input.triggers, { automationId, triggerId: otherTriggerId, triggerRevision: 0 }] } });
            expect(recursive.statusCode, recursive.body).toBe(200);
            expect(recursive.json().results[0]).toMatchObject({ kind: "skipped", reason: "causeSuppressed" });
            expect(recursive.json().results[1]).toMatchObject({ kind: "admitted" });
            expect(await db.automationRun.count({ where: { automationId } })).toBe(2);
            await db.automation.update({ where: { id: automationId }, data: { scopeSessionId: randomUUID() } });
            const nextInvocation = await app.inject({ method: "POST", url: "/v1/automations/actions/admit",
                headers: { "x-test-user-id": accountId }, payload: { ...input,
                    evidence: { ...input.evidence, requestId: randomUUID() } } });
            expect(nextInvocation.statusCode, nextInvocation.body).toBe(200);
            expect(nextInvocation.json().results[0]).toMatchObject({ kind: "admitted" });
            const retainedRuns = await db.automationRun.findMany({ where: { automationId, triggerId },
                select: { state: true } });
            expect(retainedRuns).toHaveLength(2);
            expect(retainedRuns.every(run => run.state === "queued")).toBe(true);
        } finally { await app.close(); }
    });
});
