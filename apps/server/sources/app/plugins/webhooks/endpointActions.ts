import {
    PluginWebhookEndpointCredentialConfigureResultV1Schema,
    PluginWebhookEndpointCredentialFinishRotationResultV1Schema,
    PluginWebhookEndpointCredentialRotateResultV1Schema,
    type PluginWebhookEndpointCredentialConfigureInputV1,
    type PluginWebhookEndpointCredentialConfigureResultV1,
    type PluginWebhookEndpointCredentialFinishRotationInputV1,
    type PluginWebhookEndpointCredentialFinishRotationResultV1,
    type PluginWebhookEndpointCredentialRotateInputV1,
    type PluginWebhookEndpointCredentialRotateResultV1,
    type PluginWebhookDeliveryMovePendingInputV1,
    type PluginWebhookEndpointCheckCorrespondenceInputV1,
    type PluginWebhookEndpointCheckCorrespondenceResultV1,
    type PluginWebhookEndpointEnsureInputV1,
    type PluginWebhookEndpointReadInputV1,
    type PluginWebhookEndpointRetargetInputV1,
    type PluginWebhookEndpointRevokeInputV1,
} from "@happier-dev/protocol";

import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveConfiguredCanonicalServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import { movePendingPluginWebhookDeliveriesV1 } from "./deliveryStore";
import {
    createInitialPluginWebhookCredentialTxV1,
    finishPluginWebhookCredentialRotationTxV1,
    rotatePluginWebhookCredentialTxV1,
} from "./credentialStore";
import { createGeneratedPluginWebhookCredentialMaterialV1 } from "./credentialMaterial";
import { resolveCurrentPluginWebhookContributionTxV1 } from "./currentContribution";
import { resolveCurrentPluginWebhookTargetTxV1 } from "./currentTarget";
import { checkCurrentPluginWebhookEndpointCorrespondenceTxV1 } from "./endpointCorrespondence";
import {
    createPluginWebhookEndpointStoreV1,
    PluginWebhookEndpointStoreError,
    type ResolvedPluginWebhookContributionV1,
    type ResolvedPluginWebhookTargetV1,
} from "./endpointStore";

type CredentialRandomBytesV1 = (length: number) => Uint8Array;

export async function configurePluginWebhookEndpointCredentialV1(params: Readonly<{
    accountId: string;
    input: PluginWebhookEndpointCredentialConfigureInputV1;
    randomBytes?: CredentialRandomBytesV1;
}>): Promise<PluginWebhookEndpointCredentialConfigureResultV1> {
    return await inTx(async (tx) => {
        const endpoint = await tx.pluginWebhookEndpoint.findFirst({
            where: { id: params.input.webhookEndpointId, accountId: params.accountId },
            select: {
                revision: true,
                enabled: true,
                revokedAt: true,
                routingKind: true,
                routeId: true,
                route: {
                    select: {
                        currentCredential: { select: { credentialVersionId: true } },
                    },
                },
            },
        });
        if (!endpoint || !endpoint.enabled || endpoint.revokedAt !== null || endpoint.routingKind !== "accountEndpoint") {
            throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
        }
        if (endpoint.route.currentCredential) {
            if (
                endpoint.revision !== params.input.expectedRevision
                && endpoint.revision !== params.input.expectedRevision + 1
            ) {
                throw new PluginWebhookEndpointStoreError("idempotency_conflict");
            }
            return PluginWebhookEndpointCredentialConfigureResultV1Schema.parse({
                kind: "alreadyConfigured",
                webhookEndpointId: params.input.webhookEndpointId,
                revision: endpoint.revision,
                credentialVersionId: endpoint.route.currentCredential.credentialVersionId,
            });
        }
        if (endpoint.revision !== params.input.expectedRevision) {
            throw new PluginWebhookEndpointStoreError("idempotency_conflict");
        }
        const material = createGeneratedPluginWebhookCredentialMaterialV1({
            ...(params.randomBytes ? { randomBytes: params.randomBytes } : {}),
        });
        await createInitialPluginWebhookCredentialTxV1(tx, {
            routeId: endpoint.routeId,
            credentialVersionId: material.credentialVersionId,
            secret: material.secret,
        });
        const updated = await tx.pluginWebhookEndpoint.updateMany({
            where: {
                id: params.input.webhookEndpointId,
                accountId: params.accountId,
                revision: params.input.expectedRevision,
            },
            data: { revision: { increment: 1 } },
        });
        if (updated.count !== 1) throw new PluginWebhookEndpointStoreError("idempotency_conflict");
        return PluginWebhookEndpointCredentialConfigureResultV1Schema.parse({
            kind: "configured",
            webhookEndpointId: params.input.webhookEndpointId,
            revision: endpoint.revision + 1,
            credentialVersionId: material.credentialVersionId,
            oneTimeGeneratedSecret: material.secret,
        });
    });
}

