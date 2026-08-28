import { describe, expect, it, vi } from "vitest";

import {
    MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    type AutomationEventDeclarationReleaseV1,
} from "@happier-dev/protocol";
import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from "../../testkit/routeHarness";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { AutomationEventSourceStatusReportError } from "@/app/automations/automationEventSourceStatusService";
import { AutomationEventStoredDefinitionsReadError } from "@/app/automations/automationEventStoredDefinitionService";
import { verifyPluginInstallationPublisherBodyBinding } from "@/app/plugins/installations/publisherProof";

import { registerAutomationEventRoutes } from "./registerAutomationEventRoutes";

const PATH = "/v1/automations/events/source-status/report";
const ADMIT_PATH = "/v1/automations/events/admit";
const STORED_DEFINITION_READ_PATH = "/v1/automations/events/stored-definitions/read";
const BODY = {
    v: 1,
    caller: {
        pluginId: "com.acme.github",
        contributionLocalId: "repository-event",
        materialization: {
            machineId: "machine-1",
            materializationId: "materialization-1",
            pluginId: "com.acme.github",
        },
        immutableGenerationId: "github-immutable-generation-a",
    },
    input: {
        kind: "catalogReconciliation" as const,
        scope: { kind: "checkpointedPull" as const },
        observedRevision: "7",
        adoptedRevision: "7",
        state: "current" as const,
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
    },
};
const WEBHOOK_INVOCATION_REFERENCE = {
    v: 1,
    deliveryId: "delivery-1",
    endpoint: {
        webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
        revision: 3,
        webhookContribution: {
            pluginId: "com.acme.github",
            localId: "repository-events",
        },
        handlerActionLocalId: "receive-repository-events",
        sourceInstanceId: "repository-1",
    },
    target: {
        materialization: {
            machineId: "machine-1",
            materializationId: "materialization-1",
            pluginId: "com.acme.github",
        },
        machineInstallationId: "installation-1",
    },
    lease: { leaseId: "wh_lease_AAECAwQFBgcICQoLDA0ODw", revision: 5 },
} as const;

const STORED_DEFINITION_READ_BODY = {
    v: 1,
    caller: {
        pluginId: "com.acme.github",
        immutableGenerationId: "github-immutable-generation-a",
        materialization: {
            machineId: "machine-1",
            materializationId: "materialization-1",
            pluginId: "com.acme.github",
        },
    },
    input: {
        transport: { kind: "checkpointedPull" as const },
        pageSize: 1,
    },
};

const EVENT_DECLARATION_RELEASE = {
    release: { pluginId: "com.acme.github", version: "1.0.0" },
    archiveDigestSha256: `sha256:${"a".repeat(64)}`,
} satisfies AutomationEventDeclarationReleaseV1;

const ADMIT_BODY = {
    v: 1,
    caller: {
        pluginId: "com.acme.github",
        contributionLocalId: "repository-event",
        immutableGenerationId: "github-immutable-generation-a",
        materialization: {
            machineId: "machine-1",
            materializationId: "materialization-1",
            pluginId: "com.acme.github",
        },
    },
    input: {
        eventRef: { pluginId: "com.acme.github", localId: "repository-event" },
        occurrenceId: "delivery-1",
        occurredAt: 1,
        observationReceivedAt: 2,
        payload: { action: "opened" },
        definitions: [{
            automationId: "automation-1",
            triggerId: "trigger-automation-1",
            triggerRevision: 3,
            sourceSelectorId: "9d5af559-2c82-4c22-b6a0-ecabce38a631",
        }],
    },
    hostEvidence: {
        v: 1,
        t: "plain",
        accountCurrentness: {
            mode: "plain",
            version: 7,
            contentKeyFingerprint: null,
        },
    },
} as const;

const ADMIT_PUBLISHER = {
    machineId: "machine-1",
    installationId: "installation-1",
} as const;

const ADMIT_PRE_BODY_PROOF = {
    publisher: ADMIT_PUBLISHER,
    expectedBodySha256Base64Url: "different-signed-body-hash",
} as const;

function oversizedAdmitRawBody(): string {
    return JSON.stringify({
        ...ADMIT_BODY,
        padding: "x".repeat(MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES),
    });
}

