import { randomBytes as nodeRandomBytes } from "node:crypto";

import { PluginWebhookEndpointEnsureResultV1Schema, PluginWebhookEndpointIdV1Schema, PluginWebhookEndpointReadResultV1Schema, PluginWebhookEndpointRetargetResultV1Schema, PluginWebhookEndpointRevokeResultV1Schema, PluginWebhookPublicUrlV1Schema, formatPluginWebhookEndpointIdV1, type PluginWebhookEndpointEnsureInputV1, type PluginWebhookEndpointEnsureResultV1, type PluginWebhookEndpointReadResultV1, type PluginWebhookEndpointRetargetResultV1, type PluginWebhookEndpointRevokeResultV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { createPluginWebhookCheckIdDigestV1, createPluginWebhookIdentityFingerprintV1 as fingerprint } from './checkIdDigest';
export { createPluginWebhookCheckIdDigestV1 } from './checkIdDigest';

import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { encryptPluginWebhookCredentialSecretV1 } from "./credentialCipher";
import { createGeneratedPluginWebhookCredentialMaterialV1 } from "./credentialMaterial";
import { isContributionSetupCompatibleWithRoutingKindV1 } from "./routingKind";
import { projectPluginWebhookEndpointReadinessV1 } from "./endpointReadiness";
import { markPluginWebhookAccountChangedInTxV1 } from "./accountChange";
import type { PluginWebhookVerifierV1 } from '@happier-dev/protocol/plugins/contributions/webhooks';

const MANAGED_GITHUB_ENDPOINT_KEY_PREFIX = 'managed-github-repository:';

export function managedGithubEndpointKey(repositoryId: string): string {
    return MANAGED_GITHUB_ENDPOINT_KEY_PREFIX + repositoryId;
}

export function isManagedGithubEndpointKey(key: string | null): boolean {
    return key?.startsWith(MANAGED_GITHUB_ENDPOINT_KEY_PREFIX) ?? false;
}

export class PluginWebhookEndpointStoreError extends Error {
    constructor(readonly code:
        | "idempotency_conflict"
        | "endpoint_unavailable"
        | "route_unavailable"
        | "source_conflict"
        | "installation_conflict"
    ) {
        super(code);
        this.name = "PluginWebhookEndpointStoreError";
    }
}

export type ResolvedPluginWebhookContributionV1 = Readonly<{
    pluginId: string;
    localId: string;
    routingKind: "accountEndpoint" | "providerInstallation";
    handlerActionLocalId: string;
    verifierKind: PluginWebhookVerifierV1['kind'];
}> | Readonly<{
    pluginId: string;
    localId: string;
    routingKind: "accountEndpoint";
    handlerActionLocalId: null;
    verifierKind: "capabilityUrl_v1";
}>;

export type ResolvedPluginWebhookTargetV1 = Readonly<{
    materialization: Readonly<{ machineId: string; materializationId: string; pluginId: string }>;
    machineInstallationId: string;
    pluginVersion: string;
}>;

type Awaitable<T> = T | Promise<T>;

export type PluginWebhookEndpointStoreV1 = Readonly<{
    ensure(input: PluginWebhookEndpointEnsureInputV1 & Readonly<{ accountId: string }>): Promise<PluginWebhookEndpointEnsureResultV1>;
    read(input: Readonly<{ accountId: string; webhookEndpointId: string }>): Promise<PluginWebhookEndpointReadResultV1>;
    revoke(input: Readonly<{
        accountId: string;
        webhookEndpointId: string;
        expectedRevision: number;
        idempotencyKey: string;
    }>): Promise<PluginWebhookEndpointRevokeResultV1>;
    retarget(input: Readonly<{
        accountId: string;
        webhookEndpointId: string;
        expectedRevision: number;
        targetMaterialization: ResolvedPluginWebhookTargetV1["materialization"];
        idempotencyKey: string;
    }>): Promise<PluginWebhookEndpointRetargetResultV1>;
}>;

export function formatPluginWebhookEndpointPublicUrlV1(publicBaseUrl: string, opaqueRouteId: string): string {
    const base = new URL(publicBaseUrl);
    base.pathname = `/v1/plugins/webhooks/${opaqueRouteId}`;
    base.search = "";
    base.hash = "";
    return PluginWebhookPublicUrlV1Schema.parse(base.toString());
}

const ENSURE_REJOIN_SELECT_V1 = {
    id: true,
    revision: true,
    routingKind: true,
    enabled: true,
    revokedAt: true,
    providerConfirmedAt: true,
    handlerActionId: true,
    setupKind: true,
    ensureRequestFingerprint: true,
    route: { select: { opaqueRouteId: true, enabled: true, revokedAt: true } },
} as const;

function projectEnsureRejoin(row: Readonly<{
    id: string;
    revision: number;
    routingKind: string;
    enabled: boolean;
    revokedAt: Date | null;
    providerConfirmedAt: Date | null;
    handlerActionId: string | null;
    setupKind?: string | null;
    ensureRequestFingerprint: string | null;
    route: Readonly<{ opaqueRouteId: string; enabled: boolean; revokedAt: Date | null }>;
}>, requestFingerprint: string, publicBaseUrl: string): PluginWebhookEndpointEnsureResultV1 {
    if (row.ensureRequestFingerprint !== requestFingerprint) {
        throw new PluginWebhookEndpointStoreError("idempotency_conflict");
    }
    return PluginWebhookEndpointEnsureResultV1Schema.parse({
        webhookEndpointId: row.id,
        revision: row.revision,
        publicUrl: formatPluginWebhookEndpointPublicUrlV1(publicBaseUrl, row.route.opaqueRouteId),
        readiness: projectPluginWebhookEndpointReadinessV1({
            endpointEnabled: row.enabled,
            endpointRevokedAt: row.revokedAt,
            routeEnabled: row.route.enabled,
            routeRevokedAt: row.route.revokedAt,
            // This request resolved the exact current target before rejoining,
            // and the fingerprint proves the rejoined row froze that same
            // materialization, installation, and plugin version.
            targetStatus: "current",
            providerConfirmedAt: row.providerConfirmedAt,
            // A rejoin never repeats the creating response's one-time secret.
            oneTimeCredentialDisclosureLost: row.routingKind === "accountEndpoint" && row.setupKind !== "capabilityUrlV1",
            receiptOnly: row.handlerActionId === null,
        }),
    });
}

async function readEnsureIdempotencyV1(accountId: string, idempotencyKey: string, tx?: Tx) {
    return await (tx ?? db).pluginWebhookEndpoint.findFirst({
        where: { accountId, ensureIdempotencyKey: idempotencyKey },
        select: ENSURE_REJOIN_SELECT_V1,
    });
}

async function readEnsureDeterministicConflictV1(params: Readonly<{
    accountId: string;
    input: PluginWebhookEndpointEnsureInputV1;
    contribution: ResolvedPluginWebhookContributionV1;
    tx?: Tx;
}>): Promise<"source_conflict" | "installation_conflict" | null> {
    const client = params.tx ?? db;
    const source = await client.pluginWebhookEndpoint.findFirst({
        where: {
            accountId: params.accountId,
            pluginId: params.contribution.pluginId,
            webhookContributionId: params.contribution.localId,
            sourceInstanceId: params.input.sourceInstanceId,
            checkId: params.input.setup.kind === "capabilityUrlV1" ? params.input.setup.checkId : "",
            checkIdDigest: createPluginWebhookCheckIdDigestV1(params.input.setup.kind === "capabilityUrlV1" ? params.input.setup.checkId : ""),
        },
        select: { id: true },
    });
    if (source) return "source_conflict";

    if (params.input.setup.kind !== "githubSharedInstallationV1") return null;
    const installation = await client.pluginWebhookEndpoint.findFirst({
        where: {
            providerInstallationId: params.input.setup.installationId,
            route: {
                operatorPluginId: params.contribution.pluginId,
                operatorWebhookContributionId: params.contribution.localId,
                verifierKind: params.contribution.verifierKind,
                routingKind: params.contribution.routingKind,
            },
        },
        select: { id: true },
    });
    return installation ? "installation_conflict" : null;
}

function ensureFingerprint(params: Readonly<{
    input: PluginWebhookEndpointEnsureInputV1;
    contribution: ResolvedPluginWebhookContributionV1;
    target: ResolvedPluginWebhookTargetV1;
}>): string {
    return fingerprint({
        webhookContribution: params.input.webhookContribution,
        targetMaterialization: params.input.targetMaterialization,
        sourceInstanceId: params.input.sourceInstanceId,
        setupKind: params.input.setup.kind,
        ...(params.input.setup.kind === "capabilityUrlV1" ? { checkId: params.input.setup.checkId } : {}),
        providerInstallationId: params.input.setup.kind === "githubSharedInstallationV1"
            ? params.input.setup.installationId
            : null,
        handlerActionLocalId: params.contribution.handlerActionLocalId,
        targetMachineInstallationId: params.target.machineInstallationId,
        targetPluginVersion: params.target.pluginVersion,
    });
}

export async function ensurePluginWebhookEndpointV1(params: Readonly<{
    tx?: Tx;
    accountId: string;
    input: PluginWebhookEndpointEnsureInputV1;
    contribution: ResolvedPluginWebhookContributionV1;
    target: ResolvedPluginWebhookTargetV1;
    publicBaseUrl: string;
    randomBytes?: (length: number) => Uint8Array;
    managed?: true;
}>): Promise<PluginWebhookEndpointEnsureResultV1> {
    if (
        isManagedGithubEndpointKey(params.input.idempotencyKey) !== (params.managed === true)
        || params.input.webhookContribution.pluginId !== params.contribution.pluginId
        || params.input.webhookContribution.localId !== params.contribution.localId
        || params.input.targetMaterialization.machineId !== params.target.materialization.machineId
        || params.input.targetMaterialization.materializationId !== params.target.materialization.materializationId
        || params.input.targetMaterialization.pluginId !== params.target.materialization.pluginId
        || params.target.materialization.pluginId !== params.contribution.pluginId
        || (params.input.setup.kind === "capabilityUrlV1") !== (params.contribution.verifierKind === "capabilityUrl_v1")
        || !isContributionSetupCompatibleWithRoutingKindV1({
            contributionRoutingKind: params.contribution.routingKind,
            setupKind: params.input.setup.kind,
        })
    ) {
        throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
    }
    if (params.input.setup.kind === "capabilityUrlV1") {
        const existingHeartbeat = await (params.tx ?? db).pluginWebhookEndpoint.findFirst({
            where: { accountId: params.accountId, pluginId: params.contribution.pluginId,
                webhookContributionId: params.contribution.localId, sourceInstanceId: params.input.sourceInstanceId,
                checkId: params.input.setup.checkId, checkIdDigest: createPluginWebhookCheckIdDigestV1(params.input.setup.checkId),
                setupKind: "capabilityUrlV1" },
            select: { id: true, revision: true, enabled: true, revokedAt: true, releasedAt: true,
                providerConfirmedAt: true, handlerActionId: true,
                targetMachineId: true, targetMachineInstallationId: true, targetMaterializationId: true, targetPluginVersion: true,
                route: { select: { opaqueRouteId: true, enabled: true, revokedAt: true, verifierKind: true } } },
        });
        if (existingHeartbeat) {
            if (!existingHeartbeat.enabled || existingHeartbeat.revokedAt !== null || existingHeartbeat.releasedAt !== null
                || !existingHeartbeat.route.enabled || existingHeartbeat.route.revokedAt !== null
                || existingHeartbeat.route.verifierKind !== "capabilityUrl_v1") {
                throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
            }
            const sameTarget = existingHeartbeat.targetMachineId === params.target.materialization.machineId
                && existingHeartbeat.targetMaterializationId === params.target.materialization.materializationId
                && existingHeartbeat.targetMachineInstallationId === params.target.machineInstallationId
                && existingHeartbeat.targetPluginVersion === params.target.pluginVersion;
            const moved = sameTarget ? null : await retargetPluginWebhookEndpointV1({
                ...(params.tx ? { tx: params.tx } : {}), accountId: params.accountId,
                webhookEndpointId: existingHeartbeat.id, expectedRevision: existingHeartbeat.revision,
                idempotencyKey: params.input.idempotencyKey, target: params.target,
            });
            if (moved && moved.kind !== "retargeted" && moved.kind !== "alreadyRetargeted") {
                throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
            }
            return { webhookEndpointId: existingHeartbeat.id, revision: moved?.revision ?? existingHeartbeat.revision,
                publicUrl: formatPluginWebhookEndpointPublicUrlV1(params.publicBaseUrl, existingHeartbeat.route.opaqueRouteId),
                readiness: projectPluginWebhookEndpointReadinessV1({ endpointEnabled: existingHeartbeat.enabled,
                    endpointRevokedAt: existingHeartbeat.revokedAt, routeEnabled: existingHeartbeat.route.enabled,
                    routeRevokedAt: existingHeartbeat.route.revokedAt, targetStatus: "current", providerConfirmedAt: existingHeartbeat.providerConfirmedAt,
                    oneTimeCredentialDisclosureLost: false, receiptOnly: existingHeartbeat.handlerActionId === null }) };
        }
    }
    const requestFingerprint = ensureFingerprint(params);
    const existing = await readEnsureIdempotencyV1(params.accountId, params.input.idempotencyKey, params.tx);
    if (existing) return projectEnsureRejoin(existing, requestFingerprint, params.publicBaseUrl);
    const deterministicConflict = await readEnsureDeterministicConflictV1(params);
    if (deterministicConflict) throw new PluginWebhookEndpointStoreError(deterministicConflict);

    const randomBytes = params.randomBytes
        ?? ((length: number) => Uint8Array.from(nodeRandomBytes(length)));
    const endpointId = PluginWebhookEndpointIdV1Schema.parse(formatPluginWebhookEndpointIdV1(randomBytes(16)));
    const opaqueRouteId = `wh_route_${Buffer.from(randomBytes(16)).toString("base64url")}`;
    const credential = params.contribution.routingKind === "accountEndpoint" && params.contribution.verifierKind !== "capabilityUrl_v1"
        ? createGeneratedPluginWebhookCredentialMaterialV1({ randomBytes })
        : null;
    const persist = async (tx: Tx): Promise<PluginWebhookEndpointEnsureResultV1> => {
            const raced = await tx.pluginWebhookEndpoint.findFirst({
                where: { accountId: params.accountId, ensureIdempotencyKey: params.input.idempotencyKey },
                select: ENSURE_REJOIN_SELECT_V1,
            });
            if (raced) return projectEnsureRejoin(raced, requestFingerprint, params.publicBaseUrl);

            const route = params.contribution.routingKind === "accountEndpoint"
                ? await tx.pluginWebhookRoute.create({
                    data: {
                        opaqueRouteId,
                        verifierKind: params.contribution.verifierKind,
                        routingKind: params.contribution.routingKind,
                    },
                    select: { id: true, opaqueRouteId: true, enabled: true, revokedAt: true },
                })
                : await tx.pluginWebhookRoute.findFirst({
                    where: {
                        operatorPluginId: params.contribution.pluginId,
                        operatorWebhookContributionId: params.contribution.localId,
                        verifierKind: params.contribution.verifierKind,
                        routingKind: params.contribution.routingKind,
                        enabled: true,
                        revokedAt: null,
                        currentCredentialId: { not: null },
                    },
                    select: { id: true, opaqueRouteId: true, enabled: true, revokedAt: true },
                });
            if (!route) throw new PluginWebhookEndpointStoreError("route_unavailable");

            const endpoint = await tx.pluginWebhookEndpoint.create({
                data: {
                    id: endpointId,
                    accountId: params.accountId,
                    pluginId: params.contribution.pluginId,
                    webhookContributionId: params.contribution.localId,
                    handlerActionId: params.contribution.handlerActionLocalId,
                    sourceInstanceId: params.input.sourceInstanceId,
                    checkId: params.input.setup.kind === "capabilityUrlV1" ? params.input.setup.checkId : "",
                    checkIdDigest: createPluginWebhookCheckIdDigestV1(params.input.setup.kind === "capabilityUrlV1" ? params.input.setup.checkId : ""),
                    ensureIdempotencyKey: params.input.idempotencyKey,
                    ensureRequestFingerprint: requestFingerprint,
                    setupKind: params.input.setup.kind,
                    routeId: route.id,
                    routingKind: params.contribution.routingKind,
                    providerInstallationId: params.input.setup.kind === "githubSharedInstallationV1"
                        ? params.input.setup.installationId
                        : null,
                    targetMachineId: params.target.materialization.machineId,
                    targetMachineInstallationId: params.target.machineInstallationId,
                    targetMaterializationId: params.target.materialization.materializationId,
                    targetPluginVersion: params.target.pluginVersion,
                },
                select: { id: true, revision: true, enabled: true, revokedAt: true, providerConfirmedAt: true },
            });

            if (params.contribution.verifierKind === "capabilityUrl_v1") {
                await tx.pluginWebhookRoute.update({ where: { id: route.id }, data: { accountEndpointId: endpoint.id } });
            }
            if (credential && params.contribution.verifierKind !== "capabilityUrl_v1") {
                const encryptedSecret = encryptPluginWebhookCredentialSecretV1({
                    routeId: route.id,
                    verifierKind: params.contribution.verifierKind,
                    credentialVersionId: credential.credentialVersionId,
                    secret: credential.secret,
                });
                const row = await tx.pluginWebhookCredential.create({
                    data: {
                        routeId: route.id,
                        credentialVersionId: credential.credentialVersionId,
                        verifierKind: params.contribution.verifierKind,
                        encryptedSecret,
                        state: "current",
                    },
                    select: { id: true },
                });
                await tx.pluginWebhookRoute.update({
                    where: { id: route.id },
                    data: { currentCredentialId: row.id, accountEndpointId: endpoint.id },
                });
            }
            await markPluginWebhookAccountChangedInTxV1(tx, {
                accountId: params.accountId,
                pluginId: params.contribution.pluginId,
            });
            return PluginWebhookEndpointEnsureResultV1Schema.parse({
                webhookEndpointId: endpoint.id,
                revision: endpoint.revision,
                publicUrl: formatPluginWebhookEndpointPublicUrlV1(params.publicBaseUrl, route.opaqueRouteId),
                readiness: projectPluginWebhookEndpointReadinessV1({
                    endpointEnabled: endpoint.enabled,
                    endpointRevokedAt: endpoint.revokedAt,
                    routeEnabled: route.enabled,
                    routeRevokedAt: route.revokedAt,
                    // The binding was just created against the resolved current target.
                    targetStatus: "current",
                    providerConfirmedAt: endpoint.providerConfirmedAt,
                    // The creating response is the one that discloses the secret.
                    oneTimeCredentialDisclosureLost: false,
                    receiptOnly: params.contribution.handlerActionLocalId === null,
                }),
                ...(credential ? { oneTimeGeneratedSecret: credential.secret } : {}),
            });
    };
    if (params.tx) return await persist(params.tx);
    try {
        return await inTx(persist, { /* Endpoint target/revision mutations participate with webhook authority-before-fence readers. */ isolationLevel: "Serializable" });
    } catch (error) {
        if (error instanceof PluginWebhookEndpointStoreError) throw error;
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        const raced = await readEnsureIdempotencyV1(params.accountId, params.input.idempotencyKey);
        if (raced) return projectEnsureRejoin(raced, requestFingerprint, params.publicBaseUrl);
        const deterministicConflict = await readEnsureDeterministicConflictV1(params);
        if (deterministicConflict) throw new PluginWebhookEndpointStoreError(deterministicConflict);
        throw error;
    }
}

export async function readPluginWebhookEndpointV1(params: Readonly<{
    accountId: string;
    webhookEndpointId: string;
    publicBaseUrl: string;
    /**
     * Read resolves claimable-target currentness itself. Without it the one
     * readiness projection would have to accept an unresolved target, and an
     * endpoint whose machine is gone would still read as `ready`.
     */
    resolveTarget: (params: Readonly<{
        accountId: string;
        target: ResolvedPluginWebhookTargetV1["materialization"];
    }>) => Awaitable<ResolvedPluginWebhookTargetV1 | null>;
}>): Promise<PluginWebhookEndpointReadResultV1> {
    const endpoint = await db.pluginWebhookEndpoint.findFirst({
        where: { id: params.webhookEndpointId, accountId: params.accountId },
        select: {
            id: true,
            revision: true,
            pluginId: true,
            webhookContributionId: true,
            sourceInstanceId: true,
            routingKind: true,
            setupKind: true,
            enabled: true,
            revokedAt: true,
            providerConfirmedAt: true,
            handlerActionId: true,
            createdAt: true,
            targetMachineId: true,
            targetMachineInstallationId: true,
            targetMaterializationId: true,
            targetPluginVersion: true,
            route: { select: { opaqueRouteId: true, enabled: true, revokedAt: true } },
        },
    });
    if (
        !endpoint
        || endpoint.pluginId === null
        || endpoint.webhookContributionId === null
        || endpoint.sourceInstanceId === null
        || endpoint.targetMachineId === null
        || endpoint.targetMachineInstallationId === null
        || endpoint.targetMaterializationId === null
        || endpoint.targetPluginVersion === null
        || (endpoint.routingKind !== "accountEndpoint" && endpoint.routingKind !== "providerInstallation")
    ) {
        throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
    }
    const targetMaterialization = {
        machineId: endpoint.targetMachineId,
        materializationId: endpoint.targetMaterializationId,
        pluginId: endpoint.pluginId,
    };
    const resolved = await params.resolveTarget({
        accountId: params.accountId,
        target: targetMaterialization,
    });
    // The frozen target is what a claim authenticates against, so a resolved
    // materialization that no longer carries the frozen installation/version is
    // not this endpoint's target.
    const targetStatus = resolved
        && resolved.machineInstallationId === endpoint.targetMachineInstallationId
        && resolved.pluginVersion === endpoint.targetPluginVersion
        ? "current" as const
        : "unavailable" as const;
    return PluginWebhookEndpointReadResultV1Schema.parse({
        webhookEndpointId: endpoint.id,
        revision: endpoint.revision,
        contribution: { pluginId: endpoint.pluginId, localId: endpoint.webhookContributionId },
        targetMaterialization,
        sourceInstanceId: endpoint.sourceInstanceId,
        routing: endpoint.routingKind,
        readiness: projectPluginWebhookEndpointReadinessV1({
            endpointEnabled: endpoint.enabled,
            endpointRevokedAt: endpoint.revokedAt,
            routeEnabled: endpoint.route.enabled,
            routeRevokedAt: endpoint.route.revokedAt,
            targetStatus,
            providerConfirmedAt: endpoint.providerConfirmedAt,
            oneTimeCredentialDisclosureLost: false,
            receiptOnly: endpoint.handlerActionId === null,
        }),
        publicUrl: formatPluginWebhookEndpointPublicUrlV1(params.publicBaseUrl, endpoint.route.opaqueRouteId),
        createdAt: endpoint.createdAt.getTime(),
        ...(endpoint.revokedAt ? { revokedAt: endpoint.revokedAt.getTime() } : {}),
    });
}

type PluginWebhookEndpointTargetCurrentnessV1 = Readonly<{
    pluginId: string;
    machineId: string;
    machineInstallationId: string;
    materializationId: string;
    version: string;
}>;

export type CurrentPluginWebhookEndpointTargetV1 = Readonly<{
    webhookEndpointId: string;
    revision: number;
    managedRepositoryHook?: true;
    webhookContribution: Readonly<{ pluginId: string; localId: string }>;
}>;

function currentPluginWebhookEndpointTargetWhere(params: Readonly<{
    accountId: string;
    target: PluginWebhookEndpointTargetCurrentnessV1;
    webhookEndpointId?: string;
    purpose?: "delivery" | "observation";
}>) {
    return {
        ...(params.webhookEndpointId === undefined ? {} : { id: params.webhookEndpointId }),
        accountId: params.accountId,
        pluginId: params.target.pluginId,
        targetMachineId: params.target.machineId,
        targetMachineInstallationId: params.target.machineInstallationId,
        targetMaterializationId: params.target.materializationId,
        targetPluginVersion: params.target.version,
        releasedAt: null,
        ...(params.purpose === "observation" ? {} : {
            enabled: true,
            revokedAt: null,
            route: { enabled: true, revokedAt: null },
        }),
    };
}

function projectCurrentPluginWebhookEndpointTargetV1(endpoint: Readonly<{
    id: string;
    revision: number;
    pluginId: string | null;
    webhookContributionId: string | null;
    providerRepositoryHookId: string | null;
}>): CurrentPluginWebhookEndpointTargetV1 | null {
    if (endpoint.pluginId === null || endpoint.webhookContributionId === null) return null;
    return {
        webhookEndpointId: endpoint.id,
        revision: endpoint.revision,
        ...(endpoint.providerRepositoryHookId === null ? {} : { managedRepositoryHook: true }),
        webhookContribution: {
            pluginId: endpoint.pluginId,
            localId: endpoint.webhookContributionId,
        },
    };
}

/**
 * Reads one current generic endpoint target without disclosing endpoint
 * routing or source facts to an Automation owner. Observation placement
 * survives route unavailability; delivery authority still requires an active
 * endpoint and route by default.
 */
export async function readCurrentPluginWebhookEndpointTargetTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    webhookEndpointId: string;
    target: PluginWebhookEndpointTargetCurrentnessV1;
    purpose?: "delivery" | "observation";
}>): Promise<CurrentPluginWebhookEndpointTargetV1 | null> {
    const endpoint = await params.tx.pluginWebhookEndpoint.findFirst({
        where: currentPluginWebhookEndpointTargetWhere(params),
        select: {
            id: true,
            revision: true,
            pluginId: true,
            webhookContributionId: true,
            providerRepositoryHookId: true,
        },
    });
    return endpoint ? projectCurrentPluginWebhookEndpointTargetV1(endpoint) : null;
}