export async function rotatePluginWebhookEndpointCredentialV1(params: Readonly<{
    accountId: string;
    input: PluginWebhookEndpointCredentialRotateInputV1;
    randomBytes?: CredentialRandomBytesV1;
    now?: Date;
}>): Promise<PluginWebhookEndpointCredentialRotateResultV1> {
    return await inTx(async (tx) => {
        const endpoint = await tx.pluginWebhookEndpoint.findFirst({
            where: { id: params.input.webhookEndpointId, accountId: params.accountId },
            select: {
                revision: true,
                enabled: true,
                revokedAt: true,
                routingKind: true,
                routeId: true,
            },
        });
        if (!endpoint || !endpoint.enabled || endpoint.revokedAt !== null || endpoint.routingKind !== "accountEndpoint") {
            throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
        }
        // Rotation carries no operation identity, so `expectedRevision + 1`
        // cannot tell "my rotation committed and its response was lost" from
        // "an unrelated retarget bumped the revision while an earlier
        // rotation's previous credential is still inside its overlap window".
        // Reporting the second case as a completed rotation hands the caller
        // another request's credential versions as its own result, so this
        // owner returns the truthful conflict and the caller rereads. Unlike
        // finish-rotation, whose input names the exact previous credential it
        // expects to be retired, nothing here corresponds to this request.
        if (endpoint.revision !== params.input.expectedRevision) {
            throw new PluginWebhookEndpointStoreError("idempotency_conflict");
        }
        const material = createGeneratedPluginWebhookCredentialMaterialV1({
            ...(params.randomBytes ? { randomBytes: params.randomBytes } : {}),
        });
        const rotated = await rotatePluginWebhookCredentialTxV1(tx, {
            routeId: endpoint.routeId,
            credentialVersionId: material.credentialVersionId,
            secret: material.secret,
            ...(params.now ? { now: params.now } : {}),
        });
        const updated = await tx.pluginWebhookEndpoint.updateMany({
            where: {
                id: params.input.webhookEndpointId,
                accountId: params.accountId,
                revision: params.input.expectedRevision,
            },
            data: { revision: { increment: 1 } },
        });
        if (updated.count !== 1) throw new PluginWebhookEndpointStoreError("idempotency_conflict");
        return PluginWebhookEndpointCredentialRotateResultV1Schema.parse({
            kind: "rotated",
            webhookEndpointId: params.input.webhookEndpointId,
            revision: endpoint.revision + 1,
            credentialVersionId: rotated.credentialVersionId,
            previousCredentialVersionId: rotated.previousCredentialVersionId,
            previousAcceptUntilMs: rotated.previousAcceptUntil.getTime(),
            oneTimeGeneratedSecret: rotated.secret,
        });
    });
}

export async function finishPluginWebhookEndpointCredentialRotationV1(params: Readonly<{
    accountId: string;
    input: PluginWebhookEndpointCredentialFinishRotationInputV1;
}>): Promise<PluginWebhookEndpointCredentialFinishRotationResultV1> {
    return await inTx(async (tx) => {
        const endpoint = await tx.pluginWebhookEndpoint.findFirst({
            where: { id: params.input.webhookEndpointId, accountId: params.accountId },
            select: {
                revision: true,
                enabled: true,
                revokedAt: true,
                routingKind: true,
                routeId: true,
                route: { select: { previousCredentialId: true } },
            },
        });
        if (!endpoint || !endpoint.enabled || endpoint.revokedAt !== null || endpoint.routingKind !== "accountEndpoint") {
            return { kind: "unavailable" };
        }
        if (
            endpoint.revision === params.input.expectedRevision + 1
            && endpoint.route.previousCredentialId === null
        ) {
            return PluginWebhookEndpointCredentialFinishRotationResultV1Schema.parse({
                kind: "alreadyRetired",
                webhookEndpointId: params.input.webhookEndpointId,
                revision: endpoint.revision,
            });
        }
        if (endpoint.revision !== params.input.expectedRevision) {
            return { kind: "revisionConflict", currentRevision: endpoint.revision };
        }
        const result = await finishPluginWebhookCredentialRotationTxV1(tx, {
            routeId: endpoint.routeId,
            expectedPreviousCredentialVersionId: params.input.expectedPreviousCredentialVersionId,
        });
        if (result.kind === "credentialChanged" || result.kind === "unavailable") {
            return { kind: result.kind, currentRevision: endpoint.revision };
        }
        const revision = result.kind === "retired" ? endpoint.revision + 1 : endpoint.revision;
        if (result.kind === "retired") {
            const updated = await tx.pluginWebhookEndpoint.updateMany({
                where: {
                    id: params.input.webhookEndpointId,
                    accountId: params.accountId,
                    revision: params.input.expectedRevision,
                },
                data: { revision: { increment: 1 } },
            });
            if (updated.count !== 1) {
                return { kind: "revisionConflict", currentRevision: endpoint.revision };
            }
        }
        return PluginWebhookEndpointCredentialFinishRotationResultV1Schema.parse({
            kind: result.kind,
            webhookEndpointId: params.input.webhookEndpointId,
            revision,
        });
    });
}

