import type { Fastify } from "@/app/api/types";
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability/actions';
import { encodePluginAccountAvailabilityMaterializationsReadV1 } from '@happier-dev/protocol/plugins/availability/v1';
import type { FastifyReply } from "fastify";
import { EPHEMERAL_HOSTED_WEB_ASSET_DELIVERY_HEADERS_V1 } from '@happier-dev/protocol/plugins/ui/hostedWebAssetPolicy';

import {
    PluginInstallationPublisherProofError,
    verifyPluginInstallationPublisherHeader,
} from "@/app/plugins/installations/publisherProof";

import {
    PluginAvailabilityOperationError,
    createPluginAvailabilityOperations,
    type PluginAvailabilityOperations,
} from "./operations";
import {
    BROWSER_ARTIFACT_CAPABILITY_ROUTE_PATH,
} from "./browserArtifactCapability";

export type PluginAvailabilityRoutesOptions = Readonly<{
    operations?: PluginAvailabilityOperations;
}>;

function requestUserId(request: Readonly<{ userId?: unknown }>): string {
    if (typeof request.userId === "string" && request.userId.length > 0) {
        return request.userId;
    }
    throw new PluginAvailabilityOperationError(
        "plugin_availability_authentication_required",
    );
}

async function sendOperationError(
    reply: FastifyReply,
    error: unknown,
): Promise<void> {
    if (error instanceof PluginAvailabilityOperationError) {
        if (error.code === "managed_resources_review_required") {
            reply.code(409).send({ error: error.code, resources: error.resources });
            return;
        }
        const statusCode = error.code.endsWith("_not_found")
            ? 404
            : error.code === "plugin_availability_authentication_required"
                ? 401
                : error.code === "plugin_ui_artifact_hosting_unsupported"
                    || error.code === "plugin_package_asset_hosting_unsupported"
                    || error.code === "plugin_release_content_conflict"
                    || error.code === "plugin_intent_revision_conflict"
                    || error.code === "plugin_intent_release_selected"
                    || error.code === "plugin_collection_contract_conflict"
                    || error.code === "plugin_package_asset_conflict"
                    || error.code === "collection_quota_incompatible"
                    ? 409
                    : 400;
        reply.code(statusCode).send(
            error.code === "collection_quota_incompatible"
            && error.dimension !== undefined
            && error.effectiveMaximum !== undefined
                ? {
                    error: error.code,
                    dimension: error.dimension,
                    effectiveMaximum: error.effectiveMaximum,
                }
                : { error: error.code },
        );
        return;
    }
    if (error instanceof PluginInstallationPublisherProofError) {
        const code = error.code === "required"
            ? "plugin_availability_publisher_proof_required"
            : error.code === "expired"
                ? "plugin_availability_publisher_proof_expired"
                : "plugin_availability_publisher_proof_invalid";
        reply.code(403).send({ error: code });
        return;
    }
    throw error;
}

/**
 * The one HTTP projection of the Availability action family. Present-user
 * operations are Account-authenticated; only machine publication additionally
 * requires the incumbent installation-publisher proof.
 */
