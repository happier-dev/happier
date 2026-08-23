import type { ConnectedServiceCredentialHealthV1 } from "@happier-dev/protocol";

import { inTx, type Tx } from "@/storage/inTx";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import {
    resolveLegacyServiceAccountTokenIdentityFields,
} from "../qualifiedConnectedAccounts/identity";
import {
    deleteQualifiedConnectedServiceLegacyVendorToken,
    migrateQualifiedConnectedServiceCredentialInTx,
    mutateQualifiedConnectedServiceCredentialHealth,
    mutateQualifiedConnectedServiceCredentialInTx,
    mutateQualifiedConnectedServiceLegacyVendorToken,
    readQualifiedConnectedServiceCredentialMutationBasisInTx,
    readQualifiedConnectedServiceCredential,
    type QualifiedCredentialMutationParams,
} from "../qualifiedConnectedAccounts/credentialRepository";
import {
    decodeLegacyQualifiedConnectedAccountCredentialEnvelope,
    resolveQualifiedConnectedAccountStoredMetadata,
} from "../qualifiedConnectedAccounts/credentialStoredMetadataAdapter";

type CredentialMetadata = Readonly<Record<string, unknown>>;

export type ConnectedServiceCredentialMutationResult =
    | Readonly<{ status: "written"; credentialRevision: string }>
    | Readonly<{ status: "superseded"; reason: "revision_mismatch" | "refresh_lease_lost"; credentialRevision: string | null }>
    | Readonly<{ status: "provider_identity_mismatch" }>
    | Readonly<{ status: "revision_required" }>
    | Readonly<{ status: "capacity_exhausted" }>
    | Readonly<{ status: "storage_mode_mismatch" }>;

export type ConnectedServiceCredentialHealthMutationResult =
    | Readonly<{ status: "written"; credentialRevision: string }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "unsupported_format" }>
    | Readonly<{ status: "revision_required" }>
    | Readonly<{ status: "storage_mode_mismatch" }>
    | Readonly<{ status: "superseded"; reason: "revision_mismatch"; credentialRevision: string }>;

export type ConnectedServiceCredentialMutationParams = Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    token: Uint8Array<ArrayBuffer>;
    metadata: CredentialMetadata;
    expiresAt: Date | null;
    storageMode: "plain" | "sealed";
    incomingIdentity: Readonly<{ providerEmail?: string | null; providerAccountId?: string | null }>;
    allowProviderIdentityChange: boolean;
    expectedCredentialRevision?: string | null;
    refreshLeaseOwnerId?: string;
    now?: Date;
}>;

export async function mutateConnectedServiceCredentialInTx(
    tx: Tx,
    params: ConnectedServiceCredentialMutationParams,
): Promise<ConnectedServiceCredentialMutationResult> {
    return await mutateConnectedServiceCredentialForModeInTx(
        tx,
        params,
    );
}

export async function migrateConnectedServiceCredentialInTx(
    tx: Tx,
    params: Omit<
        ConnectedServiceCredentialMutationParams,
        "expectedCredentialRevision"
    > & Readonly<{ expectedCredentialRevision: string }>,
    toMode: "plain" | "e2ee",
): Promise<ConnectedServiceCredentialMutationResult> {
    // Account encryption migration prepares the target representation before
    // the canonical Account owner commits the target mode in the same transaction.
    return await mutateConnectedServiceCredentialForModeInTx(
        tx,
        params,
        toMode,
    );
}

