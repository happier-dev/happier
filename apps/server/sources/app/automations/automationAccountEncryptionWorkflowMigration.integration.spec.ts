import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { buildAccountStoredContentCompatibilityHttpHeadersV1, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import {
    AutomationTriggerIdSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationStoredWorkflowDefinitionRecipeV2,
} from "@happier-dev/protocol";
import {
    materializeWorkflowAcceptedSnapshotV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
} from "@happier-dev/protocol/workflows";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { verifyAccountContentKeyBindingForAccountPublicKey } from "@/app/encryption/accountContentKeyAdmission";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerAccountEncryptionMigrateRoutes } from "@/app/api/routes/account/registerAccountEncryptionMigrateRoutes";
import {
    AutomationAccountEncryptionMigrationConflictError,
    applyAutomationAccountEncryptionTransitionStageInTx,
    inspectAutomationAccountEncryptionTransitionInTx,
    matchAutomationAccountEncryptionMigrationPostStateInTx,
    migrateAutomationAccountEncryptionInTx,
    readAutomationAccountEncryptionMigrationInventoryInTx,
} from "./automationCrudService";

describe("active Account migration of current Workflow content (real SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-workflow-account-transition-" });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const keyPair = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(keyPair.publicKey);
        const verifiedBinding = verifyAccountContentKeyBindingForAccountPublicKey({
            accountPublicKeyHex: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySignature: binding.contentPublicKeySig,
        });
        if (!verifiedBinding) throw new Error("Expected a verified target content binding");
        const account = await db.account.create({ data: { encryptionMode: "plain", ...binding } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const runId = randomUUID();
        const recordId = randomUUID();
        const runDataKey = tweetnacl.randomBytes(32);
        const mode = { mode: "e2ee" as const, runDataKey, randomBytes: tweetnacl.randomBytes };
        const acceptedBinding = { v: 1 as const, purpose: "accepted_snapshot" as const, accountId: account.id, runId };
        const materialized = await materializeWorkflowAcceptedSnapshotV1({
            definition: { version: 1, inputs: [], defaults: {
                agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.codex", localId: "codex" } },
            }, blocks: [
                { kind: "step" as const, id: "work", document: { text: "Work", references: [], attachments: [] }, input: [], result: { kind: "text" as const } },
            ] },
            context: {
                source: { kind: "inline" }, inputs: {}, machineId: machine.id,
                executionTarget: { kind: "session" },
                workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
                origin: { kind: "direct" }, authorization: { principal: { kind: "host" } },
            },
            admission: { kind: "user" },
            // Installed-target availability is the Machine boundary; materialization stays real.
            effects: { resolveTargetAvailability: async () => true },
        });
        if (!materialized.ok) throw new Error(`Workflow fixture admission failed: ${materialized.error.code}`);
        const acceptedSnapshot = materialized.snapshot;
        const sourceAccepted = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: "plain", binding: acceptedBinding, acceptedSnapshot,
        }));
        const targetAccepted = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            ...mode, binding: acceptedBinding, acceptedSnapshot,
        }));
        const invocationBinding = { v: 1 as const, purpose: "invocation_progress" as const,
            accountId: account.id, runId, recordId, sequence: "0", parentRecordId: null, memberOrdinal: "0", attempt: "0" };
        const progress = { kind: "happier.workflow-progress.v1" as const,
            invocationPath: { blockId: "$root", scope: [] }, blockKind: "root" as const,
            attempt: "0", logicalInvocationRecordId: recordId };
        const sourceProgress = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: "plain", binding: invocationBinding, progress,
        }));
        const targetProgress = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            ...mode, binding: invocationBinding, progress,
        }));
        await db.automationRun.create({ data: { id: runId, accountId: account.id,
            originKind: "direct", causeKind: null, state: "running", scheduledAt: new Date(), dueAt: new Date(),
            workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: sourceAccepted,
            executionInputEnvelope: sourceAccepted,
            workflowInvocations: { create: { id: recordId, sequence: 0n, memberOrdinal: 0n,
                attempt: 0n, lifecycle: "running", contentEnvelope: sourceProgress } },
        } });
        const recipientKeyEnvelope = {
            recipientAccountId: account.id,
            recipientContentPublicKeyFingerprint: verifiedBinding.contentPublicKeyFingerprint,
            encryptedDataKey: privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
                dataKey: runDataKey, recipientPublicKey: keyPair.publicKey, randomBytes: tweetnacl.randomBytes,
            }))),
        };
        const directive = { action: "migrate" as const, templates: [], runs: [{
            runId, expectedRunRevision: 0, triggerEvidenceEnvelope: null, occurrenceEvidenceEqualityTag: null,
            executionInputEnvelope: targetAccepted, resultEnvelope: null, replyContextEnvelope: null, failureDetailEnvelope: null,
            workflow: { sourceAcceptedSnapshotEnvelope: sourceAccepted, acceptedSnapshotEnvelope: targetAccepted,
                sourceCheckpointEnvelope: null, checkpointEnvelope: null, expectedDataEncryptionKey: null,
                recipientKeyEnvelopes: [recipientKeyEnvelope], invocations: [{ id: recordId,
                    expectedContentRevision: "0", sourceContentEnvelope: sourceProgress, contentEnvelope: targetProgress }] },
        }] };
        return { account, runId, recordId, directive, targetAccepted, targetProgress, recipientKeyEnvelope, verifiedBinding };
    }

    it.each([
        ["prComment", "migration"], ["ciFailed", "migration"],
        ["prComment", "staged"], ["ciFailed", "staged"],
    ] as const)("transitions a bound scoped %s definition through the %s writer", async (triggerKind, writer) => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}",
        } });
        const automationId = randomUUID();
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const binding = { v: 1 as const, automationId, triggerId, triggerRevision: 0, triggerKind };
        const definition = { kind: triggerKind, pullRequest: { repository: "happier-dev/happier", number: 42 } };
        const sourceDefinition = JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain", binding, definition,
        }));
        const targetDefinition = JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "e2ee", binding, definition,
            material: { type: "dataKey", machineKey: new Uint8Array(32).fill(9) },
            randomBytes: (length) => new Uint8Array(length).fill(6),
        }));
        const sourceRecipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({
            v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind: "session" } } },
        });
        const targetRecipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({
            v: 2, templateVersion: 2, triggerEvidence: null,
            // The server is ciphertext-blind for the Workflow definition; the
            // purpose/binding-bearing trigger envelope above uses the real codec.
            workflow: { t: "encrypted", c: "scoped-workflow-definition-target" },
        });
        if (sourceRecipe.kind !== "available" || targetRecipe.kind !== "available") {
            throw new Error("Expected canonical scoped Workflow recipes");
        }
        await db.automation.create({ data: {
            id: automationId, accountId: account.id, name: "Scoped PR transition", enabled: false,
            targetType: null, scopeSessionId: session.id, templateVersion: 1, templateCiphertext: sourceRecipe.serialized,
            triggers: { create: { id: triggerId, kind: triggerKind, sourceSessionId: session.id, definitionEnvelope: sourceDefinition } },
        } });
        const sourceDefinitions = [{ triggerId, triggerRevision: 0, envelope: sourceDefinition }];
        const targetDefinitions = [{ triggerId, triggerRevision: 0, envelope: targetDefinition }];
        const inventory = await inTx(tx => readAutomationAccountEncryptionMigrationInventoryInTx({ tx, accountId: account.id }));
        expect(inventory.templates).toEqual([{ automationId, expectedTemplateVersion: 1,
            templateCiphertext: sourceRecipe.serialized, triggerDefinitionEnvelopes: sourceDefinitions }]);
        const inspected = await inTx(tx => inspectAutomationAccountEncryptionTransitionInTx({ tx, accountId: account.id, sourceMode: "plain" }));
        if (inspected.status !== "complete") throw new Error("Expected a current Workflow source inventory");
        const observed = inspected.page.items.find(item => item.kind === "definition" && item.automationId === automationId);
        if (!observed || observed.kind !== "definition") throw new Error("Expected the scoped Workflow definition in the inventory");
        expect(observed.source).toEqual({ templateCiphertext: sourceRecipe.serialized, triggerDefinitionEnvelopes: sourceDefinitions });
        const stageItem = { kind: "definition" as const, automationId, expectedRevision: observed.revision,
            source: observed.source, target: { templateCiphertext: targetRecipe.serialized, triggerDefinitionEnvelopes: targetDefinitions } };
        if (writer === "staged" && triggerKind === "prComment") {
            const wrongBinding = JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: "plain", binding: { ...binding, triggerRevision: 1 }, definition,
            }));
            const wrongVersion = serializeAutomationStoredWorkflowDefinitionRecipeV2({ ...targetRecipe.recipe, templateVersion: 3 });
            const wrongMode = serializeAutomationStoredWorkflowDefinitionRecipeV2({ ...sourceRecipe.recipe, templateVersion: 2 });
            if (wrongVersion.kind !== "available" || wrongMode.kind !== "available") throw new Error("Expected valid neighboring recipe candidates");
            for (const target of [
                { ...stageItem.target, templateCiphertext: wrongVersion.serialized },
                { ...stageItem.target, templateCiphertext: wrongMode.serialized },
                { ...stageItem.target, templateCiphertext: JSON.stringify({ ...targetRecipe.recipe, v: 1 }) },
            ]) {
                expect(await inTx(tx => applyAutomationAccountEncryptionTransitionStageInTx({
                    tx, accountId: account.id, fromMode: "plain", toMode: "e2ee", items: [{ ...stageItem, target }],
                }))).toEqual({ status: "invalid_content" });
            }
            expect(await inTx(tx => applyAutomationAccountEncryptionTransitionStageInTx({
                tx, accountId: account.id, fromMode: "plain", toMode: "e2ee", items: [{ ...stageItem,
                    source: { ...stageItem.source, templateCiphertext: "stale source" } }],
            }))).toEqual({ status: "migration_incomplete" });
            // A server can check the visible plain source binding, never a
            // private binding inside target ciphertext owned by the key-holder.
            await db.automationTrigger.update({ where: { id: triggerId }, data: { definitionEnvelope: wrongBinding } });
            expect(await inTx(tx => applyAutomationAccountEncryptionTransitionStageInTx({
                tx, accountId: account.id, fromMode: "plain", toMode: "e2ee", items: [{ ...stageItem,
                    source: { ...stageItem.source, triggerDefinitionEnvelopes: [{ ...sourceDefinitions[0]!, envelope: wrongBinding }] } }],
            }))).toEqual({ status: "invalid_content" });
            await db.automationTrigger.update({ where: { id: triggerId }, data: { definitionEnvelope: sourceDefinition } });
            expect((await db.automation.findUniqueOrThrow({ where: { id: automationId } })).templateVersion).toBe(1);
            expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: triggerId } })).definitionEnvelope).toBe(sourceDefinition);
        }
        const result = await inTx(tx => writer === "migration"
            ? migrateAutomationAccountEncryptionInTx({ tx, accountId: account.id, toMode: "e2ee", directive: {
                action: "migrate", runs: [], templates: [{ automationId, expectedTemplateVersion: 1,
                    templateCiphertext: targetRecipe.serialized, triggerDefinitionEnvelopes: targetDefinitions }],
            } })
            : applyAutomationAccountEncryptionTransitionStageInTx({ tx, accountId: account.id, fromMode: "plain", toMode: "e2ee", items: [stageItem] }));
        expect(result).toEqual({ status: "applied" });
        expect(await db.automation.findUniqueOrThrow({ where: { id: automationId }, select: {
            templateVersion: true, templateCiphertext: true, triggers: { select: { kind: true, definitionEnvelope: true } },
        } })).toEqual({ templateVersion: 2, templateCiphertext: targetRecipe.serialized,
            triggers: [{ kind: triggerKind, definitionEnvelope: targetDefinition }] });
        if (writer === "migration") {
            await db.account.update({ where: { id: account.id }, data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
            expect(await inTx(tx => matchAutomationAccountEncryptionMigrationPostStateInTx({
                tx, accountId: account.id, toMode: "e2ee", directive: { action: "migrate", runs: [], templates: [{
                    automationId, expectedTemplateVersion: 1, templateCiphertext: targetRecipe.serialized,
                    triggerDefinitionEnvelopes: targetDefinitions,
                }] },
            }))).toEqual({ status: "matched" });
            expect((await db.automation.findUniqueOrThrow({ where: { id: automationId } })).templateVersion).toBe(2);
        }
    });

    it("transitions current run content and recipient keys atomically and advances the invocation token", async () => {
        const f = await fixture();
        const result = await inTx(tx => migrateAutomationAccountEncryptionInTx({
            tx, accountId: f.account.id, toMode: "e2ee", directive: f.directive,
            ownerContentPublicKeyFingerprint: f.verifiedBinding.contentPublicKeyFingerprint,
        }));
        expect(result).toEqual({ status: "applied" });
        const run = await db.automationRun.findUniqueOrThrow({ where: { id: f.runId } });
        expect(run).toMatchObject({ revision: 1, executionInputEnvelope: f.targetAccepted,
            workflowAcceptedSnapshotEnvelope: f.targetAccepted });
        const invocation = await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: f.recordId } });
        expect(invocation).toMatchObject({ contentRevision: 1n, contentEnvelope: f.targetProgress });
        const ownerEnvelope = await db.workflowRunDataKeyEnvelope.findUniqueOrThrow({
            where: { runId_recipientAccountId: { runId: f.runId, recipientAccountId: f.account.id } },
        });
        expect(privacyKit.encodeBase64(ownerEnvelope.encryptedDataKey)).toBe(f.recipientKeyEnvelope.encryptedDataKey);
        expect(ownerEnvelope.recipientContentPublicKeyFingerprint).toBe(f.recipientKeyEnvelope.recipientContentPublicKeyFingerprint);
        // The Account route commits the target mode after applying its participants.
        await db.account.update({ where: { id: f.account.id }, data: { encryptionMode: "e2ee" } });
        const replay = () => inTx(tx => matchAutomationAccountEncryptionMigrationPostStateInTx({
            tx, accountId: f.account.id, toMode: "e2ee", directive: f.directive,
        }));
        expect(await replay()).toEqual({ status: "matched" });
        const alteredKey = new Uint8Array(ownerEnvelope.encryptedDataKey);
        alteredKey[alteredKey.length - 1] = (alteredKey[alteredKey.length - 1] ?? 0) ^ 1;
        await db.workflowRunDataKeyEnvelope.update({
            where: { runId_recipientAccountId: { runId: f.runId, recipientAccountId: f.account.id } },
            data: { encryptedDataKey: alteredKey },
        });
        expect(await replay()).toEqual({ status: "mismatch" });
    });

    it("refuses stale invocation source bytes without committing any run or key replacement", async () => {
        const f = await fixture();
        f.directive.runs[0]!.workflow.invocations[0]!.sourceContentEnvelope = "stale source";
        await expect(inTx(tx => migrateAutomationAccountEncryptionInTx({
            tx, accountId: f.account.id, toMode: "e2ee", directive: f.directive,
            ownerContentPublicKeyFingerprint: f.verifiedBinding.contentPublicKeyFingerprint,
        }))).rejects.toBeInstanceOf(AutomationAccountEncryptionMigrationConflictError);
        expect((await db.automationRun.findUniqueOrThrow({ where: { id: f.runId } })).revision).toBe(0);
        expect(await db.workflowRunDataKeyEnvelope.count({ where: { runId: f.runId } })).toBe(0);
    });

    it("an invocation-only token change conflicts even when source ciphertext and parent revision are unchanged", async () => {
        const f = await fixture();
        await db.workflowRunInvocation.update({ where: { id: f.recordId }, data: { contentRevision: { increment: 1 } } });
        await expect(inTx(tx => migrateAutomationAccountEncryptionInTx({
            tx, accountId: f.account.id, toMode: "e2ee", directive: f.directive,
            ownerContentPublicKeyFingerprint: f.verifiedBinding.contentPublicKeyFingerprint,
        }))).rejects.toBeInstanceOf(AutomationAccountEncryptionMigrationConflictError);
        expect((await db.automationRun.findUniqueOrThrow({ where: { id: f.runId } })).revision).toBe(0);
        expect((await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: f.recordId } })).contentRevision).toBe(1n);
        expect(await db.workflowRunDataKeyEnvelope.count({ where: { runId: f.runId } })).toBe(0);
    });

    it("moves a current E2EE run to plain without retaining client data keys", async () => {
        const f = await fixture();
        const item = f.directive.runs[0]!;
        const workflow = item.workflow;
        const plainAccepted = workflow.sourceAcceptedSnapshotEnvelope;
        const plainProgress = workflow.invocations[0]!.sourceContentEnvelope;
        await db.account.update({ where: { id: f.account.id }, data: { encryptionMode: "e2ee" } });
        await db.automationRun.update({ where: { id: f.runId }, data: {
            workflowAcceptedSnapshotEnvelope: f.targetAccepted, executionInputEnvelope: f.targetAccepted,
        } });
        await db.workflowRunInvocation.update({ where: { id: f.recordId }, data: { contentEnvelope: f.targetProgress } });
        await db.workflowRunDataKeyEnvelope.create({ data: { runId: f.runId, recipientAccountId: f.account.id,
            recipientContentPublicKeyFingerprint: f.recipientKeyEnvelope.recipientContentPublicKeyFingerprint,
            encryptedDataKey: privacyKit.decodeBase64(f.recipientKeyEnvelope.encryptedDataKey),
        } });
        item.executionInputEnvelope = plainAccepted;
        workflow.sourceAcceptedSnapshotEnvelope = f.targetAccepted;
        workflow.acceptedSnapshotEnvelope = plainAccepted;
        // The fixture starts plain. This observation is the current encrypted owner token.
        const directive = { ...f.directive, runs: [{ ...item, workflow: { ...workflow,
            expectedDataEncryptionKey: f.recipientKeyEnvelope.encryptedDataKey, recipientKeyEnvelopes: [],
            invocations: [{ ...workflow.invocations[0]!, sourceContentEnvelope: f.targetProgress, contentEnvelope: plainProgress }],
        } }] };
        expect(await inTx(tx => migrateAutomationAccountEncryptionInTx({
            tx, accountId: f.account.id, toMode: "plain", directive,
        }))).toEqual({ status: "applied" });
        expect((await db.automationRun.findUniqueOrThrow({ where: { id: f.runId } })).workflowAcceptedSnapshotEnvelope).toBe(plainAccepted);
        expect((await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: f.recordId } })).contentRevision).toBe(1n);
        expect(await db.workflowRunDataKeyEnvelope.count({ where: { runId: f.runId } })).toBe(0);
    });

    it("does not re-seal recognized pre-cut Workflow history during an Account transition", async () => {
        const f = await fixture();
        const outer = JSON.parse(f.directive.runs[0]!.workflow.sourceAcceptedSnapshotEnvelope);
        const legacyAccepted = JSON.stringify({ ...outer, v: { ...outer.v, v: 1 } });
        await db.automationRun.update({ where: { id: f.runId }, data: {
            workflowAcceptedSnapshotEnvelope: legacyAccepted, executionInputEnvelope: legacyAccepted,
        } });
        expect(await inTx(tx => migrateAutomationAccountEncryptionInTx({
            tx, accountId: f.account.id, toMode: "e2ee", directive: { action: "assert_empty" },
        }))).toEqual({ status: "applied" });
        expect((await db.automationRun.findUniqueOrThrow({ where: { id: f.runId } })).workflowAcceptedSnapshotEnvelope).toBe(legacyAccepted);
        expect((await db.workflowRunInvocation.findUniqueOrThrow({ where: { id: f.recordId } })).contentRevision).toBe(0n);
    });

    it("does not let a clear directive flip mode around retained current direct Run content", async () => {
        const f = await fixture();
        expect(await inTx(tx => migrateAutomationAccountEncryptionInTx({
            tx, accountId: f.account.id, toMode: "e2ee", directive: { action: "clear" },
        }))).toEqual({ status: "not_empty" });
        expect((await db.automationRun.findUniqueOrThrow({ where: { id: f.runId } })).revision).toBe(0);
    });

    it("the active inventory pairs all retained invocation tokens and blobs and includes deleted templates", async () => {
        const f = await fixture();
        const automationId = randomUUID();
        const templateCiphertext = JSON.stringify({ kind: "happier_automation_template_plain_v1", payload: { prompt: "Retained template" } });
        await db.automation.create({ data: { id: automationId, accountId: f.account.id,
            name: "Deleted automation", targetType: "new_session", templateCiphertext,
            deletedAt: new Date(), enabled: false } });
        await withAuthenticatedTestApp(app => registerAccountEncryptionMigrateRoutes(app), async app => {
            const response = await app.inject({ method: "GET", url: "/v1/account/encryption/migrate/automations/inventory",
                headers: { "x-test-user-id": f.account.id, ...buildAccountStoredContentCompatibilityHttpHeadersV1({ v: 1, protocolVersion: 4 }) } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                templates: [{ automationId, expectedTemplateVersion: 0, templateCiphertext, triggerDefinitionEnvelopes: [] }],
                runs: [{ runId: f.runId, expectedRunRevision: 0, workflow: {
                    acceptedSnapshotEnvelope: f.directive.runs[0]!.workflow.sourceAcceptedSnapshotEnvelope,
                    checkpointEnvelope: null,
                    invocations: [{ index: { id: f.recordId, contentRevision: "0" },
                        contentEnvelope: f.directive.runs[0]!.workflow.invocations[0]!.sourceContentEnvelope }],
                    keyCensus: { ownerAccountId: f.account.id, dataEncryptionKey: null },
                } }],
            });
            const other = await db.account.create({ data: { encryptionMode: "plain" } });
            const unrelated = await app.inject({ method: "GET", url: "/v1/account/encryption/migrate/automations/inventory",
                headers: { "x-test-user-id": other.id, ...buildAccountStoredContentCompatibilityHttpHeadersV1({ v: 1, protocolVersion: 4 }) } });
            expect(unrelated.statusCode).toBe(200);
            expect(unrelated.json()).toEqual({ templates: [], runs: [] });
        });
    });
});
