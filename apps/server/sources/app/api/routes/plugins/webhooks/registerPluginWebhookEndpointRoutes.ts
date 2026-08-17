import {
    PluginWebhookActionHttpPathsV1,
    PluginWebhookDeliveryMovePendingInputV1Schema,
    PluginWebhookDeliveryMovePendingResultV1Schema,
    PluginWebhookEndpointEnsureInputV1Schema,
    PluginWebhookEndpointEnsureResultV1Schema,
    PluginWebhookEndpointCredentialConfigureInputV1Schema,
    PluginWebhookEndpointCredentialConfigureResultV1Schema,
    PluginWebhookEndpointCredentialFinishRotationInputV1Schema,
    PluginWebhookEndpointCredentialFinishRotationResultV1Schema,
    PluginWebhookEndpointCredentialRotateInputV1Schema,
    PluginWebhookEndpointCredentialRotateResultV1Schema,
    PluginWebhookEndpointReadInputV1Schema,
    PluginWebhookEndpointReadResultV1Schema,
    PluginWebhookEndpointRetargetInputV1Schema,
    PluginWebhookEndpointRetargetResultV1Schema,
    PluginWebhookEndpointRevokeInputV1Schema,
    PluginWebhookEndpointRevokeResultV1Schema,
    PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1,
    PLUGIN_WEBHOOK_DELIVERY_DISCARD_HTTP_PATH_V1,
    PLUGIN_WEBHOOK_DELIVERY_REPLAY_HTTP_PATH_V1,
    PluginWebhookAccountStatusRequestV1Schema,
    PluginWebhookAccountStatusResultV1Schema,
    PluginWebhookDeliveryDiscardInputV1Schema,
    PluginWebhookDeliveryDiscardResultV1Schema,
    PluginWebhookDeliveryReplayInputV1Schema,
    PluginWebhookDeliveryReplayResultV1Schema,
} from "@happier-dev/protocol";
import type { FastifyReply } from "fastify";

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import {
    createPluginWebhookEndpointActionsV1,
    type PluginWebhookEndpointActionsV1,
} from "@/app/plugins/webhooks/endpointActions";
import { PluginWebhookEndpointStoreError } from "@/app/plugins/webhooks/endpointStore";
import { readPluginWebhookAccountStatusV1 } from "@/app/plugins/webhooks/statusStore";
import {
    discardPluginWebhookDeliveryV1,
    replayPluginWebhookDeliveryV1,
} from "@/app/plugins/webhooks/retention";

import type { Fastify } from "../../../types";

type PresentUserEndpointActionsV1 = Pick<
    PluginWebhookEndpointActionsV1,
    | "ensure"
    | "read"
    | "revoke"
    | "retarget"
    | "movePending"
    | "configureCredential"
    | "rotateCredential"
    | "finishCredentialRotation"
>;

export type RegisterPluginWebhookEndpointRoutesOptions = Readonly<{
    /**
     * Supplied by the canonical GitHub/Connected Accounts authority once it
     * exists. Generic Webhooks neither infers nor recreates that authority.
     */
    authorizeSharedInstallation?: NonNullable<Parameters<typeof createPluginWebhookEndpointActionsV1>[0]>["authorizeSharedInstallation"];
}>;

function noStore(reply: { header(name: string, value: string): unknown }): void {
    reply.header("Cache-Control", "no-store");
}

function endpointErrorStatus(error: PluginWebhookEndpointStoreError): number {
    if (error.code === "idempotency_conflict" || error.code === "source_conflict") return 409;
    if (error.code === "identity_collision") return 503;
    return 404;
}

function sendEndpointError(reply: FastifyReply, error: PluginWebhookEndpointStoreError): void {
    reply.code(endpointErrorStatus(error)).send({ error: error.code });
}