async function resolveCurrentWebhookTargetV1(params: Readonly<{
    accountId: string;
    target: ResolvedPluginWebhookTargetV1["materialization"];
}>): Promise<ResolvedPluginWebhookTargetV1 | null> {
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    return await inTx(async (tx) => await resolveCurrentPluginWebhookTargetTxV1({
        tx,
        serverIdentityId,
        accountId: params.accountId,
        target: params.target,
    }));
}

async function resolveCurrentWebhookContributionV1(params: Readonly<{
    accountId: string;
    contribution: Readonly<{ pluginId: string; localId: string }>;
    target: ResolvedPluginWebhookTargetV1;
}>): Promise<ResolvedPluginWebhookContributionV1 | null> {
    return await inTx(async (tx) => await resolveCurrentPluginWebhookContributionTxV1({
        tx,
        ...params,
    }));
}

async function isCurrentCallerPluginEnabledV1(accountId: string, pluginId: string): Promise<boolean> {
    const intent = await db.accountPluginIntent.findUnique({
        where: { accountId_pluginId: { accountId, pluginId } },
        select: { enabled: true, desiredVersion: true },
    });
    return intent?.enabled === true && intent.desiredVersion !== null;
}

/**
 * Canonical host Action adapter for Account webhook endpoint lifecycle. The
 * caller supplies only host-stamped principal facts; Account and plugin caller
 * identity never come from Action input.
 */
export function createPluginWebhookEndpointActionsV1(options: Readonly<{
    authorizeSharedInstallation?: Parameters<typeof createPluginWebhookEndpointStoreV1>[0]["authorizeSharedInstallation"];
}> = {}) {
    const store = createPluginWebhookEndpointStoreV1({
        resolveTarget: resolveCurrentWebhookTargetV1,
        resolveContribution: resolveCurrentWebhookContributionV1,
        resolvePublicBaseUrl: () => resolveConfiguredCanonicalServerUrl(process.env) ?? null,
        ...(options.authorizeSharedInstallation
            ? { authorizeSharedInstallation: options.authorizeSharedInstallation }
            : {}),
    });

    return {
        ensure: async (params: Readonly<{ accountId: string; input: PluginWebhookEndpointEnsureInputV1 }>) => (
            await store.ensure({ accountId: params.accountId, ...params.input })
        ),
        read: async (params: Readonly<{ accountId: string; input: PluginWebhookEndpointReadInputV1 }>) => (
            await store.read({ accountId: params.accountId, ...params.input })
        ),
        revoke: async (params: Readonly<{ accountId: string; input: PluginWebhookEndpointRevokeInputV1 }>) => (
            await store.revoke({ accountId: params.accountId, ...params.input })
        ),
        retarget: async (params: Readonly<{ accountId: string; input: PluginWebhookEndpointRetargetInputV1 }>) => (
            await store.retarget({ accountId: params.accountId, ...params.input })
        ),
        movePending: async (params: Readonly<{
            accountId: string;
            input: PluginWebhookDeliveryMovePendingInputV1;
        }>) => await movePendingPluginWebhookDeliveriesV1({ accountId: params.accountId, ...params.input }),
        configureCredential: configurePluginWebhookEndpointCredentialV1,
        rotateCredential: rotatePluginWebhookEndpointCredentialV1,
        finishCredentialRotation: finishPluginWebhookEndpointCredentialRotationV1,
        /**
         * Plugin caller authentication stays here, at the public Action
         * boundary. The correspondence decision itself belongs to the single
         * transaction-scoped owner shared with the Automation writer.
         */
        checkCorrespondence: async (params: Readonly<{
            accountId: string;
            callerPluginId: string;
            input: PluginWebhookEndpointCheckCorrespondenceInputV1;
        }>): Promise<PluginWebhookEndpointCheckCorrespondenceResultV1> => {
            if (
                params.callerPluginId.length === 0
                || !await isCurrentCallerPluginEnabledV1(params.accountId, params.callerPluginId)
            ) {
                return { kind: "unavailable", code: "endpoint_unavailable" };
            }
            const serverIdentityId = await getOrCreateServerIdentityId(process.env);
            return await inTx(async (tx) => await checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
                tx,
                serverIdentityId,
                accountId: params.accountId,
                input: params.input,
            }));
        },
    };
}

export type PluginWebhookEndpointActionsV1 = ReturnType<typeof createPluginWebhookEndpointActionsV1>;