describe("Automation Event HTTP routes", () => {
    it("caps every private Event admission at the Protocol-owned canonical transport ceiling", () => {
        const app = createFakeRouteApp();
        registerAutomationEventRoutes(app as never);

        const route = getRouteEntry(app, "POST", ADMIT_PATH);
        expect(route.opts.bodyLimit).toBe(MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES);
        expect(route.opts.bodyLimit).toBeLessThan(100 * 1024 * 1024);
    });

    it("rejects a private admission body above the canonical raw byte limit before publisher admission", async () => {
        const app = createAuthenticatedTestApp();
        const admitEvent = vi.fn();
        registerAutomationEventRoutes(app as never, {
            admitEvent,
            reportSourceStatus: vi.fn(),
            readStoredDefinitions: vi.fn(),
            verifyPublisherBeforeBody: vi.fn(async () => ADMIT_PRE_BODY_PROOF),
            verifyPublisherBodyBinding: vi.fn(() => ADMIT_PUBLISHER),
        });
        await app.ready();
        try {
            const body = oversizedAdmitRawBody();
            expect(Buffer.byteLength(body, "utf8"))
                .toBeGreaterThan(MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES);

            const response = await app.inject({
                method: "POST",
                url: ADMIT_PATH,
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": "account-1",
                },
                payload: body,
            });
            expect(response.statusCode).toBe(413);
            expect(admitEvent).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("authenticates Event admission before attempting to parse an unauthenticated body", async () => {
        const app = createAuthenticatedTestApp();
        const admitEvent = vi.fn();
        const authenticate = vi.fn(async (_request: unknown, reply: { code(statusCode: number): { send(value: null): unknown } }) => (
            reply.code(401).send(null)
        ));
        app.authenticate = authenticate;
        registerAutomationEventRoutes(app as never, {
            admitEvent,
            reportSourceStatus: vi.fn(),
            readStoredDefinitions: vi.fn(),
            verifyPublisher: vi.fn(),
        });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: ADMIT_PATH,
                headers: { "content-type": "application/json" },
                payload: "{not-json",
            });

            expect(response.statusCode).toBe(401);
            expect(authenticate).toHaveBeenCalledTimes(1);
            expect(admitEvent).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it.each([
        ["a missing publisher proof", {}],
        ["an invalid publisher proof", {
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: "not-a-publisher-proof",
        }],
    ])("rejects a bearer-authenticated malformed Event admission with %s before parsing", async (
        _description,
        publisherHeaders,
    ) => {
        const app = createAuthenticatedTestApp();
        const admitEvent = vi.fn();
        registerAutomationEventRoutes(app as never, {
            admitEvent,
            reportSourceStatus: vi.fn(),
            readStoredDefinitions: vi.fn(),
        });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: ADMIT_PATH,
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": "account-1",
                    ...publisherHeaders,
                },
                payload: "{not-json",
            });

            expect(response.statusCode).toBe(401);
            expect(admitEvent).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("rejects a pre-authorized publisher proof whose parsed body hash does not match before admission", async () => {
        const app = createAuthenticatedTestApp();
        const admitEvent = vi.fn();
        const verifyPublisherBeforeBody = vi.fn(async () => ADMIT_PRE_BODY_PROOF);
        const verifyPublisherBodyBinding = vi.fn(verifyPluginInstallationPublisherBodyBinding);
        registerAutomationEventRoutes(app as never, {
            admitEvent,
            reportSourceStatus: vi.fn(),
            readStoredDefinitions: vi.fn(),
            verifyPublisherBeforeBody,
            verifyPublisherBodyBinding,
        });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: ADMIT_PATH,
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": "account-1",
                },
                payload: ADMIT_BODY,
            });

            expect(response.statusCode).toBe(401);
        } finally {
            await app.close();
        }

        expect(verifyPublisherBeforeBody).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            path: ADMIT_PATH,
            required: true,
        }));
        expect(verifyPublisherBodyBinding).toHaveBeenCalledWith({
            proof: ADMIT_PRE_BODY_PROOF,
            body: ADMIT_BODY,
        });
        expect(admitEvent).not.toHaveBeenCalled();
    });

    it("binds Event admission to the signed exact caller and the canonical server writer", async () => {
        const app = createFakeRouteApp();
        const admitEvent = vi.fn(async () => ({
            results: [{ kind: "admitted" as const, runId: "run-1", checkpointSafe: true as const }],
            continuation: {
                kind: "ready" as const,
                accountCurrentness: { mode: "plain" as const, version: 1, contentKeyFingerprint: null },
            },
        }));
        const dependencies: Parameters<typeof registerAutomationEventRoutes>[1] & Readonly<{
            admitEvent: typeof admitEvent;
        }> = {
            reportSourceStatus: vi.fn(),
            readStoredDefinitions: vi.fn(),
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-1",
                installationId: "installation-1",
            })),
            verifyPublisherBeforeBody: vi.fn(async () => ({
                publisher: ADMIT_PUBLISHER,
                expectedBodySha256Base64Url: "signed-body-hash",
            })),
            verifyPublisherBodyBinding: vi.fn(() => ADMIT_PUBLISHER),
            admitEvent,
        };
        registerAutomationEventRoutes(app as never, dependencies);

        const route = getRouteEntry(app, "POST", ADMIT_PATH);
        expect(route.opts.onRequest).toEqual([app.authenticate, expect.any(Function)]);
        expect(route.opts.preHandler).toBeUndefined();
        expect(route.opts.schema).toEqual(expect.objectContaining({
            body: expect.anything(),
            response: expect.objectContaining({ 200: expect.anything(), 401: expect.anything(), 409: expect.anything() }),
        }));

        const reply = createReplyStub();
        await getRouteHandler(app, "POST", ADMIT_PATH)({
            userId: "account-1",
            method: "POST",
            url: ADMIT_PATH,
            headers: {},
            body: ADMIT_BODY,
        }, reply);

        expect(admitEvent).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: {
                pluginId: "com.acme.github",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
                immutableGenerationId: "github-immutable-generation-a",
            },
            request: ADMIT_BODY,
        });
        expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
        expect(reply.send).toHaveBeenCalledWith({
            results: [{ kind: "admitted", runId: "run-1", checkpointSafe: true }],
            continuation: {
                kind: "ready",
                accountCurrentness: { mode: "plain", version: 1, contentKeyFingerprint: null },
            },
        });
    });

  it("registers the status-report Action with strict authenticated schemas", () => {
        const app = createFakeRouteApp();
        registerAutomationEventRoutes(app as never);

        const route = getRouteEntry(app, "POST", PATH);
        expect(route.opts.preHandler).toBe(app.authenticate);
        expect(route.opts.schema).toEqual(expect.objectContaining({
            body: expect.anything(),
            response: expect.objectContaining({ 200: expect.anything(), 401: expect.anything(), 409: expect.anything() }),
        }));
    });

    it("registers the private stored-definition read in the incumbent Event route family", () => {
        const app = createFakeRouteApp();
        registerAutomationEventRoutes(app as never);

        const route = getRouteEntry(app, "POST", STORED_DEFINITION_READ_PATH);
        expect(route.opts.preHandler).toBe(app.authenticate);
        expect(route.opts.schema).toEqual(expect.objectContaining({
            body: expect.anything(),
            response: expect.objectContaining({ 200: expect.anything(), 401: expect.anything(), 409: expect.anything() }),
        }));
    });

    it("binds a private stored-definition read to the publisher-stamped exact materialization", async () => {
        const app = createFakeRouteApp();
        const readStoredDefinitions = vi.fn(async () => ({
            kind: "unchanged" as const,
            revision: "7",
            eventDeclarationRelease: EVENT_DECLARATION_RELEASE,
        }));
        const verifyPublisher = vi.fn(async () => ({
            machineId: "machine-1",
            installationId: "installation-1",
        }));
        registerAutomationEventRoutes(app as never, {
            reportSourceStatus: vi.fn(),
            readStoredDefinitions,
            verifyPublisher,
        });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", STORED_DEFINITION_READ_PATH)({
            userId: "account-1",
            method: "POST",
            url: STORED_DEFINITION_READ_PATH,
            headers: {},
            body: STORED_DEFINITION_READ_BODY,
        }, reply);

        expect(verifyPublisher).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            path: STORED_DEFINITION_READ_PATH,
            required: true,
        }));
        expect(readStoredDefinitions).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: {
                pluginId: "com.acme.github",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
                immutableGenerationId: "github-immutable-generation-a",
            },
            input: STORED_DEFINITION_READ_BODY.input,
        });
        expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
        expect(reply.send).toHaveBeenCalledWith({
            kind: "unchanged",
            revision: "7",
            eventDeclarationRelease: EVENT_DECLARATION_RELEASE,
        });
    });

    it("rejects a mismatched publisher machine before the private definition service can disclose bytes", async () => {
        const app = createFakeRouteApp();
        const readStoredDefinitions = vi.fn();
        registerAutomationEventRoutes(app as never, {
            reportSourceStatus: vi.fn(),
            readStoredDefinitions,
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-other",
                installationId: "installation-1",
            })),
        });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", STORED_DEFINITION_READ_PATH)({
            userId: "account-1",
            method: "POST",
            url: STORED_DEFINITION_READ_PATH,
            headers: {},
            body: STORED_DEFINITION_READ_BODY,
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(401);
        expect(readStoredDefinitions).not.toHaveBeenCalled();
    });

    it("projects a private stored-definition currentness failure as a bounded conflict", async () => {
        const app = createFakeRouteApp();
        registerAutomationEventRoutes(app as never, {
            reportSourceStatus: vi.fn(),
            readStoredDefinitions: vi.fn(async () => {
                throw new AutomationEventStoredDefinitionsReadError("caller_materialization_not_current");
            }),
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-1",
                installationId: "installation-1",
            })),
        });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", STORED_DEFINITION_READ_PATH)({
            userId: "account-1",
            method: "POST",
            url: STORED_DEFINITION_READ_PATH,
            headers: {},
            body: STORED_DEFINITION_READ_BODY,
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.send).toHaveBeenCalledWith({ error: "caller_materialization_not_current" });
    });

    it("binds the signed machine installation to the caller materialization frame", async () => {
        const app = createFakeRouteApp();
        const reportSourceStatus = vi.fn(async () => ({}));
        const verifyPublisher = vi.fn(async () => ({
            machineId: "machine-1",
            installationId: "installation-1",
        }));
        registerAutomationEventRoutes(app as never, { reportSourceStatus, verifyPublisher });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", PATH)({
            userId: "account-1",
            method: "POST",
            url: PATH,
            headers: {},
            body: BODY,
        }, reply);

        expect(verifyPublisher).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            path: PATH,
            required: true,
        }));
        expect(reportSourceStatus).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: {
                pluginId: "com.acme.github",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
                immutableGenerationId: "github-immutable-generation-a",
            },
            input: BODY.input,
        });
        expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
        expect(reply.send).toHaveBeenCalledWith({});
    });

    it("does not forward a Webhook invocation reference through the status caller frame", async () => {
        const app = createFakeRouteApp();
        const reportSourceStatus = vi.fn(async () => ({}));
        registerAutomationEventRoutes(app as never, {
            reportSourceStatus,
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-1",
                installationId: "installation-1",
            })),
        });
        const reply = createReplyStub();
        const body = {
            ...BODY,
            caller: {
                ...BODY.caller,
                webhookInvocationReference: WEBHOOK_INVOCATION_REFERENCE,
            },
        };

        await getRouteHandler(app, "POST", PATH)({
            userId: "account-1",
            method: "POST",
            url: PATH,
            headers: {},
            body,
        }, reply);

        expect(reportSourceStatus).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: {
                pluginId: "com.acme.github",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
                immutableGenerationId: "github-immutable-generation-a",
            },
            input: BODY.input,
        });
    });

    it("rejects missing publisher proof before writing status", async () => {
        const app = createFakeRouteApp();
        const reportSourceStatus = vi.fn();
        registerAutomationEventRoutes(app as never, {
            reportSourceStatus,
            verifyPublisher: vi.fn(async () => null),
        });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", PATH)({
            userId: "account-1",
            method: "POST",
            url: PATH,
            headers: {},
            body: BODY,
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(401);
        expect(reportSourceStatus).not.toHaveBeenCalled();
    });

    it("rejects a caller materialization stamped for a different machine instead of substituting the publisher machine", async () => {
        const app = createFakeRouteApp();
        const reportSourceStatus = vi.fn(async () => ({}));
        registerAutomationEventRoutes(app as never, {
            reportSourceStatus,
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-1",
                installationId: "installation-1",
            })),
        });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", PATH)({
            userId: "account-1",
            method: "POST",
            url: PATH,
            headers: {},
            body: {
                ...BODY,
                caller: {
                    ...BODY.caller,
                    materialization: {
                        ...BODY.caller.materialization,
                        machineId: "machine-other",
                    },
                },
            },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(401);
        expect(reportSourceStatus).not.toHaveBeenCalled();
    });

    it("reports stale source status as a bounded conflict", async () => {
        const app = createFakeRouteApp();
        registerAutomationEventRoutes(app as never, {
            reportSourceStatus: vi.fn(async () => {
                throw new AutomationEventSourceStatusReportError("observation_target_changed");
            }),
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-1",
                installationId: "installation-1",
            })),
        });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", PATH)({
            userId: "account-1",
            method: "POST",
            url: PATH,
            headers: {},
            body: BODY,
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.send).toHaveBeenCalledWith({ error: "observation_target_changed" });
    });
});
