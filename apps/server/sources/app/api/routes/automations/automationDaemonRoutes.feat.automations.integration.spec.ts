import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { automationRoutes } from "./automationRoutes";

function buildTemplateEnvelope(existingSessionId?: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: "ciphertext-base64",
        ...(existingSessionId ? { existingSessionId } : {}),
    });
}

describe("automation daemon routes (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-daemon-routes-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.restoreEnv();
        process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED = "1";
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("claims due runs and returns automation payload for daemon workers", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-daemon-claim" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Nightly run",
                enabled: true,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                templateVersion: 1,
            },
            select: { id: true },
        });
        await db.automationAssignment.create({
            data: {
                automationId: automation.id,
                machineId: "machine-1",
                enabled: true,
                priority: 0,
            },
        });
        await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 10_000),
                dueAt: new Date(Date.now() - 5_000),
            },
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/automations/runs/claim",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-1",
                        leaseDurationMs: 30_000,
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json() as any;
                expect(body.run).toEqual(
                    expect.objectContaining({
                        automationId: automation.id,
                        state: "claimed",
                        claimedByMachineId: "machine-1",
                    }),
                );
                expect(body.automation).toEqual(
                    expect.objectContaining({
                        id: automation.id,
                        name: "Nightly run",
                        targetType: "new_session",
                    }),
                );

                const claimed = await db.automationRun.findUnique({
                    where: { id: body.run.id },
                    select: {
                        state: true,
                        claimedByMachineId: true,
                        leaseExpiresAt: true,
                    },
                });
                expect(claimed?.state).toBe("claimed");
                expect(claimed?.claimedByMachineId).toBe("machine-1");
                expect(claimed?.leaseExpiresAt).not.toBeNull();
            },
        );
    });

    it("renews lease only for the claiming machine", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-daemon-heartbeat" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Heartbeat run",
                enabled: true,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                templateVersion: 1,
            },
            select: { id: true },
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
                claimedAt: new Date(Date.now() - 10_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() + 1_000),
                attempt: 1,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const okResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${run.id}/heartbeat`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-1",
                        leaseDurationMs: 45_000,
                    },
                });
                expect(okResponse.statusCode).toBe(200);
                const okBody = okResponse.json() as any;
                expect(okBody.ok).toBe(true);
                expect(typeof okBody.leaseExpiresAt).toBe("number");

                const deniedResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${run.id}/heartbeat`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-2",
                        leaseDurationMs: 45_000,
                    },
                });
                expect(deniedResponse.statusCode).toBe(404);
                expect(deniedResponse.json()).toEqual({ error: "automation_run_not_found_or_not_claimed" });
            },
        );
    });

    it("returns assignments scoped to the requested machine", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-daemon-assignments" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-2",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Assigned run",
                enabled: true,
                scheduleKind: "interval",
                everyMs: 120_000,
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                templateVersion: 1,
            },
            select: { id: true },
        });
        await db.automationAssignment.createMany({
            data: [
                {
                    automationId: automation.id,
                    machineId: "machine-1",
                    enabled: true,
                    priority: 2,
                },
                {
                    automationId: automation.id,
                    machineId: "machine-2",
                    enabled: true,
                    priority: 1,
                },
            ],
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: "/v2/automations/daemon/assignments?machineId=machine-1",
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json() as any;
                expect(Array.isArray(body.assignments)).toBe(true);
                expect(body.assignments).toHaveLength(1);
                expect(body.assignments[0]).toEqual(
                    expect.objectContaining({
                        machineId: "machine-1",
                        enabled: true,
                        priority: 2,
                        automation: expect.objectContaining({
                            id: automation.id,
                            name: "Assigned run",
                        }),
                    }),
                );
            },
        );
    });

    it("rejects existing_session automation creation when target session is missing or inactive", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-existing-session-create-validation" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const inactiveSession = await db.session.create({
            data: {
                tag: "inactive-target",
                accountId: account.id,
                metadata: "{}",
                active: false,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const missingResponse = await app.inject({
                    method: "POST",
                    url: "/v2/automations",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        name: "Existing missing",
                        enabled: true,
                        schedule: { kind: "interval", everyMs: 60_000 },
                        targetType: "existing_session",
                        templateCiphertext: buildTemplateEnvelope("missing-session"),
                        assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                    },
                });
                expect(missingResponse.statusCode).toBe(400);
                expect(String((missingResponse.json() as any).error ?? "")).toMatch(/existing session/i);

                const inactiveResponse = await app.inject({
                    method: "POST",
                    url: "/v2/automations",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        name: "Existing inactive",
                        enabled: true,
                        schedule: { kind: "interval", everyMs: 60_000 },
                        targetType: "existing_session",
                        templateCiphertext: buildTemplateEnvelope(inactiveSession.id),
                        assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                    },
                });
                expect(inactiveResponse.statusCode).toBe(400);
                expect(String((inactiveResponse.json() as any).error ?? "")).toMatch(/inactive/i);
            },
        );
    });
});
