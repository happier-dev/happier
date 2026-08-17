import { z } from "zod";

import {
    PluginWebhookClaimRequestV1Schema,
    PluginWebhookClaimResultV1Schema,
    PluginWebhookCompleteRequestV1Schema,
    PluginMachineMaterializationRefV1Schema,
    PluginWebhookEndpointCheckCorrespondenceInputV1Schema,
    PluginWebhookEndpointCheckCorrespondenceResultV1Schema,
    PluginWebhookFailRequestV1Schema,
    PluginWebhookRenewRequestV1Schema,
    PluginWebhookRenewResultV1Schema,
    PluginWebhookSettleResultV1Schema,
} from "@happier-dev/protocol";

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { resolveCurrentClaimablePluginMachineMaterializationTx } from "@/app/plugins/availability/operations";
import { verifyPluginInstallationPublisherHeader } from "@/app/plugins/installations/publisherProof";
import { createPluginWebhookEndpointActionsV1 } from "@/app/plugins/webhooks/endpointActions";
import {
    claimPluginWebhookDeliveryV1,
    completePluginWebhookDeliveryV1,
    failPluginWebhookDeliveryV1,
    renewPluginWebhookDeliveryV1,
} from "@/app/plugins/webhooks/claimStore";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx } from "@/storage/inTx";
import type { Fastify } from "../../../types";

const DeliveryParamsSchema = z.object({
    deliveryId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
}).strict();

const CHECK_CORRESPONDENCE_PATH = "/v1/plugins/webhooks/endpoints/check-correspondence";
const EmptyQuerySchema = z.object({}).strict();
const PluginWebhookCheckCorrespondenceRequestSchema = z.object({
    caller: PluginMachineMaterializationRefV1Schema,
    input: PluginWebhookEndpointCheckCorrespondenceInputV1Schema,
}).strict();

type AuthenticatedPluginCallerV1 = Readonly<{ pluginId: string }>;
type AuthenticatePluginCallerV1 = (params: Readonly<{
    accountId: string;
    caller: Readonly<{
        pluginId: string;
        machineId: string;
        materializationId: string;
    }>;
    publisher: Readonly<{ machineId: string; installationId: string }>;
}>) => Promise<AuthenticatedPluginCallerV1 | null>;

const webhookEndpointActions = createPluginWebhookEndpointActionsV1();

type RouteDependencies = Readonly<{
    claim: typeof claimPluginWebhookDeliveryV1;
    renew: typeof renewPluginWebhookDeliveryV1;
    complete: typeof completePluginWebhookDeliveryV1;
    fail: typeof failPluginWebhookDeliveryV1;
    checkCorrespondence: typeof webhookEndpointActions.checkCorrespondence;
    authenticateCaller: AuthenticatePluginCallerV1;
    verifyPublisher: typeof verifyPluginInstallationPublisherHeader;
}>;

async function authenticateCurrentPluginCallerV1(params: Readonly<{
    accountId: string;
    caller: Readonly<{
        pluginId: string;
        machineId: string;
        materializationId: string;
    }>;
    publisher: Readonly<{ machineId: string; installationId: string }>;
}>): Promise<AuthenticatedPluginCallerV1 | null> {
    if (params.caller.machineId !== params.publisher.machineId) return null;
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    return await inTx(async (tx) => {
        const row = await tx.pluginMachineMaterialization.findUnique({
            where: {
                machineId_materializationId: {
                    machineId: params.caller.machineId,
                    materializationId: params.caller.materializationId,
                },
            },
            select: {
                accountId: true,
                pluginId: true,
                version: true,
                machine: { select: { installationId: true } },
            },
        });
        if (
            !row
            || row.accountId !== params.accountId
            || row.pluginId !== params.caller.pluginId
            || row.machine.installationId !== params.publisher.installationId
        ) return null;
        const current = await resolveCurrentClaimablePluginMachineMaterializationTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            machineId: params.caller.machineId,
            machineInstallationId: params.publisher.installationId,
            materializationId: params.caller.materializationId,
            pluginId: row.pluginId,
            version: row.version,
            requiredMachineOperationCapability: "pluginWebhookClaim",
        });
        return current.kind === "current" ? { pluginId: row.pluginId } : null;
    });
}

const DEFAULT_DEPENDENCIES: RouteDependencies = {
    claim: claimPluginWebhookDeliveryV1,
    renew: renewPluginWebhookDeliveryV1,
    complete: completePluginWebhookDeliveryV1,
    fail: failPluginWebhookDeliveryV1,
    checkCorrespondence: webhookEndpointActions.checkCorrespondence,
    authenticateCaller: authenticateCurrentPluginCallerV1,
    verifyPublisher: verifyPluginInstallationPublisherHeader,
};

function noStore(reply: { header(name: string, value: string): unknown }): void {
    reply.header("Cache-Control", "no-store");
}

type DaemonWebhookTargetV1 = Readonly<{
    materialization: Readonly<{ machineId: string }>;
    machineInstallationId: string;
}>;

