import { describe, expect, it, vi } from "vitest";

import {
    AutomationConversationTargetVerificationCallerError,
} from "@/app/automations/automationConversationTargetVerificationService";
import {
    createFakeRouteApp,
    createReplyStub,
    getRouteEntry,
    getRouteHandler,
} from "../../testkit/routeHarness";

import { registerAutomationConversationRoutes } from "./registerAutomationConversationRoutes";

const PATH = "/v1/automations/conversation/target/verify";
const LIST_PATH = "/v1/automations/conversation/targets/list";
const ADMIT_PATH = "/v1/automations/conversation/admit";
const BODY = {
    v: 1,
    caller: {
        pluginId: "happier.channels",
        contributionLocalId: "binding/create-v1",
        materialization: {
            machineId: "machine-1",
            materializationId: "materialization-1",
            pluginId: "happier.channels",
        },
    },
    input: {
        automationId: "automation-1",
        expectedTemplateVersion: 3,
    },
} as const;

const LIST_BODY = {
    v: 1,
    caller: {
        pluginId: "happier.channels",
        contributionLocalId: "binding/create-v1",
        materialization: {
            machineId: "machine-1",
            materializationId: "materialization-1",
            pluginId: "happier.channels",
        },
    },
    input: {
        limit: 2,
        cursor: "automation-0",
    },
} as const;

const ADMIT_BODY = {
    v: 1,
    caller: {
        pluginId: "happier.channels",
        contributionLocalId: "provider/observation-ingest-v1",
        materialization: {
            machineId: "machine-1",
            materializationId: "materialization-1",
            pluginId: "happier.channels",
        },
    },
    input: {
        automationId: "automation-1",
        bindingId: "binding-1",
        templateVersion: 3,
        occurrenceId: "conversation-occurrence-1",
        occurredAt: 1_723_247_200_000,
        sender: { id: "sender-1" },
        text: "Please summarize the latest change.",
        resultDelivery: {
            kind: "finalResult",
            actionRef: {
                pluginId: "happier.channels",
                localId: "automation/result-deliver-v1",
            },
            opaqueContext: { conversationId: "conversation-1" },
        },
    },
} as const;

