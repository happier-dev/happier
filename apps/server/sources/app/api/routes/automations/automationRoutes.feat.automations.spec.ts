import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationValidationError } from "@/app/automations/automationValidation";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder as createBaseRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { PRESENT_USER_REQUIRED_ERROR } from "../../utils/requirePresentUser";

const dbMocks = createDbMocks({
    account: ["findUnique"],
} as const);
const findAccountById = dbMocks.db.account.findUnique;

function createRouteTestBuilder(options: Parameters<typeof createBaseRouteTestBuilder>[0]) {
    return createBaseRouteTestBuilder({
        ...options,
        defaultRequest: { authAuthority: "present_user", ...options.defaultRequest },
    });
}

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_plain_v1",
    payload: { prompt: "daily sweep" },
});

const listAutomations = vi.fn(async (): Promise<unknown[]> => []);
const getAutomation = vi.fn(async (): Promise<unknown | null> => null);
const createAutomation = vi.fn(async () => ({
    id: "a1",
    accountId: "u1",
    name: "Daily sweep",
    description: null,
    enabled: true,
    triggerKind: "schedule",
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
const verifyAutomationConversationTargetV1 = vi.fn(async () => ({
    kind: "notVerified" as const,
    reason: "notFound" as const,
}));
const listAutomationConversationTargetsV1 = vi.fn(async () => ({ items: [], nextCursor: null }));
const createAutomationConversationTargetV1 = vi.fn(async () => ({
    kind: "created" as const,
    automationId: "automation-1",
    templateVersion: 1,
}));
const claimAutomationRun = vi.fn(async () => ({
    run: {
        id: "run-1",
        automationId: "a1",
        accountId: "u1",
        state: "claimed",
        originKind: "scheduled",
        occurrenceKey: null,
        occurrenceEvidenceEqualityTag: null,
        originSourceSelectorId: null,
        triggerEvidenceEnvelope: null,
        executionInputEnvelope: JSON.stringify({
            kind: "happier_automation_run_execution_input_v1",
            targetType: "new_session",
            templateVersion: 1,
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            origin: { kind: "scheduled", scheduledFor: Date.parse("2026-02-12T10:00:00.000Z") },
        }),
        executionDispatchState: null,
        executionAttempt: 0,
        executionDispatchCommittedAt: null,
        executionDispatchDueAt: null,
        executionNativeRunId: null,
        executionNativeCallId: null,
        executionNativeSidechainId: null,
        resultEnvelope: null,
        replyContextEnvelope: null,
        replyHandoffActionPluginId: null,
        replyHandoffActionLocalId: null,
        replyHandoffTargetMachineId: null,
        replyHandoffTargetMachineInstallationId: null,
        replyHandoffTargetMaterializationId: null,
        replyHandoffId: null,
        replyHandoffState: "none",
        replyHandoffAttempt: 0,
        replyHandoffDueAt: null,
        replyHandoffReceiptEnvelope: null,
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
        automation: {
            id: "a1",
            name: "Daily sweep",
            enabled: true,
            triggerKind: "schedule",
            targetType: "new_session",
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
        },
    },
    accountCurrentness: {
        mode: "plain",
        version: 0,
        contentKeyFingerprint: null,
    },
}));
const verifyPublisher = vi.hoisted(() => vi.fn());

vi.mock("@/app/automations/automationCrudService", () => ({
    listAutomations,
    getAutomation,
    createAutomation,
    updateAutomation,
}));
vi.mock("@/app/automations/automationClaimService", () => ({
    claimAutomationRun,
}));
vi.mock("@/app/plugins/installations/publisherProof", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/plugins/installations/publisherProof")>();
    return { ...actual, verifyPluginInstallationPublisherHeader: verifyPublisher };
});
vi.mock("@/app/automations/automationConversationTargetVerificationService", () => ({
    AutomationConversationTargetVerificationCallerError: class extends Error {},
    createAutomationConversationTargetV1,
    listAutomationConversationTargetsV1,
    verifyAutomationConversationTargetV1,
}));
installDbModuleMock(() => ({
    db: dbMocks.db,
}));

describe("automationRoutes", () => {
    const resetAutomationsEnv = createEnvReset();

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        resetAutomationsEnv({
            HAPPIER_FEATURE_AUTOMATIONS__ENABLED: undefined,
        });
        findAccountById.mockResolvedValue({
            publicKey: null,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
        });
        verifyPublisher.mockImplementation(async ({ request }: { request: any }) => ({
            machineId: request.body?.machineId ?? request.query?.machineId,
            installationId: "installation-1",
        }));
    });

    it("refuses terminal authority before a retained V2 management mutation", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            authAuthority: "account_automation",
            body: {
                name: "Terminal must not create",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                assignments: [{ machineId: "m1" }],
            },
        });

        expect(reply.statusCode).toBe(403);
        expect(response).toBeUndefined();
        expect(reply.send).toHaveBeenCalledWith({ error: PRESENT_USER_REQUIRED_ERROR });
        expect(createAutomation).not.toHaveBeenCalled();
    });

    it("refuses a retained V2 worker claim when publisher proof names another machine", async () => {
        const { registerAutomationDaemonRoutes } = await import("./registerAutomationDaemonRoutes");
        const verifyPublisher = vi.fn(async () => ({
            machineId: "machine-other",
            installationId: "installation-other",
        }));
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations/runs/claim",
            registerRoutes(app) {
                registerAutomationDaemonRoutes(app as any, { verifyPublisher } as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            authAuthority: "account_automation",
            method: "POST",
            body: { machineId: "m1", leaseDurationMs: 30_000 },
        });

        expect(reply.statusCode).toBe(401);
        expect(response).toBeNull();
        expect(claimAutomationRun).not.toHaveBeenCalled();
    });

    it("registers CRUD, legacy daemon, V3 worker, and the E3 Event admission boundary", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const listRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const createRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const claimRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations/runs/claim",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const v3RunDetailRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v3/automations/:id/runs/:runId",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const v3AssignmentWakeRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v3/automations/worker/assignments",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const eventStatusRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v1/automations/events/source-status/report",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const eventListRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v1/automations/events/sources/list",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const eventAdmitRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v1/automations/events/admit",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const conversationTargetVerifyRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v1/automations/conversation/target/verify",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const storedDefinitionReadRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v1/automations/events/stored-definitions/read",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        expect(listRoute.handler).toBeTypeOf("function");
        expect(createRoute.handler).toBeTypeOf("function");
        expect(claimRoute.handler).toBeTypeOf("function");
        expect(v3RunDetailRoute.handler).toBeTypeOf("function");
        expect(v3AssignmentWakeRoute.handler).toBeTypeOf("function");
        expect(storedDefinitionReadRoute.handler).toBeTypeOf("function");
        expect(eventStatusRoute.handler).toBeTypeOf("function");
        expect(eventListRoute.routeExists).toBe(false);
        expect(eventAdmitRoute.handler).toBeTypeOf("function");
        expect(conversationTargetVerifyRoute.routeExists).toBe(true);
        expect(createRouteTestBuilder({
            method: "POST",
            path: "/v1/automations/conversation/targets/list",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        }).routeExists).toBe(true);
    });

    it("does not register routes when HAPPIER_FEATURE_AUTOMATIONS__ENABLED=0", async () => {
        resetAutomationsEnv({
            HAPPIER_FEATURE_AUTOMATIONS__ENABLED: "0",
        });
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const claimRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations/runs/claim",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const eventStatusRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v1/automations/events/source-status/report",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const conversationTargetVerifyRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v1/automations/conversation/target/verify",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        expect(route.handler).toBeTypeOf("function");
        expect(claimRoute.handler).toBeTypeOf("function");

        const { reply } = await route.invoke({ userId: "u1" });
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(eventStatusRoute.handler).toBeTypeOf("function");
        const { reply: eventReply } = await eventStatusRoute.invoke({ userId: "u1" });
        expect(eventReply.code).toHaveBeenCalledWith(404);
        const { reply: conversationTargetVerifyReply } = await conversationTargetVerifyRoute.invoke({
            userId: "u1",
        });
        expect(conversationTargetVerifyReply.code).toHaveBeenCalledWith(404);
    });

    it("creates an automation from POST /v2/automations", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response } = await route.invoke({
            userId: "u1",
            body: {
                name: "Daily sweep",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                assignments: [{ machineId: "m1" }],
            },
        });

        expect(createAutomation).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "u1",
            requireV2DefinitionRepresentability: true,
        }));
        expect(response).toEqual(expect.objectContaining({ id: "a1", name: "Daily sweep" }));
    });

    it("asks the canonical owner for only V2-representable definitions", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response } = await route.invoke({ userId: "u1" });

        expect(listAutomations).toHaveBeenCalledWith({
            accountId: "u1",
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        });
        expect(response).toEqual([]);
    });

    it("returns the existing 404 before mutating an Event definition through V2", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/automations/:id",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const currentStoredContentCompatibility = {
            supportsCurrentProtocol: true,
            supportsPluginDataProtocol: true,
            outcome: "accepted" as const,
            declaration: { v: 1, protocolVersion: 3 },
            upgradeRequired: null,
        };

        for (const automationId of ["event-automation"]) {
            const { response, reply } = await route.invoke({
                userId: "u1",
                params: { id: automationId },
                accountStoredContentCompatibility: currentStoredContentCompatibility,
                body: { name: "Not a V2 mutation" },
            });

            expect(response).toEqual({ error: "automation_not_found" });
            expect(reply.code).toHaveBeenCalledWith(404);
            expect(reply.code).not.toHaveBeenCalledWith(409);
        }

        expect(getAutomation).toHaveBeenNthCalledWith(1, {
            accountId: "u1",
            automationId: "event-automation",
            expectedTriggerKind: "schedule",
            requireV2DefinitionRepresentability: true,
        });
        expect(updateAutomation).not.toHaveBeenCalled();
    });

    it("returns 404 before a predecessor patch can write legacy content over an execution-run definition", async () => {
        getAutomation.mockResolvedValueOnce({
            ...await createAutomation(),
            targetType: "execution_run",
        });
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/automations/:id",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            params: { id: "execution-run-automation" },
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: false,
                supportsPluginDataProtocol: false,
                outcome: "legacy-missing",
                declaration: null,
                upgradeRequired: null,
            },
            body: { name: "Must not mutate a current target" },
        });

        expect(response).toEqual({ error: "automation_not_found" });
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(updateAutomation).not.toHaveBeenCalled();
    });

    it("admits the exact predecessor encrypted outer target only for a legacy compatibility request", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: false,
                supportsPluginDataProtocol: false,
                outcome: "legacy-missing",
                declaration: null,
                upgradeRequired: null,
            },
            body: {
                name: "Predecessor encrypted target",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "existing_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "ciphertext-base64",
                    existingSessionId: "session-legacy",
                }),
            },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(createAutomation).toHaveBeenCalledWith({
            accountId: "u1",
            requireV2DefinitionRepresentability: true,
            input: expect.objectContaining({
                legacyTemplateEnvelopeAdmission: {
                    kind: "legacy-encrypted-existing-session-v1",
                    existingSessionId: "session-legacy",
                },
            }),
        });
        expect(response).toEqual(expect.objectContaining({ id: "a1" }));
    });

    it("rejects the predecessor encrypted outer target from a current compatibility request", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { reply } = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                supportsPluginDataProtocol: true,
                outcome: "accepted",
                declaration: {
                    v: 1,
                    protocolVersion: 3,
                },
                upgradeRequired: null,
            },
            body: {
                name: "Current caller cannot send predecessor envelope",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "existing_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "ciphertext-base64",
                    existingSessionId: "session-legacy",
                }),
            },
        });

        expect(createAutomation).not.toHaveBeenCalled();
        expect(reply.code).toHaveBeenCalledWith(400);
    });

    it("admits the exact predecessor plain outer target only for a legacy compatibility request", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });
        const predecessorPlainTarget = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: {
                prompt: "resume predecessor session",
                existingSessionId: "session-legacy-plain",
                sessionEncryptionMode: "plain",
            },
            existingSessionId: "session-legacy-plain",
        });

        const legacy = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: false,
                supportsPluginDataProtocol: false,
                outcome: "legacy-missing",
                declaration: null,
                upgradeRequired: null,
            },
            body: {
                name: "Predecessor plain target",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "existing_session",
                templateCiphertext: predecessorPlainTarget,
            },
        });

        expect(legacy.reply.code).not.toHaveBeenCalledWith(400);
        expect(createAutomation).toHaveBeenCalledWith({
            accountId: "u1",
            requireV2DefinitionRepresentability: true,
            input: expect.objectContaining({
                legacyTemplateEnvelopeAdmission: {
                    kind: "legacy-plain-existing-session-v1",
                    existingSessionId: "session-legacy-plain",
                },
            }),
        });

        vi.clearAllMocks();
        findAccountById.mockResolvedValue({
            publicKey: null,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
        });

        const current = await route.invoke({
            userId: "u1",
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                supportsPluginDataProtocol: true,
                outcome: "accepted",
                declaration: { v: 1, protocolVersion: 3 },
                upgradeRequired: null,
            },
            body: {
                name: "Current caller cannot send predecessor plain envelope",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "existing_session",
                templateCiphertext: predecessorPlainTarget,
            },
        });

        expect(createAutomation).not.toHaveBeenCalled();
        expect(current.reply.code).toHaveBeenCalledWith(400);
    });

    it("returns 400 for invalid automation payloads", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                name: "",
                enabled: true,
            },
        });

        expect(createAutomation).not.toHaveBeenCalled();
        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });

    it("returns 500 when automation creation fails for non-validation errors", async () => {
        createAutomation.mockRejectedValueOnce(new Error("database unavailable"));
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            body: {
                name: "Daily sweep",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                assignments: [{ machineId: "m1" }],
            },
        });

        expect(createAutomation).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "u1",
            requireV2DefinitionRepresentability: true,
        }));
        expect(reply.code).toHaveBeenCalledWith(500);
        expect(response).toEqual({ error: "automation_create_failed" });
    });

    it("claims due runs for daemon callers", async () => {
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations/runs/claim",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response } = await route.invoke({
            userId: "u1",
            body: { machineId: "m1", leaseDurationMs: 30_000 },
        });

        expect(claimAutomationRun).toHaveBeenCalledWith(
            expect.objectContaining({
                accountId: "u1",
                machineId: "m1",
                leaseDurationMs: 30_000,
                expectedTriggerKind: "schedule",
                requireV2RunRepresentability: true,
            }),
        );
        expect(response).toEqual(expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }));
    });

    it("returns 400 for assignment payloads that fail validation in the service layer", async () => {
        updateAutomation.mockRejectedValueOnce(new AutomationValidationError("Unknown machine assignments: m-missing"));
        const { automationRoutes } = await import("./automationRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/automations/:id/assignments",
            registerRoutes(app) {
                automationRoutes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "u1",
            params: { id: "a1" },
            body: {
                assignments: [{ machineId: "m-missing", enabled: true, priority: 0 }],
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual({ error: "Unknown machine assignments: m-missing" });
    });
});