export function registerPluginWebhookEndpointRoutes(
    app: Fastify,
    actions: PresentUserEndpointActionsV1 | undefined = undefined,
    env: NodeJS.ProcessEnv = process.env,
    options: RegisterPluginWebhookEndpointRoutesOptions = {},
): void {
    const resolvedActions = actions ?? createPluginWebhookEndpointActionsV1(
        options.authorizeSharedInstallation
            ? { authorizeSharedInstallation: options.authorizeSharedInstallation }
            : {},
    );
    const featureGate = createServerFeatureGatePreHandler("plugins.webhooks", env);
    const authenticatedWebhookPreHandler = [app.authenticate, featureGate];
    app.post(PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.ensure"], {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookEndpointEnsureInputV1Schema,
            response: { 200: PluginWebhookEndpointEnsureResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            return await reply.send(await resolvedActions.ensure({ accountId: request.userId, input: request.body }));
        } catch (error) {
            if (error instanceof PluginWebhookEndpointStoreError) {
                sendEndpointError(reply, error);
                return;
            }
            throw error;
        }
    });

    app.post(PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.read"], {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookEndpointReadInputV1Schema,
            response: { 200: PluginWebhookEndpointReadResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            return await reply.send(await resolvedActions.read({ accountId: request.userId, input: request.body }));
        } catch (error) {
            if (error instanceof PluginWebhookEndpointStoreError) {
                sendEndpointError(reply, error);
                return;
            }
            throw error;
        }
    });

    app.post(PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.revoke"], {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookEndpointRevokeInputV1Schema,
            response: { 200: PluginWebhookEndpointRevokeResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            return await reply.send(await resolvedActions.revoke({ accountId: request.userId, input: request.body }));
        } catch (error) {
            if (error instanceof PluginWebhookEndpointStoreError) {
                sendEndpointError(reply, error);
                return;
            }
            throw error;
        }
    });

    app.post(PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.retarget"], {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookEndpointRetargetInputV1Schema,
            response: { 200: PluginWebhookEndpointRetargetResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            return await reply.send(await resolvedActions.retarget({ accountId: request.userId, input: request.body }));
        } catch (error) {
            if (error instanceof PluginWebhookEndpointStoreError) {
                sendEndpointError(reply, error);
                return;
            }
            throw error;
        }
    });

    app.post(PluginWebhookActionHttpPathsV1["plugin.webhook.delivery.movePending"], {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookDeliveryMovePendingInputV1Schema,
            response: { 200: PluginWebhookDeliveryMovePendingResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        return await reply.send(await resolvedActions.movePending({ accountId: request.userId, input: request.body }));
    });

    app.post(PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.credential.configure"], {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookEndpointCredentialConfigureInputV1Schema,
            response: { 200: PluginWebhookEndpointCredentialConfigureResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            return await reply.send(await resolvedActions.configureCredential({
                accountId: request.userId,
                input: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginWebhookEndpointStoreError) {
                sendEndpointError(reply, error);
                return;
            }
            throw error;
        }
    });

    app.post(PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.credential.rotate"], {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookEndpointCredentialRotateInputV1Schema,
            response: { 200: PluginWebhookEndpointCredentialRotateResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        try {
            return await reply.send(await resolvedActions.rotateCredential({
                accountId: request.userId,
                input: request.body,
            }));
        } catch (error) {
            if (error instanceof PluginWebhookEndpointStoreError) {
                sendEndpointError(reply, error);
                return;
            }
            throw error;
        }
    });

    app.post(PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.credential.finishRotation"], {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookEndpointCredentialFinishRotationInputV1Schema,
            response: { 200: PluginWebhookEndpointCredentialFinishRotationResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        return await reply.send(await resolvedActions.finishCredentialRotation({
            accountId: request.userId,
            input: request.body,
        }));
    });

    app.post(PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1, {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookAccountStatusRequestV1Schema,
            response: { 200: PluginWebhookAccountStatusResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        return await reply.send(await readPluginWebhookAccountStatusV1({
            accountId: request.userId,
            input: request.body,
        }));
    });

    app.post(PLUGIN_WEBHOOK_DELIVERY_REPLAY_HTTP_PATH_V1, {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookDeliveryReplayInputV1Schema,
            response: { 200: PluginWebhookDeliveryReplayResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        return await reply.send(await replayPluginWebhookDeliveryV1({
            accountId: request.userId,
            deliveryId: request.body.deliveryId,
            expectedRevision: request.body.expectedRevision,
        }));
    });

    app.post(PLUGIN_WEBHOOK_DELIVERY_DISCARD_HTTP_PATH_V1, {
        preHandler: authenticatedWebhookPreHandler,
        schema: {
            body: PluginWebhookDeliveryDiscardInputV1Schema,
            response: { 200: PluginWebhookDeliveryDiscardResultV1Schema },
        },
    }, async (request, reply) => {
        noStore(reply);
        const result = await discardPluginWebhookDeliveryV1({
            accountId: request.userId,
            deliveryId: request.body.deliveryId,
            expectedRevision: request.body.expectedRevision,
            discardedByUserId: request.userId,
            reasonCode: "user_requested",
        });
        if (result.kind === "discarded") {
            return await reply.send(result);
        }
        return await reply.send({
            kind: result.kind === "revisionConflict" ? "revisionConflict" as const : "unavailable" as const,
        });
    });

}
