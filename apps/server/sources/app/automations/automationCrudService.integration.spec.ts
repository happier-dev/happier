import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
    AutomationRunExecutionInputV1Schema,
    AutomationDefinitionDetailSchema,
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationStoredWorkflowDefinitionRecipeV2Schema,
    AutomationOccurrenceKeyV1Schema,
    AutomationTriggerIdSchema,
    WorkflowTriggerRemoveRequestV1Schema,
    createWorkflowTriggerActions,
    AutomationTriggerDefinitionInputSchema,
    AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
    AutomationPullRequestTriggerSchema,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    type WorkflowTriggerSetV1,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";


import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerAutomationV3Routes } from "@/app/api/routes/automations/registerAutomationV3Routes";
import { registerAccountEncryptionMigrateRoutes } from "@/app/api/routes/account/registerAccountEncryptionMigrateRoutes";

import {
    AutomationDisabledError,
    AutomationDefinitionCreateConflictError,
    AutomationTriggerCreateConflictError,
    createAutomation,
    createAutomationTrigger,
    deleteAutomation,
    deleteAutomationTrigger,
    getAutomation,
    listAutomationDefinitionsPage,
    listAutomations,
    migrateAutomationAccountEncryptionInTx,
    reconcileAutomationDefinition,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
    updateAutomationTrigger,
} from "./automationCrudService";
import { AutomationValidationError, parseAutomationUpsertInput } from "./automationValidation";
import { runAutomationScheduleWorkerPass } from "./automationScheduleWorker";
import { admitAutomationRunTx } from "./automationRunAdmissionService";
import { cancelAutomationRun } from "./automationRunService";
// Read the provenance-pinned output artifact without importing Protocol's TS
// test source into the server compiler's rootDir.
const v02FixtureSource = readFileSync(new URL(
    "../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures.ts", import.meta.url,
), "utf8");
function readV02Fixture(name: string): string {
    const match = v02FixtureSource.match(new RegExp(`^export const ${name} = '(.*)';$`, "m"));
    if (!match?.[1]) throw new Error(`Missing pinned predecessor vector ${name}`);
    return match[1];
}
const AUTOMATION_TEMPLATE_V02_ENCRYPTED = readV02Fixture("AUTOMATION_TEMPLATE_V02_ENCRYPTED");
const AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED = readV02Fixture("AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED");
const AUTOMATION_TEMPLATE_V02_PLAIN = readV02Fixture("AUTOMATION_TEMPLATE_V02_PLAIN");

function currentRecipe(templateVersion: number) {
    return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: `Recipe ${templateVersion}` } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: { kind: "path", path: "/tmp/automation-crud" },
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
}

function workflowRecipe(templateVersion: number, machineId: string) {
    return AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
        v: 2,
        templateVersion,
        workflow: {
            t: "plain",
            v: {
                inlineDefinition: {
                    version: 1,
                    inputs: [],
                    defaults: {
                        agentTarget: {
                            kind: "agent",
                            identity: { pluginId: "happier.agent.codex", localId: "codex" },
                        },
                    },
                    blocks: [{
                        kind: "step",
                        id: "step",
                        document: { text: "Work", references: [], attachments: [] },
                        input: [],
                        result: { kind: "text" },
                    }],
                },
                workspace: { directory: "/tmp/automation-workflow" },
                executionTarget: { kind: "session" },
            },
        },
        triggerEvidence: null,
    });
}

function intervalTrigger(everyMs: number, enabled = true) {
    return {
        kind: "schedule" as const,
        enabled,
        schedule: {
            kind: "interval" as const,
            scheduleExpr: null,
            everyMs,
            timezone: null,
        },
    };
}

function triggerInput(trigger: ReturnType<typeof intervalTrigger>) {
    return { triggerId: AutomationTriggerIdSchema.parse(randomUUID()), trigger };
}

function legacyTemplateEnvelope(payloadCiphertext = "ciphertext-base64"): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext,
    });
}

/** Creates one revocable account machine for enabled-Automation assignment fixtures. */
async function seedExecutionMachine(accountId: string): Promise<string> {
    const machineId = `execution-machine-${randomUUID()}`;
    await db.machine.create({
        data: { id: machineId, accountId, metadata: "{}" },
    });
    return machineId;
}

async function seedPluginEventTriggerWithStatus(automationId: string, suffix: string) {
    const trigger = await db.automationTrigger.create({
        data: {
            id: `event-trigger-${suffix}-${randomUUID()}`,
            automationId,
            kind: "pluginEvent",
            enabled: true,
            eventPluginId: "happier.github",
            eventLocalId: "repository-pushed",
            sourceSelectorId: `selector-${suffix}-${randomUUID()}`,
            sourceContractVersion: 1,
            observationTransport: "checkpointedPull",
            watcherMachineId: `watcher-machine-${suffix}`,
            watcherMachineInstallationId: `watcher-installation-${suffix}`,
            watcherPluginId: "happier.github",
            watcherMaterializationId: `watcher-materialization-${suffix}`,
            definitionEnvelope: JSON.stringify({ v: 1, suffix }),
        },
        select: {
            id: true,
            revision: true,
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
        },
    });
    await db.automationEventSourceStatus.create({
        data: {
            triggerId: trigger.id,
            eventPluginId: trigger.eventPluginId!,
            eventLocalId: trigger.eventLocalId!,
            sourceSelectorId: trigger.sourceSelectorId!,
            triggerRevision: trigger.revision,
            reporterMachineId: `reporter-machine-${suffix}`,
            reporterMachineInstallationId: `reporter-installation-${suffix}`,
            reporterMaterializationId: `reporter-materialization-${suffix}`,
            reporterSourceCustody: { kind: "development", registeredRootId: `reporter-generation-${suffix}` },
            state: "observing",
        },
    });
    return trigger;
}

