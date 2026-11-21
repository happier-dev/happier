import { isManagedGithubEndpointKey } from "./endpointStore";
import { PluginWebhookEndpointCredentialConfigureResultV1Schema, PluginWebhookEndpointCredentialFinishRotationResultV1Schema, PluginWebhookEndpointCredentialRotateResultV1Schema, type PluginWebhookEndpointCredentialConfigureInputV1, type PluginWebhookEndpointCredentialConfigureResultV1, type PluginWebhookEndpointCredentialFinishRotationInputV1, type PluginWebhookEndpointCredentialFinishRotationResultV1, type PluginWebhookEndpointCredentialRotateInputV1, type PluginWebhookEndpointCredentialRotateResultV1, type PluginWebhookDeliveryMovePendingInputV1, type PluginWebhookEndpointCheckCorrespondenceInputV1, type PluginWebhookEndpointCheckCorrespondenceResultV1, type PluginWebhookEndpointConvergeTargetInputV1, type PluginWebhookEndpointConvergeTargetResultV1, type PluginWebhookEndpointEnsureInputV1, type PluginWebhookEndpointReadInputV1, type PluginWebhookEndpointRetargetInputV1, type PluginWebhookEndpointRevokeInputV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';

import { isPluginIntentSelectingDeclarationV1 } from "@/app/plugins/availability/currentDeclaration";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveConfiguredPublicServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import { readHomeConfigEnv } from "@/app/home/settings/homeSettings";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { readPluginWebhookHeartbeatReceiptV1 } from './heartbeat';
import { managePluginWebhookHeartbeatV1 } from './heartbeatManagement';
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
import { convergeCurrentPluginWebhookEndpointTargetTxV1 } from "./endpointTargetConvergence";
import {
    createPluginWebhookEndpointStoreV1,
    PluginWebhookEndpointStoreError,
    revokePluginWebhookEndpointV1,
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
    }, { isolationLevel: "ReadCommitted" });
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
                ensureIdempotencyKey: true,
            },
        });
        if (!endpoint || isManagedGithubEndpointKey(endpoint.ensureIdempotencyKey) || !endpoint.enabled || endpoint.revokedAt !== null || endpoint.routingKind !== "accountEndpoint") {
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
    }, { /* Endpoint revision and credential rotation/retirement participate with authority readers. */ isolationLevel: "Serializable" });
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
    }, { /* Endpoint revision and credential rotation/retirement participate with authority readers. */ isolationLevel: "Serializable" });
}

async function resolveCurrentWebhookTargetV1(serverIdentityId: string, params: Readonly<{
    tx?: Tx;
    accountId: string;
    target: ResolvedPluginWebhookTargetV1["materialization"];
}>): Promise<ResolvedPluginWebhookTargetV1 | null> {
    if (params.tx) {
        return await resolveCurrentPluginWebhookTargetTxV1({
            tx: params.tx,
            serverIdentityId,
            accountId: params.accountId,
            target: params.target,
        });
    }
    return await inTx(async (tx) => await resolveCurrentPluginWebhookTargetTxV1({
        tx,
        serverIdentityId,
        accountId: params.accountId,
        target: params.target,
    }));
}

async function resolveCurrentWebhookContributionV1(params: Readonly<{
    tx?: Tx;
    accountId: string;
    contribution: Readonly<{ pluginId: string; localId: string }>;
    target: ResolvedPluginWebhookTargetV1;
}>): Promise<ResolvedPluginWebhookContributionV1 | null> {
    if (params.tx) {
        return await resolveCurrentPluginWebhookContributionTxV1({
            tx: params.tx,
            accountId: params.accountId,
            contribution: params.contribution,
            target: params.target,
        });
    }
    return await inTx(async (tx) => await resolveCurrentPluginWebhookContributionTxV1({
        tx,
        accountId: params.accountId,
        contribution: params.contribution,
        target: params.target,
    }));
}

async function isCurrentCallerPluginEnabledV1(accountId: string, pluginId: string): Promise<boolean> {
    const intent = await db.accountPluginIntent.findUnique({
        where: { accountId_pluginId: { accountId, pluginId } },
        select: { enabled: true, desiredVersion: true, releaseLessDeclaration: true },
    });
    return isPluginIntentSelectingDeclarationV1(intent, pluginId);
}

/**
 * Canonical host Action adapter for Account webhook endpoint lifecycle. The
 * caller supplies only host-stamped principal facts; Account and plugin caller
 * identity never come from Action input.
 */
