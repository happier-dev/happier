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
            body: LIST_BODY,
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(401);
        expect(reply.send).toHaveBeenCalledWith(null);
        expect(listTargets).toHaveBeenCalledTimes(1);
    });

    it("drives the whole conversation flow for a third-party plugin that is not Channels", async () => {
        const app = createFakeRouteApp();
        const thirdPartyCaller = {
            pluginId: "acme.slack-bridge",
            contributionLocalId: "slack/binding-v1",
            materialization: {
                machineId: "machine-1",
                materializationId: "materialization-slack-1",
                pluginId: "acme.slack-bridge",
            },
        } as const;
        const stampedCaller = {
            pluginId: "acme.slack-bridge",
            machineId: "machine-1",
            machineInstallationId: "installation-1",
            materializationId: "materialization-slack-1",
        } as const;
        const listTargets = vi.fn(async () => ({
            items: [{ automationId: "automation-1", templateVersion: 3, label: "Conversation target" }],
            nextCursor: null,
        }));
        const verifyTarget = vi.fn(async () => ({ kind: "verified" as const, templateVersion: 3 }));
        const admit = vi.fn(async () => ({
            kind: "admitted" as const,
            runId: "run-1",
            checkpointSafe: true as const,
        }));
        registerAutomationConversationRoutes(app as never, {
            listTargets,
            verifyTarget,
            admit,
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-1",
                installationId: "installation-1",
            })),
        });

        for (const [path, body] of [
            [LIST_PATH, { ...LIST_BODY, caller: thirdPartyCaller }],
            [PATH, { ...BODY, caller: thirdPartyCaller }],
            [ADMIT_PATH, {
                ...ADMIT_BODY,
                caller: {
                    ...thirdPartyCaller,
                    contributionLocalId: "slack/observation-ingest-v1",
                },
                input: {
                    ...ADMIT_BODY.input,
                    resultDelivery: {
                        ...ADMIT_BODY.input.resultDelivery,
                        actionRef: {
                            pluginId: "acme.slack-bridge",
                            localId: "slack/result-deliver-v1",
                        },
                    },
                },
            }],
        ] as const) {
            const reply = createReplyStub();
            await getRouteHandler(app, "POST", path)({
                userId: "account-1",
                method: "POST",
                url: path,
                headers: {},
                body,
            }, reply);
            expect(reply.code).not.toHaveBeenCalledWith(401);
        }

        expect(listTargets).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: stampedCaller,
            input: LIST_BODY.input,
        });
        expect(verifyTarget).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: stampedCaller,
            input: BODY.input,
        });
        expect(admit).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            caller: {
                ...stampedCaller,
                contributionLocalId: "slack/observation-ingest-v1",
            },
        }));
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

    it("admits a publisher-stamped external plugin caller through the generic admission policy", async () => {
        const app = createFakeRouteApp();
        const admit = vi.fn(async () => ({
            kind: "admitted" as const,
            runId: "run-1",
            checkpointSafe: true as const,
        }));
        registerAutomationConversationRoutes(app as never, {
            admit,
            verifyPublisher: vi.fn(async () => ({
                machineId: "machine-1",
                installationId: "installation-1",
            })),
        });
        const reply = createReplyStub();
        const externalCaller = {
            ...ADMIT_BODY.caller,
            pluginId: "com.acme.other",
            materialization: {
                ...ADMIT_BODY.caller.materialization,
                pluginId: "com.acme.other",
            },
        } as const;

        await getRouteHandler(app, "POST", ADMIT_PATH)({
            userId: "account-1",
            method: "POST",
            url: ADMIT_PATH,
            headers: {},
            body: { ...ADMIT_BODY, caller: externalCaller },
        }, reply);

        expect(admit).toHaveBeenCalledWith({
            accountId: "account-1",
            caller: {
                pluginId: "com.acme.other",
                contributionLocalId: "provider/observation-ingest-v1",
                machineId: "machine-1",
                machineInstallationId: "installation-1",
                materializationId: "materialization-1",
            },
            input: ADMIT_BODY.input,
        });
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
        "templateVersionMismatch",
        "resultDeliveryUnsupported",
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

    it("rejects a mismatched publisher machine or stale materialization before disclosure", async () => {
        for (const scenario of ["machine", "currentness"] as const) {
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
                body: BODY,
            }, reply);

            expect(reply.code).toHaveBeenCalledWith(401);
            expect(reply.send).toHaveBeenCalledWith(null);
            if (scenario !== "currentness") {
                expect(verifyTarget).not.toHaveBeenCalled();
            }
        }
    });
});