async function authenticateExactTargetV1(params: Readonly<{
    dependencies: RouteDependencies;
    accountId: string;
    request: Readonly<{
        method?: string;
        url: string;
        headers?: Record<string, string | string[] | undefined>;
        body?: unknown;
    }>;
    target: DaemonWebhookTargetV1;
}>): Promise<boolean> {
    try {
        const publisher = await params.dependencies.verifyPublisher({
            accountId: params.accountId,
            request: params.request,
            path: params.request.url,
            required: true,
        });
        if (
            publisher?.machineId === params.target.materialization.machineId
            && publisher.installationId === params.target.machineInstallationId
        ) {
            return true;
        }
    } catch {
        // Authentication failures are deliberately indistinguishable at this boundary.
    }
    return false;
}

export function registerPluginWebhookDaemonRoutes(
    app: Fastify,
    dependencies: RouteDependencies = DEFAULT_DEPENDENCIES,
    env: NodeJS.ProcessEnv = process.env,
): void {
    const featureGate = createServerFeatureGatePreHandler("plugins.webhooks", env);
    const authenticatedWebhookPreHandler = [app.authenticate, featureGate];
    app.post(CHECK_CORRESPONDENCE_PATH, {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            querystring: EmptyQuerySchema,
            body: PluginWebhookCheckCorrespondenceRequestSchema,
            response: {
                200: PluginWebhookEndpointCheckCorrespondenceResultV1Schema,
                401: z.null(),
            },
        },
    }, async (request, reply) => {
        noStore(reply);
        let publisher: Awaited<ReturnType<RouteDependencies["verifyPublisher"]>>;
        try {
            publisher = await dependencies.verifyPublisher({
                accountId: request.userId,
                request,
                path: CHECK_CORRESPONDENCE_PATH,
                required: true,
            });
        } catch {
            return reply.code(401).send(null);
        }
        if (!publisher) return reply.code(401).send(null);
        if (request.body.caller.machineId !== publisher.machineId) {
            return reply.code(401).send(null);
        }
        const caller = await dependencies.authenticateCaller({
            accountId: request.userId,
            caller: request.body.caller,
            publisher,
        });
        if (!caller) {
            return await reply.send({ kind: "unavailable", code: "endpoint_unavailable" });
        }
        return await reply.send(await dependencies.checkCorrespondence({
            accountId: request.userId,
            callerPluginId: caller.pluginId,
            input: request.body.input,
        }));
    });

    app.post("/v1/daemon/plugins/webhooks/claim", {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookClaimRequestV1Schema,
            response: { 200: PluginWebhookClaimResultV1Schema, 401: z.null() },
        },
    }, async (request, reply) => {
        noStore(reply);
        if (!await authenticateExactTargetV1({
            dependencies,
            accountId: request.userId,
            request,
            target: request.body.target,
        })) return reply.code(401).send(null);
        return await reply.send(await dependencies.claim({
            accountId: request.userId,
            target: request.body.target,
        }));
    });

    app.post("/v1/daemon/plugins/webhooks/:deliveryId/renew", {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            params: DeliveryParamsSchema,
            body: PluginWebhookRenewRequestV1Schema,
            response: { 200: PluginWebhookRenewResultV1Schema, 401: z.null() },
        },
    }, async (request, reply) => {
        noStore(reply);
        if (!await authenticateExactTargetV1({
            dependencies,
            accountId: request.userId,
            request,
            target: request.body.target,
        })) return reply.code(401).send(null);
        return await reply.send(await dependencies.renew({
            accountId: request.userId,
            deliveryId: request.params.deliveryId,
            target: request.body.target,
            lease: request.body.lease,
            transition: request.body.transition,
        }));
    });

    app.post("/v1/daemon/plugins/webhooks/:deliveryId/complete", {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            params: DeliveryParamsSchema,
            body: PluginWebhookCompleteRequestV1Schema,
            response: { 200: PluginWebhookSettleResultV1Schema, 401: z.null() },
        },
    }, async (request, reply) => {
        noStore(reply);
        if (!await authenticateExactTargetV1({
            dependencies,
            accountId: request.userId,
            request,
            target: request.body.target,
        })) return reply.code(401).send(null);
        return await reply.send(await dependencies.complete({
            accountId: request.userId,
            deliveryId: request.params.deliveryId,
            target: request.body.target,
            lease: request.body.lease,
            disposition: request.body.result.disposition,
        }));
    });

    app.post("/v1/daemon/plugins/webhooks/:deliveryId/fail", {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            params: DeliveryParamsSchema,
            body: PluginWebhookFailRequestV1Schema,
            response: { 200: PluginWebhookSettleResultV1Schema, 401: z.null() },
        },
    }, async (request, reply) => {
        noStore(reply);
        if (!await authenticateExactTargetV1({
            dependencies,
            accountId: request.userId,
            request,
            target: request.body.target,
        })) return reply.code(401).send(null);
        return await reply.send(await dependencies.fail({
            accountId: request.userId,
            deliveryId: request.params.deliveryId,
            target: request.body.target,
            lease: request.body.lease,
            result: request.body.result,
            ...(request.body.automationAdmissionUnresolved === undefined
                ? {}
                : { automationAdmissionUnresolved: request.body.automationAdmissionUnresolved }),
        }));
    });
}
