import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationValidationError } from "@/app/automations/automationValidation";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

const listAutomations = vi.fn(async () => []);
const createAutomation = vi.fn(async () => ({
    id: "a1",
    accountId: "u1",
    name: "Daily sweep",
    description: null,
    enabled: true,
    scheduleKind: "interval",
    scheduleExpr: null,
    everyMs: 60_000,
    timezone: null,
    targetType: "new_session",
    templateCiphertext: TEST_TEMPLATE_ENVELOPE,
    templateVersion: 1,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: new Date("2026-02-12T10:00:00.000Z"),
    updatedAt: new Date("2026-02-12T10:00:00.000Z"),
    assignments: [{ machineId: "m1", enabled: true, priority: 0 }],
}));
const updateAutomation = vi.fn(async () => null);
const claimAutomationRun = vi.fn(async () => ({
    run: {
        id: "run-1",
        automationId: "a1",
        accountId: "u1",
        state: "claimed",
        scheduledAt: new Date("2026-02-12T10:00:00.000Z"),
        dueAt: new Date("2026-02-12T10:00:00.000Z"),
        claimedAt: new Date("2026-02-12T10:00:00.000Z"),
        startedAt: null,
        finishedAt: null,
        claimedByMachineId: "m1",
        leaseExpiresAt: new Date("2026-02-12T10:00:30.000Z"),
        attempt: 1,
        summaryCiphertext: null,
        errorCode: null,
        errorMessage: null,
        producedSessionId: null,
        createdAt: new Date("2026-02-12T10:00:00.000Z"),
        updatedAt: new Date("2026-02-12T10:00:00.000Z"),
    },
}));

vi.mock("@/app/automations/automationCrudService", () => ({
    listAutomations,
    createAutomation,
    updateAutomation,
}));
vi.mock("@/app/automations/automationClaimService", () => ({
    claimAutomationRun,
}));

describe("automationRoutes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED;
    });

    it("registers CRUD and daemon claim endpoints", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const app = createFakeRouteApp();
        automationRoutes(app as any);

        expect(() => getRouteHandler(app, "GET", "/v2/automations")).not.toThrow();
        expect(() => getRouteHandler(app, "POST", "/v2/automations")).not.toThrow();
        expect(() => getRouteHandler(app, "POST", "/v2/automations/runs/claim")).not.toThrow();
    });

    it("does not register routes when HAPPIER_FEATURE_AUTOMATIONS__ENABLED=0", async () => {
        process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED = "0";
        const { automationRoutes } = await import("./automationRoutes");
        const app = createFakeRouteApp();
        automationRoutes(app as any);

        expect(() => getRouteHandler(app, "GET", "/v2/automations")).toThrow();
        expect(() => getRouteHandler(app, "POST", "/v2/automations/runs/claim")).toThrow();
    });

    it("creates an automation from POST /v2/automations", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const app = createFakeRouteApp();
        automationRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v2/automations");
        const reply = createReplyStub();

        const response = await handler(
            {
                userId: "u1",
                body: {
                    name: "Daily sweep",
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000 },
                    targetType: "new_session",
                    templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                    assignments: [{ machineId: "m1" }],
                },
            },
            reply,
        );

        expect(createAutomation).toHaveBeenCalledWith(expect.objectContaining({ accountId: "u1" }));
        expect(response).toEqual(expect.objectContaining({ id: "a1", name: "Daily sweep" }));
    });

    it("returns 400 for invalid automation payloads", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const app = createFakeRouteApp();
        automationRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v2/automations");
        const reply = createReplyStub();

        const response = await handler(
            {
                userId: "u1",
                body: {
                    name: "",
                    enabled: true,
                },
            },
            reply,
        );

        expect(createAutomation).not.toHaveBeenCalled();
        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });

    it("returns 500 when automation creation fails for non-validation errors", async () => {
        createAutomation.mockRejectedValueOnce(new Error("database unavailable"));
        const { automationRoutes } = await import("./automationRoutes");
        const app = createFakeRouteApp();
        automationRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v2/automations");
        const reply = createReplyStub();

        const response = await handler(
            {
                userId: "u1",
                body: {
                    name: "Daily sweep",
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000 },
                    targetType: "new_session",
                    templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                    assignments: [{ machineId: "m1" }],
                },
            },
            reply,
        );

        expect(createAutomation).toHaveBeenCalledWith(expect.objectContaining({ accountId: "u1" }));
        expect(reply.code).toHaveBeenCalledWith(500);
        expect(response).toEqual({ error: "automation_create_failed" });
    });

    it("claims due runs for daemon callers", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const app = createFakeRouteApp();
        automationRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v2/automations/runs/claim");
        const reply = createReplyStub();

        const response = await handler(
            {
                userId: "u1",
                body: { machineId: "m1", leaseDurationMs: 30_000 },
            },
            reply,
        );

        expect(claimAutomationRun).toHaveBeenCalledWith(
            expect.objectContaining({ accountId: "u1", machineId: "m1", leaseDurationMs: 30_000 }),
        );
        expect(response).toEqual(expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }));
    });

    it("returns 400 for assignment payloads that fail validation in the service layer", async () => {
        updateAutomation.mockRejectedValueOnce(new AutomationValidationError("Unknown machine assignments: m-missing"));
        const { automationRoutes } = await import("./automationRoutes");
        const app = createFakeRouteApp();
        automationRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v2/automations/:id/assignments");
        const reply = createReplyStub();

        const response = await handler(
            {
                userId: "u1",
                params: { id: "a1" },
                body: {
                    assignments: [{ machineId: "m-missing", enabled: true, priority: 0 }],
                },
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "Unknown machine assignments: m-missing" });
    });
});