/**
 * Lists only generic endpoints currently targeted to one exact caller. The
 * Automation stored-definition reader consumes this bounded target view; it
 * remains separate from delivery custody and never exposes routing source
 * material.
 */
export async function listCurrentPluginWebhookEndpointTargetsTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    target: PluginWebhookEndpointTargetCurrentnessV1;
    purpose?: "delivery" | "observation";
}>): Promise<readonly CurrentPluginWebhookEndpointTargetV1[]> {
    const endpoints = await params.tx.pluginWebhookEndpoint.findMany({
        where: currentPluginWebhookEndpointTargetWhere(params),
        orderBy: { id: "asc" },
        select: {
            id: true,
            revision: true,
            pluginId: true,
            webhookContributionId: true,
            providerRepositoryHookId: true,
        },
    });
    return endpoints.flatMap((endpoint) => {
        const projected = projectCurrentPluginWebhookEndpointTargetV1(endpoint);
        return projected === null ? [] : [projected];
    });
}

/**
 * Checks the current generic endpoint target without disclosing endpoint
 * routing or source facts to a domain status writer.
 */
export async function isCurrentPluginWebhookEndpointTargetTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    webhookEndpointId: string;
    target: PluginWebhookEndpointTargetCurrentnessV1;
}>): Promise<boolean> {
    return (await readCurrentPluginWebhookEndpointTargetTxV1(params)) !== null;
}

