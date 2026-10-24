import type { Prisma } from "@prisma/client";
import type { ConnectedServiceCredentialHealthV1 } from "@happier-dev/protocol";

import { inTx, type Tx } from "@/storage/inTx";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { deleteConnectedServiceUsageSourcesForProfile } from "../providerAccountUsage/sourceStorage";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import {
    isConnectedServiceProviderIdentityMismatch,
    withCredentialHealth,
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
    createConnectedServiceCredentialRevision,
    resolveConnectedServiceCredentialRevision,
    withConnectedServiceCredentialRevision,
} from "./credentialRevision";

type CredentialMetadata = Readonly<Record<string, unknown>>;

export type ConnectedServiceCredentialMutationResult =
    | Readonly<{ status: "written"; credentialRevision: string }>
    | Readonly<{
        status: "superseded";
        reason: "revision_mismatch" | "refresh_lease_lost";
        credentialRevision: string | null;
    }>
    | Readonly<{ status: "provider_identity_mismatch" }>
    | Readonly<{ status: "storage_mode_mismatch" }>;

export type ConnectedServiceCredentialHealthMutationResult =
    | Readonly<{ status: "written"; credentialRevision: string }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "unsupported_format" }>
    | Readonly<{
        status: "superseded";
        reason: "revision_mismatch";
        credentialRevision: string;
    }>;

export type ConnectedServiceCredentialMutationParams = Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    token: Uint8Array<ArrayBuffer>;
    metadata: CredentialMetadata;
    expiresAt: Date | null;
    storageMode: "plain" | "sealed";
    incomingIdentity: Readonly<{
        providerEmail?: string | null;
        providerAccountId?: string | null;
    }>;
    allowProviderIdentityChange: boolean;
    // Omitted is the released unguarded behavior, null expects no row, and a string expects that
    // exact current credential revision.
    expectedCredentialRevision?: string | null;
    refreshLeaseOwnerId?: string;
    now?: Date;
}>;

function readExistingIdentity(metadata: unknown): Readonly<{
    providerEmail?: string | null;
    providerAccountId?: string | null;
    providerOrganizationId?: string | null;
}> | null {
    if (isConnectedServiceCredentialMetadataV2(metadata)) {
        return normalizeConnectedServiceCredentialMetadataV2(metadata);
    }
    if (isConnectedServiceCredentialMetadataV3(metadata)) {
        return normalizeConnectedServiceCredentialMetadataV3(metadata);
    }
    return null;
}

/**
 * Canonical credential write owner for V1/V2/V3 adapters.
 *
 * Revision comparison, refresh-lease fencing, provider-identity transition, credential persistence,
 * and account projection publication are one serializable transaction.
 */
export async function mutateConnectedServiceCredentialInTx(
    tx: Tx,
    params: ConnectedServiceCredentialMutationParams,
): Promise<ConnectedServiceCredentialMutationResult> {
        const account = await tx.account.findUnique({
            where: { id: params.accountId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (
            !account
            || (resolveEffectiveAccountEncryptionModeFromAccountRow(account) === "plain") !== (params.storageMode === "plain")
        ) {
            return { status: "storage_mode_mismatch" };
        }
        const current = await tx.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: params.accountId,
                    vendor: params.serviceId,
                    profileId: params.profileId,
                },
            },
            select: {
                id: true,
                metadata: true,
                refreshLeaseOwnerMachineId: true,
                refreshLeaseExpiresAt: true,
            },
        });
        const currentRevision = current
            ? resolveConnectedServiceCredentialRevision({ rowId: current.id, metadata: current.metadata })
            : null;

        if (
            params.expectedCredentialRevision !== undefined
            && params.expectedCredentialRevision !== currentRevision
        ) {
            return {
                status: "superseded",
                reason: "revision_mismatch",
                credentialRevision: currentRevision,
            };
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
                    credentialRevision: currentRevision,
                };
            }
        }

        const existingIdentity = readExistingIdentity(current?.metadata);
        if (
            existingIdentity
            && isConnectedServiceProviderIdentityMismatch({
                existing: existingIdentity,
                incoming: params.incomingIdentity,
            })
            && !params.allowProviderIdentityChange
        ) {
            return { status: "provider_identity_mismatch" };
        }

        const credentialRevision = createConnectedServiceCredentialRevision();
        const metadata = withConnectedServiceCredentialRevision(params.metadata, credentialRevision) as Prisma.InputJsonValue;
        const data = {
            updatedAt: new Date(),
            token: params.token,
            metadata,
            expiresAt: params.expiresAt,
            // A completed credential mutation consumes the exact refresh authority. This prevents
            // the same attempt from committing a second result under the old owner id.
            refreshLeaseOwnerMachineId: null,
            refreshLeaseExpiresAt: null,
        };

        if (current) {
            await tx.serviceAccountToken.update({ where: { id: current.id }, data });
        } else {
            await tx.serviceAccountToken.create({
                data: {
                    accountId: params.accountId,
                    vendor: params.serviceId,
                    profileId: params.profileId,
                    ...data,
                },
            });
        }
        if (current && (
            (existingIdentity?.providerAccountId ?? null) !== (params.metadata.providerAccountId ?? null)
            || (existingIdentity?.providerOrganizationId ?? null) !== (params.metadata.providerOrganizationId ?? null)
        )) {
            // Aliases are projections of this exact credential context. Retain them for token
            // rotation, but remove every profile/group alias atomically on a context change.
            await deleteConnectedServiceUsageSourcesForProfile(params, tx);
        }
        return { status: "written", credentialRevision };
}

