import { randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";
import {
    ConnectedServiceCredentialHealthV1Schema,
    StoredJsonContentEnvelopeSchema,
    QualifiedConnectedAccountConfigurationTargetV4Schema,
    QualifiedConnectedAccountCredentialMetadataV4Schema,
    QualifiedConnectedAccountRefSchema,
    QualifiedConnectedAccountServiceRefSchema,
    QualifiedConnectedAccountProfileV4Schema,
    PluginContributionLocalIdSchema,
    readAccountScopedCiphertextKindByte,
    type QualifiedConnectedAccountConfigurationSnapshotV4,
    type QualifiedConnectedAccountConfigurationTargetV4,
    type QualifiedConnectedAccountCredentialMetadataV4,
    type QualifiedConnectedAccountRef,
    type QualifiedConnectedAccountServiceRef,
    type QualifiedConnectedAccountProfileV4,
    type ConnectedServiceCredentialHealthV1,
    type StoredJsonContentEnvelope,
} from "@happier-dev/protocol";

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { decryptString, encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import {
    createConnectedServiceCredentialRevision,
} from "../credentials/credentialRevision";
import {
    parseQualifiedConnectedServiceCredentialStoredMetadataV4,
    type QualifiedConnectedServiceCredentialStoredMetadataV4,
    withCredentialHealth,
    withQualifiedConnectedServiceCredentialHealth,
} from "../credentialHealthMetadata";
import {
    isConnectedServiceCredentialMetadataV2,
    normalizeConnectedServiceCredentialMetadataV2,
} from "../connectedServicesV2/credentialMetadataV2";
import {
    isConnectedServiceCredentialMetadataV3,
    normalizeConnectedServiceCredentialMetadataV3,
} from "../connectedServicesV3/credentialMetadataV3";
import {
    createServiceAccountTokenIdentityFields,
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
    assertQualifiedConnectedAccountLegacyIdentityMatches,
    classifyQualifiedConnectedAccountLegacyAuthenticationMode,
    projectQualifiedConnectedAccountPublicAuthenticationModeId,
    resolveLegacyServiceAccountTokenIdentityFields,
    resolveQualifiedConnectedAccountLegacyIdentity,
} from "./identity";
import {
    doesQualifiedConnectedAccountPreparedCreateWinnerMatch,
    type QualifiedConnectedAccountPreparedCreate,
} from "./credentialPreparedWrite";
import {
    resolveQualifiedConnectedAccountStoredMetadata,
    decodeLegacyQualifiedConnectedAccountCredentialEnvelope,
} from "./credentialStoredMetadataAdapter";
import {
    settleQualifiedConnectedAccountCredentialMetadata,
} from "./credentialMetadataSettlement";
import {
    clearQualifiedConnectedAccountUsageForAccountInTx,
} from "./usageRepository";

type StoredEnvelopeContainerV1 =
    | Readonly<{
        v: 1;
        storage: "json_v1";
        content: StoredJsonContentEnvelope;
    }>
    | Readonly<{
        v: 1;
        storage: "server_sealed_json_v1";
        ciphertext: string;
    }>;

export type QualifiedConnectedServiceCredentialMutationResult =
    | Readonly<{
        status: "written";
        credentialRevision: string;
        configurationRevision: string | null;
    }>
    | Readonly<{
        status: "superseded";
        reason:
            | "credential_revision_mismatch"
            | "configuration_revision_mismatch"
            | "refresh_lease_lost"
            | "concurrent_mutation";
        credentialRevision: string | null;
        configurationRevision: string | null;
    }>
    | Readonly<{ status: "provider_identity_mismatch" }>
    | Readonly<{ status: "authentication_mode_mismatch" }>
    | Readonly<{ status: "storage_mode_mismatch" }>;

export type QualifiedConnectedAccountConfigurationMutationResult =
    | Readonly<{
        status: "written";
        credentialRevision: string;
        configurationRevision: string;
    }>
    | Readonly<{
        status: "superseded";
        reason:
            | "credential_revision_mismatch"
            | "configuration_revision_mismatch"
            | "concurrent_mutation";
        credentialRevision: string;
        configurationRevision: string | null;
    }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "storage_mode_mismatch" }>;

export type QualifiedConnectedServiceCredentialHealthMutationResult =
    | Readonly<{
        status: "written";
        credentialRevision: string;
        configurationRevision: string | null;
    }>
    | Readonly<{
        status: "superseded";
        reason:
            | "credential_revision_mismatch"
            | "configuration_revision_mismatch"
            | "concurrent_mutation";
        credentialRevision: string;
        configurationRevision: string | null;
    }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "unsupported_format" }>;

export type QualifiedConnectedServiceCredentialDeleteResult =
    | Readonly<{ status: "deleted" }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "referenced" }>
    | Readonly<{
        status: "superseded";
        credentialRevision: string | null;
        configurationRevision: string | null;
    }>;

type QualifiedConnectedServiceCredentialDeleteStorageResult =
    | QualifiedConnectedServiceCredentialDeleteResult
    | Readonly<{ status: "storage_mode_mismatch" }>;

export type QualifiedConnectedAccountsAccountCleanupResult = Readonly<{
    deletedCredentialCount: number;
    deletedUsageSourceCount: number;
    deletedUsageRecordCount: number;
    reconciledGroupCount: number;
}>;

class QualifiedCredentialGroupCasConflictError extends Error {
    constructor() {
        super("Qualified Connected Account credential group CAS lost");
        this.name = "QualifiedCredentialGroupCasConflictError";
    }
}

/**
 * Clears every Connected Account credential and usage/quota record for one
 * Happier account while retaining its group definitions as empty groups.
 * Membership removal advances structural group generation once; runtime-state
 * revision is preserved because credential cleanup does not mutate runtime
 * member state.
 *
 * The caller must already hold this account's write lock by updating its Account
 * row in the same transaction. Qualified structural writers publish through that
 * row, so this snapshot cannot race an independently committed membership change.
 */
export async function clearQualifiedConnectedAccountsForAccountInTx(
    tx: Tx,
    params: Readonly<{ accountId: string }>,
): Promise<QualifiedConnectedAccountsAccountCleanupResult> {
    const groups = await tx.connectedServiceAuthGroup.findMany({
        where: { accountId: params.accountId },
        select: {
            id: true,
            generation: true,
            runtimeStateRevision: true,
            activeProfileId: true,
            activeConnectedAccountId: true,
            members: {
                take: 1,
                select: { id: true },
            },
        },
    });
    const clearedUsage =
        await clearQualifiedConnectedAccountUsageForAccountInTx(
            tx,
            { accountId: params.accountId },
        );
    const deletedCredentials = await tx.serviceAccountToken.deleteMany({
        where: { accountId: params.accountId },
    });

    let reconciledGroupCount = 0;
    for (const group of groups) {
        const structuralStateChanged =
            group.members.length > 0
            || group.activeConnectedAccountId !== null
            || group.activeProfileId !== null;
        if (!structuralStateChanged) continue;

        const updated = await tx.connectedServiceAuthGroup.updateMany({
            where: {
                id: group.id,
                accountId: params.accountId,
                generation: group.generation,
                runtimeStateRevision: group.runtimeStateRevision,
            },
            data: {
                activeConnectedAccountId: null,
                activeProfileId: null,
                generation: { increment: 1 },
            },
        });
        if (updated.count !== 1) {
            throw new QualifiedCredentialGroupCasConflictError();
        }
        reconciledGroupCount += 1;
    }

    return {
        deletedCredentialCount: deletedCredentials.count,
        deletedUsageSourceCount: clearedUsage.deletedSources,
        deletedUsageRecordCount: clearedUsage.deletedRecords,
        reconciledGroupCount,
    };
}

export type QualifiedConnectedServiceRefreshLeaseResult =
    | Readonly<{ status: "not_found" }>
    | Readonly<{
        status: "resolved";
        acquired: boolean;
        leaseUntil: number;
        ownerId: string;
        credentialRevision: string;
    }>;

function isUniqueConstraintError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "P2002";
}

function createConfigurationRevision(): string {
    return `cscr_${randomBytes(24).toString("base64url")}`;
}

function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
    const encoded = new TextEncoder().encode(value);
    const buffer = new ArrayBuffer(encoded.byteLength);
    const copy = new Uint8Array(buffer);
    copy.set(encoded);
    return copy;
}

function decodeUtf8(value: Uint8Array): string {
    return new TextDecoder().decode(value);
}

function isEnvelopeModeCompatible(
    accountMode: "plain" | "e2ee",
    envelope: StoredJsonContentEnvelope,
): boolean {
    return accountMode === "plain"
        ? envelope.t === "plain"
        : envelope.t === "encrypted";
}

async function readEffectiveAccountEncryptionMode(
    tx: Tx,
    accountId: string,
): Promise<"plain" | "e2ee"> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    if (!account) {
        throw new Error("Qualified Connected Account owner account not found");
    }
    return resolveEffectiveAccountEncryptionModeFromAccountRow(account);
}