async function readOperationV1(tx: Tx, params: Readonly<{
    accountId: string;
    endpointId: string;
    operationKind: "revoke" | "retarget" | "rotateUrl";
    idempotencyKey: string;
    expectedRevision: number;
    target?: Readonly<{ machineId: string; materializationId: string; pluginId: string }>;
}>) {
    const operation = await tx.pluginWebhookEndpointOperation.findUnique({
        where: {
            endpointId_idempotencyKey: {
                endpointId: params.endpointId,
                idempotencyKey: params.idempotencyKey,
            },
        },
    });
    if (!operation) return null;
    if (
        operation.accountId !== params.accountId
        || operation.operationKind !== params.operationKind
        || operation.expectedRevision !== params.expectedRevision
        || operation.requestTargetMachineId !== (params.target?.machineId ?? null)
        || operation.requestTargetMaterializationId !== (params.target?.materializationId ?? null)
        || operation.requestTargetPluginId !== (params.target?.pluginId ?? null)
    ) {
        throw new PluginWebhookEndpointStoreError("idempotency_conflict");
    }
    return operation;
}

export async function revokePluginWebhookEndpointV1(params: Readonly<{
    tx?: Tx;
    accountId: string;
    webhookEndpointId: string;
    expectedRevision: number;
    idempotencyKey: string;
    now?: Date;
}>): Promise<PluginWebhookEndpointRevokeResultV1> {
    const now = params.now ?? new Date();
    const persist = async (tx: Tx): Promise<PluginWebhookEndpointRevokeResultV1> => {
        const prior = await readOperationV1(tx, {
            accountId: params.accountId,
            endpointId: params.webhookEndpointId,
            operationKind: "revoke",
            idempotencyKey: params.idempotencyKey,
            expectedRevision: params.expectedRevision,
        });
        if (prior) {
            return PluginWebhookEndpointRevokeResultV1Schema.parse({
                kind: prior.resultKind,
                webhookEndpointId: params.webhookEndpointId,
                revision: prior.resultRevision,
            });
        }
        const endpoint = await tx.pluginWebhookEndpoint.findFirst({
            where: { id: params.webhookEndpointId, accountId: params.accountId },
            select: { revision: true, enabled: true, revokedAt: true, routingKind: true, routeId: true, pluginId: true,
                ensureIdempotencyKey: true },
        });
        if (!endpoint) throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
        if (endpoint.revision !== params.expectedRevision) throw new PluginWebhookEndpointStoreError("idempotency_conflict");
        const revision = endpoint.enabled && endpoint.revokedAt === null
            ? endpoint.revision + 1
            : endpoint.revision;
        if (revision !== endpoint.revision) {
            const updated = await tx.pluginWebhookEndpoint.updateMany({
                where: { id: params.webhookEndpointId, accountId: params.accountId, revision: params.expectedRevision, enabled: true, revokedAt: null },
                data: { enabled: false, revokedAt: now, revision: { increment: 1 },
                    ...(isManagedGithubEndpointKey(endpoint.ensureIdempotencyKey)
                        ? { releasedAt: now, sourceInstanceId: null, ensureIdempotencyKey: null } : {}) },
            });
            if (updated.count !== 1) throw new PluginWebhookEndpointStoreError("idempotency_conflict");
            if (endpoint.routingKind === "accountEndpoint") {
                await revokePluginWebhookAccountEndpointRouteV1(tx, endpoint.routeId, params.webhookEndpointId, now);
            }
        }
        const result = PluginWebhookEndpointRevokeResultV1Schema.parse({
            kind: revision === endpoint.revision ? "alreadyRevoked" : "revoked",
            webhookEndpointId: params.webhookEndpointId,
            revision,
        });
        await tx.pluginWebhookEndpointOperation.create({
            data: {
                endpointId: params.webhookEndpointId,
                accountId: params.accountId,
                operationKind: "revoke",
                idempotencyKey: params.idempotencyKey,
                expectedRevision: params.expectedRevision,
                resultKind: result.kind,
                resultRevision: result.revision,
            },
        });
        if (revision !== endpoint.revision && endpoint.pluginId !== null) {
            await markPluginWebhookAccountChangedInTxV1(tx, {
                accountId: params.accountId,
                pluginId: endpoint.pluginId,
            });
        }
        return result;
    };
    return params.tx ? persist(params.tx) : inTx(persist, { isolationLevel: "ReadCommitted" });
}

