import { z } from "zod";

import {
    AutomationConversationActionHttpPathsV1,
    AutomationConversationActionHttpRequestSchemasV1,
    AutomationConversationAdmitResultV1Schema,
    AutomationConversationTargetsListResultV1Schema,
    AutomationConversationTargetVerifyResultV1Schema,
} from "@happier-dev/protocol";

import {
    admitAutomationConversationV1,
    AutomationConversationAdmissionCallerError,
} from "@/app/automations/automationConversationAdmissionService";
import {
    AUTOMATION_CONVERSATION_TARGET_CALLER_PLUGIN_ID_V1,
    AutomationConversationTargetVerificationCallerError,
    listAutomationConversationTargetsV1,
    verifyAutomationConversationTargetV1,
} from "@/app/automations/automationConversationTargetVerificationService";
import {
    PluginInstallationPublisherProofError,
    verifyPluginInstallationPublisherHeader,
} from "@/app/plugins/installations/publisherProof";
import type { Fastify } from "../../types";

const TARGET_VERIFY_PATH = AutomationConversationActionHttpPathsV1[
    "automation.conversation.target.verify"
];
const TARGET_LIST_PATH = AutomationConversationActionHttpPathsV1[
    "automation.conversation.targets.list"
];
const ADMIT_PATH = AutomationConversationActionHttpPathsV1[
    "automation.conversation.admit"
];

type RouteDependencies = Readonly<{
    admit: typeof admitAutomationConversationV1;
    listTargets: typeof listAutomationConversationTargetsV1;
    verifyTarget: typeof verifyAutomationConversationTargetV1;
    verifyPublisher: typeof verifyPluginInstallationPublisherHeader;
}>;

const DEFAULT_DEPENDENCIES: RouteDependencies = {
    admit: admitAutomationConversationV1,
    listTargets: listAutomationConversationTargetsV1,
    verifyTarget: verifyAutomationConversationTargetV1,
    verifyPublisher: verifyPluginInstallationPublisherHeader,
};

export function registerAutomationConversationRoutes(
    app: Fastify,
    dependencies: Partial<RouteDependencies> = DEFAULT_DEPENDENCIES,
): void {
    const resolvedDependencies: RouteDependencies = {
        ...DEFAULT_DEPENDENCIES,
        ...dependencies,
    };

    app.post(TARGET_LIST_PATH, {
        preHandler: app.authenticate,
        schema: {
            body: AutomationConversationActionHttpRequestSchemasV1[
                "automation.conversation.targets.list"
            ],
            response: {
                200: AutomationConversationTargetsListResultV1Schema,
                401: z.null(),
            },
        },
    }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        try {
            const publisher = await resolvedDependencies.verifyPublisher({
                accountId: request.userId,
                request,
                path: TARGET_LIST_PATH,
                required: true,
            });
            if (!publisher) return reply.code(401).send(null);
            if (
                request.body.caller.pluginId
                    !== AUTOMATION_CONVERSATION_TARGET_CALLER_PLUGIN_ID_V1
                || request.body.caller.materialization.machineId
                    !== publisher.machineId
            ) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.listTargets({
                accountId: request.userId,
                caller: {
                    pluginId: request.body.caller.pluginId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId:
                        request.body.caller.materialization.materializationId,
                },
                input: request.body.input,
            }));
        } catch (error) {
            if (
                error instanceof PluginInstallationPublisherProofError
                || error instanceof AutomationConversationTargetVerificationCallerError
            ) {
                return reply.code(401).send(null);
            }
            throw error;
        }
    });

    app.post(TARGET_VERIFY_PATH, {
        preHandler: app.authenticate,
        schema: {
            body: AutomationConversationActionHttpRequestSchemasV1[
                "automation.conversation.target.verify"
            ],
            response: {
                200: AutomationConversationTargetVerifyResultV1Schema,
                401: z.null(),
            },
        },
    }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        try {
            const publisher = await resolvedDependencies.verifyPublisher({
                accountId: request.userId,
                request,
                path: TARGET_VERIFY_PATH,
                required: true,
            });
            if (!publisher) return reply.code(401).send(null);
            if (
                request.body.caller.pluginId
                    !== AUTOMATION_CONVERSATION_TARGET_CALLER_PLUGIN_ID_V1
                || request.body.caller.materialization.machineId
                    !== publisher.machineId
            ) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.verifyTarget({
                accountId: request.userId,
                caller: {
                    pluginId: request.body.caller.pluginId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId:
                        request.body.caller.materialization.materializationId,
                },
                input: request.body.input,
            }));
        } catch (error) {
            if (
                error instanceof PluginInstallationPublisherProofError
                || error instanceof AutomationConversationTargetVerificationCallerError
            ) {
                return reply.code(401).send(null);
            }
            throw error;
        }
    });

    app.post(ADMIT_PATH, {
        preHandler: app.authenticate,
        schema: {
            body: AutomationConversationActionHttpRequestSchemasV1[
                "automation.conversation.admit"
            ],
            response: {
                200: AutomationConversationAdmitResultV1Schema,
                401: z.null(),
            },
        },
    }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        try {
            const publisher = await resolvedDependencies.verifyPublisher({
                accountId: request.userId,
                request,
                path: ADMIT_PATH,
                required: true,
            });
            if (!publisher) return reply.code(401).send(null);
            if (
                request.body.caller.pluginId
                    !== AUTOMATION_CONVERSATION_TARGET_CALLER_PLUGIN_ID_V1
                || request.body.caller.materialization.machineId
                    !== publisher.machineId
            ) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.admit({
                accountId: request.userId,
                caller: {
                    pluginId: request.body.caller.pluginId,
                    contributionLocalId: request.body.caller.contributionLocalId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId:
                        request.body.caller.materialization.materializationId,
                },
                input: request.body.input,
            }));
        } catch (error) {
            if (
                error instanceof PluginInstallationPublisherProofError
                || error instanceof AutomationConversationAdmissionCallerError
            ) {
                return reply.code(401).send(null);
            }
            throw error;
        }
    });
}