export function createPluginWebhookEndpointActionsV1(options: Readonly<{
    authorizeSharedInstallation?: Parameters<typeof createPluginWebhookEndpointStoreV1>[0]["authorizeSharedInstallation"];
}> = {}) {
    // Endpoint URLs live at the Home's effective public address — deployment, stored or inferred
    // (plan 2026-09-26-home-owner-console §3.2) — read once per action from the live overlay.
    const createStore = async (serverIdentityId: string) => {
        const publicBaseUrl = resolveConfiguredPublicServerUrl(await readHomeConfigEnv()) ?? null;
        return createStoreWithBaseUrl(serverIdentityId, publicBaseUrl);
    };
    const createStoreWithBaseUrl = (serverIdentityId: string, publicBaseUrl: string | null) => createPluginWebhookEndpointStoreV1({
        resolveTarget: async (params) => await resolveCurrentWebhookTargetV1(serverIdentityId, params),
        resolveContribution: resolveCurrentWebhookContributionV1,
        resolvePublicBaseUrl: () => publicBaseUrl,
        ...(options.authorizeSharedInstallation
            ? { authorizeSharedInstallation: options.authorizeSharedInstallation }
            : {}),
    });

    return {
        ensureHeartbeat: async (params: Readonly<{ accountId: string; callerPluginId: string; input: PluginWebhookEndpointEnsureInputV1 }>) => {
            if (params.input.setup.kind !== "capabilityUrlV1" || params.callerPluginId !== params.input.webhookContribution.pluginId) {
                throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
            }
            const store = await createStore(await getOrCreateServerIdentityId(process.env));
            return await store.ensure({ accountId: params.accountId, ...params.input });
        },
        readHeartbeat: readPluginWebhookHeartbeatReceiptV1,
        manageHeartbeat: managePluginWebhookHeartbeatV1,
        ensure: async (params: Readonly<{ accountId: string; input: PluginWebhookEndpointEnsureInputV1 }>) => {
            const store = await createStore(await getOrCreateServerIdentityId(process.env));
            return await store.ensure({ accountId: params.accountId, ...params.input });
        },
        read: async (params: Readonly<{ accountId: string; input: PluginWebhookEndpointReadInputV1 }>) => {
            const store = await createStore(await getOrCreateServerIdentityId(process.env));
            return await store.read({ accountId: params.accountId, ...params.input });
        },
        revoke: async (params: Readonly<{ accountId: string; input: PluginWebhookEndpointRevokeInputV1 }>) => (
            await revokePluginWebhookEndpointV1({ accountId: params.accountId, ...params.input })
        ),
        retarget: async (params: Readonly<{ accountId: string; input: PluginWebhookEndpointRetargetInputV1 }>) => {
            const store = await createStore(await getOrCreateServerIdentityId(process.env));
            return await store.retarget({ accountId: params.accountId, ...params.input });
        },
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
        /**
         * Same principal boundary as `checkCorrespondence`: the caller plugin
         * must be a current enabled plugin for this Account, and the endpoint
         * decision itself belongs to its single transaction-scoped owner. The
         * caller plugin is intentionally not required to be the contribution's
         * provider plugin — a feature owner such as `happier.channels` drives
         * an endpoint whose contribution belongs to the provider plugin — so
         * the authorization that matters is the exact opaque endpoint identity
         * plus its source-instance/setup correspondence.
         */
        convergeTarget: async (params: Readonly<{
            accountId: string;
            callerPluginId: string;
            input: PluginWebhookEndpointConvergeTargetInputV1;
        }>): Promise<PluginWebhookEndpointConvergeTargetResultV1> => {
            if (
                params.callerPluginId.length === 0
                || !await isCurrentCallerPluginEnabledV1(params.accountId, params.callerPluginId)
            ) {
                return { kind: "unavailable", code: "endpoint_unavailable" };
            }
            const serverIdentityId = await getOrCreateServerIdentityId(process.env);
            return await inTx(async (tx) => await convergeCurrentPluginWebhookEndpointTargetTxV1({
                tx,
                serverIdentityId,
                accountId: params.accountId,
                input: params.input,
            }), { /* Endpoint revision and credential rotation/retirement participate with authority readers. */ isolationLevel: "Serializable" });
        },
    };
}

export type PluginWebhookEndpointActionsV1 = ReturnType<typeof createPluginWebhookEndpointActionsV1>;
