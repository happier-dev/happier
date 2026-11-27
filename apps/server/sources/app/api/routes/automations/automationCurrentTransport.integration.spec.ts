import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import { createAccountWorkflowTriggerActions } from "@happier-dev/protocol/actions";
import {
    AutomationDefinitionDetailSchema, AutomationDefinitionDetailsResponseSchema,
    AutomationV3RunDetailSchema, AutomationV3RunListResponseSchema,
} from "@happier-dev/protocol/automations/automationApiV3";
import { WorkflowTriggerListResultV1Schema } from "@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1";
import { buildAutomationRunSummaryChangeEntityIdV1 } from "@happier-dev/protocol/changes";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { resolveWorkflowRunAccessInTx } from "@/app/workflows/workflowRunAccess";
import { transitionWorkflowRun } from "@/app/workflows/workflowRunService";
import { sealWorkflowCheckpointStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import { removeMachineAccessGrantInTx } from "@/app/machines/machineAccess";
import { admitDueAutomationScheduleTriggerTx } from "@/app/automations/automationRunQueueService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setEligibleMachineAccessGrantInTx } from "@/testkit/machineAccessGrant.testkit";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { automationRoutes } from "./automationRoutes";
import { AUTOMATION_TEMPLATE_V02_PLAIN } from "@happier-dev/protocol/testing/accountScopedCipherFixtures";
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { AutomationStoredWorkflowDefinitionRecipeV2Schema } from "@happier-dev/protocol/automations/automationWorkflowRecipeV2";

function workflowRecipe(kind: "session" | "detached_run") {
    return JSON.stringify(AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
        v: 2, templateVersion: 1, triggerEvidence: null,
        workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind } } },
    }));
}