export function registerPluginAvailabilityRoutes(
    app: Fastify,
    options: PluginAvailabilityRoutesOptions = {},
): void {
    const operations = options.operations ?? createPluginAvailabilityOperations();
    const intentReadPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.intent.read"
    ];
    const intentsListPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.intents.list"
    ];
    const intentSetPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.intent.set"
    ];
    const collectionWritersClaimPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.collectionWriters.claim"
    ];
    const releaseReadPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.release.read"
    ];
    const releasePublishPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.release.publish"
    ];
    const materializationsReportPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.materializations.report"
    ];
    const materializationsReadPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.materializations.read"
    ];
    const uiArtifactPublishPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.uiArtifact.publish"
    ];
    const uiArtifactReadPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.uiArtifact.read"
    ];
    const uiArtifactRemovePath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.uiArtifact.remove"
    ];
    const uiArtifactBrowserFrameIssuePath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.uiArtifact.browserFrame.issue"
    ];
    const packageAssetPublishPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.packageAsset.publish"
    ];
    const packageAssetReadPath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.packageAsset.read"
    ];
    const packageAssetRemovePath = PluginAvailabilityActionHttpPathsV1[
        "account.plugins.availability.packageAsset.remove"
    ];

    // This is intentionally the sole unauthenticated Availability route. The
    // opaque bearer path has no Account/API authority; its operation rechecks
    // the sealed scope, deployment origin, current hosting, and static policy
    // before returning a byte response.
    app.get(BROWSER_ARTIFACT_CAPABILITY_ROUTE_PATH, async (request, reply) => {
        for (const [name, value] of Object.entries(
            EPHEMERAL_HOSTED_WEB_ASSET_DELIVERY_HEADERS_V1,
        )) {
            reply.header(name, value);
        }
        try {
            const params = request.params as Readonly<{
                capability?: unknown;
                "*"?: unknown;
            }>;
            const response = await operations.readBrowserArtifactFrame({
                capability: typeof params.capability === "string" ? params.capability : "",
                requestPath: typeof params["*"] === "string" ? params["*"] : "",
                request: {
                    protocol: request.protocol,
                    host: request.host,
                },
            });
            reply.header("content-type", response.contentType);
            for (const [name, value] of Object.entries(response.headers)) {
                reply.header(name, value);
            }
            return reply.send(Buffer.from(response.bytes));
        } catch (error) {
            if (error instanceof PluginAvailabilityOperationError) {
                return reply.code(404).send({ error: "Not found" });
            }
            throw error;
        }
    });

    app.post(intentReadPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.readIntent({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(intentsListPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.listIntentIds({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(intentSetPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.setIntent({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(collectionWritersClaimPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const accountId = requestUserId(request);
            const publisher = await verifyPluginInstallationPublisherHeader({
                accountId, request, path: collectionWritersClaimPath,
            });
            return await operations.claimCollectionWriters({
                accountId,
                input: request.body,
                ...(publisher ? { publisher } : {}),
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(releaseReadPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.readRelease({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(materializationsReadPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            // Transport encoding: identical Machine UI-artifact lists are sent once.
            return encodePluginAccountAvailabilityMaterializationsReadV1(await operations.readMaterializations({
                accountId: requestUserId(request),
                input: request.body,
            }));
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(uiArtifactPublishPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.publishUiArtifact({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(uiArtifactReadPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await operations.readUiArtifact({
                accountId: requestUserId(request),
                input: request.body,
            });
            return result;
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(packageAssetPublishPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.publishPackageAsset({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(packageAssetReadPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await operations.readPackageAsset({
                accountId: requestUserId(request),
                input: request.body,
            });
            return result;
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(packageAssetRemovePath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.removePackageAsset({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(uiArtifactBrowserFrameIssuePath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.issueBrowserArtifactFrame({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(uiArtifactRemovePath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            return await operations.removeUiArtifact({
                accountId: requestUserId(request),
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(releasePublishPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const accountId = requestUserId(request);
            await verifyPluginInstallationPublisherHeader({
                accountId,
                request,
                path: releasePublishPath,
                required: true,
            });
            return await operations.publishRelease({
                accountId,
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });

    app.post(materializationsReportPath, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const accountId = requestUserId(request);
            const publisher = await verifyPluginInstallationPublisherHeader({
                accountId,
                request,
                path: materializationsReportPath,
                required: true,
            });
            if (!publisher) {
                throw new PluginAvailabilityOperationError(
                    "plugin_availability_publisher_proof_required",
                );
            }
            return await operations.reportMaterializations({
                accountId,
                publisherMachineId: publisher.machineId,
                input: request.body,
            });
        } catch (error) {
            await sendOperationError(reply, error);
            return;
        }
    });
}
