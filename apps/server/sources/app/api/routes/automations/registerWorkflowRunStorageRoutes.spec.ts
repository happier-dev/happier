import { describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { getRouteEntry } from "../../testkit/routeHarness";
import { registerWorkflowRunStorageRoutes } from "./registerWorkflowRunStorageRoutes";

// These refusal cases need the persisted custodian only. The composed Setup
// spec exercises the same route with real storage and publisher signatures.
vi.mock("@/storage/db", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/storage/db")>();
    const { createDbMocks } = await import("../../testkit/dbMocks");
    const { db } = createDbMocks({ machine: ["findUnique"] });
    db.machine.findUnique.mockResolvedValue({ accountId: "account-1" });
    return { ...actual, db };
});

describe("registerWorkflowRunStorageRoutes", () => {
    it("rejects a workflow persistence request without an exact machine publisher proof", async () => {
        const verifyPublisher = vi.fn(async () => null);
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/workflow-storage",
            defaultRequest: { userId: "account-1" },
            registerRoutes(app) {
                registerWorkflowRunStorageRoutes(app as never, { verifyPublisher });
            },
        });

        const { reply } = await route.invoke({
            body: { operation: "recovery.list", publisherMachineId: "machine-1", pageByteLimit: 4096 },
        });

        expect(verifyPublisher).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            path: "/v3/automations/runs/workflow-storage",
            required: true,
        }));
        expect(reply.statusCode).toBe(401);
    });

    it.each(["api_token", "account_directory", "ephemeral_session_runner", undefined, "unknown"])("denies Account storage to restricted or missing credential provenance %s", async (authTokenKind) => {
        const verifyPublisher = vi.fn(async () => null);
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/workflow-storage",
            defaultRequest: { userId: "account-1", authTokenKind },
            registerRoutes(app) {
                // This case tests absent stamped provenance; the default auth fixture supplies Account provenance.
                app.authenticate.mockImplementation(() => undefined);
                registerWorkflowRunStorageRoutes(app as never, { verifyPublisher });
            },
        });
        const { reply } = await route.invoke({ body: { operation: "get", runId: "run-1" } });
        expect(reply.statusCode).toBe(401);
        expect(verifyPublisher).not.toHaveBeenCalled();
        const spoofedPublisher = await route.invoke({ body: { operation: "get", runId: "run-1", publisherMachineId: "machine-1" } });
        expect(spoofedPublisher.reply.statusCode).toBe(401);
        expect(verifyPublisher).not.toHaveBeenCalled();
    });

    it("requires exact publisher proof for a verified external Action Account read", async () => {
        const verifyPublisher = vi.fn(async () => null);
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/workflow-storage",
            defaultRequest: { userId: "account-1", authTokenKind: "api_token", externalActionExecutionAuthorized: true },
            registerRoutes(app) { registerWorkflowRunStorageRoutes(app as never, { verifyPublisher }); },
        });
        const ordinary = await route.invoke({ body: { operation: "get", runId: "run-1" } });
        expect(ordinary.reply.statusCode).toBe(401);
        expect(verifyPublisher).not.toHaveBeenCalled();
        const publisherBacked = await route.invoke({ body: { operation: "get", runId: "run-1", publisherMachineId: "machine-1" } });
        expect(publisherBacked.reply.statusCode).toBe(401);
        expect(verifyPublisher).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-1", required: true }));
    });

    it("accepts strict Account read and control shapes without a Machine while retaining worker shapes", () => {
        const route = createRouteTestBuilder({
            method: "POST", path: "/v3/automations/runs/workflow-storage",
            registerRoutes(app) { registerWorkflowRunStorageRoutes(app as never); },
        });
        const schema = (getRouteEntry(route.app, "POST", "/v3/automations/runs/workflow-storage").opts.schema as { body: { safeParse(value: unknown): { success: boolean } } }).body;
        const operations = [
            { operation: "get", runId: "run-1" },
            { operation: "wait", runId: "run-1" },
            { operation: "wait", runId: "run-1", conditions: ["terminal", "attention"], timeoutSeconds: 0 },
            { operation: "list", request: {}, pageByteLimit: 4096 },
            { operation: "invocations.list", runId: "run-1", pageByteLimit: 4096 },
            { operation: "invocations.get", runId: "run-1", invocationId: "row-1" },
            { operation: "invocations.current", runId: "run-1", parentRecordId: "root", memberOrdinal: "0" },
            ...["pause", "resume", "cancel", "delete"].map((operation) => ({ operation, runId: "run-1", expectedRevision: 0 })),
        ];
        for (const operation of operations) {
            expect(schema.safeParse(operation).success).toBe(true);
            expect(schema.safeParse({ ...operation, publisherMachineId: "machine-1" }).success).toBe(true);
            expect(schema.safeParse({ ...operation, authorized: true }).success).toBe(false);
        }
        for (const conditions of [[], ["terminal", "terminal"], ["needs_attention"]]) {
            expect(schema.safeParse({ operation: "wait", runId: "run-1", conditions }).success).toBe(false);
        }
        // Only the host owns the authored deadline; the storage read accepts
        // its deadline-expired marker, never a server-side waiting budget.
        expect(schema.safeParse({ operation: "wait", runId: "run-1", timeoutSeconds: 1 }).success).toBe(false);
        expect(schema.safeParse({ operation: "recovery.list", pageByteLimit: 4096 }).success).toBe(false);
    });

    it("admits only direct Workflow origins at the internal storage boundary", () => {
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/workflow-storage",
            registerRoutes(app) {
                registerWorkflowRunStorageRoutes(app as never);
            },
        });
        const bodySchema = getRouteEntry(
            route.app,
            "POST",
            "/v3/automations/runs/workflow-storage",
        ).opts.schema as { body: { safeParse(value: unknown): { success: boolean } } };
        const common = {
            operation: "admit",
            publisherMachineId: "machine-1",
            runId: "7be4d65c-d3b7-4868-a416-b18d9ee29c1c",
            machineId: "machine-1",
            accountCurrentness: { mode: "plain", version: 1, contentKeyFingerprint: null },
            acceptedEnvelope: "sealed",
        };

        expect(bodySchema.body.safeParse({
            ...common,
            origin: { kind: "direct" },
        }).success).toBe(true);
        expect(bodySchema.body.safeParse({
            ...common,
            origin: { kind: "automation", automationId: "automation-1" },
        }).success).toBe(false);
    });

    it("accepts only an exact nonnegative direct-member slot lookup", () => {
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/workflow-storage",
            registerRoutes(app) {
                registerWorkflowRunStorageRoutes(app as never);
            },
        });
        const bodySchema = getRouteEntry(
            route.app,
            "POST",
            "/v3/automations/runs/workflow-storage",
        ).opts.schema as { body: { safeParse(value: unknown): { success: boolean } } };
        const exact = {
            operation: "invocations.current",
            publisherMachineId: "machine-1",
            runId: "run-1",
            parentRecordId: "parent-1",
            memberOrdinal: "499",
        };

        expect(bodySchema.body.safeParse(exact).success).toBe(true);
        expect(bodySchema.body.safeParse({ ...exact, memberOrdinal: "-1" }).success).toBe(false);
        expect(bodySchema.body.safeParse({ ...exact, cursor: "page-scan" }).success).toBe(false);
        expect(bodySchema.body.safeParse({ operation: "invocations.list", runId: "run-1", parentRecordId: null,
            memberOrdinal: "0", progressEnvelopes: true, pageByteLimit: 4096 }).success).toBe(true);
    });

    it("admits the internal progress-envelope sidecar request only as a literal opt-in", () => {
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/workflow-storage",
            registerRoutes(app) {
                registerWorkflowRunStorageRoutes(app as never);
            },
        });
        const bodySchema = getRouteEntry(
            route.app,
            "POST",
            "/v3/automations/runs/workflow-storage",
        ).opts.schema as { body: { safeParse(value: unknown): { success: boolean } } };
        const history = { operation: "invocations.list", publisherMachineId: "machine-1", runId: "run-1", pageByteLimit: 4096 };

        expect(bodySchema.body.safeParse(history).success).toBe(true);
        expect(bodySchema.body.safeParse({ ...history, progressEnvelopes: true }).success).toBe(true);
        expect(bodySchema.body.safeParse({ ...history, progressEnvelopes: false }).success).toBe(false);
    });

    it("rejects direct admission when the authenticated publisher is not the target Machine", async () => {
        const verifyPublisher = vi.fn(async () => ({
            machineId: "publisher-machine",
            installationId: "installation-1",
            requestNonce: "nonce-1",
            proofExpiresAt: new Date("2026-09-19T12:00:00.000Z"),
        }));
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/workflow-storage",
            defaultRequest: { userId: "account-1" },
            registerRoutes(app) {
                registerWorkflowRunStorageRoutes(app as never, { verifyPublisher });
            },
        });

        const { reply, response } = await route.invoke({
            body: {
                operation: "admit",
                publisherMachineId: "publisher-machine",
                runId: "7be4d65c-d3b7-4868-a416-b18d9ee29c1c",
                origin: { kind: "direct" },
                machineId: "target-machine",
                accountCurrentness: { mode: "plain", version: 1, contentKeyFingerprint: null },
                acceptedEnvelope: "sealed",
            },
        });

        expect(reply.statusCode).toBe(422);
        expect(response).toEqual({ error: "target_unavailable" });
    });
});