describe("Automation current transport and retained 0.2 data", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-current-automation-transport-",
            env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: "1" },
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    it.each(["session", "detached_run"] as const)("preserves the revoked Machine refusal for Workflow Run now with a %s target", async kind => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const guest = await db.account.create({ data: { encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: "test-host", platform: "linux",
                happyCliVersion: "test", homeDir: "/home/test", happyHomeDir: "/home/test/.happier" }),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
        } });
        const grant = { actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: "account" as const, accountId: guest.id } };
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { ...grant, level: "view" })))
            .toMatchObject({ kind: "saved" });
        const definition = { accountId: guest.id, name: "Guest Workflow", enabled: true,
            templateVersion: 1, templateCiphertext: workflowRecipe(kind) };
        const automation = await db.automation.create({ data: {
            ...definition, assignments: { create: { machineId: machine.id, enabled: true } },
            triggers: { create: { kind: "schedule", scheduleKind: "interval", enabled: true, everyMs: 60_000 } },
        } });
        const unassigned = await db.automation.create({ data: definition });
        await withAuthenticatedTestApp(automationRoutes, async app => {
            const runNow = (id: string) => app.inject({ method: "POST", url: `/v3/automations/${id}/run-now`,
                headers: { "x-test-user-id": guest.id, "idempotency-key": randomUUID() } });
            const allowed = await runNow(automation.id);
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, grant))).toMatchObject({ kind: "removed" });
            const denied = await runNow(automation.id);
            const noAssignment = await runNow(unassigned.id);
            expect(await db.automationRun.count({ where: { accountId: guest.id } })).toBe(1);
            expect(noAssignment.statusCode).toBe(400);
            expect(noAssignment.json()).toEqual({ error: "Cannot admit manual Automation Run: noEnabledAssignment" });
            expect(denied.statusCode, denied.body).toBe(409);
            expect(denied.json()).toEqual({ error: "target_unavailable" });
        });
    });

    it("projects recurring holds onto the authenticated Workflow trigger set with one batched holder read", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const other = await db.account.create({ data: { encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, installationId: randomUUID(), metadata: "{}",
        } });
        const dueAt = new Date(Date.now() - 60_000);
        const schedule = { kind: "schedule" as const, scheduleKind: "interval" as const, everyMs: 60_000, nextRunAt: dueAt };
        const automation = await db.automation.create({ data: {
            accountId: account.id, name: "Scheduled Workflow", enabled: true,
            templateVersion: 1, templateCiphertext: workflowRecipe("detached_run"),
            assignments: { create: { machineId: machine.id, enabled: true } },
            triggers: { create: [schedule, schedule, schedule] },
        }, include: { triggers: true } });
        const [trigger, privateTrigger, unheldTrigger] = automation.triggers;
        const admit = async (candidate: typeof trigger) => {
            const result = await inTx(tx => admitDueAutomationScheduleTriggerTx({
                tx, triggerId: candidate.id, expectedRevision: candidate.revision, expectedNextRunAt: dueAt, now: dueAt,
            }));
            if (result?.kind !== "admitted") throw new Error("Fixture schedule did not admit");
            return result.run.id;
        };
        await withAuthenticatedTestApp(automationRoutes, async app => {
            const headers = { "x-test-user-id": account.id };
            const outsideFixture = () => { throw new Error("Unexpected host transport"); };
            const actions = createAccountWorkflowTriggerActions({
                resolveWorkflow: outsideFixture,
                resolveEncryption: async () => ({ kind: "available", witness: {
                    mode: "plain", version: 1, contentKeyFingerprint: null,
                } }),
                randomBytes: outsideFixture,
                newId: outsideFixture,
                automations: {
                    list: outsideFixture, create: outsideFixture, reconcile: outsideFixture, delete: outsideFixture,
                    listDetails: async selection => {
                        const response = await app.inject({ method: "POST", url: "/v3/automations/query",
                            headers, payload: { ...selection, details: true } });
                        expect(response.statusCode, response.body).toBe(200);
                        return AutomationDefinitionDetailsResponseSchema.parse(response.json());
                    },
                    get: async automationId => {
                        const response = await app.inject({ method: "GET", url: `/v3/automations/${automationId}`, headers });
                        expect(response.statusCode, response.body).toBe(200);
                        return AutomationDefinitionDetailSchema.parse(response.json());
                    },
                },
            });
            const readSet = async (selection: Parameters<typeof actions.list>[0] = { scope: "account_all" }) => {
                const page = WorkflowTriggerListResultV1Schema.parse(await actions.list(selection));
                expect(page.sets).toHaveLength(1);
                return page.sets[0]!;
            };
            expect(await readSet()).not.toHaveProperty("scheduleHolds");
            const runId = await admit(trigger);
            const privateRunId = await admit(privateTrigger);
            const occurrenceChanges = await db.accountChange.findMany({
                where: { accountId: account.id, kind: "automation", entityId: { in: [runId, privateRunId].map(id =>
                    buildAutomationRunSummaryChangeEntityIdV1(automation.id, id)) } },
                select: { entityId: true },
            });
            expect(occurrenceChanges).toHaveLength(2);
            await db.automationRun.update({ where: { id: runId }, data: { state: "running" } });
            // Isolate the two permissions: this Account may read the definition, while the
            // saved incumbent on its second trigger is private to another Account.
            await db.automationRun.update({ where: { id: privateRunId }, data: {
                accountId: other.id, state: "interrupted", visibleTeamId: null,
            } });
            expect(await inTx(tx => resolveWorkflowRunAccessInTx(tx, { actorAccountId: account.id, runId: privateRunId }))).toBeNull();
            let holderReads = 0;
            const stopObserving = observeSqliteRequests({ before: request => {
                if (request.model === "AutomationRun" && request.action === "findMany"
                    && JSON.stringify(request.args).includes('"notIn"')) holderReads++;
            } });
            try {
                const set = await readSet();
                expect(set).toHaveProperty("scheduleHolds", expect.arrayContaining([
                    { triggerId: trigger.id, reason: "open_occurrence", runId, runState: "running" },
                    { triggerId: privateTrigger.id, reason: "open_occurrence" },
                ]));
                expect(set.scheduleHolds).toHaveLength(2);
                expect(JSON.stringify(set)).not.toContain(privateRunId);
                expect(set.missedSchedules?.map(item => item.triggerId)).toEqual([unheldTrigger.id]);
                expect(holderReads).toBe(1);
            } finally {
                stopObserving();
            }
            const running = await db.automationRun.update({ where: { id: runId },
                data: { claimedByMachineId: machine.id, leaseExpiresAt: dueAt } });
            const readOccurrences = async () => {
                const response = await app.inject({ method: "GET", url: `/v3/automations/${automation.id}/runs`, headers });
                expect(response.statusCode, response.body).toBe(200);
                return AutomationV3RunListResponseSchema.parse(response.json()).runs;
            };
            expect(await readOccurrences()).toContainEqual(expect.objectContaining({
                id: runId, state: "running", workflowRunState: "running", errorCode: null,
            }));
            const code = "credential_scope_denied";
            const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
                mode: "plain",
                binding: { v: 1, purpose: "checkpoint", accountId: account.id, runId },
                checkpoint: { kind: "happier.workflow-checkpoint.v1", rootRecordId: randomUUID(), nextSequence: "1",
                    frontier: { nextBlockOrdinal: 0, paused: false } },
            }));
            const interruption = await transitionWorkflowRun({
                accountId: account.id, runId, machineId: machine.id, parentAttempt: running.attempt,
                expectedRevision: running.revision, state: "interrupted", errorCode: code, checkpointEnvelope,
                accountCurrentness: { mode: "plain", version: 1, contentKeyFingerprint: null },
            });
            expect(interruption).toMatchObject({ state: "interrupted", errorCode: code, finishedAt: null });
            expect(await readOccurrences()).toContainEqual(expect.objectContaining({
                id: runId, state: "failed", workflowRunState: "interrupted",
                cause: expect.objectContaining({ kind: "trigger" }), errorCode: code, finishedAt: null,
            }));
            const exact = await app.inject({ method: "GET", url: `/v3/automations/${automation.id}/runs/${runId}`, headers });
            expect(exact.statusCode, exact.body).toBe(200);
            expect(AutomationV3RunDetailSchema.parse(exact.json())).toMatchObject({
                id: runId, state: "failed", workflowRunState: "interrupted", errorCode: code,
            });
            // A cadence edit retains an open prior occurrence as the incumbent.
            await db.automationTrigger.update({ where: { id: trigger.id }, data: { revision: { increment: 1 } } });
            expect(await readSet({ automationId: automation.id })).toHaveProperty("scheduleHolds", expect.arrayContaining([
                { triggerId: trigger.id, reason: "open_occurrence", runId, runState: "interrupted" },
            ]));
            const cancelled = await app.inject({ method: "POST", url: `/v3/automations/runs/${runId}/cancel`, headers });
            expect(cancelled.statusCode, cancelled.body).toBe(200);
            expect(await readOccurrences()).toContainEqual(expect.objectContaining({
                id: runId, state: "cancelled", workflowRunState: "cancelled", errorCode: null,
            }));
            expect(await readSet()).toHaveProperty("scheduleHolds", [
                { triggerId: privateTrigger.id, reason: "open_occurrence" },
            ]);
        });
    });

    it('closes the retained Automation route when the canonical Workflow gate is disabled', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        vi.stubEnv('HAPPIER_FEATURE_WORKFLOWS__ENABLED', '0');
        vi.stubEnv('HAPPIER_FEATURE_AUTOMATIONS__ENABLED', '1');
        try {
            await withAuthenticatedTestApp(automationRoutes, async (app) => {
                const response = await app.inject({
                    method: 'GET', url: '/v3/automations', headers: { 'x-test-user-id': account.id },
                });
                expect(response.statusCode).toBe(404);
                expect(response.json()).toEqual({ error: 'not_found' });
            });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("returns the live deleted revision rather than an earlier displayed revision", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const other = await db.account.create({ data: { encryptionMode: "plain" } });
        const automation = await db.automation.create({ data: {
            accountId: account.id, name: "Delete receipt", targetType: "new_session",
            templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN, templateVersion: 10,
        } });
        await db.automation.update({ where: { id: automation.id }, data: { templateVersion: 11 } });
        await withAuthenticatedTestApp(automationRoutes, async (app) => {
            const foreign = await app.inject({ method: "DELETE", url: `/v3/automations/${automation.id}`,
                headers: { "x-test-user-id": other.id } });
            expect(foreign.statusCode).toBe(404);
            const deleted = await app.inject({ method: "DELETE", url: `/v3/automations/${automation.id}`,
                headers: { "x-test-user-id": account.id } });
            expect(deleted.statusCode, deleted.body).toBe(200);
            expect(deleted.json()).toEqual({ ok: true, removedRevision: 11 });
            const repeated = await app.inject({ method: "DELETE", url: `/v3/automations/${automation.id}`,
                headers: { "x-test-user-id": account.id } });
            expect(repeated.statusCode).toBe(404);
        });
        expect(await db.automation.findUniqueOrThrow({ where: { id: automation.id } }))
            .toMatchObject({ templateVersion: 11, deletedAt: expect.any(Date) });
    });

    it("reads the bounded latest occurrences across visible Account Automations in Run history order", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const other = await db.account.create({ data: { encryptionMode: "plain" } });
        const newer = new Date("2026-10-03T00:00:00Z");
        const older = new Date("2026-10-02T00:00:00Z");
        const createAutomation = (accountId: string, name: string, deletedAt?: Date) => db.automation.create({ data: {
            accountId, name, deletedAt, targetType: "new_session", templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
        } });
        const [first, second, deleted, foreign] = await Promise.all([
            createAutomation(account.id, "First"), createAutomation(account.id, "Second"),
            createAutomation(account.id, "Deleted", newer), createAutomation(other.id, "Private"),
        ]);
        const data = { originKind: "automation", causeKind: "manual" as const, scheduledAt: older, dueAt: older };
        await db.automationRun.createMany({ data: [
            { ...data, id: "latest-z", accountId: account.id, automationId: first.id, createdAt: newer, causeOccurredAt: older, state: "skipped" },
            { ...data, id: "latest-a", accountId: account.id, automationId: second.id, createdAt: newer, causeOccurredAt: newer, state: "succeeded" },
            { ...data, id: "latest-old", accountId: account.id, automationId: first.id, createdAt: older, causeOccurredAt: newer, state: "succeeded" },
            { ...data, id: "latest-zz-deleted", accountId: account.id, automationId: deleted.id, createdAt: newer, causeOccurredAt: newer, state: "succeeded" },
            { ...data, id: "latest-zz-foreign", accountId: other.id, automationId: foreign.id, createdAt: newer, causeOccurredAt: newer, state: "succeeded" },
        ] });
        await withAuthenticatedTestApp(automationRoutes, async (app) => {
            const firstPage = await app.inject({ method: "GET", url: "/v3/automations/runs?limit=2",
                headers: { "x-test-user-id": account.id } });
            expect(firstPage.statusCode, firstPage.body).toBe(200);
            const page = AutomationV3RunListResponseSchema.parse(firstPage.json());
            expect(page.runs.map(run => run.id)).toEqual(["latest-z", "latest-a"]);
            expect(page.runs[0]?.state).toBe("skipped");
            expect(page.nextCursor).toBe("latest-a");
        });
    });

    it("pages Account attention including pre-session failures without per-run history reads, and clears settled attention", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const other = await db.account.create({ data: { encryptionMode: "plain" } });
        const automation = await db.automation.create({ data: {
            accountId: account.id, name: "One shot", targetType: "new_session",
            templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
        } });
        const otherAutomation = await db.automation.create({ data: {
            accountId: other.id, name: "Private", targetType: "new_session",
            templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
        } });
        const now = new Date("2026-10-02T00:00:00Z");
        const data = { accountId: account.id, automationId: automation.id, originKind: "automation",
            causeKind: "manual" as const, causeOccurredAt: now, scheduledAt: now, dueAt: now, createdAt: now };
        await db.automationRun.createMany({ data: [
            { ...data, id: "attention-z", state: "failed", errorCode: "machine_unavailable" },
            { ...data, id: "attention-y", state: "dispatch_failed" },
            { ...data, id: "attention-x", state: "succeeded", causeKind: "conversation",
                occurrenceKey: createHash("sha256").update("conversation-attention").digest("base64url"), triggerEvidenceEnvelope: '{"t":"plain","v":{}}',
                replyHandoffState: "blocked", replyContextEnvelope: '{"t":"plain","v":{}}',
                replyHandoffActionPluginId: "example.reply", replyHandoffActionLocalId: "deliver",
                replyHandoffTargetMachineId: "machine", replyHandoffTargetMachineInstallationId: "installation",
                replyHandoffTargetMaterializationId: "materialization", replyHandoffId: "delivery" },
            { ...data, id: "attention-normal", state: "succeeded" },
            { ...data, id: "attention-managed", state: "failed", workflowAcceptedSnapshotEnvelope: "private", workflowCustodyState: "settled" },
            { ...data, id: "attention-foreign", accountId: other.id, automationId: otherAutomation.id, state: "failed" },
        ] });
        const events = vi.spyOn(db.automationRunEvent, "findMany");
        const exact = vi.spyOn(db.automationRun, "findFirst");
        // Prisma delegates expose generated functions; explicitly retain the real database read.
        const readPage = db.automationRun.findMany.bind(db.automationRun);
        const pages = vi.spyOn(db.automationRun, "findMany").mockImplementation(readPage);
        try {
            await withAuthenticatedTestApp(automationRoutes, async (app) => {
                const headers = { "x-test-user-id": account.id };
                const first = await app.inject({ method: "GET", url: "/v3/automations/runs?attention=required&limit=2", headers });
                expect(first.statusCode, first.body).toBe(200);
                expect(first.json().runs.map((run: { id: string }) => run.id)).toEqual(["attention-z", "attention-y"]);
                expect(first.json().runs[0]).toMatchObject({ producedSessionId: null, errorCode: "machine_unavailable" });
                expect(first.json().runs[0]).not.toHaveProperty("workflowAcceptedSnapshotEnvelope");
                // The cursor row can leave attention between pages without changing traversal order.
                await db.automationRun.update({ where: { id: "attention-y" }, data: { state: "cancelled", revision: { increment: 1 } } });
                const second = await app.inject({ method: "GET", url: `/v3/automations/runs?attention=required&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers });
                expect(second.statusCode, second.body).toBe(200);
                expect(second.json().runs.map((run: { id: string }) => run.id)).toEqual(["attention-x"]);
                expect(second.json().nextCursor).toBeNull();
                await db.automationRun.update({ where: { id: "attention-x" }, data: { replyHandoffState: "accepted", revision: { increment: 1 } } });
                const refreshed = await app.inject({ method: "GET", url: "/v3/automations/runs?attention=required&limit=2", headers });
                expect(refreshed.json().runs.map((run: { id: string }) => run.id)).toEqual(["attention-z"]);
            });
            expect(events).not.toHaveBeenCalled();
            expect(exact).not.toHaveBeenCalled();
            expect(pages).toHaveBeenCalledTimes(3);
        } finally {
            events.mockRestore(); exact.mockRestore(); pages.mockRestore();
        }
    });

    it("reads unchanged 0.2-created templates and schedules through V3 while V2 routes are absent", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        // The pinned bytes come from the actual 0.2 UI writer, not current types.
        const automation = await db.automation.create({ data: {
            accountId: account.id,
            name: "Retained release review",
            targetType: "new_session",
            templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
            templateVersion: 1,
            triggers: { create: {
                kind: "schedule", enabled: true, scheduleKind: "interval", everyMs: 60_000,
            } },
        } });
        await withAuthenticatedTestApp(automationRoutes, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const list = await app.inject({ method: "GET", url: "/v3/automations", headers });
            expect(list.statusCode).toBe(200);
            expect(list.json().automations).toEqual([expect.objectContaining({ id: automation.id })]);
            const detail = await app.inject({ method: "GET", url: `/v3/automations/${automation.id}`, headers });
            expect(detail.statusCode).toBe(200);
            expect(detail.json()).toMatchObject({
                id: automation.id,
                templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
                triggers: [{ kind: "schedule", schedule: { kind: "interval", everyMs: 60_000 } }],
            });
            for (const [method, url] of [
                ["GET", "/v2/automations"], ["POST", "/v2/automations"],
                ["GET", `/v2/automations/${automation.id}`], ["PATCH", `/v2/automations/${automation.id}`],
                ["DELETE", `/v2/automations/${automation.id}`],
                ["POST", `/v2/automations/${automation.id}/pause`],
                ["POST", `/v2/automations/${automation.id}/resume`],
                ["POST", `/v2/automations/${automation.id}/run-now`],
                ["POST", `/v2/automations/${automation.id}/assignments`],
                ["GET", `/v2/automations/${automation.id}/runs`],
                ["GET", "/v2/automations/daemon/assignments"],
                ["POST", "/v2/automations/runs/claim"],
                ["POST", "/v2/automations/runs/run/heartbeat"],
                ["POST", "/v2/automations/runs/run/start"],
                ["POST", "/v2/automations/runs/run/succeed"],
                ["POST", "/v2/automations/runs/run/fail"],
                ["POST", "/v2/automations/runs/run/cancel"],
            ] as const) {
                const response = await app.inject({ method, url, headers });
                expect(response.statusCode, `${method} ${url}`).toBe(404);
            }
        });
        expect((await db.automation.findUniqueOrThrow({ where: { id: automation.id } })).templateCiphertext)
            .toBe(AUTOMATION_TEMPLATE_V02_PLAIN);
    });
});