/** Shared retirement for endpoint revocation and capability-address replacement. */
async function revokePluginWebhookAccountEndpointRouteV1(tx: Tx, routeId: string, endpointId: string, now: Date, releaseBinding = false): Promise<void> {
    await tx.pluginWebhookRoute.updateMany({ where: { id: routeId, accountEndpointId: endpointId },
        data: { enabled: false, revokedAt: now, ...(releaseBinding ? { accountEndpointId: null } : {}) } });
}

/** Replace only the URL capability. The stable check keeps its latest admitted receipt. */
export async function rotatePluginWebhookHeartbeatEndpointV1(params: Readonly<{
    tx: Tx; accountId: string; webhookEndpointId: string; expectedRevision: number; idempotencyKey: string;
}>): Promise<Readonly<{ kind: 'rotated'; webhookEndpointId: string; revision: number }>> {
    const { tx } = params;
    const prior = await readOperationV1(tx, { accountId: params.accountId, endpointId: params.webhookEndpointId,
        operationKind: 'rotateUrl', expectedRevision: params.expectedRevision, idempotencyKey: params.idempotencyKey });
    if (prior) return { kind: 'rotated', webhookEndpointId: params.webhookEndpointId, revision: prior.resultRevision };
    const endpoint = await tx.pluginWebhookEndpoint.findFirst({ where: { id: params.webhookEndpointId, accountId: params.accountId,
        setupKind: 'capabilityUrlV1', handlerActionId: null, enabled: true, revokedAt: null },
        select: { revision: true, routeId: true, pluginId: true } });
    if (!endpoint) throw new PluginWebhookEndpointStoreError('endpoint_unavailable');
    if (endpoint.revision !== params.expectedRevision) throw new PluginWebhookEndpointStoreError('idempotency_conflict');
    const route = await tx.pluginWebhookRoute.create({ data: { opaqueRouteId: `wh_route_${nodeRandomBytes(16).toString('base64url')}`,
        verifierKind: 'capabilityUrl_v1', routingKind: 'accountEndpoint' } });
    await revokePluginWebhookAccountEndpointRouteV1(tx, endpoint.routeId, params.webhookEndpointId, new Date(), true);
    const updated = await tx.pluginWebhookEndpoint.updateMany({ where: { id: params.webhookEndpointId, accountId: params.accountId,
        revision: params.expectedRevision, enabled: true, revokedAt: null }, data: { routeId: route.id, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new PluginWebhookEndpointStoreError('idempotency_conflict');
    await tx.pluginWebhookRoute.update({ where: { id: route.id }, data: { accountEndpointId: params.webhookEndpointId } });
    const revision = endpoint.revision + 1;
    await tx.pluginWebhookEndpointOperation.create({ data: { endpointId: params.webhookEndpointId, accountId: params.accountId,
        operationKind: 'rotateUrl', idempotencyKey: params.idempotencyKey, expectedRevision: params.expectedRevision,
        resultKind: 'rotated', resultRevision: revision } });
    if (endpoint.pluginId) await markPluginWebhookAccountChangedInTxV1(tx, { accountId: params.accountId, pluginId: endpoint.pluginId });
    return { kind: 'rotated', webhookEndpointId: params.webhookEndpointId, revision };
}

export async function retargetPluginWebhookEndpointV1(params: Readonly<{
    tx?: Tx;
    accountId: string;
    webhookEndpointId: string;
    expectedRevision: number;
    idempotencyKey: string;
    target: ResolvedPluginWebhookTargetV1;
}>): Promise<PluginWebhookEndpointRetargetResultV1> {
    const persist = async (tx: Tx): Promise<PluginWebhookEndpointRetargetResultV1> => {
        const prior = await readOperationV1(tx, {
            accountId: params.accountId,
            endpointId: params.webhookEndpointId,
            operationKind: "retarget",
            idempotencyKey: params.idempotencyKey,
            expectedRevision: params.expectedRevision,
            target: params.target.materialization,
        });
        if (prior) {
            if (
                prior.resultPreviousTargetMachineId === null
                || prior.resultPreviousTargetMaterializationId === null
                || prior.resultPreviousTargetPluginId === null
                || prior.resultTargetMachineId === null
                || prior.resultTargetMaterializationId === null
                || prior.resultTargetPluginId === null
            ) {
                throw new PluginWebhookEndpointStoreError("idempotency_conflict");
            }
            return PluginWebhookEndpointRetargetResultV1Schema.parse({
                kind: "alreadyRetargeted",
                webhookEndpointId: params.webhookEndpointId,
                revision: prior.resultRevision,
                previousTargetMaterialization: {
                    machineId: prior.resultPreviousTargetMachineId,
                    materializationId: prior.resultPreviousTargetMaterializationId,
                    pluginId: prior.resultPreviousTargetPluginId,
                },
                targetMaterialization: {
                    machineId: prior.resultTargetMachineId,
                    materializationId: prior.resultTargetMaterializationId,
                    pluginId: prior.resultTargetPluginId,
                },
            });
        }
        const endpoint = await tx.pluginWebhookEndpoint.findFirst({
            where: { id: params.webhookEndpointId, accountId: params.accountId },
            select: {
                revision: true,
                pluginId: true,
                targetMachineId: true,
                targetMachineInstallationId: true,
                targetMaterializationId: true,
                targetPluginVersion: true,
            },
        });
        if (!endpoint) return { kind: "revisionConflict" };
        if (endpoint.revision !== params.expectedRevision) {
            return { kind: "revisionConflict", currentRevision: endpoint.revision };
        }
        if (
            endpoint.pluginId === null
            || endpoint.targetMachineId === null
            || endpoint.targetMachineInstallationId === null
            || endpoint.targetMaterializationId === null
            || endpoint.targetPluginVersion === null
            || params.target.materialization.pluginId !== endpoint.pluginId
        ) {
            return { kind: "targetUnavailable", currentRevision: endpoint.revision };
        }
        const previousTargetMaterialization = {
            machineId: endpoint.targetMachineId,
            materializationId: endpoint.targetMaterializationId,
            pluginId: endpoint.pluginId,
        };
        const updated = await tx.pluginWebhookEndpoint.updateMany({
            where: { id: params.webhookEndpointId, accountId: params.accountId, revision: params.expectedRevision },
            data: {
                previousTargetMachineId: endpoint.targetMachineId,
                previousTargetMachineInstallationId: endpoint.targetMachineInstallationId,
                previousTargetMaterializationId: endpoint.targetMaterializationId,
                previousTargetPluginVersion: endpoint.targetPluginVersion,
                targetMachineId: params.target.materialization.machineId,
                targetMachineInstallationId: params.target.machineInstallationId,
                targetMaterializationId: params.target.materialization.materializationId,
                targetPluginVersion: params.target.pluginVersion,
                revision: { increment: 1 },
            },
        });
        if (updated.count !== 1) return { kind: "revisionConflict", currentRevision: endpoint.revision };
        const result = PluginWebhookEndpointRetargetResultV1Schema.parse({
            kind: "retargeted",
            webhookEndpointId: params.webhookEndpointId,
            revision: endpoint.revision + 1,
            previousTargetMaterialization,
            targetMaterialization: params.target.materialization,
        });
        if (result.kind !== "retargeted" && result.kind !== "alreadyRetargeted") {
            throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
        }
        await tx.pluginWebhookEndpointOperation.create({
            data: {
                endpointId: params.webhookEndpointId,
                accountId: params.accountId,
                operationKind: "retarget",
                idempotencyKey: params.idempotencyKey,
                expectedRevision: params.expectedRevision,
                requestTargetMachineId: params.target.materialization.machineId,
                requestTargetMaterializationId: params.target.materialization.materializationId,
                requestTargetPluginId: params.target.materialization.pluginId,
                resultKind: result.kind,
                resultRevision: result.revision,
                resultPreviousTargetMachineId: result.previousTargetMaterialization.machineId,
                resultPreviousTargetMaterializationId: result.previousTargetMaterialization.materializationId,
                resultPreviousTargetPluginId: result.previousTargetMaterialization.pluginId,
                resultTargetMachineId: result.targetMaterialization.machineId,
                resultTargetMaterializationId: result.targetMaterialization.materializationId,
                resultTargetPluginId: result.targetMaterialization.pluginId,
            },
        });
        await markPluginWebhookAccountChangedInTxV1(tx, {
            accountId: params.accountId,
            pluginId: endpoint.pluginId,
        });
        return result;
    };
    return params.tx ? await persist(params.tx) : await inTx(persist, { /* Endpoint target/revision mutations participate with webhook authority-before-fence readers. */ isolationLevel: "Serializable" });
}

/**
 * Thin domain facade over the named transaction functions above. Resolution is
 * injected by the host adapter so endpoint persistence never becomes a second
 * owner of Availability or admitted plugin manifests.
 */
export function createPluginWebhookEndpointStoreV1(options: Readonly<{
    resolveTarget(params: Readonly<{
        tx?: Tx;
        accountId: string;
        target: ResolvedPluginWebhookTargetV1["materialization"];
    }>): Awaitable<ResolvedPluginWebhookTargetV1 | null>;
    resolveContribution(params: Readonly<{
        tx?: Tx;
        accountId: string;
        contribution: Readonly<{ pluginId: string; localId: string }>;
        target: ResolvedPluginWebhookTargetV1;
    }>): Awaitable<ResolvedPluginWebhookContributionV1 | null>;
    authorizeSharedInstallation?(params: Readonly<{
        tx: Tx;
        accountId: string;
        installationId: string;
        installationAuthorizationRef: string;
        contribution: ResolvedPluginWebhookContributionV1;
    }>): Awaitable<boolean>;
    resolvePublicBaseUrl(): string | null;
    randomBytes?: (length: number) => Uint8Array;
}>): PluginWebhookEndpointStoreV1 {
    const resolvePublicBaseUrl = (): string => {
        const publicBaseUrl = options.resolvePublicBaseUrl();
        if (!publicBaseUrl) throw new PluginWebhookEndpointStoreError("route_unavailable");
        return publicBaseUrl;
    };

    return {
        ensure: async (input) => {
            const resolved: {
                value: Readonly<{
                    target: ResolvedPluginWebhookTargetV1;
                    contribution: ResolvedPluginWebhookContributionV1;
                    publicBaseUrl: string;
                }> | null;
            } = { value: null };
            const { accountId, ...actionInput } = input;
            try {
                return await inTx(async (tx) => {
                    const target = await options.resolveTarget({
                        tx,
                        accountId,
                        target: input.targetMaterialization,
                    });
                    if (!target) throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
                    const contribution = await options.resolveContribution({
                        tx,
                        accountId,
                        contribution: input.webhookContribution,
                        target,
                    });
                    if (!contribution) throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
                    if (
                        input.setup.kind === "githubSharedInstallationV1"
                        && (
                            !options.authorizeSharedInstallation
                            || !await options.authorizeSharedInstallation({
                                tx,
                                accountId,
                                installationId: input.setup.installationId,
                                installationAuthorizationRef: input.setup.installationAuthorizationRef,
                                contribution,
                            })
                        )
                    ) {
                        throw new PluginWebhookEndpointStoreError("installation_conflict");
                    }
                    const publicBaseUrl = resolvePublicBaseUrl();
                    resolved.value = { target, contribution, publicBaseUrl };
                    return await ensurePluginWebhookEndpointV1({
                        tx,
                        accountId,
                        input: actionInput,
                        contribution,
                        target,
                        publicBaseUrl,
                        randomBytes: options.randomBytes,
                    });
                }, { /* Endpoint target/revision mutations participate with webhook authority-before-fence readers. */ isolationLevel: "Serializable" });
            } catch (error) {
                if (error instanceof PluginWebhookEndpointStoreError) throw error;
                if (!isPrismaErrorCode(error, "P2002") || !resolved.value) throw error;
                const requestFingerprint = ensureFingerprint({
                    input: actionInput,
                    contribution: resolved.value.contribution,
                    target: resolved.value.target,
                });
                const raced = await readEnsureIdempotencyV1(accountId, input.idempotencyKey);
                if (raced) return projectEnsureRejoin(raced, requestFingerprint, resolved.value.publicBaseUrl);
                const deterministicConflict = await readEnsureDeterministicConflictV1({
                    accountId,
                    input: actionInput,
                    contribution: resolved.value.contribution,
                });
                if (deterministicConflict) throw new PluginWebhookEndpointStoreError(deterministicConflict);
                throw error;
            }
        },
        read: async (input) => await readPluginWebhookEndpointV1({
            ...input,
            publicBaseUrl: resolvePublicBaseUrl(),
            resolveTarget: options.resolveTarget,
        }),
        revoke: revokePluginWebhookEndpointV1,
        retarget: async (input) => await inTx(async (tx) => {
            const target = await options.resolveTarget({
                tx,
                accountId: input.accountId,
                target: input.targetMaterialization,
            });
            if (!target) throw new PluginWebhookEndpointStoreError("endpoint_unavailable");
            const endpoint = await tx.pluginWebhookEndpoint.findFirst({
                where: { id: input.webhookEndpointId, accountId: input.accountId },
                select: {
                    revision: true,
                    pluginId: true,
                    webhookContributionId: true,
                    handlerActionId: true,
                    routingKind: true,
                    route: { select: { verifierKind: true } },
                },
            });
            if (
                endpoint
                && endpoint.pluginId === target.materialization.pluginId
            ) {
                if (
                    endpoint.webhookContributionId === null
                ) {
                    return PluginWebhookEndpointRetargetResultV1Schema.parse({
                        kind: "incompatible",
                        currentRevision: endpoint.revision,
                    });
                }
                const contribution = await options.resolveContribution({
                    tx,
                    accountId: input.accountId,
                    contribution: {
                        pluginId: endpoint.pluginId,
                        localId: endpoint.webhookContributionId,
                    },
                    target,
                });
                if (
                    !contribution
                    || contribution.pluginId !== endpoint.pluginId
                    || contribution.localId !== endpoint.webhookContributionId
                    || contribution.handlerActionLocalId !== endpoint.handlerActionId
                    || contribution.routingKind !== endpoint.routingKind
                    || contribution.verifierKind !== endpoint.route.verifierKind
                ) {
                    return PluginWebhookEndpointRetargetResultV1Schema.parse({
                        kind: "incompatible",
                        currentRevision: endpoint.revision,
                    });
                }
            }
            return await retargetPluginWebhookEndpointV1({
                tx,
                accountId: input.accountId,
                webhookEndpointId: input.webhookEndpointId,
                expectedRevision: input.expectedRevision,
                idempotencyKey: input.idempotencyKey,
                target,
            });
        }, { /* Endpoint target/revision mutations participate with webhook authority-before-fence readers. */ isolationLevel: "Serializable" }),
    };
}
