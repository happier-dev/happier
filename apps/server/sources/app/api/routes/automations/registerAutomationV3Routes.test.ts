import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    AutomationSourceSelectorIdV1Schema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationV3Settings,
} from "@happier-dev/protocol";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder as createBaseRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { AutomationStoredContentReadError } from "@/app/automations/automationStoredContentRead";
import type { ClearAutomationRunHistoryResult } from "@/app/automations/automationCrudService";
import { PRESENT_USER_REQUIRED_ERROR } from "../../utils/requirePresentUser";

const dbMocks = createDbMocks({ account: ["findUnique"] } as const);
const findAccountById = dbMocks.db.account.findUnique;

function createRouteTestBuilder(options: Parameters<typeof createBaseRouteTestBuilder>[0]) {
    return createBaseRouteTestBuilder({
        ...options,
        defaultRequest: { authAuthority: "present_user", ...options.defaultRequest },
    });
}

const templateCiphertext = JSON.stringify({
    kind: "happier_automation_template_plain_v1",
    payload: { prompt: "daily sweep" },
});
const accountCurrentness = {
    mode: "plain",
    version: 7,
    contentKeyFingerprint: null,
} as const;

const scheduleExecutionRecipe = {
    v: 1,
    templateVersion: 1,
    template: {
        t: "plain" as const,
        v: { v: 1, prompt: "daily sweep" },
    },
    triggerEvidence: null,
    target: {
        kind: "newSession" as const,
        spawn: {
            executionTarget: { serverId: "server-1", machineId: "machine-1" },
            directory: "/tmp/daily-sweep",
            agentTarget: {
                kind: "agent" as const,
                identity: { pluginId: "happier.agent.codex", localId: "codex" },
            },
        },
    },
};

const scheduleAutomation = {
    id: "automation-1",
    accountId: "account-1",
    name: "Daily sweep",
    description: null,
    enabled: true,
    triggerKind: "schedule",
    scheduleKind: "interval",
    scheduleExpr: null,
    everyMs: 60_000,
    timezone: null,
    targetType: "new_session",
    templateCiphertext,
    templateVersion: 1,
    triggerEventPluginId: null,
    triggerEventLocalId: null,
    triggerSourceSelectorId: null,
    triggerSourceContractVersion: null,
    triggerObservationTransport: null,
    triggerWebhookEndpointId: null,
    triggerObservationStartsAt: null,
    watcherMachineId: null,
    watcherMachineInstallationId: null,
    watcherPluginId: null,
    watcherMaterializationId: null,
    triggerDefinitionEnvelope: null,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: new Date("2026-02-12T10:00:00.000Z"),
    updatedAt: new Date("2026-02-12T10:00:00.000Z"),
    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
};

const eventAutomation = {
    ...scheduleAutomation,
    id: "automation-event-1",
    name: "Repository updates",
    triggerKind: "pluginEvent",
    scheduleKind: null,
    everyMs: null,
    triggerEventPluginId: "happier.scm.github",
    triggerEventLocalId: "repository-event-v1",
    triggerSourceSelectorId: "9d5af559-2c82-4c22-b6a0-ecabce38a631",
    triggerSourceContractVersion: 1,
    triggerObservationTransport: "checkpointedPull",
    watcherMachineId: "machine-1",
    watcherMachineInstallationId: "installation-1",
    watcherPluginId: "happier.scm.github",
    watcherMaterializationId: "materialization-1",
    triggerDefinitionEnvelope: JSON.stringify(
        sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding: {
                v: 1,
                automationId: "automation-event-1",
                templateVersion: 1,
                triggerKind: "pluginEvent",
                eventRef: {
                    pluginId: "happier.scm.github",
                    localId: "repository-event-v1",
                },
                sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
                    "9d5af559-2c82-4c22-b6a0-ecabce38a631",
                ),
            },
            definition: {
                v: 1,
                sourceInstanceId: "github:repository:1234",
                sourceConfig: { repository: "happier-dev/happier" },
                displayLabel: "happier-dev/happier",
                filter: null,
                maximumObservationAgeMs: 60_000,
            },
        }),
    ),
};

