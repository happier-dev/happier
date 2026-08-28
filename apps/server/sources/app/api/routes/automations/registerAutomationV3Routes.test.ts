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
import { AutomationSessionLifecycleRegistrationValidationError } from "@/app/automations/automationSessionLifecycleRegistration";
import type { ClearAutomationRunHistoryResult } from "@/app/automations/automationCrudService";
import { PRESENT_USER_REQUIRED_ERROR } from "../../utils/requirePresentUser";

const dbMocks = createDbMocks({
    account: ["findUnique"],
    automationTrigger: ["findMany"],
} as const);
const findAccountById = dbMocks.db.account.findUnique;
const findRetiredAutomationTriggers = dbMocks.db.automationTrigger.findMany;

function createRouteTestBuilder(options: Parameters<typeof createBaseRouteTestBuilder>[0]) {
    return createBaseRouteTestBuilder({
        ...options,
        defaultRequest: { authAuthority: "present_user", ...options.defaultRequest },
    });
}

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
    targetType: "new_session",
    templateCiphertext: JSON.stringify(scheduleExecutionRecipe),
    templateVersion: 1,
    lastRunAt: null,
    createdAt: new Date("2026-02-12T10:00:00.000Z"),
    updatedAt: new Date("2026-02-12T10:00:00.000Z"),
    assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
    triggers: [{
        id: "trigger-schedule-1",
        automationId: "automation-1",
        kind: "schedule" as const,
        enabled: true,
        revision: 1,
        deletedAt: null,
        scheduleKind: "interval" as const,
        scheduleExpr: null,
        everyMs: 60_000,
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
        sessionLifecycleEvent: null,
        sourceSessionId: null,
        sourceTurnId: null,
        createdAt: new Date("2026-02-12T10:00:00.000Z"),
        updatedAt: new Date("2026-02-12T10:00:00.000Z"),
        eventSourceStatus: null,
    }],
};