describe("Automation conversation target-verification route", () => {
    it("registers the current-materialization target selector with a narrow response and no cache", async () => {
        const app = createFakeRouteApp();
        const listTargets = vi.fn(async () => ({
            items: [{ automationId: "automation-1", templateVersion: 3, label: "Conversation target" }],
            nextCursor: null,
        }));
        const verifyPublisher = vi.fn(async () => ({
            machineId: "machine-1",
            installationId: "installation-1",
        }));
        registerAutomationConversationRoutes(app as never, {
            listTargets,
            verifyPublisher,
        });

        const route = getRouteEntry(app, "POST", LIST_PATH);
        expect(route.opts.preHandler).toBe(app.authenticate);
        expect(route.opts.schema).toEqual(expect.objectContaining({
            body: expect.anything(),
            response: { 200: expect.anything(), 401: expect.anything() },
        }));
        const reply = createReplyStub();
        await getRouteHandler(app, "POST", LIST_PATH)({
            userId: "account-1",
            method: "POST",
            url: LIST_PATH,
            headers: {},
            body: LIST_BODY,
        }, reply);

        expect(verifyPublisher).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            path: LIST_PATH,
            required: true,
        }));
        expect(listTargets).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: {
                pluginId: "happier.channels",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
            },
            input: LIST_BODY.input,
        });
        expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
        expect(reply.send).toHaveBeenCalledWith({
            items: [{ automationId: "automation-1", templateVersion: 3, label: "Conversation target" }],
            nextCursor: null,
        });
    });

    it("refuses noncurrent target-list callers before disclosure", async () => {
        const app = createFakeRouteApp();
        const listTargets = vi.fn(async () => {
            throw new AutomationConversationTargetVerificationCallerError();
        });
        registerAutomationConversationRoutes(app as never, {
            listTargets,
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-1",
                installationId: "installation-1",
            })),
        });

        const reply = createReplyStub();
        await getRouteHandler(app, "POST", LIST_PATH)({
            userId: "account-1",
            method: "POST",
            url: LIST_PATH,
            headers: {},
            body: {
                ...LIST_BODY,
                caller: {
                    ...LIST_BODY.caller,
                    pluginId: "com.acme.other",
                    materialization: {
                        ...LIST_BODY.caller.materialization,
                        pluginId: "com.acme.other",
                    },
                },
            },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(401);
        expect(reply.send).toHaveBeenCalledWith(null);
        expect(listTargets).not.toHaveBeenCalled();
    });

    it("registers canonical conversation admission with the same host-derived caller fence", async () => {
        const app = createFakeRouteApp();
        const admit = vi.fn(async () => ({
            kind: "admitted" as const,
            runId: "run-1",
            checkpointSafe: true as const,
        }));
        const verifyPublisher = vi.fn(async () => ({
            machineId: "machine-1",
            installationId: "installation-1",
        }));
        registerAutomationConversationRoutes(app as never, {
            admit,
            verifyPublisher,
        });

        const route = getRouteEntry(app, "POST", ADMIT_PATH);
        expect(route.opts.preHandler).toBe(app.authenticate);
        expect(route.opts.schema).toEqual(expect.objectContaining({
            body: expect.anything(),
            response: { 200: expect.anything(), 401: expect.anything() },
        }));
        const reply = createReplyStub();
        await getRouteHandler(app, "POST", ADMIT_PATH)({
            userId: "account-1",
            method: "POST",
            url: ADMIT_PATH,
            headers: {},
            body: ADMIT_BODY,
        }, reply);

        expect(verifyPublisher).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            path: ADMIT_PATH,
            required: true,
        }));
        expect(admit).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: {
                pluginId: "happier.channels",
                contributionLocalId: "provider/observation-ingest-v1",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
            },
            input: ADMIT_BODY.input,
        });
        expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
        expect(reply.send).toHaveBeenCalledWith({
            kind: "admitted",
            runId: "run-1",
            checkpointSafe: true,
        });
    });

    it("binds the plugin-only read to the server Account and publisher-stamped exact materialization", async () => {
        const app = createFakeRouteApp();
        const verifyTarget = vi.fn(async () => ({
            kind: "verified" as const,
            templateVersion: 3,
        }));
        const verifyPublisher = vi.fn(async () => ({
            machineId: "machine-1",
            installationId: "installation-1",
        }));
        registerAutomationConversationRoutes(app as never, {
            verifyTarget,
            verifyPublisher,
        });

        const route = getRouteEntry(app, "POST", PATH);
        expect(route.opts.preHandler).toBe(app.authenticate);
        expect(route.opts.schema).toEqual(expect.objectContaining({
            body: expect.anything(),
            response: { 200: expect.anything(), 401: expect.anything() },
        }));
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
        expect(verifyTarget).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: {
                pluginId: "happier.channels",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
            },
            input: BODY.input,
        });
        expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
        expect(reply.send).toHaveBeenCalledWith({ kind: "verified", templateVersion: 3 });
    });

    it.each([
        "notFound",
        "notConversation",
        "templateVersionMismatch",
    ] as const)("returns %s as a normal nondisclosing domain result", async (reason) => {
        const app = createFakeRouteApp();
        registerAutomationConversationRoutes(app as never, {
            verifyTarget: vi.fn(async () => ({ kind: "notVerified" as const, reason })),
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

        expect(reply.code).not.toHaveBeenCalledWith(401);
        expect(reply.send).toHaveBeenCalledWith({ kind: "notVerified", reason });
    });

    it("rejects wrong plugin, publisher machine, or stale materialization before disclosure", async () => {
        for (const scenario of ["plugin", "machine", "currentness"] as const) {
            const app = createFakeRouteApp();
            const verifyTarget = scenario === "currentness"
                ? vi.fn(async () => {
                    throw new AutomationConversationTargetVerificationCallerError();
                })
                : vi.fn();
            registerAutomationConversationRoutes(app as never, {
                verifyTarget,
                verifyPublisher: vi.fn(async () => ({
                    machineId: scenario === "machine" ? "machine-other" : "machine-1",
                    installationId: "installation-1",
                })),
            });
            const reply = createReplyStub();
            await getRouteHandler(app, "POST", PATH)({
                userId: "account-1",
                method: "POST",
                url: PATH,
                headers: {},
                body: scenario === "plugin"
                    ? {
                        ...BODY,
                        caller: {
                            ...BODY.caller,
                            pluginId: "com.acme.other",
                            materialization: {
                                ...BODY.caller.materialization,
                                pluginId: "com.acme.other",
                            },
                        },
                    }
                    : BODY,
            }, reply);

            expect(reply.code).toHaveBeenCalledWith(401);
            expect(reply.send).toHaveBeenCalledWith(null);
            if (scenario !== "currentness") {
                expect(verifyTarget).not.toHaveBeenCalled();
            }
        }
    });
});
