import { z } from "zod/mini";

import { PluginWebhookClaimRequestV1Schema, PluginWebhookClaimResultV1Schema, PluginWebhookCompleteRequestV1Schema, PluginWebhookFailRequestV1Schema, PluginWebhookRenewRequestV1Schema, PluginWebhookRenewResultV1Schema, PluginWebhookSettleResultV1Schema, type PluginWebhookClaimRequestV1, type PluginWebhookClaimResultV1 } from '@happier-dev/protocol/plugins/webhooks/deliveryV1';
import { PluginMachineMaterializationRefV1Schema } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { PluginWebhookEndpointCheckCorrespondenceInputV1Schema, PluginWebhookEndpointCheckCorrespondenceResultV1Schema, PluginWebhookEndpointConvergeTargetInputV1Schema, PluginWebhookEndpointConvergeTargetResultV1Schema, PluginWebhookPluginSurfaceActionHttpPathsV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1, PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1, PluginWebhookEndpointEnsureInputV1Schema, PluginWebhookEndpointEnsureResultV1Schema, PluginWebhookHeartbeatReadInputV1Schema, PluginWebhookHeartbeatReadResultV1Schema } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { PLUGIN_WEBHOOK_HEARTBEAT_MANAGE_PATH_V1, PluginWebhookHeartbeatManageInputV1Schema, PluginWebhookHeartbeatManageResultV1Schema } from '@happier-dev/protocol/plugins/webhooks/endpointV1';

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { authenticateCurrentPluginMaterializationCallerV1 } from "@/app/plugins/availability/callerMaterialization";
import {
    verifyPluginInstallationPublisherHeader,
    type VerifiedPluginInstallationPublisher,
} from "@/app/plugins/installations/publisherProof";
import { createPluginWebhookEndpointActionsV1 } from "@/app/plugins/webhooks/endpointActions";
import { PluginWebhookEndpointStoreError } from "@/app/plugins/webhooks/endpointStore";
import {
    claimPluginWebhookDeliveryV1,
    completePluginWebhookDeliveryV1,
    failPluginWebhookDeliveryV1,
    renewPluginWebhookDeliveryV1,
} from "@/app/plugins/webhooks/claimStore";
import type { Fastify } from "../../../types";

const DeliveryParamsSchema = z.strictObject({
    deliveryId: z.string().check(z.regex(/^[A-Za-z0-9._:-]{1,128}$/u)),
});