async function mutateConnectedServiceCredentialForModeInTx(
    tx: Tx,
    params: ConnectedServiceCredentialMutationParams,
    accountEncryptionTransitionMode?: "plain" | "e2ee",
): Promise<ConnectedServiceCredentialMutationResult> {
    if (params.expectedCredentialRevision === undefined) {
        return { status: "revision_required" };
    }
    const account = await tx.account.findUnique({
        where: { id: params.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    const accountMode =
        accountEncryptionTransitionMode
        ?? (
            currentness?.status === "ready"
                ? currentness.currentness.encryptionMode
                : null
        );
    if (
        !account
        || currentness?.status !== "ready"
        || (accountMode === "plain")
            !== (params.storageMode === "plain")
    ) {
        return { status: "storage_mode_mismatch" };
    }
    const metadataProjection =
        resolveQualifiedConnectedAccountStoredMetadata({
            rowId: "legacy-incoming",
            metadata: params.metadata,
        });
    if (
        metadataProjection.format !== "legacy_v2"
        && metadataProjection.format !== "legacy_v3"
    ) {
        return { status: "storage_mode_mismatch" };
    }
    const identity = resolveLegacyServiceAccountTokenIdentityFields({
        serviceId: params.serviceId,
        profileId: params.profileId,
        credentialKind: metadataProjection.kind,
    });
    const ref = {
        service: {
            pluginId: identity.servicePluginId,
            localId: identity.serviceLocalId,
        },
        accountId: identity.connectedAccountId,
    };
    const content =
        decodeLegacyQualifiedConnectedAccountCredentialEnvelope({
            accountId: params.accountId,
            serviceId: params.serviceId,
            profileId: params.profileId,
            token: params.token,
            metadata: params.metadata,
        });
    if (!content) return { status: "storage_mode_mismatch" };
    const current =
        await readQualifiedConnectedServiceCredentialMutationBasisInTx(
            tx,
            {
                accountId: params.accountId,
                ref,
            },
        );
    if (current?.credentialRevision === null) {
        return { status: "revision_required" };
    }
    const expectedCredentialRevision = params.expectedCredentialRevision;
    const mutationParams: QualifiedCredentialMutationParams =
        expectedCredentialRevision === null
            ? {
                accountId: params.accountId,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: identity.authenticationModeId,
                content,
                metadata: metadataProjection.presentation,
                legacyIdentity: {
                    serviceId: params.serviceId,
                    profileId: params.profileId,
                },
                legacyExpiresAt: params.expiresAt,
            }
            : {
                accountId: params.accountId,
                ref,
                expectedCredentialRevision,
                expectedConfigurationRevision:
                    current?.configurationRevision ?? null,
                authenticationModeId: identity.authenticationModeId,
                content,
                metadata: metadataProjection.presentation,
                reconnect: {
                    allowProviderIdentityChange:
                        params.allowProviderIdentityChange,
                },
                ...(params.refreshLeaseOwnerId
                    ? {
                        refreshLeaseOwnerId:
                            params.refreshLeaseOwnerId,
                    }
                    : {}),
                ...(params.now ? { now: params.now } : {}),
                legacyIdentity: {
                    serviceId: params.serviceId,
                    profileId: params.profileId,
                },
                legacyExpiresAt: params.expiresAt,
            };
    const result =
        accountEncryptionTransitionMode
            ? await migrateQualifiedConnectedServiceCredentialInTx(
                tx,
                mutationParams,
                accountEncryptionTransitionMode,
            )
            : await mutateQualifiedConnectedServiceCredentialInTx(
                tx,
                mutationParams,
            );
    if (result.status === "written") {
        return {
            status: "written",
            credentialRevision: result.credentialRevision,
        };
    }
    if (result.status === "revision_required") return result;
    if (result.status === "provider_identity_mismatch") return result;
    if (result.status === "capacity_exhausted") return result;
    if (result.status === "storage_mode_mismatch"
        || result.status === "authentication_mode_mismatch") {
        return { status: "storage_mode_mismatch" };
    }
    return {
        status: "superseded",
        reason: result.reason === "refresh_lease_lost"
            ? "refresh_lease_lost"
            : "revision_mismatch",
        credentialRevision: result.credentialRevision,
    };
}

export async function mutateConnectedServiceCredential(
    params: ConnectedServiceCredentialMutationParams,
): Promise<ConnectedServiceCredentialMutationResult> {
    return await inTx(async (tx) => {
        const result = await mutateConnectedServiceCredentialInTx(tx, params);
        if (result.status === "written") {
            await recordConnectedServiceAccountProfileChange({ tx, accountId: params.accountId });
        }
        return result;
    });
}

export async function mutateConnectedServiceCredentialHealth(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
    expectedCredentialRevision?: string;
}>): Promise<ConnectedServiceCredentialHealthMutationResult> {
    if (params.expectedCredentialRevision === undefined) {
        return { status: "revision_required" };
    }
    const identity = resolveLegacyServiceAccountTokenIdentityFields({
        serviceId: params.serviceId,
        profileId: params.profileId,
    });
    const ref = {
        service: {
            pluginId: identity.servicePluginId,
            localId: identity.serviceLocalId,
        },
        accountId: identity.connectedAccountId,
    };
    const current = await readQualifiedConnectedServiceCredential({
        accountId: params.accountId,
        ref,
    });
    if (current.status !== "resolved") return current;
    if (current.credential.revisionSemantics === "legacy_unfenced") {
        return { status: "revision_required" };
    }
    const result = await mutateQualifiedConnectedServiceCredentialHealth({
        accountId: params.accountId,
        ref,
        health: params.health,
        expectedCredentialRevision: params.expectedCredentialRevision,
        expectedConfigurationRevision:
            current.credential.configurationRevision,
    });
    if (result.status === "superseded") {
        return {
            status: "superseded",
            reason: "revision_mismatch",
            credentialRevision: result.credentialRevision,
        };
    }
    return result;
}

export async function mutateLegacyConnectedServiceVendorToken(params: Readonly<{
    accountId: string;
    vendor: string;
}>): Promise<Readonly<{ status: "revision_required" }>> {
    return await mutateQualifiedConnectedServiceLegacyVendorToken({
        accountId: params.accountId,
        vendor: params.vendor,
    });
}

export async function deleteLegacyConnectedServiceVendorToken(params: Readonly<{
    accountId: string;
    vendor: string;
}>): Promise<Readonly<{ status: "revision_required" }>> {
    return await deleteQualifiedConnectedServiceLegacyVendorToken({
        accountId: params.accountId,
        vendor: params.vendor,
    });
}