describe("automationCrudService (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-crud-",
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRunAssignment.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationEventSourceStatus.deleteMany(),
            () => db.automationEventSourceCatalogStatus.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.accessKey.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("admits retained predecessor ciphertext only for the Account's E2EE Session", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            id: "session-old", accountId: account.id, tag: randomUUID(),
            metadata: "opaque-retained-e2ee-metadata", encryptionMode: "e2ee",
        } });
        const input = parseAutomationUpsertInput({
            name: "Retained Session", enabled: false, schedule: { kind: "manual" },
            targetType: "existing_session", templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
        }, { accountMode: "plain", allowLegacyEncryptedExistingSessionTemplate: true });
        const retained = await createAutomation({ accountId: account.id, input });
        expect(retained).toMatchObject({ templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, templateVersion: 1 });
        await expect(reconcileAutomationDefinition({ accountId: account.id, automationId: retained.id, input: {
            expectedTemplateVersion: 1, name: "Retained Session", description: null,
            enabled: false, assignments: [], triggers: [], removedTriggers: [],
        } })).resolves.toMatchObject({ templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, templateVersion: 2 });
        await expect(updateAutomation({ accountId: account.id, automationId: retained.id,
            input: { targetType: "new_session" } })).rejects.toBeInstanceOf(AutomationValidationError);
        await withAuthenticatedTestApp(registerAutomationV3Routes, async (app) => {
            const response = await app.inject({ method: "PATCH", url: `/v3/automations/${retained.id}`,
                headers: { "x-test-user-id": account.id }, payload: {
                    expectedTemplateVersion: 2,
                    templateCiphertext: JSON.stringify({ kind: "happier_automation_template_plain_v1",
                        payload: { ...JSON.parse(AUTOMATION_TEMPLATE_V02_PLAIN).payload, existingSessionId: session.id } }),
                } });
            expect(response.statusCode).toBe(400);
        });
        await expect(createAutomation({ accountId: account.id, input: {
            ...input, templateCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED,
            legacyTemplateEnvelopeAdmission: undefined,
        } })).rejects.toBeInstanceOf(AutomationValidationError);
        const other = await db.account.create({ data: { encryptionMode: "plain" } });
        await expect(createAutomation({ accountId: other.id, input })).rejects.toBeInstanceOf(AutomationValidationError);
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        await expect(createAutomation({ accountId: account.id, input })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(updateAutomation({ accountId: account.id, automationId: retained.id,
            input: { name: "Cannot rename after target mode changed" } })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(getAutomation({ accountId: account.id, automationId: retained.id }))
            .resolves.toMatchObject({ name: "Retained Session", templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, templateVersion: 2 });
        await db.session.update({ where: { id: session.id }, data: {
            metadata: JSON.stringify({ flavor: "pi", piSessionId: "plain-session" }),
        } });
        const otherTarget = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify({ flavor: "pi", piSessionId: "other-plain-session" }),
        } });
        await withAuthenticatedTestApp(registerAutomationV3Routes, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const plainTemplate = (sessionId: string) => JSON.stringify({ kind: "happier_automation_template_plain_v1",
                payload: { ...JSON.parse(AUTOMATION_TEMPLATE_V02_PLAIN).payload, existingSessionId: sessionId } });
            const retarget = await app.inject({ method: "PATCH", url: `/v3/automations/${retained.id}`, headers,
                payload: { expectedTemplateVersion: 2, templateCiphertext: plainTemplate(otherTarget.id) } });
            expect(retarget.statusCode).toBe(400);
            const recovery = await app.inject({ method: "PATCH", url: `/v3/automations/${retained.id}`, headers,
                payload: { expectedTemplateVersion: 2, templateCiphertext: plainTemplate(session.id) } });
            expect(recovery.statusCode, recovery.body).toBe(200);
            expect(recovery.json()).toMatchObject({ targetType: "existingSession", templateVersion: 3,
                templateCiphertext: plainTemplate(session.id) });
        });
    });

    it.each(["existing_session", "new_session"] as const)("refuses arbitrary retained ciphertext on a plain Account even on a non-template patch (%s)", async (targetType) => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const retained = await db.automation.create({ data: {
            accountId: account.id, name: "Unbound predecessor", enabled: false,
            targetType, templateCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED, templateVersion: 1,
        } });
        await expect(updateAutomation({ accountId: account.id, automationId: retained.id,
            input: { name: "Bypass" } })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(db.automation.findUniqueOrThrow({ where: { id: retained.id } }))
            .resolves.toMatchObject({ name: "Unbound predecessor", templateVersion: 1 });
        await expect(deleteAutomation({ accountId: account.id, automationId: retained.id })).resolves.toBe(true);
    });

    it("recovers a legacy encrypted new-Session template through the existing templateVersion CAS", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const retained = await db.automation.create({ data: {
            accountId: account.id, name: "Recoverable predecessor", enabled: false,
            targetType: "new_session", templateCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED, templateVersion: 1,
        } });
        const recovered = await updateAutomation({ accountId: account.id, automationId: retained.id,
            expectedTemplateVersion: 1, input: { executionRecipe: currentRecipe(2) } });
        expect(recovered).toMatchObject({ templateVersion: 2 });
        expect(JSON.parse(recovered!.templateCiphertext)).toMatchObject({ template: { t: "plain" } });
        await expect(updateAutomation({ accountId: account.id, automationId: retained.id,
            expectedTemplateVersion: 1, input: { executionRecipe: currentRecipe(2) } }))
            .rejects.toMatchObject({ name: "AutomationTemplateMutationConflictError" });
        await expect(getAutomation({ accountId: account.id, automationId: retained.id }))
            .resolves.toMatchObject({ templateVersion: 2, templateCiphertext: recovered!.templateCiphertext });
    });

    it("recovers an opaque predecessor through authenticated inventory and the canonical v3 PATCH", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const retained = await db.automation.create({ data: {
            accountId: account.id, name: "HTTP recovery", enabled: false,
            targetType: "new_session", templateCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED, templateVersion: 1,
        } });
        await withAuthenticatedTestApp((app) => {
            registerAutomationV3Routes(app);
            registerAccountEncryptionMigrateRoutes(app);
        }, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const inventory = await app.inject({ method: "GET", headers,
                url: "/v1/account/encryption/migrate/automations/inventory" });
            expect(inventory.statusCode, inventory.body).toBe(200);
            expect(inventory.json().templates).toEqual([expect.objectContaining({
                automationId: retained.id, expectedTemplateVersion: 1,
                templateCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED,
            })]);
            const detail = await app.inject({ method: "GET", headers, url: `/v3/automations/${retained.id}` });
            expect(detail.statusCode).toBe(409);
            expect(detail.json()).toEqual({ error: "automation_stored_content_unavailable" });
            const patch = { expectedTemplateVersion: inventory.json().templates[0].expectedTemplateVersion,
                templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN };
            const malformed = await app.inject({ method: "PATCH", headers,
                url: `/v3/automations/${retained.id}`, payload: { ...patch, templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1", payload: { arbitrary: "not an Automation template" },
                }) } });
            expect(malformed.statusCode).toBe(400);
            for (const privateOrWrongTarget of [
                { sessionEncryptionKeyBase64: "" }, { sessionEncryptionVariant: "dataKey" },
                { sessionEncryptionMode: "e2ee" }, { existingSessionId: "retarget" },
            ]) {
                const invalid = await app.inject({ method: "PATCH", headers,
                    url: `/v3/automations/${retained.id}`, payload: { ...patch, templateCiphertext: JSON.stringify({
                        kind: "happier_automation_template_plain_v1",
                        payload: { ...JSON.parse(AUTOMATION_TEMPLATE_V02_PLAIN).payload, ...privateOrWrongTarget },
                    }) } });
                expect(invalid.statusCode).toBe(400);
            }
            const mixed = await app.inject({ method: "PATCH", headers,
                url: `/v3/automations/${retained.id}`, payload: { ...patch, executionRecipe: currentRecipe(2) } });
            expect(mixed.statusCode).toBe(400);
            const recovered = await app.inject({ method: "PATCH", headers,
                url: `/v3/automations/${retained.id}`, payload: patch });
            expect(recovered.statusCode, recovered.body).toBe(200);
            expect(recovered.json()).toMatchObject({ id: retained.id, templateVersion: 2 });
            expect(recovered.json().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_PLAIN);
            const stale = await app.inject({ method: "PATCH", headers,
                url: `/v3/automations/${retained.id}`, payload: patch });
            expect(stale.statusCode).toBe(409);
            expect(stale.json()).toEqual({ error: "automation_template_version_conflict" });
            const reloaded = await db.automation.findUniqueOrThrow({ where: { id: retained.id } });
            expect(reloaded.templateVersion).toBe(2);
            expect(reloaded).toMatchObject({ targetType: "new_session", templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN });
            const strict = await db.automation.create({ data: {
                accountId: account.id, name: "Current recipe", enabled: false, targetType: "new_session",
                templateCiphertext: JSON.stringify(currentRecipe(1)), templateVersion: 1,
            } });
            const downgrade = await app.inject({ method: "PATCH", headers,
                url: `/v3/automations/${strict.id}`, payload: patch });
            expect(downgrade.statusCode).toBe(400);
            await expect(db.automation.findUniqueOrThrow({ where: { id: strict.id } }))
                .resolves.toMatchObject({ templateCiphertext: JSON.stringify(currentRecipe(1)), templateVersion: 1 });
        });
    });

    it("keeps the exact retained E2EE-Session template during the Account transition", async () => {
        const account = await db.account.create({ data: {
            encryptionMode: "e2ee", ...createSignedAccountContentBinding(),
        } });
        await db.session.create({ data: {
            id: "session-old", accountId: account.id, tag: randomUUID(),
            metadata: "opaque-retained-e2ee-metadata", encryptionMode: "e2ee",
        } });
        const retained = await createAutomation({ accountId: account.id, input: parseAutomationUpsertInput({
            name: "Retained during transition", enabled: false, schedule: { kind: "manual" },
            targetType: "existing_session", templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
        }, { accountMode: "e2ee", allowLegacyEncryptedExistingSessionTemplate: true }) });
        const directive = { action: "migrate" as const, templates: [{
            automationId: retained.id, expectedTemplateVersion: retained.templateVersion,
            templateCiphertext: retained.templateCiphertext, triggerDefinitionEnvelopes: [],
        }], runs: [] };
        await expect(inTx(async (tx) => migrateAutomationAccountEncryptionInTx({
            tx, accountId: account.id, toMode: "plain", directive,
        }))).resolves.toEqual({ status: "applied" });
        await expect(db.automation.findUniqueOrThrow({ where: { id: retained.id } }))
            .resolves.toMatchObject({ templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, templateVersion: 2 });
        await expect(db.session.findUniqueOrThrow({ where: { id: "session-old" } }))
            .resolves.toMatchObject({ encryptionMode: "e2ee" });
    });

    it("persists workflow trigger references and session scope through create, patch and reconciliation", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machineId = await seedExecutionMachine(account.id);
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", agentState: "{}",
        } });
        const automation = await createAutomation({ accountId: account.id, input: {
            automationId: randomUUID(), name: "Scoped workflow", enabled: true,
            workflowDefinitionId: "builtin:keep-going", scopeSessionId: session.id,
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
                v: 2, templateVersion: 1, triggerEvidence: null,
                workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind: "session" } } },
            }),
            assignments: [{ machineId }], triggers: [],
        } });
        expect(automation).toMatchObject({
            workflowDefinitionId: "builtin:keep-going", scopeSessionId: session.id,
        });
        await expect(createAutomation({ accountId: account.id, input: {
            automationId: automation.id, name: automation.name, enabled: true,
            workflowDefinitionId: "builtin:keep-going", scopeSessionId: session.id,
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(JSON.parse(automation.templateCiphertext)), assignments: [{ machineId }], triggers: [],
        } })).resolves.toMatchObject({ id: automation.id });
        await expect(createAutomation({ accountId: account.id, input: {
            automationId: automation.id, name: automation.name, enabled: true,
            workflowDefinitionId: "builtin:review-converge", scopeSessionId: session.id,
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(JSON.parse(automation.templateCiphertext)), assignments: [{ machineId }], triggers: [],
        } })).rejects.toBeInstanceOf(AutomationDefinitionCreateConflictError);
        expect((await listAutomationDefinitionsPage({
            accountId: account.id, workflowDefinitionId: "builtin:keep-going", scopeSessionId: session.id,
        })).automations.map((item) => item.id)).toEqual([automation.id]);
        expect((await listAutomationDefinitionsPage({ accountId: account.id, scope: "account_inline" })).automations).toEqual([]);
        const patched = await updateAutomation({ accountId: account.id, automationId: automation.id,
            input: { workflowDefinitionId: "builtin:review-converge", scopeSessionId: null },
        });
        expect(patched).toMatchObject({ workflowDefinitionId: "builtin:review-converge", scopeSessionId: null });
        const reconciled = await reconcileAutomationDefinition({
            accountId: account.id, automationId: automation.id, input: {
                expectedTemplateVersion: automation.templateVersion,
                name: automation.name, description: null, enabled: true,
                workflowDefinitionId: "builtin:keep-going", scopeSessionId: session.id,
                assignments: [{ machineId }], triggers: [], removedTriggers: [],
            },
        });
        expect(reconciled).toMatchObject({ workflowDefinitionId: "builtin:keep-going", scopeSessionId: session.id });
        await expect(updateAutomation({ accountId: account.id, automationId: automation.id,
            input: { assignments: [{ machineId }, { machineId: await seedExecutionMachine(account.id) }] },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        const foreignAccount = await db.account.create({ data: { encryptionMode: "plain" } });
        const foreignSession = await db.session.create({ data: {
            accountId: foreignAccount.id, tag: randomUUID(), metadata: "{}", agentState: "{}",
        } });
        await expect(updateAutomation({ accountId: account.id, automationId: automation.id,
            input: { scopeSessionId: foreignSession.id },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await withAuthenticatedTestApp(registerAutomationV3Routes, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const response = await app.inject({ method: "POST", url: "/v3/automations", headers, payload: {
                automationId: randomUUID(), name: "HTTP trigger", enabled: true,
                workflowDefinitionId: "builtin:keep-going", scopeSessionId: session.id,
                executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(JSON.parse(automation.templateCiphertext)),
                assignments: [{ machineId }], triggers: [],
            } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ workflowDefinitionId: "builtin:keep-going", scopeSessionId: session.id });
            const listed = await app.inject({ method: "GET", url: `/v3/automations?scopeSessionId=${session.id}`, headers });
            expect(listed.statusCode).toBe(200);
            expect(listed.json().automations).toHaveLength(2);
            const patchedResponse = await app.inject({ method: "PATCH", url: `/v3/automations/${response.json().id}`,
                headers, payload: { expectedTemplateVersion: 1, scopeSessionId: null, workflowDefinitionId: "builtin:review-converge" },
            });
            expect(patchedResponse.statusCode).toBe(200);
            expect(patchedResponse.json()).toMatchObject({ workflowDefinitionId: "builtin:review-converge", scopeSessionId: null });
        });
    });

    it.each(["prComment", "ciFailed"] as const)("persists scoped %s selectors through CRUD without Event routing", async (kind) => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machineId = await seedExecutionMachine(account.id);
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", agentState: "{}",
        } });
        const automation = await createAutomation({ accountId: account.id, input: {
            automationId: randomUUID(), name: "PR trigger", enabled: true,
            scopeSessionId: session.id, workflowDefinitionId: null,
            executionRecipe: workflowRecipe(1, machineId), assignments: [{ machineId }], triggers: [],
        } });
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const trigger = AutomationTriggerDefinitionInputSchema.parse({
            kind, enabled: true, pullRequest: { repository: "owner/repo", number: 42 },
        });
        const write = () => createAutomationTrigger({ accountId: account.id,
            automationId: automation.id, triggerId, trigger });
        const created = await write();
        if (!created) throw new Error("Missing created Automation");
        expect(created.triggers[0]).toMatchObject({ kind, sourceSessionId: session.id,
            eventPluginId: null, eventLocalId: null, sourceSelectorId: null });
        await expect(write()).resolves.toMatchObject({ id: automation.id });
        await expect(updateAutomation({ accountId: account.id, automationId: automation.id,
            input: { scopeSessionId: null } })).rejects.toBeInstanceOf(AutomationValidationError);
        const paused = await updateAutomationTrigger({ accountId: account.id, automationId: automation.id,
            triggerId, expectedRevision: 0, enabled: false });
        if (!paused) throw new Error("Missing paused Automation");
        const stored = paused.triggers[0];
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: "plain",
            binding: { v: 1, automationId: automation.id, triggerId, triggerRevision: 1, triggerKind: kind },
            envelope: JSON.parse(stored.definitionEnvelope!),
        });
        expect(opened.kind).toBe("available");
        if (opened.kind !== "available") throw new Error("PR selection unavailable");
        expect(AutomationPullRequestTriggerSchema.parse(opened.definition)).toEqual({ kind,
            pullRequest: { repository: "owner/repo", number: 42 } });
        await deleteAutomationTrigger({ accountId: account.id, automationId: automation.id, triggerId, expectedRevision: 1 });
        expect((await getAutomation({ accountId: account.id, automationId: automation.id }))?.triggers).toEqual([]);
    });

    it("keeps encrypted PR selection opaque and requires a resealed enablement revision", async () => {
        const account = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const machineId = await seedExecutionMachine(account.id);
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", agentState: "{}",
        } });
        const automation = await createAutomation({ accountId: account.id, input: {
            automationId: randomUUID(), name: "Private PR", enabled: true, scopeSessionId: session.id,
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ ...workflowRecipe(1, machineId),
                workflow: { t: "encrypted", c: "opaque-workflow-context" } }),
            assignments: [{ machineId }], triggers: [],
        } });
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: "e2ee",
            material: { type: "legacy", secret: new Uint8Array(32).fill(7) } }).material;
        const envelope = (triggerRevision: number) => sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "e2ee", material, randomBytes: (length) => new Uint8Array(length).fill(1),
            binding: { v: 1, automationId: automation.id, triggerId, triggerRevision, triggerKind: "prComment" },
            definition: { kind: "prComment", pullRequest: { repository: "private/repo", number: 42 } },
        });
        const trigger = AutomationTriggerDefinitionInputSchema.parse({ kind: "prComment", enabled: true,
            triggerDefinitionEnvelope: envelope(0) });
        const created = await createAutomationTrigger({ accountId: account.id, automationId: automation.id, triggerId, trigger });
        expect(created?.triggers[0]?.definitionEnvelope).not.toContain("private/repo");
        await expect(updateAutomationTrigger({ accountId: account.id, automationId: automation.id,
            triggerId, expectedRevision: 0, enabled: false })).rejects.toBeInstanceOf(AutomationValidationError);
        const paused = await updateAutomationTrigger({ accountId: account.id, automationId: automation.id,
            triggerId, expectedRevision: 0, enabled: false,
            triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(envelope(1)),
        });
        expect(paused?.triggers[0]).toMatchObject({ kind: "prComment", revision: 1, enabled: false, sourceSessionId: session.id });
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: "e2ee", material,
            binding: { v: 1, automationId: automation.id, triggerId, triggerRevision: 1, triggerKind: "prComment" },
            envelope: JSON.parse(paused!.triggers[0]!.definitionEnvelope!),
        });
        expect(opened).toMatchObject({ kind: "available", definition: { kind: "prComment", pullRequest: { repository: "private/repo", number: 42 } } });
    });

    it.each(["plain", "e2ee", "legacy"] as const)("advances the exposed revision on recipe-free trigger changes (%s)", async (mode) => {
        const account = await db.account.create({ data: {
            encryptionMode: mode === "e2ee" ? "e2ee" : "plain",
            ...(mode === "e2ee" ? createSignedAccountContentBinding() : {}),
        } });
        const machineId = await seedExecutionMachine(account.id);
        const common = {
            name: "Versioned trigger set", enabled: false,
            assignments: [{ machineId }],
        };
        const automation = await createAutomation({ accountId: account.id, input: mode === "legacy"
                ? { ...common, schedule: { kind: "interval", everyMs: 60_000 }, targetType: "new_session", templateCiphertext: JSON.stringify({ kind: "happier_automation_template_plain_v1", payload: { prompt: "Retained prompt" } }) }
                : { ...common, automationId: randomUUID(), triggers: [triggerInput(intervalTrigger(60_000))], executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
                    ...workflowRecipe(1, "unused"),
                    ...(mode === "e2ee" ? { workflow: { t: "encrypted", c: "unavailable-private-context" } } : {}),
                }) },
        });
        const removed = await reconcileAutomationDefinition({ accountId: account.id, automationId: automation.id, input: {
            expectedTemplateVersion: automation.templateVersion, name: automation.name, description: null, enabled: false,
            assignments: [{ machineId }], triggers: [], removedTriggers: [{
                triggerId: AutomationTriggerIdSchema.parse(automation.triggers[0]!.id), expectedRevision: automation.triggers[0]!.revision,
            }],
        } });
        expect(removed!.templateVersion).toBeGreaterThan(automation.templateVersion);
        expect(removed!.triggers).toEqual([]);
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const added = await reconcileAutomationDefinition({ accountId: account.id, automationId: automation.id, input: {
            expectedTemplateVersion: removed!.templateVersion, name: automation.name, description: null, enabled: false,
            assignments: [{ machineId }], triggers: [{ kind: "new", triggerId, trigger: intervalTrigger(60_000) }], removedTriggers: [],
        } });
        expect(added!.templateVersion).toBeGreaterThan(removed!.templateVersion);
        const disabled = await reconcileAutomationDefinition({ accountId: account.id, automationId: automation.id, input: {
            expectedTemplateVersion: added!.templateVersion, name: automation.name, description: null, enabled: false,
            assignments: [{ machineId }], triggers: [{ kind: "existing", triggerId, expectedRevision: added!.triggers[0]!.revision, enabled: false }], removedTriggers: [],
        } });
        expect(disabled!.templateVersion).toBeGreaterThan(added!.templateVersion);
        if (mode === "legacy") {
            expect(disabled!.templateCiphertext).toBe(automation.templateCiphertext);
        } else {
            const before = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(JSON.parse(automation.templateCiphertext));
            const after = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(JSON.parse(disabled!.templateCiphertext));
            expect(after.templateVersion).toBe(disabled!.templateVersion);
            expect(after.workflow).toEqual(before.workflow);
        }
    });

    it("advances the same revision through individual trigger mutations", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const automation = await createAutomation({ accountId: account.id, input: {
            automationId: randomUUID(), name: "Individual mutations", enabled: false,
            executionRecipe: currentRecipe(1), triggers: [],
        } });
        const triggerId = randomUUID();
        const added = await createAutomationTrigger({ accountId: account.id, automationId: automation.id, triggerId, trigger: intervalTrigger(60_000) });
        expect(added!.templateVersion).toBeGreaterThan(automation.templateVersion);
        const changed = await updateAutomationTrigger({ accountId: account.id, automationId: automation.id, triggerId,
            expectedRevision: added!.triggers[0]!.revision, enabled: false });
        expect(changed!.templateVersion).toBeGreaterThan(added!.templateVersion);
        const removed = await deleteAutomationTrigger({ accountId: account.id, automationId: automation.id, triggerId,
            expectedRevision: changed!.triggers[0]!.revision });
        expect(removed!.templateVersion).toBeGreaterThan(changed!.templateVersion);
        const after = AutomationStoredDefinitionExecutionRecipeV1Schema.parse(JSON.parse(removed!.templateCiphertext));
        expect(after).toEqual({ ...currentRecipe(1), templateVersion: removed!.templateVersion });
    });

    it("does not resurrect a removed trigger when the UI store receives a delayed pre-removal list", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machineId = await seedExecutionMachine(account.id);
        const automation = await createAutomation({ accountId: account.id, input: {
            automationId: randomUUID(), name: "Missing source", enabled: true,
            workflowDefinitionId: "builtin:keep-going",
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
                workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind: "session" } } }, triggerEvidence: null }),
            assignments: [{ machineId }], triggers: [triggerInput(intervalTrigger(60_000))],
        } });
        // Load the UI package at runtime to preserve its own TS alias/compilation boundary.
        const uiRequire = createRequire(new URL("../../../../ui/package.json", import.meta.url));
        // These native/environment boundaries use the UI package's canonical stubs.
        const expoStubPath = fileURLToPath(new URL("../../../../ui/sources/dev/expoConstantsStub.ts", import.meta.url));
        const nativeStubPath = fileURLToPath(new URL("../../../../ui/sources/dev/reactNativeStub.ts", import.meta.url));
        vi.doMock(uiRequire.resolve("expo-constants"), () => import(expoStubPath));
        vi.doMock(uiRequire.resolve("react-native"), () => import(nativeStubPath));
        const uiDomainPath = fileURLToPath(new URL("../../../../ui/sources/sync/store/domains/automations.ts", import.meta.url));
        const { createAutomationsDomain } = await import(uiDomainPath);
        const { createStore } = await import(uiRequire.resolve("zustand/vanilla"));
        type TriggerState = {
            workflowTriggerSetsById: Readonly<Record<string, WorkflowTriggerSetV1>>;
            applyWorkflowTriggerSetPage: (input: { queryKey: string; sets: readonly WorkflowTriggerSetV1[] }) => void;
            upsertWorkflowTriggerSet: (input: { queryKey?: string; set: WorkflowTriggerSetV1 }) => void;
        };
        const store: { getState: () => TriggerState } = createStore((set: unknown, get: unknown) => createAutomationsDomain({ set, get }));
        await withAuthenticatedTestApp(registerAutomationV3Routes, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const read = async () => {
                const response = await app.inject({ method: "GET", url: `/v3/automations/${automation.id}`, headers });
                expect(response.statusCode).toBe(200);
                return AutomationDefinitionDetailSchema.parse(response.json());
            };
            const actions = createWorkflowTriggerActions({
                automations: {
                    get: read,
                    list: async () => ({ automations: [await read()], nextCursor: null }),
                    reconcile: async (id, input) => {
                        const response = await app.inject({ method: "PUT", url: `/v3/automations/${id}`, headers, payload: input });
                        expect(response.statusCode).toBe(200);
                        return AutomationDefinitionDetailSchema.parse(response.json());
                    },
                    create: async () => { throw new Error("Unexpected create"); },
                    delete: async () => { throw new Error("Unexpected delete"); },
                },
                newId: () => { throw new Error("Unexpected identity allocation"); },
                openContext: async () => { throw Object.assign(new Error("source_unavailable"), { code: "source_unavailable" }); },
                sealContext: async () => { throw new Error("Removal must preserve opaque content"); },
                resolveWorkflow: async () => { throw new Error("Removal must not resolve the source"); },
            });
            const delayed = await actions.list({ workflow: "builtin:keep-going" });
            const queryKey = "workflow:builtin:keep-going";
            store.getState().applyWorkflowTriggerSetPage({ queryKey, sets: delayed.sets });
            const removed = await actions.remove(WorkflowTriggerRemoveRequestV1Schema.parse({ automationId: automation.id, triggerId: automation.triggers[0]!.id }));
            store.getState().upsertWorkflowTriggerSet({ queryKey, set: removed.set });
            store.getState().applyWorkflowTriggerSetPage({ queryKey, sets: delayed.sets });
            expect(store.getState().workflowTriggerSetsById[automation.id]!.triggers).toEqual([]);
            expect(removed.set.revision).toBeGreaterThan(delayed.sets[0]!.revision);
            expect((await read()).triggers).toEqual([]);
        });
    });

    it("accepts zero or many automatic triggers with independent state", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const executionMachineId = await seedExecutionMachine(account.id);
        const directOnly = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Direct only",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: executionMachineId }],
                triggers: [],
            },
        });
        expect(directOnly.triggers).toEqual([]);

        const scheduled = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Two independent schedules",
                enabled: false,
                executionRecipe: currentRecipe(1),
                triggers: [
                    triggerInput(intervalTrigger(60_000)),
                    triggerInput(intervalTrigger(120_000, false)),
                ],
            },
        });
        expect(scheduled.triggers).toHaveLength(2);
        expect(scheduled.triggers.find((trigger) => trigger.everyMs === 60_000)).toMatchObject({
            kind: "schedule", enabled: true, revision: 0, everyMs: 60_000,
        });
        expect(scheduled.triggers.find((trigger) => trigger.everyMs === 120_000)).toMatchObject({
            kind: "schedule", enabled: false, revision: 0, everyMs: 120_000,
        });
        expect(scheduled.triggers[0]!.id).not.toBe(scheduled.triggers[1]!.id);
    });

    it("requires workflow occurrence evidence exactly for private-input causes", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = await seedExecutionMachine(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Workflow evidence",
                enabled: true,
                executionRecipe: workflowRecipe(1, machineId),
                assignments: [{ machineId }],
                triggers: [],
            },
        });

        const missingConversationEvidence = await inTx(async (tx) => await admitAutomationRunTx({
            tx,
            accountId: account.id,
            automationId: created.id,
            now: new Date(),
            cause: {
                kind: "conversation",
                occurrenceKey: AutomationOccurrenceKeyV1Schema.parse(
                    "izTbwsBetNfiXUjv6s6CRWsWzudgvK6AwVf1KjwueHs",
                ),
                occurredAt: Date.now(),
            },
        }));
        expect(missingConversationEvidence).toEqual({ kind: "ineligible", reason: "definitionInvalid" });

        const authoredManualEvidence = await inTx(async (tx) => await admitAutomationRunTx({
            tx,
            accountId: account.id,
            automationId: created.id,
            now: new Date(),
            cause: { kind: "manual", invokedAt: Date.now() },
            executionTriggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: { input: "forged" } }),
        }));
        expect(authoredManualEvidence).toEqual({ kind: "ineligible", reason: "definitionInvalid" });
        await expect(db.automationRun.count({ where: { automationId: created.id } })).resolves.toBe(0);
    });

    it("does not admit workflow recipes while the canonical workflow feature is disabled", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = await seedExecutionMachine(account.id);
        const workflow = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(), name: "Workflow", enabled: true,
                executionRecipe: workflowRecipe(1, machineId), assignments: [{ machineId }], triggers: [],
            },
        });
        const workflowAdmission = await inTx(async (tx) => await admitAutomationRunTx({
                tx, accountId: account.id, automationId: workflow.id, now: new Date(),
                cause: { kind: "manual", invokedAt: Date.now() },
                recipeFeaturePolicy: { workflowsEnabled: false },
            }));

        expect(workflowAdmission).toEqual({ kind: "ineligible", reason: "featureDisabled" });
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: workflow.id,
            recipeFeaturePolicy: { workflowsEnabled: false },
        })).rejects.toThrow(/featureDisabled/);
        await expect(db.automationRun.count({ where: { automationId: workflow.id } })).resolves.toBe(0);
    });

    it("advances Event catalog truth when an already-disabled trigger or Automation is deleted", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const createDisabledDefinition = async (name: string) => await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name,
                enabled: false,
                executionRecipe: currentRecipe(1),
                assignments: [],
                triggers: [],
            },
        });
        const triggerDeletion = await createDisabledDefinition("disabled trigger deletion");
        const trigger = await seedPluginEventTriggerWithStatus(triggerDeletion.id, "disabled-trigger");
        await db.automationTrigger.update({
            where: { id: trigger.id },
            data: { enabled: false },
        });
        const automationDeletion = await createDisabledDefinition("disabled Automation deletion");
        const secondTrigger = await seedPluginEventTriggerWithStatus(
            automationDeletion.id,
            "disabled-automation",
        );
        await db.automationTrigger.update({
            where: { id: secondTrigger.id },
            data: { enabled: false },
        });
        const reconciliationDeletion = await createDisabledDefinition("disabled reconciliation deletion");
        const thirdTrigger = await seedPluginEventTriggerWithStatus(
            reconciliationDeletion.id,
            "disabled-reconciliation",
        );
        await db.automationTrigger.update({
            where: { id: thirdTrigger.id },
            data: { enabled: false },
        });

        await deleteAutomationTrigger({
            accountId: account.id,
            automationId: triggerDeletion.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
        });
        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 1n });

        await expect(deleteAutomation({
            accountId: account.id,
            automationId: automationDeletion.id,
        })).resolves.toBe(true);
        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 2n });

        await reconcileAutomationDefinition({
            accountId: account.id,
            automationId: reconciliationDeletion.id,
            input: {
                expectedTemplateVersion: reconciliationDeletion.templateVersion,
                name: reconciliationDeletion.name,
                description: reconciliationDeletion.description,
                enabled: false,
                assignments: [],
                triggers: [],
                removedTriggers: [{
                    triggerId: AutomationTriggerIdSchema.parse(thirdTrigger.id),
                    expectedRevision: thirdTrigger.revision,
                }],
            },
        });
        await expect(db.automationEventCatalogState.findUniqueOrThrow({
            where: { accountId: account.id },
            select: { eventSourceDefinitionsRevision: true },
        })).resolves.toEqual({ eventSourceDefinitionsRevision: 3n });
    });

    it("pages the ordinary V3 definition order by stable updatedAt/id keyset", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
        for (const id of ids) {
            await createAutomation({
                accountId: account.id,
                input: {
                    automationId: id,
                    name: id,
                    enabled: false,
                    executionRecipe: currentRecipe(1),
                    triggers: [],
                },
            });
        }
        const sameUpdatedAt = new Date("2026-08-29T10:00:00.000Z");
        await db.automation.updateMany({
            where: { id: { in: ids } },
            data: { updatedAt: sameUpdatedAt },
        });

        const first = await listAutomationDefinitionsPage({
            accountId: account.id,
            limit: 2,
        });
        expect(first.automations.map((automation) => automation.id)).toEqual(ids.slice(0, 2));
        expect(first.nextCursor).not.toBeNull();

        // Cursor progression is independent of the cursor row continuing to
        // exist; numeric offsets would skip the remaining definition here.
        await db.automation.update({
            where: { id: ids[1]! },
            data: { deletedAt: new Date("2026-08-29T10:01:00.000Z") },
        });
        const second = await listAutomationDefinitionsPage({
            accountId: account.id,
            limit: 2,
            cursor: first.nextCursor,
        });
        expect(second.automations.map((automation) => automation.id)).toEqual([ids[2]]);
        expect(second.nextCursor).toBeNull();

        await expect(listAutomationDefinitionsPage({
            accountId: account.id,
            cursor: "not-a-cursor",
        })).rejects.toThrow(AutomationValidationError);
    });

    it("keeps private trigger definition envelopes and unused status relations out of the list read", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const automation = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "List read narrowing",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [triggerInput(intervalTrigger(60_000))],
            },
        });
        const privateEnvelope = JSON.stringify({
            v: 1,
            sourceInstanceId: "repository-private",
            displayLabel: "Private repository label",
            sourceConfig: { repositoryId: "repository-private" },
        });
        await db.automationTrigger.create({
            data: {
                automationId: automation.id,
                kind: "pluginEvent",
                eventPluginId: "happier.github",
                eventLocalId: "repository-pushed",
                sourceSelectorId: `selector-${randomUUID()}`,
                sourceContractVersion: 1,
                observationTransport: "checkpointedPull",
                watcherMachineId: "watcher-machine",
                watcherMachineInstallationId: "watcher-installation",
                watcherPluginId: "happier.github",
                watcherMaterializationId: "watcher-materialization",
                definitionEnvelope: privateEnvelope,
            },
            select: { id: true },
        });

        const listed = await listAutomations({ accountId: account.id });
        const listedAutomation = listed.find((row) => row.id === automation.id);
        expect(listedAutomation).toBeDefined();
        const listedEventTrigger = listedAutomation!.triggers.find((trigger) => trigger.kind === "pluginEvent");
        expect(listedEventTrigger).toBeDefined();
        expect(listedEventTrigger!).not.toHaveProperty("definitionEnvelope");
        expect(JSON.stringify(listedEventTrigger!)).not.toContain("Private repository label");
        expect(listedEventTrigger!).not.toHaveProperty("eventSourceStatus");

        const detail = await getAutomation({ accountId: account.id, automationId: automation.id });
        const detailEventTrigger = detail?.triggers.find((trigger) => trigger.kind === "pluginEvent");
        expect(detailEventTrigger).toBeDefined();
        expect(detailEventTrigger!).toHaveProperty("definitionEnvelope", privateEnvelope);
    });

    it("rejoins an identical client-identified Automation create after response loss", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const automationId = randomUUID();
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const input = {
            automationId,
            name: "Response-loss Automation",
            description: null,
            enabled: false,
            executionRecipe: currentRecipe(1),
            assignments: [] as const,
            triggers: [{ triggerId, trigger: intervalTrigger(60_000) }],
        };

        const created = await createAutomation({ accountId: account.id, input });
        const rejoined = await createAutomation({ accountId: account.id, input });

        expect(rejoined.id).toBe(created.id);
        expect(rejoined.triggers).toHaveLength(1);
        await expect(db.automation.count({ where: { id: automationId } })).resolves.toBe(1);
        await expect(db.automationTrigger.count({ where: { id: triggerId } })).resolves.toBe(1);

        await expect(createAutomation({
            accountId: account.id,
            input: { ...input, name: "Conflicting Automation" },
        })).rejects.toBeInstanceOf(AutomationDefinitionCreateConflictError);
    });

    it("rejoins an identical client-identified trigger create after response loss", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Trigger response loss",
                enabled: false,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        });
        const triggerId = randomUUID();
        const trigger = intervalTrigger(90_000, false);

        const first = await createAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId,
            trigger,
        });
        const rejoined = await createAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId,
            trigger,
        });

        expect(rejoined?.triggers).toEqual(first?.triggers);
        await expect(db.automationTrigger.count({ where: { id: triggerId } })).resolves.toBe(1);

        await expect(createAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId,
            trigger: intervalTrigger(120_000, false),
        })).rejects.toBeInstanceOf(AutomationTriggerCreateConflictError);
    });

    it("preserves trigger identities, revisions, and next-run state across name and recipe edits", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Stable schedules",
                enabled: false,
                executionRecipe: currentRecipe(1),
                triggers: [
                    triggerInput(intervalTrigger(60_000)),
                    triggerInput(intervalTrigger(120_000)),
                ],
            },
        });
        const firstNextRunAt = new Date("2026-08-27T10:00:00.000Z");
        const secondNextRunAt = new Date("2026-08-27T11:00:00.000Z");
        const firstTrigger = created.triggers.find((trigger) => trigger.everyMs === 60_000)!;
        const secondTrigger = created.triggers.find((trigger) => trigger.everyMs === 120_000)!;
        await Promise.all([
            db.automationTrigger.update({
                where: { id: firstTrigger.id }, data: { nextRunAt: firstNextRunAt },
            }),
            db.automationTrigger.update({
                where: { id: secondTrigger.id }, data: { nextRunAt: secondNextRunAt },
            }),
        ]);

        const renamed = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTemplateVersion: 1,
            input: {
                name: "Renamed stable schedules",
                executionRecipe: currentRecipe(2),
            },
        });
        expect(renamed).toMatchObject({
            name: "Renamed stable schedules",
            templateVersion: 2,
        });
        expect(renamed?.triggers.map((trigger) => ({
            id: trigger.id,
            revision: trigger.revision,
            nextRunAt: trigger.nextRunAt,
        }))).toEqual(expect.arrayContaining([
            { id: firstTrigger.id, revision: 0, nextRunAt: firstNextRunAt },
            { id: secondTrigger.id, revision: 0, nextRunAt: secondNextRunAt },
        ]));

        const edited = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: firstTrigger.id,
            expectedRevision: firstTrigger.revision,
            trigger: {
                kind: "schedule",
                schedule: intervalTrigger(180_000).schedule,
            },
        });
        expect(edited?.triggers).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: firstTrigger.id,
                revision: 1,
                everyMs: 180_000,
            }),
            expect.objectContaining({
                id: secondTrigger.id,
                revision: 0,
                everyMs: 120_000,
            }),
        ]));

        const thirdTriggerId = randomUUID();
        const withThird = await createAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: thirdTriggerId,
            trigger: intervalTrigger(240_000, false),
        });
        const third = withThird?.triggers.find((trigger) => trigger.everyMs === 240_000);
        expect(third).toMatchObject({
            id: thirdTriggerId,
            kind: "schedule",
            enabled: false,
            revision: 0,
        });

        const withoutThird = await deleteAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: third!.id,
            expectedRevision: third!.revision,
        });
        expect(withoutThird?.triggers.map((trigger) => trigger.id)).toEqual([
            created.triggers[0]!.id,
            created.triggers[1]!.id,
        ]);
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: third!.id },
            select: {
                enabled: true,
                deletedAt: true,
                scheduleKind: true,
                scheduleExpr: true,
                everyMs: true,
                timezone: true,
                nextRunAt: true,
                eventPluginId: true,
                eventLocalId: true,
                sourceSelectorId: true,
                sourceContractVersion: true,
                observationTransport: true,
                webhookEndpointId: true,
                observationStartsAt: true,
                watcherMachineId: true,
                watcherMachineInstallationId: true,
                watcherPluginId: true,
                watcherMaterializationId: true,
                definitionEnvelope: true,
                sessionLifecycleEventsJson: true,
                sessionLifecyclePolicyKind: true,
                sessionLifecycleMatchCount: true,
                remainingOccurrences: true,
                sourceSessionId: true,
                sourceTurnId: true,
            },
        })).resolves.toEqual({
            enabled: false,
            deletedAt: expect.any(Date),
            scheduleKind: null,
            scheduleExpr: null,
            everyMs: null,
            timezone: null,
            nextRunAt: null,
            eventPluginId: null,
            eventLocalId: null,
            sourceSelectorId: null,
            sourceContractVersion: null,
            observationTransport: null,
            webhookEndpointId: null,
            observationStartsAt: null,
            watcherMachineId: null,
            watcherMachineInstallationId: null,
            watcherPluginId: null,
            watcherMaterializationId: null,
            definitionEnvelope: null,
            sessionLifecycleEventsJson: null,
            sessionLifecyclePolicyKind: null,
            sessionLifecycleMatchCount: null,
            remainingOccurrences: null,
            sourceSessionId: null,
            sourceTurnId: null,
        });
    });

    it("deletes Event source projection state when its trigger is retired", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const automation = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Retired Event status",
                enabled: false,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        });
        const trigger = await seedPluginEventTriggerWithStatus(automation.id, "retired");

        await expect(deleteAutomationTrigger({
            accountId: account.id,
            automationId: automation.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
        })).resolves.not.toBeNull();
        await expect(db.automationEventSourceStatus.findUnique({
            where: { triggerId: trigger.id },
        })).resolves.toBeNull();
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: trigger.id },
            select: {
                deletedAt: true,
                eventPluginId: true,
                eventLocalId: true,
                sourceSelectorId: true,
                definitionEnvelope: true,
            },
        })).resolves.toEqual({
            deletedAt: expect.any(Date),
            eventPluginId: trigger.eventPluginId,
            eventLocalId: trigger.eventLocalId,
            sourceSelectorId: trigger.sourceSelectorId,
            definitionEnvelope: null,
        });
    });

    it("deletes every child Event source status when its parent Automation is deleted", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const automation = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Deleted parent Event statuses",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [],
            },
        });
        const first = await seedPluginEventTriggerWithStatus(automation.id, "parent-first");
        const second = await seedPluginEventTriggerWithStatus(automation.id, "parent-second");

        await expect(deleteAutomation({
            accountId: account.id,
            automationId: automation.id,
        })).resolves.toBe(true);
        await expect(db.automationEventSourceStatus.count({
            where: { triggerId: { in: [first.id, second.id] } },
        })).resolves.toBe(0);
        await expect(db.automationTrigger.count({
            where: {
                id: { in: [first.id, second.id] },
                enabled: false,
                deletedAt: null,
            },
        })).resolves.toBe(2);
    });

    it("runs a zero-trigger Automation manually and rejoins only the same invocation", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "On demand",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [],
            },
        });
        const first = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-44",
        });
        const replay = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-44",
        });
        expect(first).toMatchObject({
            triggerId: null, causeKind: "manual", causeTriggerKind: null, state: "queued",
        });
        expect(first).toMatchObject({
            occurrenceKey: expect.any(String),
            legacyManualIdempotencyKey: null,
        });
        expect(replay?.id).toBe(first?.id);
        expect(replay?.causeOccurredAt).toEqual(first?.causeOccurredAt);
        await expect(db.automationRun.count({ where: { automationId: created.id } }))
            .resolves.toBe(1);

        const prefixedManual = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "conversation:reserved-for-direct-invocation",
        });
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "conversation:reserved-for-direct-invocation",
        })).resolves.toMatchObject({ id: prefixedManual!.id, causeKind: "manual" });

        await setAutomationEnabled({
            accountId: account.id, automationId: created.id, enabled: false,
        });
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-44",
        })).resolves.toMatchObject({ id: first!.id, causeKind: "manual" });
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-45",
        })).rejects.toBeInstanceOf(AutomationDisabledError);
    });


    it("soft-deletes a definition without rewriting its admitted Run cause", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Retained history",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [triggerInput(intervalTrigger(60_000))],
            },
        });
        const trigger = created.triggers[0]!;
        await expect(db.automationRun.count({ where: { automationId: created.id } })).resolves.toBe(0);
        const dueAt = new Date();
        await db.automationTrigger.update({ where: { id: trigger.id }, data: { nextRunAt: dueAt } });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const admitted = await db.automationRun.findFirstOrThrow({
            where: { automationId: created.id, triggerId: trigger.id },
            select: { id: true },
        });
        await expect(deleteAutomation({
            accountId: account.id, automationId: created.id,
        })).resolves.toBe(true);
        await expect(listAutomations({ accountId: account.id })).resolves.toEqual([]);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted.id },
            select: {
                triggerId: true,
                causeKind: true,
                causeTriggerKind: true,
                causeTriggerRevision: true,
            },
        })).resolves.toEqual({
            triggerId: trigger.id,
            causeKind: "trigger",
            causeTriggerKind: "schedule",
            causeTriggerRevision: trigger.revision,
        });
    });


    it("fails closed for current E2EE authoring and inconsistent Account currentness", async () => {
        const e2ee = await db.account.create({
            data: createSignedAccountContentBinding(), select: { id: true },
        });
        await expect(createAutomation({
            accountId: e2ee.id,
            input: {
                automationId: randomUUID(),
                name: "Unavailable current E2EE writer",
                enabled: true,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(db.automation.count({ where: { accountId: e2ee.id } })).resolves.toBe(0);

        const legacy = await createAutomation({
            accountId: e2ee.id,
            input: {
                name: "Retained encrypted V2 schedule",
                enabled: true,
                schedule: { kind: "interval", everyMs: 300_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: legacyTemplateEnvelope(),
                assignments: [{ machineId: await seedExecutionMachine(e2ee.id) }],
            },
        });
        await db.account.update({
            where: { id: e2ee.id },
            data: { contentPublicKey: null, contentPublicKeySig: null },
        });
        await expect(runAutomationNow({
            accountId: e2ee.id,
            automationId: legacy.id,
        })).resolves.toBeNull();
        await expect(updateAutomation({
            accountId: e2ee.id,
            automationId: legacy.id,
            input: { name: "must not write" },
        })).resolves.toBeNull();
        await expect(deleteAutomation({
            accountId: e2ee.id,
            automationId: legacy.id,
        })).resolves.toBe(false);
    });

    it("rejects an enabled create with zero enabled assignments and admits a disabled draft with none", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        await expect(createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Enabled without assignment",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [],
                triggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        // An all-disabled replacement set is still zero enabled assignments.
        const disabledOnlyMachineId = await seedExecutionMachine(account.id);
        await expect(createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Enabled with only disabled assignments",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: disabledOnlyMachineId, enabled: false }],
                triggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(db.automation.count({ where: { accountId: account.id } })).resolves.toBe(0);

        // A disabled draft may own zero enabled assignments.
        await expect(createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Disabled draft",
                enabled: false,
                executionRecipe: currentRecipe(1),
                assignments: [],
                triggers: [],
            },
        })).resolves.toMatchObject({ id: expect.any(String), enabled: false });
    });

    it("rejects enabling without an enabled assignment and accepts enabling with one", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const draft = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Enable gate",
                enabled: false,
                executionRecipe: currentRecipe(1),
                assignments: [],
                triggers: [],
            },
        });
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: draft.id,
            enabled: true,
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: draft.id },
            select: { enabled: true },
        })).resolves.toMatchObject({ enabled: false });

        const executionMachineId = await seedExecutionMachine(account.id);
        await expect(updateAutomation({
            accountId: account.id,
            automationId: draft.id,
            input: {
                enabled: true,
                assignments: [{ machineId: executionMachineId }],
            },
        })).resolves.toMatchObject({ enabled: true });
    });

    it("rejects newly assigning a replaced machine while preserving an unchanged assignment", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const replacedMachineId = await seedExecutionMachine(account.id);
        const replacementMachineId = await seedExecutionMachine(account.id);
        const retained = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Reversible replacement assignment",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: replacedMachineId }],
                triggers: [],
            },
        });
        await db.machine.update({
            where: { id: replacedMachineId },
            data: { replacedByMachineId: replacementMachineId, replacedAt: new Date() },
        });

        // An unrelated whole-definition edit preserves the configured
        // assignment so clearing replacement can naturally reactivate it.
        await expect(updateAutomation({
            accountId: account.id,
            automationId: retained.id,
            input: {
                name: "Reversible replacement assignment renamed",
                assignments: [{ machineId: replacedMachineId }],
            },
        })).resolves.toMatchObject({
            name: "Reversible replacement assignment renamed",
            assignments: [{ machineId: replacedMachineId, enabled: true }],
        });

        const otherMachineId = await seedExecutionMachine(account.id);
        const other = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Available assignment",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: otherMachineId }],
                triggers: [],
            },
        });
        await expect(updateAutomation({
            accountId: account.id,
            automationId: other.id,
            input: { assignments: [{ machineId: replacedMachineId }] },
        })).rejects.toMatchObject({
            name: "AutomationValidationError",
            message: `Unavailable machine assignments: ${replacedMachineId}`,
        });
        await expect(getAutomation({ accountId: account.id, automationId: other.id }))
            .resolves.toMatchObject({
                assignments: [{ machineId: otherMachineId, enabled: true }],
            });
    });

    it("rejects removing or disabling the last enabled assignment while enabled, atomically", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const executionMachineId = await seedExecutionMachine(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Last assignment gate",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: executionMachineId }],
                triggers: [],
            },
        });
        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { assignments: [] },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: {
                assignments: [{ machineId: executionMachineId, enabled: false }],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        // The whole patch rolled back: the enabled assignment survived.
        await expect(getAutomation({ accountId: account.id, automationId: created.id }))
            .resolves.toMatchObject({
                enabled: true,
                assignments: [{ machineId: executionMachineId, enabled: true }],
            });

        // Pausing first makes the same removal a legal disabled draft edit.
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        })).resolves.toMatchObject({ enabled: false });
        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { assignments: [] },
        })).resolves.toMatchObject({ enabled: false, assignments: [] });
    });

    it("rejects a whole-editor Save leaving an enabled Automation with zero enabled assignments, atomically", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const executionMachineId = await seedExecutionMachine(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Save atomicity",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: executionMachineId }],
                triggers: [triggerInput(intervalTrigger(60_000))],
            },
        });
        await expect(reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: 1,
                name: "Save without assignment",
                description: null,
                enabled: true,
                assignments: [],
                triggers: created.triggers.map((trigger) => ({
                    kind: "existing" as const,
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: trigger.revision,
                })),
                removedTriggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        // Nothing committed: name, template revision, and assignments intact.
        await expect(getAutomation({ accountId: account.id, automationId: created.id }))
            .resolves.toMatchObject({
                name: "Save atomicity",
                templateVersion: 1,
                enabled: true,
                assignments: [{ machineId: executionMachineId, enabled: true }],
            });

        // Pausing in the same Save accepts the empty assignment set.
        await expect(reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: 1,
                name: "Save without assignment",
                description: null,
                enabled: false,
                assignments: [],
                triggers: created.triggers.map((trigger) => ({
                    kind: "existing" as const,
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: trigger.revision,
                })),
                removedTriggers: [],
            },
        })).resolves.toMatchObject({ enabled: false, assignments: [] });
    });

    it("authors, pauses, and resumes an existingSession definition against a layout-one Session", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const executionMachineId = await seedExecutionMachine(account.id);
        const sessionId = `session-layout-one-${randomUUID()}`;
        await db.session.create({
            data: {
                id: sessionId,
                accountId: account.id,
                tag: "automation-existing-session-layout-one",
                metadata: JSON.stringify({
                    v: 1,
                    summary: { text: "Spawned layout-one Session", updatedAt: 1 },
                }),
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: account.id,
                machineId: executionMachineId,
                sessionId,
                data: "opaque-machine-correspondence",
            },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Layout-one existing session",
                enabled: true,
                executionRecipe: AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
                    v: 1,
                    templateVersion: 1,
                    template: { t: "plain", v: { v: 1, prompt: "Continue the target Session" } },
                    triggerEvidence: null,
                    target: { kind: "existingSession", sessionId },
                }),
                assignments: [{ machineId: executionMachineId }],
                triggers: [triggerInput(intervalTrigger(60_000))],
            },
        });
        expect(created.targetType).toBe("existing_session");

        // A non-template definition mutation (pause/resume) revalidates the
        // retained strict target instead of reparsing it as a legacy envelope.
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        })).resolves.toMatchObject({ enabled: false });
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        })).resolves.toMatchObject({ enabled: true });

        // Revoked-first + available-sibling correspondence: a Session may retain
        // a revoked machine's key beside an available machine's key, and the
        // available sibling must satisfy the target proof.
        const siblingMachineId = await seedExecutionMachine(account.id);
        await db.accessKey.create({
            data: {
                accountId: account.id,
                machineId: siblingMachineId,
                sessionId,
                data: "opaque-sibling-correspondence",
            },
        });
        await db.machine.update({
            where: { id: executionMachineId },
            data: { revokedAt: new Date() },
        });
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        })).resolves.toMatchObject({ enabled: false });

        // With only the revoked machine's correspondence left, the same target
        // fails typed and the mutation rolls back atomically.
        await db.accessKey.deleteMany({
            where: { accountId: account.id, machineId: siblingMachineId },
        });
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: { enabled: true },
        })).resolves.toMatchObject({ enabled: false });
    });
});