const eventTrigger = {
    kind: "pluginEvent" as const,
    eventRef: { pluginId: "happier.scm.github", localId: "repository-event-v1" },
    sourceInstanceId: "github:repository:1234",
    sourceContractVersion: 1,
    sourceConfig: { credentialRef: "github:account:1", repository: "happier-dev/happier" },
    displayLabel: "happier-dev/happier",
    observationTransport: {
        kind: "checkpointedPull" as const,
        watcherMaterializationRef: {
            machineId: "machine-1",
            materializationId: "materialization-1",
            pluginId: "happier.scm.github",
        },
    },
    filter: null,
    maximumObservationAgeMs: 60_000,
};

const createAutomation = vi.fn(async () => scheduleAutomation);
const clearAutomationRunHistory = vi.fn(async (): Promise<ClearAutomationRunHistoryResult> => ({
    status: "cleared" as const,
    clearedRuns: 2,
}));
const deleteAutomation = vi.fn(async () => true);
const getAutomation = vi.fn(async () => scheduleAutomation);
const getAutomationRun = vi.fn(async () => null);
const listAutomationRuns = vi.fn(async () => ({ runs: [], nextCursor: null }));
const listAutomations = vi.fn(async () => [scheduleAutomation]);
const runAutomationNow = vi.fn(async () => null);
const setAutomationEnabled = vi.fn(async () => scheduleAutomation);
const updateAutomation = vi.fn(async () => scheduleAutomation);
const listDaemonAssignments = vi.fn(async () => []);
const automationSettings: AutomationV3Settings = {
    maxActiveRunsPerMachine: 4,
    runRetention: "thirtyDays",
};
const getAutomationSettings = vi.fn(async (): Promise<AutomationV3Settings | null> => automationSettings);
const updateAutomationSettings = vi.fn(async (): Promise<AutomationV3Settings | null> => automationSettings);
const loadAutomationEventStatusProjections = vi.fn(async () => new Map());
// The route observes the real service contract; this mocked system boundary
// only needs to carry the fixture supplied by each test.
const claimAutomationRun = vi.fn(async (): Promise<{
    run: unknown | null;
    accountCurrentness: typeof accountCurrentness | null;
}> => ({ run: null, accountCurrentness: null }));
const heartbeatAutomationRun = vi.fn(async () => ({ ok: true, leaseExpiresAt: null }));
const startAutomationRun = vi.fn(async () => null);
const succeedAutomationRun = vi.fn(async () => null);
const failAutomationRun = vi.fn(async () => null);
const settleAutomationExecutionDispatch = vi.fn(async () => null);
const cancelAutomationRun = vi.fn(async () => null);
const verifyPublisherDefault = vi.hoisted(() => vi.fn());
class AutomationTemplateMutationConflictError extends Error {}
class AutomationDisabledError extends Error {}

vi.mock("@/app/automations/automationCrudService", () => ({
    createAutomation,
    clearAutomationRunHistory,
    deleteAutomation,
    getAutomation,
    getAutomationRun,
    listAutomationRuns,
    listAutomations,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
    AutomationTemplateMutationConflictError,
    AutomationDisabledError,
}));
vi.mock("@/app/automations/automationAssignmentService", () => ({ listDaemonAssignments }));
vi.mock("@/app/automations/automationSettingsService", () => ({
    getAutomationSettings,
    updateAutomationSettings,
}));
vi.mock("@/app/automations/automationEventStatusProjection", () => ({
    loadAutomationEventStatusProjections,
}));
vi.mock("@/app/automations/automationClaimService", () => ({
    claimAutomationRun,
    heartbeatAutomationRun,
}));
vi.mock("@/app/automations/automationRunService", () => ({
    cancelAutomationRun,
    failAutomationRun,
    settleAutomationExecutionDispatch,
    startAutomationRun,
    succeedAutomationRun,
}));
vi.mock("@/app/plugins/installations/publisherProof", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/plugins/installations/publisherProof")>();
    return { ...actual, verifyPluginInstallationPublisherHeader: verifyPublisherDefault };
});
installDbModuleMock(() => ({ db: dbMocks.db }));