export async function mutateConnectedServiceCredential(
    params: ConnectedServiceCredentialMutationParams,
): Promise<ConnectedServiceCredentialMutationResult> {
    return await inTx(async (tx) => {
        const result = await mutateConnectedServiceCredentialInTx(tx, params);
        if (result.status === "written") {
            await recordConnectedServiceAccountProfileChange(tx, { accountId: params.accountId });
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
    return await inTx(async (tx) => {
        const current = await tx.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: params.accountId,
                    vendor: params.serviceId,
                    profileId: params.profileId,
                },
            },
            select: { id: true, metadata: true },
        });
        if (!current) return { status: "not_found" };

        const credentialRevision = resolveConnectedServiceCredentialRevision({
            rowId: current.id,
            metadata: current.metadata,
        });
        if (
            params.expectedCredentialRevision !== undefined
            && params.expectedCredentialRevision !== credentialRevision
        ) {
            return {
                status: "superseded",
                reason: "revision_mismatch",
                credentialRevision,
            };
        }

        const metadata = isConnectedServiceCredentialMetadataV3(current.metadata)
            ? normalizeConnectedServiceCredentialMetadataV3(current.metadata)
            : isConnectedServiceCredentialMetadataV2(current.metadata)
                ? normalizeConnectedServiceCredentialMetadataV2(current.metadata)
                : null;
        if (!metadata) return { status: "unsupported_format" };

        await tx.serviceAccountToken.update({
            where: { id: current.id },
            data: {
                updatedAt: new Date(),
                metadata: withCredentialHealth(metadata, params.health) as Prisma.InputJsonValue,
            },
        });
        await recordConnectedServiceAccountProfileChange(tx, { accountId: params.accountId });
        return { status: "written", credentialRevision };
    });
}

export async function mutateLegacyConnectedServiceVendorToken(params: Readonly<{
    accountId: string;
    vendor: string;
    token: Uint8Array<ArrayBuffer>;
}>): Promise<Readonly<{ status: "written" | "connected_credential_conflict" }>> {
    return await inTx(async (tx) => {
        // Released server-v0.2.1 accepted this raw V1, server-sealed token independently of the
        // account content mode. Retain that last-writer-wins seam only for metadata-less legacy
        // rows; V2/V3 metadata rows remain protected below and their account-mode fence is unchanged.
        const current = await tx.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: params.accountId,
                    vendor: params.vendor,
                    profileId: "default",
                },
            },
            select: { id: true, metadata: true },
        });
        if (
            current
            && (
                isConnectedServiceCredentialMetadataV2(current.metadata)
                || isConnectedServiceCredentialMetadataV3(current.metadata)
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
            await tx.serviceAccountToken.create({
                data: {
                    accountId: params.accountId,
                    vendor: params.vendor,
                    profileId: "default",
                    token: params.token,
                },
            });
        }
        await recordConnectedServiceAccountProfileChange(tx, { accountId: params.accountId });
        return { status: "written" };
    });
}

export async function deleteLegacyConnectedServiceVendorToken(params: Readonly<{
    accountId: string;
    vendor: string;
}>): Promise<Readonly<{ status: "deleted" | "not_found" | "connected_credential_conflict" }>> {
    return await inTx(async (tx) => {
        const current = await tx.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: params.accountId,
                    vendor: params.vendor,
                    profileId: "default",
                },
            },
            select: { id: true, metadata: true },
        });
        if (!current) return { status: "not_found" };
        if (
            isConnectedServiceCredentialMetadataV2(current.metadata)
            || isConnectedServiceCredentialMetadataV3(current.metadata)
        ) {
            return { status: "connected_credential_conflict" };
        }
        await tx.serviceAccountToken.delete({ where: { id: current.id } });
        await recordConnectedServiceAccountProfileChange(tx, { accountId: params.accountId });
        return { status: "deleted" };
    });
}
