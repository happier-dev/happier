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
    type PluginWebhookClaimRequestV1,
    type PluginWebhookClaimResultV1,
} from "@happier-dev/protocol";

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { authenticateCurrentPluginMaterializationCallerV1 } from "@/app/plugins/availability/callerMaterialization";
import {
    verifyPluginInstallationPublisherHeader,
    type VerifiedPluginInstallationPublisher,
} from "@/app/plugins/installations/publisherProof";
import { createPluginWebhookEndpointActionsV1 } from "@/app/plugins/webhooks/endpointActions";
import {
    claimPluginWebhookDeliveryWithBoundedWaitV1,
    completePluginWebhookDeliveryV1,
    failPluginWebhookDeliveryV1,
    renewPluginWebhookDeliveryV1,
} from "@/app/plugins/webhooks/claimStore";
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
    claim: typeof claimPluginWebhookDeliveryWithBoundedWaitV1;
    renew: typeof renewPluginWebhookDeliveryV1;
    complete: typeof completePluginWebhookDeliveryV1;
    fail: typeof failPluginWebhookDeliveryV1;
    checkCorrespondence: typeof webhookEndpointActions.checkCorrespondence;
    authenticateCaller: AuthenticatePluginCallerV1;
    verifyPublisher: typeof verifyPluginInstallationPublisherHeader;
}>;

/**
 * Webhook delivery adds the exact machine operation capability required to
 * claim; the shared exact-caller owner supplies every other admission fact.
 */
const authenticateCurrentPluginCallerV1: AuthenticatePluginCallerV1 = (params) => (
    authenticateCurrentPluginMaterializationCallerV1({
        ...params,
        requiredMachineOperationCapability: "pluginWebhookClaim",
    })
);

const DEFAULT_DEPENDENCIES: RouteDependencies = {
    claim: claimPluginWebhookDeliveryWithBoundedWaitV1,
    renew: renewPluginWebhookDeliveryV1,
    complete: completePluginWebhookDeliveryV1,
    fail: failPluginWebhookDeliveryV1,
    checkCorrespondence: webhookEndpointActions.checkCorrespondence,
    authenticateCaller: authenticateCurrentPluginCallerV1,
    verifyPublisher: verifyPluginInstallationPublisherHeader,
};

/** Per-request cancellation for the parked claim long poll. */
const claimAbortControllers = new WeakMap<object, AbortController>();

function noStore(reply: { header(name: string, value: string): unknown }): void {
    reply.header("Cache-Control", "no-store");
}

type DaemonWebhookTargetV1 = Extract<PluginWebhookClaimResultV1, { kind: "delivery" }>["target"];
type DaemonWebhookMachineInstallationV1 = PluginWebhookClaimRequestV1["machine"];

async function authenticateMachineInstallationV1<TPublisher extends VerifiedPluginInstallationPublisher>(params: Readonly<{
    accountId: string;
    request: Readonly<{
        method?: string;
        url: string;
        headers?: Record<string, string | string[] | undefined>;
        body?: unknown;
    }>;
    machineId: DaemonWebhookMachineInstallationV1["machineId"] | DaemonWebhookTargetV1["materialization"]["machineId"];
    machineInstallationId: DaemonWebhookMachineInstallationV1["machineInstallationId"] | DaemonWebhookTargetV1["machineInstallationId"];
    verifyPublisher: (params: Parameters<typeof verifyPluginInstallationPublisherHeader>[0]) => Promise<TPublisher | null>;
}>): Promise<TPublisher | null> {
    try {
        const publisher = await params.verifyPublisher({
            accountId: params.accountId,
            request: params.request,
            path: params.request.url,
            required: true,
        });
        if (
            publisher?.machineId === params.machineId
            && publisher.installationId === params.machineInstallationId
        ) {
            return publisher;
        }
    } catch {
        // Authentication failures are deliberately indistinguishable at this boundary.
    }
    return null;
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
        onRequest: async (request) => {
            claimAbortControllers.set(request, new AbortController());
        },
        onRequestAbort: async (request) => {
            claimAbortControllers.get(request)?.abort(new Error("plugin_webhook_claim_client_aborted"));
        },
        schema: {
            body: PluginWebhookClaimRequestV1Schema,
            response: { 200: PluginWebhookClaimResultV1Schema, 401: z.null() },
        },
    }, async (request, reply) => {
        noStore(reply);
        // One claim per Account/machine installation. The signed machine
        // installation proof must match the requested installation exactly;
        // the server selects the one eligible exact materialization target.
        const publisher = await authenticateMachineInstallationV1({
            accountId: request.userId,
            request,
            machineId: request.body.machine.machineId,
            machineInstallationId: request.body.machine.machineInstallationId,
            verifyPublisher: dependencies.verifyPublisher,
        });
        if (!publisher) return reply.code(401).send(null);
        const signal = claimAbortControllers.get(request)?.signal;
        // The parked window is the claim owner's fixed implementation
        // constant; the route carries no policy input except the disconnect
        // abort signal.
        return await reply.send(await dependencies.claim(
            { accountId: request.userId, machine: request.body.machine },
            signal ? { signal } : {},
        ));
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
        if (!await authenticateMachineInstallationV1({
            accountId: request.userId,
            request,
            machineId: request.body.target.materialization.machineId,
            machineInstallationId: request.body.target.machineInstallationId,
            verifyPublisher: dependencies.verifyPublisher,
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
        if (!await authenticateMachineInstallationV1({
            accountId: request.userId,
            request,
            machineId: request.body.target.materialization.machineId,
            machineInstallationId: request.body.target.machineInstallationId,
            verifyPublisher: dependencies.verifyPublisher,
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
        if (!await authenticateMachineInstallationV1({
            accountId: request.userId,
            request,
            machineId: request.body.target.materialization.machineId,
            machineInstallationId: request.body.target.machineInstallationId,
            verifyPublisher: dependencies.verifyPublisher,
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