function buildEnvelopeStorageKeyPath(params: Readonly<{
    accountId: string;
    ref: QualifiedConnectedAccountRef;
    kind: "credential" | "configuration";
}>): string[] {
    return [
        "storage",
        "qualified_connected_account",
        params.kind,
        params.accountId,
        params.ref.service.pluginId,
        params.ref.service.localId,
        params.ref.accountId,
        "v1",
    ];
}

function encodeEnvelopeForStorage(params: Readonly<{
    accountId: string;
    ref: QualifiedConnectedAccountRef;
    kind: "credential" | "configuration";
    accountMode: "plain" | "e2ee";
    content: StoredJsonContentEnvelope;
}>): Uint8Array<ArrayBuffer> {
    const content = StoredJsonContentEnvelopeSchema.parse(params.content);
    const json = JSON.stringify(content);
    const shouldServerSeal = params.accountMode === "plain"
        && readEncryptionFeatureEnv(process.env).plainAccountCredentialsAtRest !== "none";
    const container: StoredEnvelopeContainerV1 = shouldServerSeal
        ? {
            v: 1,
            storage: "server_sealed_json_v1",
            ciphertext: Buffer.from(encryptString(
                buildEnvelopeStorageKeyPath(params),
                json,
            )).toString("base64"),
        }
        : {
            v: 1,
            storage: "json_v1",
            content,
        };
    return encodeUtf8(JSON.stringify(container));
}

function decodeEnvelopeFromStorage(params: Readonly<{
    accountId: string;
    ref: QualifiedConnectedAccountRef;
    kind: "credential" | "configuration";
    bytes: Uint8Array;
}>): StoredJsonContentEnvelope {
    const raw = JSON.parse(decodeUtf8(params.bytes)) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Invalid qualified Connected Account content envelope");
    }
    const container = raw as Partial<StoredEnvelopeContainerV1>;
    if (container.v !== 1) {
        throw new Error("Unsupported qualified Connected Account content envelope");
    }
    if (container.storage === "json_v1") {
        return StoredJsonContentEnvelopeSchema.parse(container.content);
    }
    if (container.storage === "server_sealed_json_v1"
        && typeof container.ciphertext === "string") {
        const opened = decryptString(
            buildEnvelopeStorageKeyPath(params),
            Buffer.from(container.ciphertext, "base64"),
        );
        return StoredJsonContentEnvelopeSchema.parse(JSON.parse(opened));
    }
    throw new Error("Unsupported qualified Connected Account content envelope");
}

function nextUpdatedAt(current: Date): Date {
    return new Date(Math.max(Date.now(), current.getTime() + 1));
}

function resolveQualifiedConnectedAccountCredentialRevision(params: Readonly<{
    rowId: string;
    metadata: unknown;
}>): string {
    return resolveQualifiedConnectedAccountStoredMetadata(params)
        .credentialRevision;
}

type StoredQualifiedConnectedAccountIdentity = Readonly<{
    servicePluginId: string;
    serviceLocalId: string;
    qualifiedServiceDigest: string;
    connectedAccountId: string;
    qualifiedIdentityDigest: string;
}>;

function parseStoredQualifiedConnectedAccountRef(
    row: StoredQualifiedConnectedAccountIdentity,
): QualifiedConnectedAccountRef {
    const service = QualifiedConnectedAccountServiceRefSchema.parse({
        pluginId: row.servicePluginId,
        localId: row.serviceLocalId,
    });
    const ref = QualifiedConnectedAccountRefSchema.parse({
        service,
        accountId: row.connectedAccountId,
    });
    if (
        row.qualifiedServiceDigest
            !== createQualifiedConnectedAccountServiceDigest(service)
        || row.qualifiedIdentityDigest
            !== createQualifiedConnectedAccountIdentityDigest(ref)
    ) {
        throw new Error(
            "Qualified Connected Account stored identity digest mismatch",
        );
    }
    return ref;
}

type QualifiedCredentialMutationCommonParams = Readonly<{
    accountId: string;
    ref: QualifiedConnectedAccountRef;
    authenticationModeId: string;
    content: StoredJsonContentEnvelope;
    metadata: QualifiedConnectedAccountCredentialMetadataV4;
    reconnect?: Readonly<{ allowProviderIdentityChange?: boolean }>;
    refreshLeaseOwnerId?: string;
    legacyIdentity?: Readonly<{ serviceId: string; profileId: string }>;
    legacyExpiresAt?: Date | null;
    now?: Date;
}>;

export type QualifiedCredentialCreateMutationParams =
    QualifiedCredentialMutationCommonParams & Readonly<{
        expectedCredentialRevision: null;
        expectedConfigurationRevision?: never;
        initialConfiguration?: Readonly<{
            expectedConfigurationRevision: null;
            replacementContentEnvelope: StoredJsonContentEnvelope;
        }>;
    }>;

export type QualifiedCredentialUpdateMutationParams =
    QualifiedCredentialMutationCommonParams & Readonly<{
        expectedCredentialRevision: string;
        expectedConfigurationRevision: string | null;
        initialConfiguration?: never;
    }>;

export type QualifiedCredentialMutationParams =
    | QualifiedCredentialCreateMutationParams
    | QualifiedCredentialUpdateMutationParams;

export type PreparedQualifiedConnectedServiceCredentialCreate = Readonly<{
    params: QualifiedCredentialCreateMutationParams;
    write: QualifiedConnectedAccountPreparedCreate;
}>;

async function readCurrentByQualifiedRef(
    tx: Tx,
    accountId: string,
    ref: QualifiedConnectedAccountRef,
) {
    const qualifiedIdentityDigest = createQualifiedConnectedAccountIdentityDigest(ref);
    const qualifiedServiceDigest =
        createQualifiedConnectedAccountServiceDigest(ref.service);
    const current = await tx.serviceAccountToken.findUnique({
        where: {
            accountId_qualifiedIdentityDigest: {
                accountId,
                qualifiedIdentityDigest,
            },
        },
    });
    if (!current) {
        const candidates = await tx.serviceAccountToken.findMany({
            where: {
                accountId,
                servicePluginId: ref.service.pluginId,
                serviceLocalId: ref.service.localId,
                connectedAccountId: ref.accountId,
            },
            take: 2,
        });
        if (candidates.length > 1) {
            throw new Error("Ambiguous qualified Connected Account identity");
        }
        const candidate = candidates[0];
        if (candidate) {
            throw new Error("Qualified Connected Account digest mismatch");
        }
    }
    if (current && (
        current.qualifiedServiceDigest !== qualifiedServiceDigest
        || current.qualifiedIdentityDigest !== qualifiedIdentityDigest
    )) {
        throw new Error("Qualified Connected Account identity digest collision");
    }
    if (current) {
        const storedRef = parseStoredQualifiedConnectedAccountRef(current);
        if (
            storedRef.service.pluginId !== ref.service.pluginId
            || storedRef.service.localId !== ref.service.localId
            || storedRef.accountId !== ref.accountId
        ) {
            throw new Error(
                "Qualified Connected Account identity digest collision",
            );
        }
    }
    return current;
}

export async function readQualifiedConnectedServiceCredentialMutationBasisInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<Readonly<{
    credentialRevision: string;
    configurationRevision: string | null;
}> | null> {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const current = await readCurrentByQualifiedRef(
        tx,
        params.accountId,
        ref,
    );
    if (!current) return null;
    if (
        (current.configurationRevision === null)
        !== (current.configurationContent === null)
    ) {
        throw new Error(
            "Qualified Connected Account configuration sidecar is incomplete",
        );
    }
    return {
        credentialRevision:
            resolveQualifiedConnectedAccountCredentialRevision({
                rowId: current.id,
                metadata: current.metadata,
            }),
        configurationRevision: current.configurationRevision,
    };
}

function prepareQualifiedConnectedAccountCredentialCreate(params: Readonly<{
    accountId: string;
    ref: QualifiedConnectedAccountRef;
    authenticationModeId: string;
    accountMode: "plain" | "e2ee";
    content: StoredJsonContentEnvelope;
    metadata: QualifiedConnectedAccountCredentialMetadataV4;
    initialConfiguration?: Readonly<{
        replacementContentEnvelope: StoredJsonContentEnvelope;
    }>;
}>): QualifiedConnectedAccountPreparedCreate {
    const credentialRevision = createConnectedServiceCredentialRevision();
    const configurationRevision = params.initialConfiguration
        ? createConfigurationRevision()
        : null;
    return {
        authenticationModeId: params.authenticationModeId,
        credentialRevision,
        credentialBytes: encodeEnvelopeForStorage({
            accountId: params.accountId,
            ref: params.ref,
            kind: "credential",
            accountMode: params.accountMode,
            content: params.content,
        }),
        metadata: {
            v: 4,
            storage: "stored_envelope_v1",
            credentialRevision,
            values: params.metadata,
        },
        configurationRevision,
        configurationBytes: params.initialConfiguration
            ? encodeEnvelopeForStorage({
                accountId: params.accountId,
                ref: params.ref,
                kind: "configuration",
                accountMode: params.accountMode,
                content:
                    params.initialConfiguration.replacementContentEnvelope,
            })
            : null,
    };
}

