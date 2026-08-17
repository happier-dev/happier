import { z } from "zod";

import {
    AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
    AutomationEventActionHttpPathsV1,
    AutomationEventActionHttpRequestSchemasV1,
    AutomationEventAdmitHttpResultV1Schema,
    MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES,
    AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
    AutomationEventStoredDefinitionsReadResultV1Schema,
    AutomationEventSourceStatusReportResultV1Schema,
} from "@happier-dev/protocol";

import {
    AutomationEventAdmissionError,
    admitAutomationEventV1,
} from "@/app/automations/automationEventAdmissionService";
import {
    AutomationEventSourceStatusReportError,
    reportAutomationEventSourceStatusV1,
} from "@/app/automations/automationEventSourceStatusService";
import {
    AutomationEventStoredDefinitionsReadError,
    readAutomationEventStoredDefinitionsV1,
} from "@/app/automations/automationEventStoredDefinitionService";
import {
    PluginInstallationPublisherProofError,
    verifyPluginInstallationPublisherBodyBinding,
    verifyPluginInstallationPublisherHeaderBeforeBody,
    verifyPluginInstallationPublisherHeader,
    type VerifiedPluginInstallationPublisherPreBody,
} from "@/app/plugins/installations/publisherProof";
import type { Fastify } from "../../types";

const STATUS_REPORT_PATH = AutomationEventActionHttpPathsV1["automation.event.source.status.report"];
const ADMIT_PATH = AutomationEventActionHttpPathsV1["automation.event.admit"];
const STORED_DEFINITION_READ_PATH = AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1;
const ConflictResponseSchema = z.object({ error: z.string().min(1).max(64) }).strict();

type RouteDependencies = Readonly<{
    admitEvent: typeof admitAutomationEventV1;
    reportSourceStatus: typeof reportAutomationEventSourceStatusV1;
    readStoredDefinitions: typeof readAutomationEventStoredDefinitionsV1;
    verifyPublisher: typeof verifyPluginInstallationPublisherHeader;
    verifyPublisherBeforeBody: typeof verifyPluginInstallationPublisherHeaderBeforeBody;
    verifyPublisherBodyBinding: typeof verifyPluginInstallationPublisherBodyBinding;
}>;

const DEFAULT_DEPENDENCIES: RouteDependencies = {
    admitEvent: admitAutomationEventV1,
    reportSourceStatus: reportAutomationEventSourceStatusV1,
    readStoredDefinitions: readAutomationEventStoredDefinitionsV1,
    verifyPublisher: verifyPluginInstallationPublisherHeader,
    verifyPublisherBeforeBody: verifyPluginInstallationPublisherHeaderBeforeBody,
    verifyPublisherBodyBinding: verifyPluginInstallationPublisherBodyBinding,
};

function noStore(reply: { header(name: string, value: string): unknown }): void {
    reply.header("Cache-Control", "no-store");
}

