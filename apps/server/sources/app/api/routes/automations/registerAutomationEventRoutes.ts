import { z } from "zod/mini";

import { AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1, AutomationEventActionHttpPathsV1, AutomationEventActionHttpRequestSchemasV1, AutomationEventStoredDefinitionsReadHttpRequestV1Schema, AutomationEventStoredDefinitionsReadResultV1Schema } from '@happier-dev/protocol/automations/event';
import { AutomationEventAdmitHttpResultV1Schema, AutomationEventSourceStatusReportResultV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';

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
    verifyPluginInstallationPublisherRequesterOperation,
    type VerifiedPluginInstallationPublisherPreBody,
} from "@/app/plugins/installations/publisherProof";
import type { Fastify } from "../../types";

const STATUS_REPORT_PATH = AutomationEventActionHttpPathsV1["automation.event.source.status.report"];
const ADMIT_PATH = AutomationEventActionHttpPathsV1["automation.event.admit"];
const STORED_DEFINITION_READ_PATH = AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1;
const ConflictResponseSchema = z.strictObject({ error: z.string().check(z.minLength(1), z.maxLength(64)) });

type RouteDependencies = Readonly<{
    admitEvent: typeof admitAutomationEventV1;
    reportSourceStatus: typeof reportAutomationEventSourceStatusV1;
    readStoredDefinitions: typeof readAutomationEventStoredDefinitionsV1;
    verifyPublisher: typeof verifyPluginInstallationPublisherHeader;
    verifyPublisherBeforeBody: typeof verifyPluginInstallationPublisherHeaderBeforeBody;
    verifyPublisherBodyBinding: typeof verifyPluginInstallationPublisherBodyBinding;
    verifyPublisherRequesterOperation: typeof verifyPluginInstallationPublisherRequesterOperation;
}>;

const DEFAULT_DEPENDENCIES: RouteDependencies = {
    admitEvent: admitAutomationEventV1,
    reportSourceStatus: reportAutomationEventSourceStatusV1,
    readStoredDefinitions: readAutomationEventStoredDefinitionsV1,
    verifyPublisher: verifyPluginInstallationPublisherHeader,
    verifyPublisherBeforeBody: verifyPluginInstallationPublisherHeaderBeforeBody,
    verifyPublisherBodyBinding: verifyPluginInstallationPublisherBodyBinding,
    verifyPublisherRequesterOperation: verifyPluginInstallationPublisherRequesterOperation,
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
                requesterOperation: request.body.caller.requesterOperation,
                settlement: { pluginId: request.body.caller.pluginId,
                    materializationId: request.body.caller.materialization.materializationId },
                request,
                path: STORED_DEFINITION_READ_PATH,
                required: true,
            });
            if (!publisher) return reply.code(401).send(null);
            if (request.body.caller.materialization.machineId !== publisher.machineId) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.readStoredDefinitions({
                accountId: publisher.requesterOperation?.accountId ?? request.userId,
                caller: {
                    ...(publisher.requesterOperation ? { materializationAccountId: publisher.requesterOperation.custodianAccountId } : {}),
                    pluginId: request.body.caller.pluginId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId: request.body.caller.materialization.materializationId,
                    sourceCustody: request.body.caller.sourceCustody,
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
        // Request-body size is owned by the server's app-level transport body
        // limit; no feature-owned per-route ceiling is derived here.
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
            const boundPublisher = resolvedDependencies.verifyPublisherBodyBinding({
                proof: publisherProof,
                body: request.body,
            });
            const publisher = await resolvedDependencies.verifyPublisherRequesterOperation({
                publisher: boundPublisher, accountId: request.userId,
                requesterOperation: request.body.caller.requesterOperation,
                // Both admit arms name their Event; only the Event that completes the root settles it.
                settlement: { pluginId: request.body.caller.pluginId,
                    materializationId: request.body.caller.materialization.materializationId,
                    eventRef: 'input' in request.body ? request.body.input.eventRef : request.body.hostEvidence.eventRef },
            });
            if (request.body.caller.materialization.machineId !== publisher.machineId) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.admitEvent({
                accountId: publisher.requesterOperation?.accountId ?? request.userId,
                caller: {
                    ...(publisher.requesterOperation ? { materializationAccountId: publisher.requesterOperation.custodianAccountId } : {}),
                    pluginId: request.body.caller.pluginId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId: request.body.caller.materialization.materializationId,
                    sourceCustody: request.body.caller.sourceCustody,
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
                requesterOperation: request.body.caller.requesterOperation,
                request,
                path: STATUS_REPORT_PATH,
                required: true,
            });
            if (!publisher) return reply.code(401).send(null);
            if (request.body.caller.materialization.machineId !== publisher.machineId) {
                return reply.code(401).send(null);
            }

            return await reply.send(await resolvedDependencies.reportSourceStatus({
                accountId: publisher.requesterOperation?.accountId ?? request.userId,
                caller: {
                    ...(publisher.requesterOperation ? { materializationAccountId: publisher.requesterOperation.custodianAccountId } : {}),
                    pluginId: request.body.caller.pluginId,
                    machineId: request.body.caller.materialization.machineId,
                    machineInstallationId: publisher.installationId,
                    materializationId: request.body.caller.materialization.materializationId,
                    sourceCustody: request.body.caller.sourceCustody,
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