async function mutateQualifiedConnectedServiceCredentialWithPreparedInTx(
    tx: Tx,
    params: QualifiedCredentialMutationParams,
    preparedCreate: QualifiedConnectedAccountPreparedCreate | null,
): Promise<QualifiedConnectedServiceCredentialMutationResult> {
    if (params.expectedCredentialRevision === null) {
        if (params.expectedConfigurationRevision !== undefined) {
            throw new Error(
                "A qualified Connected Account credential create cannot fence an existing configuration",
            );
        }
    } else if (params.expectedConfigurationRevision === undefined) {
        throw new Error(
            "A qualified Connected Account credential update requires a configuration revision fence",
        );
    }

    const account = await tx.account.findUnique({
        where: { id: params.accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    if (!account) return { status: "storage_mode_mismatch" };
    const accountMode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    if (!isEnvelopeModeCompatible(accountMode, params.content)
        || (
            params.initialConfiguration
            && !isEnvelopeModeCompatible(
                accountMode,
                params.initialConfiguration.replacementContentEnvelope,
            )
        )) {
        return { status: "storage_mode_mismatch" };
    }

    const current = await readCurrentByQualifiedRef(tx, params.accountId, params.ref);
    const currentCredentialRevision = current
        ? resolveQualifiedConnectedAccountCredentialRevision({
            rowId: current.id,
            metadata: current.metadata,
        })
        : null;
    const currentConfigurationRevision = current?.configurationRevision ?? null;
    if (
        current
        && params.expectedCredentialRevision === null
        && preparedCreate
        && doesQualifiedConnectedAccountPreparedCreateWinnerMatch({
            prepared: preparedCreate,
            winner: current,
        })
    ) {
        return {
            status: "written",
            credentialRevision: preparedCreate.credentialRevision,
            configurationRevision: preparedCreate.configurationRevision,
        };
    }
    if (params.expectedCredentialRevision !== currentCredentialRevision) {
        return {
            status: "superseded",
            reason: "credential_revision_mismatch",
            credentialRevision: currentCredentialRevision,
            configurationRevision: currentConfigurationRevision,
        };
    }
    if (params.expectedCredentialRevision !== null
        && params.expectedConfigurationRevision !== currentConfigurationRevision) {
        return {
            status: "superseded",
            reason: "configuration_revision_mismatch",
            credentialRevision: currentCredentialRevision,
            configurationRevision: currentConfigurationRevision,
        };
    }
    if (current && current.authenticationModeId !== params.authenticationModeId) {
        return { status: "authentication_mode_mismatch" };
    }
    if (params.refreshLeaseOwnerId !== undefined) {
        const now = params.now ?? new Date();
        if (
            current?.refreshLeaseOwnerMachineId !== params.refreshLeaseOwnerId
            || current.refreshLeaseExpiresAt === null
            || current.refreshLeaseExpiresAt.getTime() <= now.getTime()
        ) {
            return {
                status: "superseded",
                reason: "refresh_lease_lost",
                credentialRevision: currentCredentialRevision,
                configurationRevision: currentConfigurationRevision,
            };
        }
    }
    const currentProjection = current
        ? resolveQualifiedConnectedAccountStoredMetadata({
            rowId: current.id,
            metadata: current.metadata,
        })
        : null;
    const metadataSettlement =
        settleQualifiedConnectedAccountCredentialMetadata({
            current: currentProjection?.presentation,
            incoming: params.metadata,
            allowProviderIdentityChange:
                params.reconnect?.allowProviderIdentityChange === true,
        });
    if (metadataSettlement.status === "provider_identity_mismatch") {
        return metadataSettlement;
    }

    const effectivePreparedCreate = !current
        && params.expectedCredentialRevision === null
        ? preparedCreate ?? prepareQualifiedConnectedAccountCredentialCreate({
            accountId: params.accountId,
            ref: params.ref,
            authenticationModeId: params.authenticationModeId,
            accountMode,
            content: params.content,
            metadata: metadataSettlement.metadata,
            ...(params.initialConfiguration
                ? { initialConfiguration: params.initialConfiguration }
                : {}),
        })
        : null;
    const credentialRevision = effectivePreparedCreate?.credentialRevision
        ?? createConnectedServiceCredentialRevision();
    const metadata: QualifiedConnectedServiceCredentialStoredMetadataV4 =
        effectivePreparedCreate?.metadata ?? {
            v: 4,
            storage: "stored_envelope_v1",
            values: metadataSettlement.metadata,
            credentialRevision,
            ...(currentProjection?.health
                ? { health: currentProjection.health }
                : {}),
        };
    const identity = createServiceAccountTokenIdentityFields({
        ref: params.ref,
        authenticationModeId: params.authenticationModeId,
    });
    const token = effectivePreparedCreate?.credentialBytes
        ?? encodeEnvelopeForStorage({
            accountId: params.accountId,
            ref: params.ref,
            kind: "credential",
            accountMode,
            content: params.content,
        });

    if (!current) {
        const configurationRevision =
            effectivePreparedCreate?.configurationRevision ?? null;
        await tx.serviceAccountToken.create({
            data: {
                accountId: params.accountId,
                ...identity,
                vendor: params.legacyIdentity?.serviceId ?? null,
                profileId: params.legacyIdentity?.profileId ?? null,
                token,
                metadata: metadata as unknown as Prisma.InputJsonValue,
                configurationRevision,
                ...(params.legacyExpiresAt !== undefined
                    ? { expiresAt: params.legacyExpiresAt }
                    : {}),
                ...(effectivePreparedCreate?.configurationBytes
                    ? {
                        configurationContent:
                            effectivePreparedCreate.configurationBytes,
                    }
                    : {}),
            },
        });
        return {
            status: "written",
            credentialRevision,
            configurationRevision,
        };
    }

    const write = await tx.serviceAccountToken.updateMany({
        where: { id: current.id, updatedAt: current.updatedAt },
        data: {
            updatedAt: nextUpdatedAt(current.updatedAt),
            token,
            metadata: metadata as unknown as Prisma.InputJsonValue,
            refreshLeaseOwnerMachineId: null,
            refreshLeaseExpiresAt: null,
            ...(params.legacyExpiresAt !== undefined
                ? { expiresAt: params.legacyExpiresAt }
                : {}),
        },
    });
    if (write.count !== 1) {
        const latest = await readCurrentByQualifiedRef(tx, params.accountId, params.ref);
        return {
            status: "superseded",
            reason: "concurrent_mutation",
            credentialRevision: latest
                    ? resolveQualifiedConnectedAccountCredentialRevision({
                    rowId: latest.id,
                    metadata: latest.metadata,
                })
                : null,
            configurationRevision: latest?.configurationRevision ?? null,
        };
    }
    return {
        status: "written",
        credentialRevision,
        configurationRevision: currentConfigurationRevision,
    };
}

export async function mutateQualifiedConnectedServiceCredentialInTx(
    tx: Tx,
    params: QualifiedCredentialMutationParams,
): Promise<QualifiedConnectedServiceCredentialMutationResult> {
    return await mutateQualifiedConnectedServiceCredentialWithPreparedInTx(
        tx,
        params,
        null,
    );
}

function canonicalizeQualifiedCredentialMutation(
    params: QualifiedCredentialMutationParams,
): QualifiedCredentialMutationParams {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const authenticationModeId =
        PluginContributionLocalIdSchema.parse(params.authenticationModeId);
    const mappedLegacyIdentity =
        resolveQualifiedConnectedAccountLegacyIdentity({
            ref,
            authenticationModeId,
        });
    if (params.legacyIdentity) {
        assertQualifiedConnectedAccountLegacyIdentityMatches({
            ref,
            authenticationModeId,
            legacyIdentity: params.legacyIdentity,
        });
    }
    const canonicalBase = {
        accountId: params.accountId,
        ref,
        authenticationModeId,
        metadata:
            QualifiedConnectedAccountCredentialMetadataV4Schema.parse(
                params.metadata,
            ),
        content: StoredJsonContentEnvelopeSchema.parse(params.content),
        ...(params.reconnect ? { reconnect: params.reconnect } : {}),
        ...(params.refreshLeaseOwnerId
            ? { refreshLeaseOwnerId: params.refreshLeaseOwnerId }
            : {}),
        ...(mappedLegacyIdentity
            ? { legacyIdentity: mappedLegacyIdentity }
            : {}),
        ...(params.now ? { now: params.now } : {}),
        ...(params.legacyExpiresAt !== undefined
            ? { legacyExpiresAt: params.legacyExpiresAt }
            : {}),
    };
    return params.expectedCredentialRevision === null
        ? {
            ...canonicalBase,
            expectedCredentialRevision: null,
            ...(params.initialConfiguration
                ? {
                    initialConfiguration: {
                        expectedConfigurationRevision: null,
                        replacementContentEnvelope:
                            StoredJsonContentEnvelopeSchema.parse(
                                params.initialConfiguration
                                    .replacementContentEnvelope,
                            ),
                    },
                }
                : {}),
        }
        : {
            ...canonicalBase,
            expectedCredentialRevision: params.expectedCredentialRevision,
            expectedConfigurationRevision:
                params.expectedConfigurationRevision,
        };
}

export async function prepareQualifiedConnectedServiceCredentialCreate(
    params: QualifiedCredentialCreateMutationParams,
): Promise<
    | Readonly<{
        status: "prepared";
        prepared: PreparedQualifiedConnectedServiceCredentialCreate;
    }>
    | Readonly<{ status: "storage_mode_mismatch" }>
    | Readonly<{ status: "authentication_mode_mismatch" }>
> {
    const unsupportedLegacyMode =
        classifyQualifiedConnectedAccountLegacyAuthenticationMode({
            service: params.ref.service,
            authenticationModeId: params.authenticationModeId,
        });
    if (
        unsupportedLegacyMode?.support === "unsupported"
        && params.legacyIdentity === undefined
    ) {
        return { status: "authentication_mode_mismatch" };
    }
    const canonicalParams = canonicalizeQualifiedCredentialMutation(params);
    if (canonicalParams.expectedCredentialRevision !== null) {
        throw new Error(
            "Qualified Connected Account create preparation requires null credential CAS",
        );
    }
    const account = await db.account.findUnique({
        where: { id: canonicalParams.accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    if (!account) return { status: "storage_mode_mismatch" };
    const accountMode =
        resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    if (
        !isEnvelopeModeCompatible(accountMode, canonicalParams.content)
        || (
            canonicalParams.initialConfiguration
            && !isEnvelopeModeCompatible(
                accountMode,
                canonicalParams.initialConfiguration
                    .replacementContentEnvelope,
            )
        )
    ) {
        return { status: "storage_mode_mismatch" };
    }
    return {
        status: "prepared",
        prepared: {
            params: canonicalParams,
            write: prepareQualifiedConnectedAccountCredentialCreate({
                accountId: canonicalParams.accountId,
                ref: canonicalParams.ref,
                authenticationModeId:
                    canonicalParams.authenticationModeId,
                accountMode,
                content: canonicalParams.content,
                metadata: canonicalParams.metadata,
                ...(canonicalParams.initialConfiguration
                    ? {
                        initialConfiguration:
                            canonicalParams.initialConfiguration,
                    }
                    : {}),
            }),
        },
    };
}

function supersededPreparedCreateResult(params: Readonly<{
    current: Awaited<ReturnType<typeof readCurrentByQualifiedRef>>;
}>): QualifiedConnectedServiceCredentialMutationResult {
    return {
        status: "superseded",
        reason: "credential_revision_mismatch",
        credentialRevision: params.current
            ? resolveQualifiedConnectedAccountCredentialRevision({
                rowId: params.current.id,
                metadata: params.current.metadata,
            })
            : null,
        configurationRevision:
            params.current?.configurationRevision ?? null,
    };
}

export async function settlePreparedQualifiedConnectedServiceCredentialCreate(
    prepared: PreparedQualifiedConnectedServiceCredentialCreate,
): Promise<QualifiedConnectedServiceCredentialMutationResult> {
    try {
        return await inTx(async (tx) => {
            const result =
                await mutateQualifiedConnectedServiceCredentialWithPreparedInTx(
                    tx,
                    prepared.params,
                    prepared.write,
                );
            if (result.status === "written") {
                await recordConnectedServiceAccountProfileChange({
                    tx,
                    accountId: prepared.params.accountId,
                });
            }
            return result;
        });
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const current = await readCurrentByQualifiedRef(
            db,
            prepared.params.accountId,
            prepared.params.ref,
        );
        if (!current) {
            throw new Error(
                "Qualified Connected Account uniqueness conflict did not resolve to the requested identity",
                { cause: error },
            );
        }
        if (doesQualifiedConnectedAccountPreparedCreateWinnerMatch({
            prepared: prepared.write,
            winner: current,
        })) {
            return {
                status: "written",
                credentialRevision: prepared.write.credentialRevision,
                configurationRevision:
                    prepared.write.configurationRevision,
            };
        }
        return supersededPreparedCreateResult({ current });
    }
}

export async function mutateQualifiedConnectedServiceCredential(
    params: QualifiedCredentialMutationParams,
): Promise<QualifiedConnectedServiceCredentialMutationResult> {
    const unsupportedLegacyMode =
        classifyQualifiedConnectedAccountLegacyAuthenticationMode({
            service: params.ref.service,
            authenticationModeId: params.authenticationModeId,
        });
    if (
        unsupportedLegacyMode?.support === "unsupported"
        && params.legacyIdentity === undefined
    ) {
        return { status: "authentication_mode_mismatch" };
    }
    if (params.expectedCredentialRevision === null) {
        const preparation =
            await prepareQualifiedConnectedServiceCredentialCreate(params);
        if (preparation.status === "storage_mode_mismatch") {
            return preparation;
        }
        if (preparation.status === "authentication_mode_mismatch") {
            return preparation;
        }
        return await settlePreparedQualifiedConnectedServiceCredentialCreate(
            preparation.prepared,
        );
    }
    const canonicalParams =
        canonicalizeQualifiedCredentialMutation(params);
    return await inTx(async (tx) => {
        const result =
            await mutateQualifiedConnectedServiceCredentialWithPreparedInTx(
                tx,
                canonicalParams,
                null,
            );
        if (result.status === "written") {
            await recordConnectedServiceAccountProfileChange({
                tx,
                accountId: canonicalParams.accountId,
            });
        }
        return result;
    });
}

export async function readQualifiedConnectedAccountConfiguration(params: Readonly<{
    accountId: string;
    target: QualifiedConnectedAccountConfigurationTargetV4;
}>): Promise<QualifiedConnectedAccountConfigurationSnapshotV4 | null> {
    const target =
        QualifiedConnectedAccountConfigurationTargetV4Schema.parse(
            params.target,
        );
    return await inTx(async (tx) => {
        const accountMode =
            await readEffectiveAccountEncryptionMode(tx, params.accountId);
        const row = await readCurrentByQualifiedRef(
            tx,
            params.accountId,
            target.ref,
        );
        if (!row) return null;
        if (row.authenticationModeId === null) {
            throw new Error(
                "Qualified Connected Account is missing its establishing authentication mode",
            );
        }
        const configurationRevision = row.configurationRevision;
        const configurationBytes = row.configurationContent;
        if ((configurationRevision === null) !== (configurationBytes === null)) {
            throw new Error(
                "Qualified Connected Account configuration sidecar is incomplete",
            );
        }
        if (configurationRevision === null || configurationBytes === null) {
            return null;
        }
        const configurationContent = decodeEnvelopeFromStorage({
            accountId: params.accountId,
            ref: target.ref,
            kind: "configuration",
            bytes: configurationBytes,
        });
        if (!isEnvelopeModeCompatible(accountMode, configurationContent)) {
            throw new Error(
                "Qualified Connected Account configuration storage mode does not match its owner account",
            );
        }
        return {
            target,
            authenticationModeId:
                projectQualifiedConnectedAccountPublicAuthenticationModeId({
                    service: target.ref.service,
                    authenticationModeId: row.authenticationModeId,
                }),
            credentialRevision: resolveQualifiedConnectedAccountCredentialRevision({
                rowId: row.id,
                metadata: row.metadata,
            }),
            configurationRevision,
            configurationContent,
        };
    });
}

export type QualifiedConnectedAccountConfigurationMutationParams = Readonly<{
    accountId: string;
    target: QualifiedConnectedAccountConfigurationTargetV4;
    expectedCredentialRevision: string;
    expectedConfigurationRevision: string | null;
    replacementContentEnvelope: StoredJsonContentEnvelope;
    preserveConfigurationRevisionForCiphertextReseal?: true;
}>;

export async function mutateQualifiedConnectedAccountConfigurationInTx(
    tx: Tx,
    params: QualifiedConnectedAccountConfigurationMutationParams,
): Promise<QualifiedConnectedAccountConfigurationMutationResult> {
    const account = await tx.account.findUnique({
        where: { id: params.accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    if (!account) return { status: "not_found" };
    const accountMode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    if (!isEnvelopeModeCompatible(
        accountMode,
        params.replacementContentEnvelope,
    )) {
        return { status: "storage_mode_mismatch" };
    }

    const row = await readCurrentByQualifiedRef(
        tx,
        params.accountId,
        params.target.ref,
    );
    if (!row) return { status: "not_found" };
    const credentialRevision = resolveQualifiedConnectedAccountCredentialRevision({
        rowId: row.id,
        metadata: row.metadata,
    });
    if (params.expectedCredentialRevision !== credentialRevision) {
        return {
            status: "superseded",
            reason: "credential_revision_mismatch",
            credentialRevision,
            configurationRevision: row.configurationRevision,
        };
    }
    if (params.expectedConfigurationRevision !== row.configurationRevision) {
        return {
            status: "superseded",
            reason: "configuration_revision_mismatch",
            credentialRevision,
            configurationRevision: row.configurationRevision,
        };
    }

    let configurationRevision: string;
    if (params.preserveConfigurationRevisionForCiphertextReseal) {
        if (
            accountMode !== "e2ee"
            || row.configurationRevision === null
            || row.configurationContent === null
            || params.replacementContentEnvelope.t !== "encrypted"
        ) {
            return { status: "storage_mode_mismatch" };
        }
        const currentContent = decodeEnvelopeFromStorage({
            accountId: params.accountId,
            ref: params.target.ref,
            kind: "configuration",
            bytes: row.configurationContent,
        });
        if (
            currentContent.t !== "encrypted"
            || readAccountScopedCiphertextKindByte(
                currentContent.c,
            ) !== 8
            || readAccountScopedCiphertextKindByte(
                params.replacementContentEnvelope.c,
            ) !== 9
        ) {
            return { status: "storage_mode_mismatch" };
        }
        configurationRevision = row.configurationRevision;
    } else {
        configurationRevision = createConfigurationRevision();
    }
    const write = await tx.serviceAccountToken.updateMany({
        where: {
            id: row.id,
            updatedAt: row.updatedAt,
            configurationRevision: row.configurationRevision,
        },
        data: {
            updatedAt: nextUpdatedAt(row.updatedAt),
            configurationRevision,
            configurationContent: encodeEnvelopeForStorage({
                accountId: params.accountId,
                ref: params.target.ref,
                kind: "configuration",
                accountMode,
                content: params.replacementContentEnvelope,
            }),
        },
    });
    if (write.count !== 1) {
        const latest = await readCurrentByQualifiedRef(
            tx,
            params.accountId,
            params.target.ref,
        );
        if (!latest) return { status: "not_found" };
        return {
            status: "superseded",
            reason: "concurrent_mutation",
            credentialRevision: resolveQualifiedConnectedAccountCredentialRevision({
                rowId: latest.id,
                metadata: latest.metadata,
            }),
            configurationRevision: latest.configurationRevision,
        };
    }
    return {
        status: "written",
        credentialRevision,
        configurationRevision,
    };
}

export async function mutateQualifiedConnectedAccountConfiguration(
    params: QualifiedConnectedAccountConfigurationMutationParams,
): Promise<QualifiedConnectedAccountConfigurationMutationResult> {
    const canonicalParams = {
        ...params,
        target: QualifiedConnectedAccountConfigurationTargetV4Schema.parse(
            params.target,
        ),
        replacementContentEnvelope: StoredJsonContentEnvelopeSchema.parse(
            params.replacementContentEnvelope,
        ),
    };
    return await inTx(async (tx) => {
        const result =
            await mutateQualifiedConnectedAccountConfigurationInTx(
                tx,
                canonicalParams,
            );
        if (result.status === "written") {
            await recordConnectedServiceAccountProfileChange({
                tx,
                accountId: params.accountId,
            });
        }
        return result;
    });
}

const QUALIFIED_CONNECTED_ACCOUNT_UNPAGINATED_LIMIT = 500;
type QualifiedConnectedAccountListStorage = Pick<
    Tx,
    "serviceAccountToken"
>;

function qualifiedConnectedAccountMigrationKey(
    ref: QualifiedConnectedAccountRef,
): string {
    return JSON.stringify([
        ref.service.pluginId,
        ref.service.localId,
        ref.accountId,
    ]);
}

function legacyConnectedAccountMigrationKey(
    identity: Readonly<{ serviceId: string; profileId: string }>,
): string {
    return JSON.stringify([identity.serviceId, identity.profileId]);
}

export async function isQualifiedConnectedAccountMigrationInventoryCompleteInTx(
    tx: QualifiedConnectedAccountListStorage,
    params: Readonly<{
        accountId: string;
        legacyCredentials: readonly Readonly<{
            serviceId: string;
            profileId: string;
        }>[];
        qualifiedCredentials: readonly Readonly<{
            ref: QualifiedConnectedAccountRef;
        }>[];
    }>,
): Promise<boolean> {
    if (
        params.legacyCredentials.length === 0
        && params.qualifiedCredentials.length === 0
    ) {
        return await tx.serviceAccountToken.count({
            where: { accountId: params.accountId },
        }) === 0;
    }

    const incomingLegacyKeys = new Set(
        params.legacyCredentials.map((credential) => {
            resolveLegacyServiceAccountTokenIdentityFields({
                serviceId: credential.serviceId,
                profileId: credential.profileId,
            });
            return legacyConnectedAccountMigrationKey(credential);
        }),
    );
    const incomingQualifiedKeys = new Set(
        params.qualifiedCredentials.map((credential) =>
            qualifiedConnectedAccountMigrationKey(
                QualifiedConnectedAccountRefSchema.parse(credential.ref),
            )),
    );
    if (
        incomingLegacyKeys.size !== params.legacyCredentials.length
        || incomingQualifiedKeys.size !== params.qualifiedCredentials.length
    ) {
        return false;
    }
    const expectedRowCount =
        incomingLegacyKeys.size + incomingQualifiedKeys.size;

    const rows = await tx.serviceAccountToken.findMany({
        where: { accountId: params.accountId },
        select: {
            vendor: true,
            profileId: true,
            servicePluginId: true,
            serviceLocalId: true,
            qualifiedServiceDigest: true,
            connectedAccountId: true,
            qualifiedIdentityDigest: true,
            authenticationModeId: true,
            configurationRevision: true,
        },
        take: expectedRowCount + 1,
    });
    if (rows.length > expectedRowCount) return false;
    for (const row of rows) {
        const ref = parseStoredQualifiedConnectedAccountRef(row);
        if ((row.vendor === null) !== (row.profileId === null)) {
            throw new Error(
                "Qualified Connected Account legacy identity shadow is incomplete",
            );
        }
        const legacyIdentity = row.vendor !== null && row.profileId !== null
            ? { serviceId: row.vendor, profileId: row.profileId }
            : null;
        if (legacyIdentity) {
            assertQualifiedConnectedAccountLegacyIdentityMatches({
                ref,
                authenticationModeId: row.authenticationModeId,
                legacyIdentity,
            });
        }
        const coveredByQualified = incomingQualifiedKeys.has(
            qualifiedConnectedAccountMigrationKey(ref),
        );
        const coveredByLegacy = legacyIdentity !== null
            && incomingLegacyKeys.has(
                legacyConnectedAccountMigrationKey(legacyIdentity),
            );
        if (
            coveredByQualified === coveredByLegacy
            || (
                coveredByLegacy
                && row.configurationRevision !== null
            )
        ) {
            return false;
        }
    }
    return rows.length === expectedRowCount;
}

async function listQualifiedConnectedAccountsByFilterInTx(
    tx: QualifiedConnectedAccountListStorage,
    params: Readonly<{
        accountId: string;
        service?: QualifiedConnectedAccountServiceRef;
    }>,
): Promise<QualifiedConnectedAccountProfileV4[]> {
    const service = params.service
        ? QualifiedConnectedAccountServiceRefSchema.parse(params.service)
        : null;
    const qualifiedServiceDigest = service
        ? createQualifiedConnectedAccountServiceDigest(service)
        : null;
    const selectedRows = await tx.serviceAccountToken.findMany({
        where: {
            accountId: params.accountId,
            ...(qualifiedServiceDigest ? { qualifiedServiceDigest } : {}),
        },
        orderBy: [
            { connectedAccountId: "asc" },
            { id: "asc" },
        ],
        take: QUALIFIED_CONNECTED_ACCOUNT_UNPAGINATED_LIMIT + 1,
    });
    const rows = selectedRows.filter((row) => {
        const canonicalValues = [
            row.servicePluginId,
            row.serviceLocalId,
            row.qualifiedServiceDigest,
            row.connectedAccountId,
            row.qualifiedIdentityDigest,
            row.authenticationModeId,
        ];
        const presentCount = canonicalValues.filter(
            (value) => typeof value === "string" && value.length > 0,
        ).length;
        if (presentCount === 0 && service === null) return false;
        if (presentCount !== canonicalValues.length) {
            throw new Error(
                "Qualified Connected Account canonical identity is incomplete",
            );
        }
        return true;
    });
    if (rows.length > QUALIFIED_CONNECTED_ACCOUNT_UNPAGINATED_LIMIT) {
        throw new Error(
            "Qualified Connected Account unpaginated list limit exceeded",
        );
    }
    return rows.map((row) => {
        const ref = parseStoredQualifiedConnectedAccountRef(row);
        const rowService = ref.service;
        if (
            service
            && (
                row.servicePluginId !== service.pluginId
                || row.serviceLocalId !== service.localId
            )
        ) {
            throw new Error(
                "Qualified Connected Account list identity digest mismatch",
            );
        }
        if (
            (row.configurationRevision === null)
            !== (row.configurationContent === null)
        ) {
            throw new Error(
                "Qualified Connected Account configuration sidecar is incomplete",
            );
        }
        const metadata = resolveQualifiedConnectedAccountStoredMetadata({
            rowId: row.id,
            metadata: row.metadata,
        });
        const legacyMode =
            classifyQualifiedConnectedAccountLegacyAuthenticationMode({
                service: rowService,
                authenticationModeId: row.authenticationModeId,
            });
        return QualifiedConnectedAccountProfileV4Schema.parse({
            ref,
            status: legacyMode?.support === "unsupported"
                ? "needs_reauth"
                : metadata.status,
            authenticationModeId:
                projectQualifiedConnectedAccountPublicAuthenticationModeId({
                    service: rowService,
                    authenticationModeId: row.authenticationModeId,
                }),
            credentialRevision: metadata.credentialRevision,
            configurationReady: row.configurationRevision !== null,
            configurationRevision: row.configurationRevision,
            kind: metadata.kind,
            expiresAt: row.expiresAt?.getTime() ?? null,
            lastUsedAt: row.lastUsedAt?.getTime() ?? null,
            ...metadata.presentation,
        });
    });
}

export async function listQualifiedConnectedAccountsInTx(
    tx: QualifiedConnectedAccountListStorage,
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
    }>,
): Promise<QualifiedConnectedAccountProfileV4[]> {
    return await listQualifiedConnectedAccountsByFilterInTx(tx, params);
}

export async function listAllQualifiedConnectedAccountsInTx(
    tx: QualifiedConnectedAccountListStorage,
    params: Readonly<{ accountId: string }>,
): Promise<QualifiedConnectedAccountProfileV4[]> {
    return await listQualifiedConnectedAccountsByFilterInTx(tx, params);
}

export async function listAllQualifiedConnectedAccountsForLegacyProjectionInTx(
    tx: QualifiedConnectedAccountListStorage,
    params: Readonly<{ accountId: string }>,
): Promise<Array<Readonly<{
    account: QualifiedConnectedAccountProfileV4;
    health: ConnectedServiceCredentialHealthV1 | null;
    legacyCredentialKind: "oauth" | "token" | null;
    publishLegacyCredentialRevision: boolean;
}>>> {
    const accounts =
        await listAllQualifiedConnectedAccountsInTx(tx, params);
    const rows = await tx.serviceAccountToken.findMany({
        where: { accountId: params.accountId },
        select: {
            id: true,
            qualifiedIdentityDigest: true,
            authenticationModeId: true,
            metadata: true,
        },
        take: QUALIFIED_CONNECTED_ACCOUNT_UNPAGINATED_LIMIT + 1,
    });
    if (rows.length > QUALIFIED_CONNECTED_ACCOUNT_UNPAGINATED_LIMIT) {
        throw new Error(
            "Qualified Connected Account legacy projection limit exceeded",
        );
    }
    const storedByIdentityDigest = new Map(
        rows.map((row) => [
            row.qualifiedIdentityDigest,
            {
                authenticationModeId: row.authenticationModeId,
                metadata: row.metadata,
                projection:
                    resolveQualifiedConnectedAccountStoredMetadata({
                        rowId: row.id,
                        metadata: row.metadata,
                    }),
            },
        ]),
    );
    return accounts.map((account) => {
        const stored = storedByIdentityDigest.get(
            createQualifiedConnectedAccountIdentityDigest(
                account.ref,
            ),
        );
        if (!stored) {
            throw new Error(
                "Qualified Connected Account legacy projection row disappeared",
            );
        }
        const explicitLegacyRevision =
            stored.metadata !== null
            && typeof stored.metadata === "object"
            && "credentialRevision" in stored.metadata
            && typeof stored.metadata.credentialRevision === "string";
        const legacyMode =
            classifyQualifiedConnectedAccountLegacyAuthenticationMode({
                service: account.ref.service,
                authenticationModeId: stored.authenticationModeId,
            });
        return {
            account,
            health: stored.projection.health,
            legacyCredentialKind:
                legacyMode?.credentialKind
                ?? stored.projection.kind
                ?? null,
            publishLegacyCredentialRevision:
                stored.projection.format === "v4"
                || explicitLegacyRevision,
        };
    });
}

export async function listQualifiedConnectedAccounts(
    params: Readonly<{
        accountId: string;
        service: QualifiedConnectedAccountServiceRef;
    }>,
): Promise<QualifiedConnectedAccountProfileV4[]> {
    return await inTx(async (tx) =>
        await listQualifiedConnectedAccountsInTx(tx, params));
}

function withQualifiedCredentialHealthForStoredFormat(params: Readonly<{
    metadata: unknown;
    health: ConnectedServiceCredentialHealthV1;
}>): Prisma.InputJsonValue | null {
    if (
        params.metadata
        && typeof params.metadata === "object"
        && "v" in params.metadata
        && params.metadata.v === 4
    ) {
        return withQualifiedConnectedServiceCredentialHealth(
            parseQualifiedConnectedServiceCredentialStoredMetadataV4(
                params.metadata,
            ),
            params.health,
        ) as unknown as Prisma.InputJsonValue;
    }
    if (isConnectedServiceCredentialMetadataV2(params.metadata)) {
        return withCredentialHealth(
            normalizeConnectedServiceCredentialMetadataV2(params.metadata),
            params.health,
        );
    }
    if (isConnectedServiceCredentialMetadataV3(params.metadata)) {
        return withCredentialHealth(
            normalizeConnectedServiceCredentialMetadataV3(params.metadata),
            params.health,
        );
    }
    return null;
}

export async function mutateQualifiedConnectedServiceCredentialHealth(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        health: ConnectedServiceCredentialHealthV1;
        expectedCredentialRevision: string;
        expectedConfigurationRevision: string | null;
    }>,
): Promise<QualifiedConnectedServiceCredentialHealthMutationResult> {
    const canonical = {
        ...params,
        ref: QualifiedConnectedAccountRefSchema.parse(params.ref),
        health: ConnectedServiceCredentialHealthV1Schema.parse(params.health),
    };
    return await inTx(async (tx) => {
        const current = await readCurrentByQualifiedRef(
            tx,
            canonical.accountId,
            canonical.ref,
        );
        if (!current) return { status: "not_found" };
        if (
            (current.configurationRevision === null)
            !== (current.configurationContent === null)
        ) {
            throw new Error(
                "Qualified Connected Account configuration sidecar is incomplete",
            );
        }
        const projection = resolveQualifiedConnectedAccountStoredMetadata({
            rowId: current.id,
            metadata: current.metadata,
        });
        if (
            canonical.expectedCredentialRevision
                !== projection.credentialRevision
        ) {
            return {
                status: "superseded",
                reason: "credential_revision_mismatch",
                credentialRevision: projection.credentialRevision,
                configurationRevision: current.configurationRevision,
            };
        }
        if (
            canonical.expectedConfigurationRevision
                !== current.configurationRevision
        ) {
            return {
                status: "superseded",
                reason: "configuration_revision_mismatch",
                credentialRevision: projection.credentialRevision,
                configurationRevision: current.configurationRevision,
            };
        }
        const metadata = withQualifiedCredentialHealthForStoredFormat({
            metadata: current.metadata,
            health: canonical.health,
        });
        if (!metadata) return { status: "unsupported_format" };
        const write = await tx.serviceAccountToken.updateMany({
            where: {
                id: current.id,
                updatedAt: current.updatedAt,
                configurationRevision:
                    canonical.expectedConfigurationRevision,
            },
            data: {
                updatedAt: nextUpdatedAt(current.updatedAt),
                metadata,
            },
        });
        if (write.count !== 1) {
            const latest = await readCurrentByQualifiedRef(
                tx,
                canonical.accountId,
                canonical.ref,
            );
            if (!latest) return { status: "not_found" };
            const latestProjection =
                resolveQualifiedConnectedAccountStoredMetadata({
                    rowId: latest.id,
                    metadata: latest.metadata,
                });
            return {
                status: "superseded",
                reason: "concurrent_mutation",
                credentialRevision: latestProjection.credentialRevision,
                configurationRevision: latest.configurationRevision,
            };
        }
        await recordConnectedServiceAccountProfileChange({
            tx,
            accountId: canonical.accountId,
        });
        return {
            status: "written",
            credentialRevision: projection.credentialRevision,
            configurationRevision: current.configurationRevision,
        };
    });
}

type QualifiedConnectedServiceCredentialSnapshot = Readonly<{
    credentialRevision: string;
    authenticationModeId: string | null;
    configurationRevision: string | null;
    content: StoredJsonContentEnvelope;
    metadata: QualifiedConnectedAccountCredentialMetadataV4;
}>;

type QualifiedConnectedServiceCredentialLegacySnapshot =
    Omit<
        QualifiedConnectedServiceCredentialSnapshot,
        "authenticationModeId"
    > & Readonly<{
        authenticationModeId: string;
        expiresAt: number | null;
    }>;

type QualifiedConnectedServiceCredentialLegacyReadResult =
    | Readonly<{
        status: "resolved";
        credential: QualifiedConnectedServiceCredentialLegacySnapshot;
    }>
    | Readonly<{
        status:
            | "not_found"
            | "unsupported_format"
            | "storage_mode_mismatch";
    }>;

async function readQualifiedConnectedServiceCredentialInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<QualifiedConnectedServiceCredentialLegacyReadResult> {
    const accountMode =
        await readEffectiveAccountEncryptionMode(tx, params.accountId);
    const row = await readCurrentByQualifiedRef(
        tx,
        params.accountId,
        params.ref,
    );
    if (!row) return { status: "not_found" };
    if (row.authenticationModeId === null) {
        throw new Error(
            "Qualified Connected Account is missing its establishing authentication mode",
        );
    }
    if ((row.configurationRevision === null)
        !== (row.configurationContent === null)) {
        throw new Error(
            "Qualified Connected Account configuration sidecar is incomplete",
        );
    }
    const projection =
        resolveQualifiedConnectedAccountStoredMetadata({
            rowId: row.id,
            metadata: row.metadata,
        });
    const isV4 = projection.format === "v4";
    let content: StoredJsonContentEnvelope | null;
    try {
        content = isV4
            ? decodeEnvelopeFromStorage({
                accountId: params.accountId,
                ref: params.ref,
                kind: "credential",
                bytes: row.token,
            })
            : (
                row.vendor && row.profileId
                    ? decodeLegacyQualifiedConnectedAccountCredentialEnvelope({
                        accountId: params.accountId,
                        serviceId: row.vendor,
                        profileId: row.profileId,
                        token: row.token,
                        metadata: row.metadata,
                    })
                    : null
            );
    } catch (error) {
        if (isV4) throw error;
        return { status: "unsupported_format" };
    }
    if (!content) return { status: "unsupported_format" };
    if (!isEnvelopeModeCompatible(accountMode, content)) {
        return { status: "storage_mode_mismatch" };
    }
    return {
        status: "resolved",
        credential: {
            credentialRevision:
                resolveQualifiedConnectedAccountCredentialRevision({
                    rowId: row.id,
                    metadata: row.metadata,
                }),
            authenticationModeId: row.authenticationModeId,
            configurationRevision: row.configurationRevision,
            content,
            expiresAt: row.expiresAt?.getTime() ?? null,
            metadata: isV4
                ? parseQualifiedConnectedServiceCredentialStoredMetadataV4(
                    row.metadata,
                ).values
                : projection.presentation,
        },
    };
}

export async function readQualifiedConnectedServiceCredentialForLegacyProjection(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
    }>,
): Promise<QualifiedConnectedServiceCredentialLegacyReadResult> {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    return await inTx(async (tx) =>
        await readQualifiedConnectedServiceCredentialInTx(tx, {
            accountId: params.accountId,
            ref,
        }));
}

export async function readQualifiedConnectedServiceCredential(params: Readonly<{
    accountId: string;
    ref: QualifiedConnectedAccountRef;
}>): Promise<QualifiedConnectedServiceCredentialSnapshot | null> {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const result = await inTx(async (tx) =>
        await readQualifiedConnectedServiceCredentialInTx(tx, {
            accountId: params.accountId,
            ref,
        }));
    if (result.status === "storage_mode_mismatch") {
        throw new Error(
            "Qualified Connected Account credential storage mode mismatch",
        );
    }
    if (result.status !== "resolved") return null;
    const {
        expiresAt: _legacyExpiresAt,
        authenticationModeId,
        ...credential
    } = result.credential;
    return {
        ...credential,
        authenticationModeId:
            projectQualifiedConnectedAccountPublicAuthenticationModeId({
                service: ref.service,
                authenticationModeId,
            }),
    };
}

function hasConnectedServiceCredentialOwnerMetadata(
    metadata: unknown,
): boolean {
    return isConnectedServiceCredentialMetadataV2(metadata)
        || isConnectedServiceCredentialMetadataV3(metadata)
        || (
            metadata !== null
            && typeof metadata === "object"
            && !Array.isArray(metadata)
            && "v" in metadata
            && metadata.v === 4
        );
}

export async function mutateQualifiedConnectedServiceLegacyVendorToken(
    params: Readonly<{
        accountId: string;
        vendor: string;
        token: Uint8Array<ArrayBuffer>;
    }>,
): Promise<Readonly<{
    status: "written" | "connected_credential_conflict";
}>> {
    const identity = resolveLegacyServiceAccountTokenIdentityFields({
        serviceId: params.vendor,
        profileId: "default",
    });
    const ref = {
        service: {
            pluginId: identity.servicePluginId,
            localId: identity.serviceLocalId,
        },
        accountId: identity.connectedAccountId,
    };
    return await inTx(async (tx) => {
        const current = await readCurrentByQualifiedRef(
            tx,
            params.accountId,
            ref,
        );
        if (
            current
            && hasConnectedServiceCredentialOwnerMetadata(
                current.metadata,
            )
        ) {
            return { status: "connected_credential_conflict" };
        }
        if (current) {
            await tx.serviceAccountToken.update({
                where: { id: current.id },
                data: {
                    updatedAt: new Date(),
                    token: params.token,
                    refreshLeaseOwnerMachineId: null,
                    refreshLeaseExpiresAt: null,
                },
            });
        } else {
            const legacyTupleCollision =
                await tx.serviceAccountToken.findUnique({
                    where: {
                        accountId_vendor_profileId: {
                            accountId: params.accountId,
                            vendor: params.vendor,
                            profileId: "default",
                        },
                    },
                    select: { id: true },
                });
            if (legacyTupleCollision) {
                return { status: "connected_credential_conflict" };
            }
            await tx.serviceAccountToken.create({
                data: {
                    accountId: params.accountId,
                    vendor: params.vendor,
                    profileId: "default",
                    ...identity,
                    token: params.token,
                },
            });
        }
        await recordConnectedServiceAccountProfileChange({
            tx,
            accountId: params.accountId,
        });
        return { status: "written" };
    });
}

export async function deleteQualifiedConnectedServiceLegacyVendorToken(
    params: Readonly<{
        accountId: string;
        vendor: string;
    }>,
): Promise<Readonly<{
    status:
        | "deleted"
        | "not_found"
        | "connected_credential_conflict";
}>> {
    const identity = resolveLegacyServiceAccountTokenIdentityFields({
        serviceId: params.vendor,
        profileId: "default",
    });
    const ref = {
        service: {
            pluginId: identity.servicePluginId,
            localId: identity.serviceLocalId,
        },
        accountId: identity.connectedAccountId,
    };
    return await inTx(async (tx) => {
        const current = await readCurrentByQualifiedRef(
            tx,
            params.accountId,
            ref,
        );
        if (!current) return { status: "not_found" };
        if (
            hasConnectedServiceCredentialOwnerMetadata(
                current.metadata,
            )
        ) {
            return { status: "connected_credential_conflict" };
        }
        await tx.serviceAccountToken.delete({
            where: { id: current.id },
        });
        await recordConnectedServiceAccountProfileChange({
            tx,
            accountId: params.accountId,
        });
        return { status: "deleted" };
    });
}

export function deleteQualifiedConnectedServiceCredential(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        expectedCredentialRevision: string;
        cleanupGroupReferences: boolean;
    }>,
): Promise<QualifiedConnectedServiceCredentialDeleteResult>;
export function deleteQualifiedConnectedServiceCredential(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        expectedCredentialRevision?: string;
        expectedStorageMode: "plain" | "sealed";
        cleanupGroupReferences: boolean;
    }>,
): Promise<QualifiedConnectedServiceCredentialDeleteStorageResult>;
export async function deleteQualifiedConnectedServiceCredential(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        expectedCredentialRevision?: string;
        expectedStorageMode?: "plain" | "sealed";
        cleanupGroupReferences: boolean;
    }>,
): Promise<QualifiedConnectedServiceCredentialDeleteStorageResult> {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    try {
        return await inTx(async (tx) => {
            const current = await readCurrentByQualifiedRef(
                tx,
                params.accountId,
                ref,
            );
            if (!current) return { status: "not_found" };
            const credentialRevision =
                resolveQualifiedConnectedAccountCredentialRevision({
                    rowId: current.id,
                    metadata: current.metadata,
                });
            if (
                params.expectedCredentialRevision !== undefined
                && credentialRevision
                    !== params.expectedCredentialRevision
            ) {
                return {
                    status: "superseded",
                    credentialRevision,
                    configurationRevision:
                        current.configurationRevision,
                };
            }
            const memberships =
                await tx.connectedServiceAuthGroupMember.findMany({
                where: {
                    accountId: params.accountId,
                    credentialId: current.id,
                },
                select: {
                    groupDbId: true,
                    enabled: true,
                    credential: {
                        select: { connectedAccountId: true },
                    },
                    group: {
                        select: {
                            vendor: true,
                            activeConnectedAccountId: true,
                            generation: true,
                            runtimeStateRevision: true,
                            members: {
                                where: {
                                    enabled: true,
                                    credentialId: { not: current.id },
                                },
                                orderBy: [
                                    { priority: "asc" },
                                    { createdAt: "asc" },
                                    { id: "asc" },
                                ],
                                take: 1,
                                select: {
                                    credential: {
                                        select: {
                                            connectedAccountId: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            });
            if (
                memberships.length > 0
                && !params.cleanupGroupReferences
            ) {
                return { status: "referenced" };
            }
            if (params.expectedStorageMode !== undefined) {
                const accountMode = await readEffectiveAccountEncryptionMode(
                    tx,
                    params.accountId,
                );
                if (
                    (accountMode === "plain")
                    !== (params.expectedStorageMode === "plain")
                ) {
                    return { status: "storage_mode_mismatch" };
                }
            }

            let deleted = await tx.serviceAccountToken.deleteMany({
                where: {
                    id: current.id,
                    updatedAt: current.updatedAt,
                },
            });
            if (deleted.count !== 1) {
                let latest = await readCurrentByQualifiedRef(
                    tx,
                    params.accountId,
                    ref,
                );
                const latestCredentialRevision = latest
                    ? resolveQualifiedConnectedAccountCredentialRevision({
                        rowId: latest.id,
                        metadata: latest.metadata,
                    })
                    : null;
                // Health and lease bookkeeping preserve the public credential
                // and configuration revisions while advancing updatedAt.
                // Retry that hidden-CAS loss once, without admitting a changed
                // credential or configuration generation.
                if (
                    params.expectedCredentialRevision !== undefined
                    && latest?.id === current.id
                    && latestCredentialRevision
                        === params.expectedCredentialRevision
                    && latest.configurationRevision
                        === current.configurationRevision
                ) {
                    deleted = await tx.serviceAccountToken.deleteMany({
                        where: {
                            id: latest.id,
                            updatedAt: latest.updatedAt,
                        },
                    });
                    if (deleted.count !== 1) {
                        latest = await readCurrentByQualifiedRef(
                            tx,
                            params.accountId,
                            ref,
                        );
                    }
                }
                if (deleted.count !== 1) {
                    return {
                        status: "superseded",
                        credentialRevision: latest
                            ? resolveQualifiedConnectedAccountCredentialRevision({
                                rowId: latest.id,
                                metadata: latest.metadata,
                            })
                            : null,
                        configurationRevision:
                            latest?.configurationRevision ?? null,
                    };
                }
            }

            if (memberships.length > 0) {
                const groups = new Map<
                    string,
                    {
                        vendor: string | null;
                        activeConnectedAccountId: string | null;
                        fallback: string | null;
                        generation: number;
                        runtimeStateRevision: number;
                    }
                >();
                for (const membership of memberships) {
                    if (groups.has(membership.groupDbId)) continue;
                    groups.set(membership.groupDbId, {
                        vendor: membership.group.vendor,
                        activeConnectedAccountId:
                            membership.group.activeConnectedAccountId,
                        fallback:
                            membership.group.members[0]?.credential
                                .connectedAccountId ?? null,
                        generation: membership.group.generation,
                        runtimeStateRevision:
                            membership.group.runtimeStateRevision,
                    });
                }
                for (const [groupDbId, group] of groups) {
                    const wasActive =
                        group.activeConnectedAccountId === ref.accountId;
                    const updated =
                        await tx.connectedServiceAuthGroup.updateMany({
                            where: {
                                id: groupDbId,
                                generation: group.generation,
                                runtimeStateRevision:
                                    group.runtimeStateRevision,
                            },
                            data: {
                                generation: { increment: 1 },
                                ...(wasActive
                                    ? {
                                        activeConnectedAccountId:
                                            group.fallback,
                                        activeProfileId:
                                            group.vendor === null
                                                ? null
                                                : group.fallback,
                                    }
                                    : {}),
                            },
                        });
                    if (updated.count !== 1) {
                        throw new QualifiedCredentialGroupCasConflictError();
                    }
                }
            }
            await recordConnectedServiceAccountProfileChange({
                tx,
                accountId: params.accountId,
            });
            return { status: "deleted" };
        });
    } catch (error) {
        if (!(error instanceof QualifiedCredentialGroupCasConflictError)) {
            throw error;
        }
        const latest = await inTx(async (tx) =>
            await readCurrentByQualifiedRef(
                tx,
                params.accountId,
                ref,
            ));
        return {
            status: "superseded",
            credentialRevision: latest
                ? resolveQualifiedConnectedAccountCredentialRevision({
                    rowId: latest.id,
                    metadata: latest.metadata,
                })
                : null,
                configurationRevision:
                    latest?.configurationRevision ?? null,
        };
    }
}

export async function deleteQualifiedConnectedServiceCredentialForStorageMode(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        expectedStorageMode: "plain" | "sealed";
        expectedCredentialRevision?: string;
        cleanupGroupReferences: boolean;
    }>,
): Promise<QualifiedConnectedServiceCredentialDeleteStorageResult> {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    return await deleteQualifiedConnectedServiceCredential({
        accountId: params.accountId,
        ref,
        expectedStorageMode: params.expectedStorageMode,
        ...(params.expectedCredentialRevision !== undefined
            ? {
                expectedCredentialRevision:
                    params.expectedCredentialRevision,
            }
            : {}),
        cleanupGroupReferences: params.cleanupGroupReferences,
    });
}

export async function acquireQualifiedConnectedServiceRefreshLease(
    params: Readonly<{
        accountId: string;
        ref: QualifiedConnectedAccountRef;
        expectedCredentialRevision?: string;
        ownerId: string;
        ttlMs: number;
        now?: Date;
    }>,
): Promise<QualifiedConnectedServiceRefreshLeaseResult> {
    const ref = QualifiedConnectedAccountRefSchema.parse(params.ref);
    const ownerId = params.ownerId.trim();
    if (!ownerId) throw new Error("Refresh lease owner id is required");
    const now = params.now ?? new Date();
    const leaseUntil = new Date(now.getTime() + params.ttlMs);
    return await inTx(async (tx) => {
        const current = await readCurrentByQualifiedRef(
            tx,
            params.accountId,
            ref,
        );
        if (!current) return { status: "not_found" };
        const credentialRevision =
            resolveQualifiedConnectedAccountCredentialRevision({
                rowId: current.id,
                metadata: current.metadata,
            });
        if (
            params.expectedCredentialRevision !== undefined
            && params.expectedCredentialRevision !== credentialRevision
        ) {
            return {
                status: "resolved",
                acquired: false,
                leaseUntil:
                    current.refreshLeaseExpiresAt?.getTime()
                    ?? now.getTime(),
                ownerId,
                credentialRevision,
            };
        }
        const canAcquire =
            current.refreshLeaseExpiresAt === null
            || current.refreshLeaseExpiresAt.getTime() <= now.getTime()
            || current.refreshLeaseOwnerMachineId === ownerId;
        if (!canAcquire) {
            return {
                status: "resolved",
                acquired: false,
                leaseUntil:
                    current.refreshLeaseExpiresAt?.getTime()
                    ?? now.getTime(),
                ownerId,
                credentialRevision,
            };
        }
        const write = await tx.serviceAccountToken.updateMany({
            where: {
                id: current.id,
                updatedAt: current.updatedAt,
                OR: [
                    { refreshLeaseExpiresAt: null },
                    { refreshLeaseExpiresAt: { lte: now } },
                    { refreshLeaseOwnerMachineId: ownerId },
                ],
            },
            data: {
                refreshLeaseOwnerMachineId: ownerId,
                refreshLeaseExpiresAt: leaseUntil,
            },
        });
        if (write.count !== 1) {
            const latest = await readCurrentByQualifiedRef(
                tx,
                params.accountId,
                ref,
            );
            if (!latest) return { status: "not_found" };
            return {
                status: "resolved",
                acquired: false,
                leaseUntil:
                    latest.refreshLeaseExpiresAt?.getTime()
                    ?? now.getTime(),
                ownerId,
                credentialRevision:
                    resolveQualifiedConnectedAccountCredentialRevision({
                        rowId: latest.id,
                        metadata: latest.metadata,
                    }),
            };
        }
        return {
            status: "resolved",
            acquired: true,
            leaseUntil: leaseUntil.getTime(),
            ownerId,
            credentialRevision,
        };
    });
}