const CHECK_CORRESPONDENCE_PATH = PluginWebhookPluginSurfaceActionHttpPathsV1[
    "plugin.webhook.endpoint.checkCorrespondence"
];
const CONVERGE_TARGET_PATH = PluginWebhookPluginSurfaceActionHttpPathsV1[
    "plugin.webhook.endpoint.convergeTarget"
];
const EmptyQuerySchema = z.strictObject({});
const PluginWebhookCheckCorrespondenceRequestSchema = z.strictObject({
    caller: PluginMachineMaterializationRefV1Schema,
    input: PluginWebhookEndpointCheckCorrespondenceInputV1Schema,
});
const PluginWebhookConvergeTargetRequestSchema = z.strictObject({
    caller: PluginMachineMaterializationRefV1Schema,
    input: PluginWebhookEndpointConvergeTargetInputV1Schema,
});

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
    convergeTarget: typeof webhookEndpointActions.convergeTarget;
    ensureHeartbeat?: typeof webhookEndpointActions.ensureHeartbeat;
    readHeartbeat?: typeof webhookEndpointActions.readHeartbeat;
    manageHeartbeat?: typeof webhookEndpointActions.manageHeartbeat;
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
    claim: claimPluginWebhookDeliveryV1,
    renew: renewPluginWebhookDeliveryV1,
    complete: completePluginWebhookDeliveryV1,
    fail: failPluginWebhookDeliveryV1,
    checkCorrespondence: webhookEndpointActions.checkCorrespondence,
    convergeTarget: webhookEndpointActions.convergeTarget,
    ensureHeartbeat: webhookEndpointActions.ensureHeartbeat,
    readHeartbeat: webhookEndpointActions.readHeartbeat,
    manageHeartbeat: webhookEndpointActions.manageHeartbeat,
    authenticateCaller: authenticateCurrentPluginCallerV1,
    verifyPublisher: verifyPluginInstallationPublisherHeader,
};

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
    /**
     * The one plugin-surface endpoint admission. Both bounded plugin endpoint
     * operations authorize identically — signed publisher proof for the exact
     * calling machine, then the shared current-caller-materialization owner —
     * so neither can drift into a weaker principal boundary than the other,
     * and an unauthenticated caller learns nothing beyond the same opaque
     * unavailable answer.
     */
    const admitPluginSurfaceEndpointCaller = async (params: Readonly<{
        path: string;
        accountId: string;
        request: Parameters<RouteDependencies["verifyPublisher"]>[0]["request"];
        caller: Readonly<{ pluginId: string; machineId: string; materializationId: string }>;
    }>): Promise<AuthenticatedPluginCallerV1 | "unauthenticated" | "unavailable"> => {
        let publisher: Awaited<ReturnType<RouteDependencies["verifyPublisher"]>>;
        try {
            publisher = await dependencies.verifyPublisher({
                accountId: params.accountId,
                request: params.request,
                path: params.path,
                required: true,
            });
        } catch {
            return "unauthenticated";
        }
        if (!publisher || params.caller.machineId !== publisher.machineId) return "unauthenticated";
        const caller = await dependencies.authenticateCaller({
            accountId: params.accountId,
            caller: params.caller,
            publisher,
        });
        return caller ?? "unavailable";
    };

    app.post(PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1, {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            querystring: EmptyQuerySchema,
            body: z.strictObject({ caller: PluginMachineMaterializationRefV1Schema, input: PluginWebhookEndpointEnsureInputV1Schema }),
            response: { 200: z.union([PluginWebhookEndpointEnsureResultV1Schema, PluginWebhookHeartbeatReadResultV1Schema]), 401: z.null() },
        },
    }, async (request, reply) => {
        noStore(reply);
        const caller = await admitPluginSurfaceEndpointCaller({ path: PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1,
            accountId: request.userId, request, caller: request.body.caller });
        if (caller === "unauthenticated") return reply.code(401).send(null);
        if (caller === "unavailable") return reply.send({ kind: "unavailable", code: "endpoint_unavailable" });
        // Endpoint creation is a host effect for this exact observation host.
        const target = request.body.input.targetMaterialization;
        if (target.machineId !== request.body.caller.machineId || target.materializationId !== request.body.caller.materializationId
            || target.pluginId !== caller.pluginId) return reply.send({ kind: "unavailable", code: "endpoint_unavailable" });
        try {
            return reply.send(await (dependencies.ensureHeartbeat ?? webhookEndpointActions.ensureHeartbeat)({
                accountId: request.userId, callerPluginId: caller.pluginId, input: request.body.input,
            }));
        } catch (error) {
            if (!(error instanceof PluginWebhookEndpointStoreError)) throw error;
            return reply.send({ kind: "unavailable", code: "endpoint_unavailable" });
        }
    });

    app.post(PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1, {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            querystring: EmptyQuerySchema,
            body: z.strictObject({ caller: PluginMachineMaterializationRefV1Schema, input: PluginWebhookHeartbeatReadInputV1Schema }),
            response: { 200: PluginWebhookHeartbeatReadResultV1Schema, 401: z.null() },
        },
    }, async (request, reply) => {
        noStore(reply);
        const caller = await admitPluginSurfaceEndpointCaller({ path: PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1,
            accountId: request.userId, request, caller: request.body.caller });
        if (caller === "unauthenticated") return reply.code(401).send(null);
        if (caller === "unavailable") return reply.send({ kind: "unavailable", code: "endpoint_unavailable" });
        return reply.send(await (dependencies.readHeartbeat ?? webhookEndpointActions.readHeartbeat)({
            accountId: request.userId, caller: request.body.caller, input: request.body.input,
        }));
    });

    app.post(PLUGIN_WEBHOOK_HEARTBEAT_MANAGE_PATH_V1, {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            querystring: EmptyQuerySchema,
            body: z.strictObject({ caller: PluginMachineMaterializationRefV1Schema, input: PluginWebhookHeartbeatManageInputV1Schema }),
            response: { 200: PluginWebhookHeartbeatManageResultV1Schema, 401: z.null() },
        },
    }, async (request, reply) => {
        noStore(reply);
        const caller = await admitPluginSurfaceEndpointCaller({ path: PLUGIN_WEBHOOK_HEARTBEAT_MANAGE_PATH_V1,
            accountId: request.userId, request, caller: request.body.caller });
        if (caller === 'unauthenticated') return reply.code(401).send(null);
        if (caller === 'unavailable') return reply.send({ kind: 'unavailable', code: 'endpoint_unavailable' });
        return reply.send(await (dependencies.manageHeartbeat ?? webhookEndpointActions.manageHeartbeat)({
            accountId: request.userId, caller: request.body.caller, input: request.body.input,
        }));
    });

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
        const caller = await admitPluginSurfaceEndpointCaller({
            path: CHECK_CORRESPONDENCE_PATH,
            accountId: request.userId,
            request,
            caller: request.body.caller,
        });
        if (caller === "unauthenticated") return reply.code(401).send(null);
        if (caller === "unavailable") {
            return await reply.send({ kind: "unavailable", code: "endpoint_unavailable" });
        }
        return await reply.send(await dependencies.checkCorrespondence({
            accountId: request.userId,
            callerPluginId: caller.pluginId,
            input: request.body.input,
        }));
    });

    app.post(CONVERGE_TARGET_PATH, {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            querystring: EmptyQuerySchema,
            body: PluginWebhookConvergeTargetRequestSchema,
            response: {
                200: PluginWebhookEndpointConvergeTargetResultV1Schema,
                401: z.null(),
            },
        },
    }, async (request, reply) => {
        noStore(reply);
        const caller = await admitPluginSurfaceEndpointCaller({
            path: CONVERGE_TARGET_PATH,
            accountId: request.userId,
            request,
            caller: request.body.caller,
        });
        if (caller === "unauthenticated") return reply.code(401).send(null);
        if (caller === "unavailable") {
            return await reply.send({ kind: "unavailable", code: "endpoint_unavailable" });
        }
        return await reply.send(await dependencies.convergeTarget({
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
        // Answers at once: nothing is parked. An empty claim names the
        // installation's own next deadline; new work arrives as the Machine wake.
        return await reply.send(await dependencies.claim(
            { accountId: request.userId, machine: request.body.machine },
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