export function registerAutomationEventRoutes(
    app: Fastify,
    dependencies: Partial<RouteDependencies> = DEFAULT_DEPENDENCIES,
): void {
    const resolvedDependencies: RouteDependencies = {
        ...DEFAULT_DEPENDENCIES,
        ...dependencies,
    };
    const admitPublisherProofs = new WeakMap<object, VerifiedPluginInstallationPublisherPreBody>();
    app.post(STORED_DEFINITION_READ_PATH, {
        preHandler: app.authenticate,
        schema: {
            body: AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
            response: {
                200: AutomationEventStoredDefinitionsReadResultV1Schema,
                401: z.null(),
                409: ConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            const publisher = await resolvedDependencies.verifyPublisher({
                accountId: request.userId,
                request,
                path: STORED_DEFINITION_READ_PATH,
                required: true,
            });
            if (!publisher) return reply.code(401).send(null);
            if (request.body.caller.materialization.machineId !== publisher.machineId) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.readStoredDefinitions({
                accountId: request.userId,
                caller: {
                    pluginId: request.body.caller.pluginId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId: request.body.caller.materialization.materializationId,
                    ...(request.body.caller.immutableGenerationId === undefined
                        ? {}
                        : { immutableGenerationId: request.body.caller.immutableGenerationId }),
                },
                input: request.body.input,
                ...(request.body.webhookInvocationReference === undefined
                    ? {}
                    : { webhookInvocationReference: request.body.webhookInvocationReference }),
            }));
        } catch (error) {
            if (error instanceof PluginInstallationPublisherProofError) {
                return reply.code(401).send(null);
            }
            if (error instanceof AutomationEventStoredDefinitionsReadError) {
                return reply.code(409).send({ error: error.code });
            }
            throw error;
        }
    });

    app.post(ADMIT_PATH, {
        bodyLimit: MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES,
        onRequest: [
            app.authenticate,
            async (request, reply) => {
                try {
                    const publisherProof = await resolvedDependencies.verifyPublisherBeforeBody({
                        accountId: request.userId,
                        request,
                        path: ADMIT_PATH,
                        required: true,
                    });
                    if (!publisherProof) return reply.code(401).send(null);
                    admitPublisherProofs.set(request, publisherProof);
                } catch (error) {
                    if (error instanceof PluginInstallationPublisherProofError) {
                        return reply.code(401).send(null);
                    }
                    throw error;
                }
            },
        ],
        schema: {
            body: AutomationEventActionHttpRequestSchemasV1["automation.event.admit"],
            response: {
                200: AutomationEventAdmitHttpResultV1Schema,
                401: z.null(),
                409: ConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            const publisherProof = admitPublisherProofs.get(request);
            admitPublisherProofs.delete(request);
            if (!publisherProof) return reply.code(401).send(null);
            const publisher = resolvedDependencies.verifyPublisherBodyBinding({
                proof: publisherProof,
                body: request.body,
            });
            if (request.body.caller.materialization.machineId !== publisher.machineId) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.admitEvent({
                accountId: request.userId,
                caller: {
                    pluginId: request.body.caller.pluginId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId: request.body.caller.materialization.materializationId,
                    ...(request.body.caller.immutableGenerationId === undefined
                        ? {}
                        : { immutableGenerationId: request.body.caller.immutableGenerationId }),
                },
                // Preserve the signed mode-specific body.  In particular the
                // encrypted arm has no semantic Event input for the route or
                // server to read before its Account-fenced rejoin.
                request: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginInstallationPublisherProofError) {
                return reply.code(401).send(null);
            }
            if (error instanceof AutomationEventAdmissionError) {
                return reply.code(409).send({ error: error.code });
            }
            throw error;
        }
    });

    app.post(STATUS_REPORT_PATH, {
        preHandler: app.authenticate,
        schema: {
            body: AutomationEventActionHttpRequestSchemasV1["automation.event.source.status.report"],
            response: {
                200: AutomationEventSourceStatusReportResultV1Schema,
                401: z.null(),
                409: ConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            const publisher = await resolvedDependencies.verifyPublisher({
                accountId: request.userId,
                request,
                path: STATUS_REPORT_PATH,
                required: true,
            });
            if (!publisher) return reply.code(401).send(null);
            if (request.body.caller.materialization.machineId !== publisher.machineId) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.reportSourceStatus({
                accountId: request.userId,
                caller: {
                    pluginId: request.body.caller.pluginId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId: request.body.caller.materialization.materializationId,
                    ...(request.body.caller.immutableGenerationId === undefined
                        ? {}
                        : { immutableGenerationId: request.body.caller.immutableGenerationId }),
                },
                input: request.body.input,
            }));
        } catch (error) {
            if (error instanceof PluginInstallationPublisherProofError) {
                return reply.code(401).send(null);
            }
            if (error instanceof AutomationEventSourceStatusReportError) {
                return reply.code(409).send({ error: error.code });
            }
            throw error;
        }
    });
}
