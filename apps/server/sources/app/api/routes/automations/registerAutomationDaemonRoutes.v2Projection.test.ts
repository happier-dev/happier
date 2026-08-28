import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const listDaemonAssignments = vi.hoisted(() => vi.fn());

vi.mock("@/app/automations/automationAssignmentService", () => ({
    listDaemonAssignments,
}));
vi.mock("@/app/automations/automationClaimService", () => ({
    claimAutomationRun: vi.fn(),
    heartbeatAutomationRun: vi.fn(),
}));

const DATE = new Date("2026-08-27T12:00:00.000Z");
const TEMPLATE = JSON.stringify({
    kind: "happier_automation_template_plain_v1",
    payload: { prompt: "daily" },
});

describe("released V2 daemon assignment projection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listDaemonAssignments.mockResolvedValue([{
            id: "assignment-1",
            machineId: "machine-1",
            enabled: true,
            priority: 7,
            updatedAt: DATE,
            nextClaimAt: new Date(DATE.getTime() + 30_000),
            automation: {
                id: "automation-1",
                accountId: "account-1",
                name: "Canonical schedule",
                description: null,
                enabled: true,
                targetType: "new_session",
                templateCiphertext: TEMPLATE,
                templateVersion: 3,
                lastRunAt: null,
                createdAt: DATE,
                updatedAt: DATE,
                assignments: [{
                    machineId: "machine-1",
                    enabled: true,
                    priority: 7,
                    updatedAt: DATE,
                }],
                triggers: [{
                    id: "trigger-1",
                    automationId: "automation-1",
                    kind: "schedule",
                    enabled: true,
                    revision: 4,
                    deletedAt: null,
                    scheduleKind: "interval",
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: "UTC",
                    nextRunAt: new Date(DATE.getTime() + 60_000),
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
                    createdAt: DATE,
                    updatedAt: DATE,
                    eventSourceStatus: null,
                }],
                runs: [],
            },
        }]);
    });

    it("projects the sole canonical schedule trigger and the worker wake cursor", async () => {
        const { registerAutomationDaemonRoutes } = await import("./registerAutomationDaemonRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/automations/daemon/assignments",
            defaultRequest: { authAuthority: "account_automation" },
            registerRoutes(app) {
                registerAutomationDaemonRoutes(app as never, {
                    verifyPublisher: vi.fn(async () => ({
                        machineId: "machine-1",
                        installationId: "installation-1",
                        requestNonce: "worker-request-nonce-1",
                        proofExpiresAt: new Date("2026-08-28T12:05:00.000Z"),
                    })),
                });
            },
        });

        const { response } = await route.invoke({
            userId: "account-1",
            query: { machineId: "machine-1" },
        });

        expect(listDaemonAssignments).toHaveBeenCalledWith({
            accountId: "account-1",
            machineId: "machine-1",
            requireV2DefinitionRepresentability: true,
        });
        expect(response).toEqual({
            assignments: [{
                machineId: "machine-1",
                enabled: true,
                priority: 7,
                updatedAt: DATE.getTime(),
                automation: expect.objectContaining({
                    id: "automation-1",
                    schedule: {
                        kind: "interval",
                        scheduleExpr: null,
                        everyMs: 60_000,
                        timezone: "UTC",
                    },
                    nextRunAt: DATE.getTime() + 30_000,
                }),
            }],
        });
    });
});