describe("registerAutomationV3Routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        findAccountById.mockResolvedValue({
            seq: 7,
            publicKey: null,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
        });
        verifyPublisherDefault.mockImplementation(async ({ request }: { request: any }) => ({
            machineId: request.body?.machineId ?? request.query?.machineId,
            installationId: "installation-1",
        }));
    });

    it("refuses terminal authority before a V3 management mutation", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "account-1",
            authAuthority: "account_automation",
            body: {
                name: "Terminal must not create",
                enabled: true,
                trigger: { kind: "manual" },
                executionRecipe: scheduleExecutionRecipe,
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });

        expect(reply.statusCode).toBe(403);
        expect(response).toBeUndefined();
        expect(reply.send).toHaveBeenCalledWith({ error: PRESENT_USER_REQUIRED_ERROR });
        expect(createAutomation).not.toHaveBeenCalled();
    });

    it("reads and replaces the Account-owned settings through the V3 worker wake contract", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const getSettingsRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v3/automations/settings",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const putSettingsRoute = createRouteTestBuilder({
            method: "PUT",
            path: "/v3/automations/settings",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const assignmentsRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v3/automations/worker/assignments",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        expect(getSettingsRoute.routeExists).toBe(true);
        expect(putSettingsRoute.routeExists).toBe(true);

        await expect(getSettingsRoute.invoke({ userId: "account-1" }))
            .resolves.toMatchObject({ response: automationSettings });
        expect(getAutomationSettings).toHaveBeenCalledWith({ accountId: "account-1" });

        const replacement = { maxActiveRunsPerMachine: 2, runRetention: "keepForever" as const };
        updateAutomationSettings.mockResolvedValueOnce(replacement);
        await expect(putSettingsRoute.invoke({
            userId: "account-1",
            body: replacement,
        })).resolves.toMatchObject({ response: replacement });
        expect(updateAutomationSettings).toHaveBeenCalledWith({
            accountId: "account-1",
            settings: replacement,
        });

        await expect(assignmentsRoute.invoke({
            userId: "account-1",
            query: { machineId: "machine-1" },
        })).resolves.toMatchObject({
            response: {
                assignments: [],
                settings: { maxActiveRunsPerMachine: automationSettings.maxActiveRunsPerMachine },
            },
        });
    });

    it("clears one Automation's terminal history through the retained-history owner", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/:id/runs/clear-history",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        expect(route.routeExists).toBe(true);
        await expect(route.invoke({
            userId: "account-1",
            params: { id: "automation-1" },
        })).resolves.toMatchObject({ response: { clearedRuns: 2 } });
        expect(clearAutomationRunHistory).toHaveBeenCalledWith({
            accountId: "account-1",
            automationId: "automation-1",
        });

        clearAutomationRunHistory.mockResolvedValueOnce({ status: "not_found" });
        const missing = await route.invoke({
            userId: "account-1",
            params: { id: "missing-automation" },
        });
        expect(missing.reply.statusCode).toBe(404);
        expect(missing.response).toEqual({ error: "automation_not_found" });
    });

    it("refuses a V3 worker claim when publisher proof names another machine", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const verifyPublisher = vi.fn(async () => ({
            machineId: "machine-other",
            installationId: "installation-other",
        }));
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/claim",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any, { verifyPublisher } as any);
            },
        });

        const { response, reply } = await route.invoke({
            userId: "account-1",
            authAuthority: "account_automation",
            method: "POST",
            body: { machineId: "machine-1", leaseDurationMs: 30_000 },
        });

        expect(reply.statusCode).toBe(401);
        expect(response).toBeNull();
        expect(claimAutomationRun).not.toHaveBeenCalled();
    });

    it("maps strict Event create and optimistic patch through the incumbent V3 routes", async () => {
        createAutomation.mockResolvedValueOnce(eventAutomation as any);
        updateAutomation.mockResolvedValueOnce(eventAutomation as any);
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const createRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const patchRoute = createRouteTestBuilder({
            method: "PATCH",
            path: "/v3/automations/:id",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const body = {
            name: "Repository updates",
            description: null,
            enabled: true,
            trigger: eventTrigger,
            executionRecipe: scheduleExecutionRecipe,
            assignments: [{ machineId: "machine-1" }],
        };

        await createRoute.invoke({ userId: "account-1", body });
        expect(createAutomation).toHaveBeenCalledWith({
            accountId: "account-1",
            input: expect.objectContaining({
                pluginEvent: eventTrigger,
                executionRecipe: scheduleExecutionRecipe,
            }),
        });

        await patchRoute.invoke({
            userId: "account-1",
            params: { id: "automation-event-1" },
            body: { ...body, expectedTemplateVersion: 1 },
        });
        expect(updateAutomation).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            automationId: "automation-event-1",
            expectedTriggerKind: "pluginEvent",
            expectedTemplateVersion: 1,
            input: expect.objectContaining({ pluginEvent: eventTrigger }),
        }));
    });

    it("uses the one Event status projection reader for list and exact detail responses", async () => {
        const sourceCatalogStatus = {
            observedRevision: "9",
            adoptedRevision: "7",
            state: "reconciliationLate" as const,
            scanStartedAt: 1_786_257_600_000,
            nextRetryAt: 1_786_257_660_000,
        };
        const projection = {
            sourceStatus: null,
            sourceCatalogStatus,
        };
        listAutomations.mockResolvedValueOnce([eventAutomation] as any);
        getAutomation.mockResolvedValueOnce(eventAutomation as any);
        loadAutomationEventStatusProjections
            .mockResolvedValueOnce(new Map([[eventAutomation.id, projection]]))
            .mockResolvedValueOnce(new Map([[eventAutomation.id, projection]]));
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const listRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v3/automations",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const detailRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v3/automations/:id",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });

        const { response: listResponse } = await listRoute.invoke({ userId: "account-1" });
        const { response: detailResponse } = await detailRoute.invoke({
            userId: "account-1",
            params: { id: eventAutomation.id },
        });

        expect(listResponse).toEqual({
            automations: [expect.objectContaining({ sourceCatalogStatus })],
        });
        expect(detailResponse).toEqual(expect.objectContaining({ sourceCatalogStatus }));
        expect(loadAutomationEventStatusProjections).toHaveBeenNthCalledWith(1, {
            automations: [eventAutomation],
        });
        expect(loadAutomationEventStatusProjections).toHaveBeenNthCalledWith(2, {
            automations: [eventAutomation],
        });
    });

    it("fails Event authoring closed for E2EE before invoking the CRUD writer", async () => {
        findAccountById.mockResolvedValueOnce({
            seq: 8,
            encryptionMode: "e2ee",
            ...createSignedAccountContentBinding(),
        });
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const createRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const { response, reply } = await createRoute.invoke({
            userId: "account-1",
            body: {
                name: "Repository updates",
                enabled: true,
                trigger: eventTrigger,
                executionRecipe: scheduleExecutionRecipe,
            },
        });
        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({ error: "automation_stored_content_unavailable" });
        expect(createAutomation).not.toHaveBeenCalled();
    });

    it("maps writer-side stored-content unavailability to the same Event authoring 409", async () => {
        createAutomation.mockRejectedValueOnce(new AutomationStoredContentReadError("modeMismatch"));
        updateAutomation.mockRejectedValueOnce(new AutomationStoredContentReadError("modeMismatch"));
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const createRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const patchRoute = createRouteTestBuilder({
            method: "PATCH",
            path: "/v3/automations/:id",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const body = {
            name: "Repository updates",
            enabled: true,
            trigger: eventTrigger,
            executionRecipe: scheduleExecutionRecipe,
        };

        const createResult = await createRoute.invoke({
            userId: "account-1",
            body,
        });
        expect(createResult.reply.statusCode).toBe(409);
        expect(createResult.response).toEqual({ error: "automation_stored_content_unavailable" });

        const patchResult = await patchRoute.invoke({
            userId: "account-1",
            params: { id: "automation-event-1" },
            body: { ...body, expectedTemplateVersion: 1 },
        });
        expect(patchResult.reply.statusCode).toBe(409);
        expect(patchResult.response).toEqual({ error: "automation_stored_content_unavailable" });
    });

    it("maps a stale Event patch to the stable optimistic-conflict response", async () => {
        updateAutomation.mockRejectedValueOnce(
            new AutomationTemplateMutationConflictError("stale template version"),
        );
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const patchRoute = createRouteTestBuilder({
            method: "PATCH",
            path: "/v3/automations/:id",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const { response, reply } = await patchRoute.invoke({
            userId: "account-1",
            params: { id: "automation-event-1" },
            body: {
                name: "Repository updates",
                enabled: true,
                trigger: eventTrigger,
                executionRecipe: scheduleExecutionRecipe,
                expectedTemplateVersion: 1,
            },
        });

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({ error: "automation_template_version_conflict" });
    });

    it("keeps schedule-shaped V3 patches on the schedule trigger owner", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const patchRoute = createRouteTestBuilder({
            method: "PATCH",
            path: "/v3/automations/:id",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });

        await patchRoute.invoke({
            userId: "account-1",
            params: { id: "automation-1" },
            body: { name: "Renamed schedule" },
        });

        expect(updateAutomation).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            automationId: "automation-1",
            expectedTriggerKind: "schedule",
        }));
    });

    it("maps manual definitions and keyed run-now requests through the existing V3 owners", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const createRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const runNowRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/:id/run-now",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });

        await createRoute.invoke({
            userId: "account-1",
            body: {
                name: "On demand",
                enabled: true,
                trigger: { kind: "manual" },
                executionRecipe: scheduleExecutionRecipe,
            },
        });
        expect(createAutomation).toHaveBeenCalledWith({
            accountId: "account-1",
            input: expect.objectContaining({
                manual: true,
                executionRecipe: scheduleExecutionRecipe,
            }),
        });

        await runNowRoute.invoke({
            userId: "account-1",
            params: { id: "automation-1" },
            headers: { "idempotency-key": "ci-build-42" },
        });
        expect(runAutomationNow).toHaveBeenCalledWith({
            accountId: "account-1",
            automationId: "automation-1",
            idempotencyKey: "ci-build-42",
        });
    });

    it("adapts current V3 strict recipe writes and run lifecycle calls to the one Automation owner", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const createRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const claimRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/claim",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const succeedRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/:runId/succeed",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const startRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/:runId/start",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const settleExecutionDispatchRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/:runId/execution-dispatch/settle",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const failRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/:runId/fail",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const workerAssignmentsRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v3/automations/worker/assignments",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });
        const legacyDaemonAssignmentsRoute = createRouteTestBuilder({
            method: "GET",
            path: "/v3/automations/daemon/assignments",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        expect(createRoute.handler).toBeTypeOf("function");
        expect(claimRoute.handler).toBeTypeOf("function");
        expect(startRoute.handler).toBeTypeOf("function");
        expect(settleExecutionDispatchRoute.handler).toBeTypeOf("function");
        expect(succeedRoute.handler).toBeTypeOf("function");
        expect(workerAssignmentsRoute.routeExists).toBe(true);
        expect(legacyDaemonAssignmentsRoute.routeExists).toBe(false);

        const { response: createResponse } = await createRoute.invoke({
            userId: "account-1",
            body: {
                name: "Daily sweep",
                enabled: true,
                trigger: {
                    kind: "schedule",
                    schedule: {
                        kind: "interval",
                        scheduleExpr: null,
                        everyMs: 60_000,
                        timezone: null,
                    },
                },
                executionRecipe: scheduleExecutionRecipe,
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });
        expect(createAutomation).toHaveBeenCalledWith({
            accountId: "account-1",
            input: expect.objectContaining({
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                executionRecipe: scheduleExecutionRecipe,
            }),
        });
        expect(createResponse).toEqual(expect.objectContaining({ targetType: "newSession" }));

        const { response: claimResponse } = await claimRoute.invoke({
            userId: "account-1",
            body: { machineId: "machine-1", leaseDurationMs: 30_000 },
        });
        expect(claimAutomationRun).toHaveBeenCalledWith({
            accountId: "account-1",
            machineId: "machine-1",
            leaseDurationMs: 30_000,
        });
        expect(claimResponse).toEqual({ run: null, automation: null, accountCurrentness: null });

        await startRoute.invoke({
            userId: "account-1",
            params: { runId: "run-1" },
            body: {
                machineId: "machine-1",
                attempt: 1,
                accountCurrentness,
            },
        });
        expect(startAutomationRun).toHaveBeenCalledWith({
            accountId: "account-1",
            runId: "run-1",
            machineId: "machine-1",
            attempt: 1,
            accountCurrentness,
        });

        await settleExecutionDispatchRoute.invoke({
            userId: "account-1",
            params: { runId: "run-1" },
            body: {
                machineId: "machine-1",
                attempt: 1,
                accountCurrentness,
                outcome: {
                    kind: "noRunCreated",
                    errorCode: "execution_run_target_unavailable",
                },
            },
        });
        expect(settleAutomationExecutionDispatch).toHaveBeenCalledWith({
            accountId: "account-1",
            runId: "run-1",
            machineId: "machine-1",
            attempt: 1,
            accountCurrentness,
            outcome: {
                kind: "noRunCreated",
                errorCode: "execution_run_target_unavailable",
            },
        });

        await succeedRoute.invoke({
            userId: "account-1",
            params: { runId: "run-1" },
            body: {
                machineId: "machine-1",
                attempt: 1,
                accountCurrentness,
                producedSessionId: "session-1",
                resultEnvelope: '{"t":"plain","v":{"text":"done"}}',
            },
        });
        expect(succeedAutomationRun).toHaveBeenCalledWith({
            accountId: "account-1",
            runId: "run-1",
            machineId: "machine-1",
            attempt: 1,
            accountCurrentness,
            producedSessionId: "session-1",
            resultEnvelope: '{"t":"plain","v":{"text":"done"}}',
        });

        await failRoute.invoke({
            userId: "account-1",
            params: { runId: "run-1" },
            body: {
                machineId: "machine-1",
                attempt: 1,
                accountCurrentness,
                errorCode: "invalid_template",
            },
        });
        expect(failAutomationRun).toHaveBeenCalledWith({
            accountId: "account-1",
            runId: "run-1",
            machineId: "machine-1",
            attempt: 1,
            accountCurrentness,
            producedSessionId: null,
            errorCode: "invalid_template",
            errorDetailEnvelope: null,
        });
    });

    it("claims the Run-frozen execution input rather than the mutable Automation template", async () => {
        const frozenExecutionInput = JSON.stringify({
            kind: "happier_automation_run_execution_input_v1",
            targetType: "new_session",
            templateVersion: 1,
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { directory: "/tmp/frozen" },
            }),
            origin: { kind: "manual", invokedAt: 1_723_247_201_000 },
        });
        claimAutomationRun.mockResolvedValueOnce({
            run: {
                id: "run-1",
                automationId: "automation-1",
                attempt: 2,
                originKind: "manual",
                scheduledAt: new Date("2024-08-20T12:00:00.000Z"),
                createdAt: new Date("2024-08-20T12:00:00.000Z"),
                executionInputEnvelope: frozenExecutionInput,
                automation: {
                    ...scheduleAutomation,
                    templateCiphertext: JSON.stringify({
                        kind: "happier_automation_template_plain_v1",
                        payload: { directory: "/tmp/current-definition" },
                    }),
                },
            },
            accountCurrentness,
        });

        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const claimRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/claim",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        const { response } = await claimRoute.invoke({
            userId: "account-1",
            body: { machineId: "machine-1" },
        });

        expect(response).toEqual({
            run: {
                id: "run-1",
                automationId: "automation-1",
                attempt: 2,
                origin: { kind: "manual", invokedAt: 1_724_155_200_000 },
                executionInputEnvelope: frozenExecutionInput,
            },
            automation: {
                id: "automation-1",
                name: "Daily sweep",
                enabled: true,
            },
            accountCurrentness,
        });
    });

    it("projects only an awaiting Conversation handoff as private final-result worker correspondence", async () => {
        const occurredAt = new Date("2024-08-20T12:00:00.000Z");
        claimAutomationRun.mockResolvedValueOnce({
            run: {
                id: "run-final",
                automationId: "automation-1",
                attempt: 2,
                originKind: "conversation",
                occurrenceKey: "channel-occurrence-final",
                originOccurredAt: occurredAt,
                createdAt: occurredAt,
                executionInputEnvelope: JSON.stringify(scheduleExecutionRecipe),
                replyHandoffState: "awaitingResult",
                replyHandoffId: "automation-reply-handoff:run-final",
                automation: scheduleAutomation,
            },
            accountCurrentness,
        });

        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const claimRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/claim",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        const { response } = await claimRoute.invoke({
            userId: "account-1",
            body: { machineId: "machine-1" },
        });

        expect(response).toEqual(expect.objectContaining({
            run: expect.objectContaining({
                origin: {
                    kind: "conversation",
                    occurrenceKey: "channel-occurrence-final",
                    occurredAt: occurredAt.getTime(),
                },
                resultDelivery: {
                    kind: "finalResult",
                    accountId: "account-1",
                    handoffId: "automation-reply-handoff:run-final",
                },
            }),
        }));
    });

    it("projects a claimed scheduled Run with its immutable due time rather than server admission time", async () => {
        const scheduledFor = new Date("2026-08-12T09:00:00.000Z");
        const admittedAt = new Date("2026-08-12T08:55:00.000Z");
        claimAutomationRun.mockResolvedValueOnce({
            run: {
                id: "run-scheduled",
                automationId: "automation-1",
                attempt: 1,
                originKind: "scheduled",
                scheduledAt: admittedAt,
                dueAt: scheduledFor,
                executionInputEnvelope: JSON.stringify(scheduleExecutionRecipe),
                automation: scheduleAutomation,
            },
            accountCurrentness,
        });

        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const claimRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/claim",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        const { response } = await claimRoute.invoke({
            userId: "account-1",
            body: { machineId: "machine-1" },
        });

        expect(response).toEqual(expect.objectContaining({
            run: expect.objectContaining({
                origin: { kind: "scheduled", scheduledFor: scheduledFor.getTime() },
            }),
        }));
    });

    it.each([
        ["whitespace cron", {
            kind: "cron",
            scheduleExpr: "   ",
            everyMs: null,
            timezone: null,
        }],
        ["oversized cron", {
            kind: "cron",
            scheduleExpr: "*".repeat(257),
            everyMs: null,
            timezone: null,
        }],
        ["sub-minimum interval", {
            kind: "interval",
            scheduleExpr: null,
            everyMs: 999,
            timezone: null,
        }],
    ] as const)("rejects a V3 %s schedule before persistence", async (_label, schedule) => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        const { reply } = await route.invoke({
            userId: "account-1",
            body: {
                name: "Invalid V3 schedule",
                enabled: true,
                trigger: { kind: "schedule", schedule },
                executionRecipe: scheduleExecutionRecipe,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(createAutomation).not.toHaveBeenCalled();
    });
});
