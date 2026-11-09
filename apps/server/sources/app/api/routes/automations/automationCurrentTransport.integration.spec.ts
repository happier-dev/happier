import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { automationRoutes } from "./automationRoutes";
import { AUTOMATION_TEMPLATE_V02_PLAIN } from "@happier-dev/protocol/testing/accountScopedCipherFixtures";

describe("Automation current transport and retained 0.2 data", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-current-automation-transport-",
            env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: "1" },
        });
    }, 120_000);

    afterAll(async () => await harness.close());

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