const eventAutomation = {
    ...scheduleAutomation,
    id: "automation-event-1",
    name: "Repository updates",
    triggers: [{
        ...scheduleAutomation.triggers[0],
        id: "trigger-event-1",
        automationId: "automation-event-1",
        kind: "pluginEvent" as const,
        scheduleKind: null,
        everyMs: null,
        eventPluginId: "happier.scm.github",
        eventLocalId: "repository-event-v1",
        sourceSelectorId: "9d5af559-2c82-4c22-b6a0-ecabce38a631",
        sourceContractVersion: 1,
        observationTransport: "checkpointedPull" as const,
        watcherMachineId: "machine-1",
        watcherMachineInstallationId: "installation-1",
        watcherPluginId: "happier.scm.github",
        watcherMaterializationId: "materialization-1",
        definitionEnvelope: JSON.stringify(
        sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding: {
                v: 1,
                automationId: "automation-event-1",
                triggerId: "trigger-event-1",
                triggerRevision: 1,
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
    }],
};

const eventTrigger = {
    kind: "pluginEvent" as const,
    enabled: true,
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
const createAutomationTrigger = vi.fn(async () => eventAutomation);
const clearAutomationRunHistory = vi.fn(async (): Promise<ClearAutomationRunHistoryResult> => ({
    status: "cleared" as const,
    clearedRuns: 2,
}));
const deleteAutomation = vi.fn(async () => true);
const deleteAutomationTrigger = vi.fn(async () => eventAutomation);
const getAutomation = vi.fn(async () => scheduleAutomation);
const getAutomationRun = vi.fn(async () => null);
const listAutomationRuns = vi.fn(async () => ({ runs: [], nextCursor: null }));
const listAutomations = vi.fn(async () => [scheduleAutomation]);
const runAutomationNow = vi.fn(async () => null);
const setAutomationEnabled = vi.fn(async () => scheduleAutomation);
const updateAutomation = vi.fn(async () => scheduleAutomation);
const reconcileAutomationDefinition = vi.fn(async () => scheduleAutomation);
const updateAutomationTrigger = vi.fn(async () => eventAutomation);
const listDaemonAssignments = vi.fn(async () => []);
const automationSettings: AutomationV3Settings = {
    maxActiveRunsPerMachine: 4,
    runRetention: "thirtyDays",
};
const getAutomationSettings = vi.fn(async (): Promise<AutomationV3Settings | null> => automationSettings);
const updateAutomationSettings = vi.fn(async (): Promise<AutomationV3Settings | null> => automationSettings);
const loadAutomationEventStatusProjections = vi.fn(async () => new Map());
const loadAutomationSessionLifecycleStatusProjections = vi.fn(async () => new Map());
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
const retryBlockedAutomationReplyHandoff = vi.fn(async () => null);
const verifyPublisherDefault = vi.hoisted(() => vi.fn());
class AutomationDefinitionCreateConflictError extends Error {}
class AutomationTemplateMutationConflictError extends Error {}
class AutomationTriggerCreateConflictError extends Error {}
class AutomationTriggerMutationConflictError extends Error {}
class AutomationDisabledError extends Error {}

vi.mock("@/app/automations/automationCrudService", () => ({
    createAutomation,
    createAutomationTrigger,
    clearAutomationRunHistory,
    deleteAutomation,
    deleteAutomationTrigger,
    getAutomation,
    getAutomationRun,
    listAutomationRuns,
    listAutomations,
    runAutomationNow,
    reconcileAutomationDefinition,
    setAutomationEnabled,
    updateAutomation,
    updateAutomationTrigger,
    AutomationDefinitionCreateConflictError,
    AutomationTemplateMutationConflictError,
    AutomationTriggerCreateConflictError,
    AutomationTriggerMutationConflictError,
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
vi.mock("@/app/automations/automationSessionLifecycleStatusProjection", () => ({
    loadAutomationSessionLifecycleStatusProjections,
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
vi.mock("@/app/automations/automationReplyHandoffService", () => ({
    retryBlockedAutomationReplyHandoff,
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
        findRetiredAutomationTriggers.mockResolvedValue([]);
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
            requestNonce: "worker-request-nonce-1",
            proofExpiresAt: new Date("2026-08-28T12:05:00.000Z"),
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
                automationId: "automation-terminal-refused",
                name: "Terminal must not create",
                enabled: true,
                triggers: [],
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

    it("routes present-user blocked reply-handoff recovery through the canonical Run owner", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/runs/:runId/retry-reply-handoff",
            registerRoutes(app) {
                registerAutomationV3Routes(app as any);
            },
        });

        expect(route.routeExists).toBe(true);
        const result = await route.invoke({
            userId: "account-1",
            params: { runId: "run-blocked-1" },
        });
        expect(result.reply.statusCode).toBe(404);
        expect(result.response).toEqual({ error: "automation_reply_handoff_not_retryable" });
        expect(retryBlockedAutomationReplyHandoff).toHaveBeenCalledWith({
            accountId: "account-1",
            runId: "run-blocked-1",
        });
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

    it("maps trigger-set create and recipe patch through the canonical V3 definition owner", async () => {
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
            automationId: "automation-event-create-1",
            name: "Repository updates",
            description: null,
            enabled: true,
            triggers: [{ triggerId: "trigger-event-create-1", trigger: eventTrigger }],
            executionRecipe: scheduleExecutionRecipe,
            assignments: [{ machineId: "machine-1" }],
        };

        await createRoute.invoke({ userId: "account-1", body });
        expect(createAutomation).toHaveBeenCalledWith({
            accountId: "account-1",
            input: expect.objectContaining({
                automationId: body.automationId,
                triggers: body.triggers,
                executionRecipe: scheduleExecutionRecipe,
            }),
        });

        await patchRoute.invoke({
            userId: "account-1",
            params: { id: "automation-event-1" },
            body: {
                name: body.name,
                enabled: body.enabled,
                executionRecipe: body.executionRecipe,
                assignments: body.assignments,
                expectedTemplateVersion: 1,
            },
        });
        expect(updateAutomation).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            automationId: "automation-event-1",
            expectedTemplateVersion: 1,
            input: expect.not.objectContaining({ triggers: expect.anything() }),
        }));
    });

    it("maps one full-editor save through the transactional reconciliation owner", async () => {
        reconcileAutomationDefinition.mockResolvedValueOnce(scheduleAutomation as any);
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const route = createRouteTestBuilder({
            method: "PUT",
            path: "/v3/automations/:id",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const body = {
            expectedTemplateVersion: 1,
            name: "Renamed",
            description: null,
            enabled: true,
            assignments: [{ machineId: "machine-1" }],
            triggers: [{
                kind: "existing",
                triggerId: "trigger-schedule-1",
                expectedRevision: 1,
            }],
            removedTriggers: [],
        };
        await route.invoke({ userId: "account-1", params: { id: "automation-1" }, body });
        expect(reconcileAutomationDefinition).toHaveBeenCalledWith({
            accountId: "account-1",
            automationId: "automation-1",
            input: body,
        });
    });

    it("routes independent trigger create, patch, and delete through the canonical trigger owner", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const createRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/:id/triggers",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const patchRoute = createRouteTestBuilder({
            method: "PATCH",
            path: "/v3/automations/:id/triggers",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const deleteRoute = createRouteTestBuilder({
            method: "DELETE",
            path: "/v3/automations/:id/triggers",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });

        await createRoute.invoke({
            userId: "account-1",
            params: { id: eventAutomation.id },
            body: { triggerId: "trigger-event-create-1", trigger: eventTrigger },
        });
        expect(createAutomationTrigger).toHaveBeenCalledWith({
            accountId: "account-1",
            automationId: eventAutomation.id,
            triggerId: "trigger-event-create-1",
            trigger: eventTrigger,
        });

        await patchRoute.invoke({
            userId: "account-1",
            params: { id: eventAutomation.id },
            body: {
                triggerId: "trigger-event-1",
                expectedRevision: 1,
                enabled: false,
            },
        });
        expect(updateAutomationTrigger).toHaveBeenCalledWith({
            accountId: "account-1",
            automationId: eventAutomation.id,
            triggerId: "trigger-event-1",
            expectedRevision: 1,
            enabled: false,
        });

        await deleteRoute.invoke({
            userId: "account-1",
            params: { id: eventAutomation.id },
            body: { triggerId: "trigger-event-1", expectedRevision: 1 },
        });
        expect(deleteAutomationTrigger).toHaveBeenCalledWith({
            accountId: "account-1",
            automationId: eventAutomation.id,
            triggerId: "trigger-event-1",
            expectedRevision: 1,
        });
    });

    it("returns typed conflicts when a client create identity is bound differently", async () => {
        createAutomation.mockRejectedValueOnce(new AutomationDefinitionCreateConflictError());
        createAutomationTrigger.mockRejectedValueOnce(new AutomationTriggerCreateConflictError());
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const definitionRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const triggerRoute = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/:id/triggers",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });

        const definitionResult = await definitionRoute.invoke({
            userId: "account-1",
            body: {
                automationId: "automation-conflict",
                name: "Conflicting create",
                enabled: true,
                executionRecipe: scheduleExecutionRecipe,
                triggers: [],
            },
        });
        expect(definitionResult.reply.statusCode).toBe(409);
        expect(definitionResult.response).toEqual({ error: "automation_create_conflict" });

        const triggerResult = await triggerRoute.invoke({
            userId: "account-1",
            params: { id: "automation-1" },
            body: {
                triggerId: "trigger-conflict",
                trigger: {
                    kind: "schedule",
                    enabled: true,
                    schedule: {
                        kind: "interval",
                        scheduleExpr: null,
                        everyMs: 60_000,
                        timezone: null,
                    },
                },
            },
        });
        expect(triggerResult.reply.statusCode).toBe(409);
        expect(triggerResult.response).toEqual({ error: "automation_trigger_create_conflict" });
    });

    it("rejects stale trigger revision through one stable conflict response", async () => {
        updateAutomationTrigger.mockRejectedValueOnce(
            new AutomationTriggerMutationConflictError("stale trigger revision"),
        );
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v3/automations/:id/triggers",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });
        const { response, reply } = await route.invoke({
            userId: "account-1",
            params: { id: eventAutomation.id },
            body: {
                triggerId: "trigger-event-1",
                expectedRevision: 1,
                enabled: false,
            },
        });

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({ error: "automation_trigger_revision_conflict" });
    });

    it("preserves typed exact-turn registration truth in the trigger create response", async () => {
        createAutomationTrigger.mockRejectedValueOnce(
            new AutomationSessionLifecycleRegistrationValidationError(
                "sourceTurnNotInProgress",
                "Source turn is no longer in progress",
            ),
        );
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v3/automations/:id/triggers",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });

        const { response, reply } = await route.invoke({
            userId: "account-1",
            params: { id: "automation-1" },
            body: {
                triggerId: "trigger-session-stale",
                trigger: {
                    kind: "sessionLifecycle",
                    enabled: true,
                    event: "parentTurnCompleted",
                    scope: {
                        kind: "exactTurn",
                        sourceSessionId: "session-source",
                        sourceTurnId: "turn-stale",
                    },
                    consumption: "once",
                },
            },
        });

        expect(reply.statusCode).toBe(400);
        expect(response).toEqual({ error: "sourceTurnNotInProgress" });
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
            .mockResolvedValueOnce(new Map([[eventAutomation.triggers[0]!.id, projection]]))
            .mockResolvedValueOnce(new Map([[eventAutomation.triggers[0]!.id, projection]]));
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
            automations: [expect.objectContaining({
                triggers: [expect.objectContaining({ sourceCatalogStatus })],
            })],
        });
        expect(detailResponse).toEqual(expect.objectContaining({
            triggers: [expect.objectContaining({ sourceCatalogStatus })],
        }));
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
                automationId: "automation-event-e2ee-plaintext",
                name: "Repository updates",
                enabled: true,
                triggers: [{ triggerId: "trigger-event-e2ee-plaintext", trigger: eventTrigger }],
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
            automationId: "automation-event-writer-failure",
            name: "Repository updates",
            enabled: true,
            triggers: [{ triggerId: "trigger-event-writer-failure", trigger: eventTrigger }],
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
            body: {
                name: body.name,
                enabled: body.enabled,
                executionRecipe: body.executionRecipe,
                expectedTemplateVersion: 1,
            },
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
                executionRecipe: scheduleExecutionRecipe,
                expectedTemplateVersion: 1,
            },
        });

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({ error: "automation_template_version_conflict" });
    });

    it("keeps definition patches independent from trigger ownership", async () => {
        const { registerAutomationV3Routes } = await import("./registerAutomationV3Routes");
        const patchRoute = createRouteTestBuilder({
            method: "PATCH",
            path: "/v3/automations/:id",
            registerRoutes(app) { registerAutomationV3Routes(app as any); },
        });

        await patchRoute.invoke({
            userId: "account-1",
            params: { id: "automation-1" },
            body: { name: "Renamed schedule", expectedTemplateVersion: 1 },
        });

        expect(updateAutomation).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            automationId: "automation-1",
            expectedTemplateVersion: 1,
        }));
    });

    it("creates a zero-trigger definition and maps keyed Run Now through the direct cause owner", async () => {
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
                automationId: "automation-on-demand-create",
                name: "On demand",
                enabled: true,
                triggers: [],
                executionRecipe: scheduleExecutionRecipe,
            },
        });
        expect(createAutomation).toHaveBeenCalledWith({
            accountId: "account-1",
            input: expect.objectContaining({
                automationId: "automation-on-demand-create",
                triggers: [],
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
                automationId: "automation-daily-sweep-create",
                name: "Daily sweep",
                enabled: true,
                triggers: [{
                    triggerId: "trigger-daily-sweep-create",
                    trigger: {
                        kind: "schedule",
                        enabled: true,
                        schedule: {
                            kind: "interval",
                            scheduleExpr: null,
                            everyMs: 60_000,
                            timezone: null,
                        },
                    },
                }],
                executionRecipe: scheduleExecutionRecipe,
                assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
            },
        });
        expect(createAutomation).toHaveBeenCalledWith({
            accountId: "account-1",
            input: expect.objectContaining({
                automationId: "automation-daily-sweep-create",
                triggers: [expect.objectContaining({
                    triggerId: "trigger-daily-sweep-create",
                    trigger: expect.objectContaining({ kind: "schedule", enabled: true }),
                })],
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
            claimRequest: {
                machineInstallationId: "installation-1",
                nonce: "worker-request-nonce-1",
                expiresAt: new Date("2026-08-28T12:05:00.000Z"),
            },
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
        const invokedAt = new Date("2024-08-20T12:00:00.000Z");
        const frozenExecutionInput = JSON.stringify(scheduleExecutionRecipe);
        claimAutomationRun.mockResolvedValueOnce({
            run: {
                id: "run-1",
                automationId: "automation-1",
                attempt: 2,
                triggerId: null,
                causeKind: "manual",
                causeTriggerKind: null,
                causeTriggerRevision: null,
                causeOccurredAt: invokedAt,
                causeScheduledFor: null,
                causeEventPluginId: null,
                causeEventLocalId: null,
                causeSessionLifecycleEvent: null,
                causeSourceSessionId: null,
                causeSourceTurnId: null,
                occurrenceKey: null,
                causeSourceSelectorId: null,
                createdAt: invokedAt,
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
                triggerId: null,
                cause: { kind: "manual", invokedAt: invokedAt.getTime() },
                executionInputEnvelope: frozenExecutionInput,
                triggerRetired: false,
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
                triggerId: null,
                causeKind: "conversation",
                causeTriggerKind: null,
                causeTriggerRevision: null,
                causeOccurredAt: occurredAt,
                causeScheduledFor: null,
                causeEventPluginId: null,
                causeEventLocalId: null,
                causeSessionLifecycleEvent: null,
                causeSourceSessionId: null,
                causeSourceTurnId: null,
                occurrenceKey: "izTbwsBetNfiXUjv6s6CRWsWzudgvK6AwVf1KjwueHs",
                causeSourceSelectorId: null,
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
                triggerId: null,
                cause: {
                    kind: "conversation",
                    occurrenceKey: "izTbwsBetNfiXUjv6s6CRWsWzudgvK6AwVf1KjwueHs",
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
                triggerId: "trigger-schedule-1",
                causeKind: "trigger",
                causeTriggerKind: "schedule",
                causeTriggerRevision: 1,
                causeOccurredAt: admittedAt,
                causeScheduledFor: scheduledFor,
                causeEventPluginId: null,
                causeEventLocalId: null,
                causeSessionLifecycleEvent: null,
                causeSourceSessionId: null,
                causeSourceTurnId: null,
                occurrenceKey: "X3IAXoHE7L1ao1iOgOPa8N8GjODPVjiURQigFl_qYJo",
                causeSourceSelectorId: null,
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
                triggerId: "trigger-schedule-1",
                cause: {
                    kind: "trigger",
                    triggerId: "trigger-schedule-1",
                    triggerKind: "schedule",
                    triggerRevision: 1,
                    occurrenceKey: "X3IAXoHE7L1ao1iOgOPa8N8GjODPVjiURQigFl_qYJo",
                    occurredAt: admittedAt.getTime(),
                    evidence: { scheduledFor: scheduledFor.getTime() },
                },
            }),
        }));
    });

    it("projects Plugin Event cause evidence from the immutable physical Event reference", async () => {
        const occurredAt = new Date("2026-08-12T09:00:00.000Z");
        claimAutomationRun.mockResolvedValueOnce({
            run: {
                id: "run-plugin-event",
                automationId: eventAutomation.id,
                attempt: 1,
                triggerId: "trigger-event-1",
                causeKind: "trigger",
                causeTriggerKind: "pluginEvent",
                causeTriggerRevision: 3,
                causeOccurredAt: occurredAt,
                causeScheduledFor: null,
                causeEventPluginId: "happier.scm.github",
                causeEventLocalId: "repository-event-v1",
                causeSessionLifecycleEvent: null,
                causeSourceSessionId: null,
                causeSourceTurnId: null,
                occurrenceKey: "uOH4C9cK4HhMeFWkUXMbdF_dtndJ0j9je-kIK3XpV1s",
                causeSourceSelectorId: "9d5af559-2c82-4c22-b6a0-ecabce38a631",
                executionInputEnvelope: JSON.stringify(scheduleExecutionRecipe),
                automation: eventAutomation,
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
                triggerId: "trigger-event-1",
                cause: {
                    kind: "trigger",
                    triggerId: "trigger-event-1",
                    triggerKind: "pluginEvent",
                    triggerRevision: 3,
                    occurrenceKey: "uOH4C9cK4HhMeFWkUXMbdF_dtndJ0j9je-kIK3XpV1s",
                    occurredAt: occurredAt.getTime(),
                    evidence: {
                        eventRef: {
                            pluginId: "happier.scm.github",
                            localId: "repository-event-v1",
                        },
                        sourceSelectorId: "9d5af559-2c82-4c22-b6a0-ecabce38a631",
                    },
                },
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
                automationId: "automation-invalid-schedule-create",
                name: "Invalid V3 schedule",
                enabled: true,
                triggers: [{
                    triggerId: "trigger-invalid-schedule-create",
                    trigger: { kind: "schedule", enabled: true, schedule },
                }],
                executionRecipe: scheduleExecutionRecipe,
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(createAutomation).not.toHaveBeenCalled();
    });
});
