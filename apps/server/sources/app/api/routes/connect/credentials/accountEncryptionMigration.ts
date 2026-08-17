import { isDeepStrictEqual } from "node:util";

import {
    AccountEncryptionMigrateConnectedServicesDirectiveSchema,
    type AccountEncryptionMigrateConnectedServicesDirective,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import {
    encodeCredentialTokenBytes,
} from "../connectedServicesV2/credentialTokenCodec";
import type {
    ConnectedServiceCredentialMetadataV2,
} from "../connectedServicesV2/credentialMetadataV2";
import {
    ConnectedServiceCredentialV3PreparationError,
    prepareConnectedServiceCredentialMutationV3,
} from "../connectedServicesV3/prepareConnectedServiceCredentialMutationV3";
import {
    isConnectedServiceCredentialRevision,
} from "./credentialRevision";
import {
    clearQualifiedConnectedAccountsForAccountInTx,
    isQualifiedConnectedAccountMigrationInventoryCompleteInTx,
    isQualifiedConnectedAccountConfigurationRevision,
    migrateQualifiedConnectedAccountConfigurationInTx,
    migrateQualifiedConnectedServiceCredentialInTx,
    readQualifiedConnectedServiceCredentialAccountEncryptionPostStateInTx,
} from "../qualifiedConnectedAccounts/credentialRepository";
import {
    resolveLegacyServiceAccountTokenIdentityFields,
} from "../qualifiedConnectedAccounts/identity";
import {
    resolveQualifiedConnectedAccountStoredMetadata,
} from "../qualifiedConnectedAccounts/credentialStoredMetadataAdapter";
import {
    clearQualifiedConnectedAccountUsageForAccountInTx,
} from "../qualifiedConnectedAccounts/usageRepository";
import {
    migrateConnectedServiceCredentialInTx,
    type ConnectedServiceCredentialMutationParams,
} from "./mutation";

type MigrateDirective = Extract<
    AccountEncryptionMigrateConnectedServicesDirective,
    Readonly<{ action: "migrate" }>
>;
type LegacyMigrationItem = MigrateDirective["credentials"][number];

type PreparedLegacyMigration = Readonly<{
    item: LegacyMigrationItem;
    mutation: Omit<
        ConnectedServiceCredentialMutationParams,
        "expectedCredentialRevision"
    > & Readonly<{ expectedCredentialRevision: string }>;
}>;

export type ConnectedServicesAccountEncryptionMigrationResult =
    | Readonly<{
        status: "applied";
        changed: boolean;
        accountVersion: number | null;
    }>
    | Readonly<{
        status:
            | "invalid_content"
            | "migration_incomplete"
            | "not_empty";
    }>;

export type ConnectedServicesAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>;

export class ConnectedServicesAccountEncryptionMigrationConflictError
    extends Error {
    constructor(readonly reason: string) {
        super(
            `Connected Services account-encryption migration rejected: ${reason}`,
        );
        this.name =
            "ConnectedServicesAccountEncryptionMigrationConflictError";
    }
}

function prepareSealedLegacyMigration(
    accountId: string,
    item: LegacyMigrationItem,
): PreparedLegacyMigration | null {
    if (item.kind !== "sealed" || !item.sealed) return null;
    const metadata: ConnectedServiceCredentialMetadataV2 = {
        v: 2,
        format: item.sealed.format,
        kind: item.metadata?.kind ?? "oauth",
        providerEmail: item.metadata?.providerEmail ?? null,
        providerAccountId: item.metadata?.providerAccountId ?? null,
    };
    return {
        item,
        mutation: {
            accountId,
            serviceId: item.serviceId,
            profileId: item.profileId,
            token: encodeCredentialTokenBytes(item.sealed.ciphertext),
            metadata,
            expiresAt:
                typeof item.metadata?.expiresAt === "number"
                && Number.isFinite(item.metadata.expiresAt)
                    ? new Date(item.metadata.expiresAt)
                    : null,
            storageMode: "sealed",
            incomingIdentity: {
                providerEmail: metadata.providerEmail,
                providerAccountId: metadata.providerAccountId,
            },
            allowProviderIdentityChange: false,
            expectedCredentialRevision:
                item.expectedCredentialRevision,
        },
    };
}

function preparePlainLegacyMigration(
    accountId: string,
    item: LegacyMigrationItem,
): PreparedLegacyMigration | null {
    if (item.kind !== "plain" || !item.record) return null;
    const prepared = prepareConnectedServiceCredentialMutationV3({
        accountId,
        serviceId: item.serviceId,
        profileId: item.profileId,
        record: item.record,
    });
    return {
        item,
        mutation: {
            accountId,
            serviceId: item.serviceId,
            profileId: item.profileId,
            ...prepared,
            storageMode: "plain",
            allowProviderIdentityChange: false,
            expectedCredentialRevision:
                item.expectedCredentialRevision,
        },
    };
}

function prepareLegacyMigrations(params: Readonly<{
    accountId: string;
    toMode: "plain" | "e2ee";
    items: readonly LegacyMigrationItem[];
}>): PreparedLegacyMigration[] | null {
    try {
        const prepared = params.items.map((item) =>
            params.toMode === "plain"
                ? preparePlainLegacyMigration(params.accountId, item)
                : prepareSealedLegacyMigration(params.accountId, item));
        return prepared.every(
            (item): item is PreparedLegacyMigration => item !== null,
        )
            ? prepared
            : null;
    } catch (error) {
        if (
            error
            instanceof ConnectedServiceCredentialV3PreparationError
        ) {
            return null;
        }
        throw error;
    }
}

async function connectedServiceUsageIsEmptyInTx(
    tx: Tx,
    accountId: string,
): Promise<boolean> {
    const [sources, records] = await Promise.all([
        tx.connectedServiceUsageSource.count({
            where: { accountId },
        }),
        tx.providerAccountUsageRecord.count({
            where: { accountId },
        }),
    ]);
    return sources === 0 && records === 0;
}

async function connectedServiceClearedGroupStateMatchesInTx(
    tx: Tx,
    accountId: string,
): Promise<boolean> {
    const [members, activeGroups] = await Promise.all([
        tx.connectedServiceAuthGroupMember.count({
            where: { accountId },
        }),
        tx.connectedServiceAuthGroup.count({
            where: {
                accountId,
                OR: [
                    { activeProfileId: { not: null } },
                    {
                        activeConnectedAccountId: {
                            not: null,
                        },
                    },
                ],
            },
        }),
    ]);
    return members === 0 && activeGroups === 0;
}

/**
 * Read-only exact Connected Services post-state matcher for Account-transition
 * replay. Random target revisions are validated as owner-generated and distinct
 * from their request-bound source revisions, while all canonical target content,
 * metadata, configuration, inventory, and cleanup state must match exactly.
 */
export async function matchConnectedServicesAccountEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive: unknown;
    }>,
): Promise<
    ConnectedServicesAccountEncryptionMigrationPostStateResult
> {
    const parsed =
        AccountEncryptionMigrateConnectedServicesDirectiveSchema
            .safeParse(params.directive);
    if (!parsed.success) return { status: "mismatch" };
    const directive = parsed.data;
    try {
        const usageEmpty =
            await connectedServiceUsageIsEmptyInTx(
                params.tx,
                params.accountId,
            );
        if (!usageEmpty) return { status: "mismatch" };

        if (
            directive.action === "assert_empty"
            || directive.action === "clear"
        ) {
            const credentialCount =
                await params.tx.serviceAccountToken.count({
                    where: { accountId: params.accountId },
                });
            const groupsMatch =
                directive.action !== "clear"
                || await connectedServiceClearedGroupStateMatchesInTx(
                    params.tx,
                    params.accountId,
                );
            return {
                status: credentialCount === 0 && groupsMatch
                    ? "matched"
                    : "mismatch",
            };
        }

        const complete =
            await isQualifiedConnectedAccountMigrationInventoryCompleteInTx(
                params.tx,
                {
                    accountId: params.accountId,
                    legacyCredentials: directive.credentials,
                    qualifiedCredentials:
                        directive.qualifiedCredentials,
                },
            );
        if (!complete) return { status: "mismatch" };

        const preparedLegacy = prepareLegacyMigrations({
            accountId: params.accountId,
            toMode: params.toMode,
            items: directive.credentials,
        });
        if (!preparedLegacy) return { status: "mismatch" };
        for (const prepared of preparedLegacy) {
            const identity =
                resolveLegacyServiceAccountTokenIdentityFields({
                    serviceId: prepared.item.serviceId,
                    profileId: prepared.item.profileId,
                    credentialKind:
                        prepared.item.metadata?.kind
                        ?? "oauth",
                });
            const snapshot =
                await readQualifiedConnectedServiceCredentialAccountEncryptionPostStateInTx(
                    params.tx,
                    {
                        accountId: params.accountId,
                        ref: {
                            service: {
                                pluginId:
                                    identity.servicePluginId,
                                localId:
                                    identity.serviceLocalId,
                            },
                            accountId:
                                identity.connectedAccountId,
                        },
                    },
                );
            const expectedContent =
                prepared.item.kind === "plain"
                && prepared.item.record
                    ? {
                        t: "plain" as const,
                        v: prepared.item.record,
                    }
                    : prepared.item.kind === "sealed"
                        && prepared.item.sealed
                        ? {
                            t: "encrypted" as const,
                            c:
                                prepared.item.sealed
                                    .ciphertext,
                        }
                        : null;
            const expectedMetadata =
                resolveQualifiedConnectedAccountStoredMetadata({
                    rowId: "account-migration-post-state",
                    metadata: prepared.mutation.metadata,
                }).presentation;
            if (
                snapshot.status !== "resolved"
                || !expectedContent
                || !isConnectedServiceCredentialRevision(
                    snapshot.credential.credentialRevision,
                )
                || snapshot.credential.credentialRevision
                    === prepared.item
                        .expectedCredentialRevision
                || snapshot.credential.authenticationModeId
                    !== identity.authenticationModeId
                || snapshot.credential.configurationRevision
                    !== null
                || snapshot.configurationContent !== null
                || !isDeepStrictEqual(
                    snapshot.credential.content,
                    expectedContent,
                )
                || !isDeepStrictEqual(
                    snapshot.credential.metadata,
                    expectedMetadata,
                )
                || snapshot.credential.expiresAt
                    !== (
                        prepared.mutation.expiresAt
                            ?.getTime()
                        ?? null
                    )
            ) {
                return { status: "mismatch" };
            }
        }

        for (const item of directive.qualifiedCredentials) {
            const snapshot =
                await readQualifiedConnectedServiceCredentialAccountEncryptionPostStateInTx(
                    params.tx,
                    {
                        accountId: params.accountId,
                        ref: item.ref,
                    },
                );
            if (
                snapshot.status !== "resolved"
                || !isConnectedServiceCredentialRevision(
                    snapshot.credential.credentialRevision,
                )
                || snapshot.credential.credentialRevision
                    === item.expectedCredentialRevision
                || snapshot.credential.authenticationModeId
                    !== item.authenticationModeId
                || !isDeepStrictEqual(
                    snapshot.credential.content,
                    item
                        .replacementCredentialContentEnvelope,
                )
                || !isDeepStrictEqual(
                    snapshot.credential.metadata,
                    item.metadata,
                )
            ) {
                return { status: "mismatch" };
            }
            if (
                item.expectedConfigurationRevision === null
            ) {
                if (
                    snapshot.credential.configurationRevision
                        !== null
                    || snapshot.configurationContent !== null
                ) {
                    return { status: "mismatch" };
                }
                continue;
            }
            if (
                !isQualifiedConnectedAccountConfigurationRevision(
                    snapshot.credential.configurationRevision,
                )
                || snapshot.credential.configurationRevision
                    === item.expectedConfigurationRevision
                || !isDeepStrictEqual(
                    snapshot.configurationContent,
                    item
                        .replacementConfigurationContentEnvelope,
                )
            ) {
                return { status: "mismatch" };
            }
        }
        return { status: "matched" };
    } catch {
        return { status: "mismatch" };
    }
}

export async function migrateConnectedServicesAccountEncryptionInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        currentMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
        directive: unknown;
    }>,
): Promise<ConnectedServicesAccountEncryptionMigrationResult> {
    const parsed =
        AccountEncryptionMigrateConnectedServicesDirectiveSchema.safeParse(
            params.directive,
        );
    if (!parsed.success) return { status: "invalid_content" };
    const directive = parsed.data;
    if (params.currentMode === params.toMode) {
        return { status: "invalid_content" };
    }

    if (
        directive.action === "assert_empty"
        || directive.action === "migrate"
    ) {
        const complete =
            await isQualifiedConnectedAccountMigrationInventoryCompleteInTx(
                params.tx,
                {
                    accountId: params.accountId,
                    legacyCredentials:
                        directive.action === "migrate"
                            ? directive.credentials
                            : [],
                    qualifiedCredentials:
                        directive.action === "migrate"
                            ? directive.qualifiedCredentials
                            : [],
                },
            );
        if (!complete) {
            return {
                status:
                    directive.action === "assert_empty"
                        ? "not_empty"
                        : "migration_incomplete",
            };
        }
    }

    const preparedLegacy =
        directive.action === "migrate"
            ? prepareLegacyMigrations({
                accountId: params.accountId,
                toMode: params.toMode,
                items: directive.credentials,
            })
            : [];
    if (!preparedLegacy) return { status: "invalid_content" };

    let changed = false;
    if (
        params.currentMode !== params.toMode
        && directive.action !== "clear"
    ) {
        const clearedUsage =
            await clearQualifiedConnectedAccountUsageForAccountInTx(
                params.tx,
                { accountId: params.accountId },
            );
        changed =
            clearedUsage.deletedSources > 0
            || clearedUsage.deletedRecords > 0;
    }

    if (directive.action === "clear") {
        const cleanup =
            await clearQualifiedConnectedAccountsForAccountInTx(
                params.tx,
                { accountId: params.accountId },
            );
        changed =
            cleanup.deletedCredentialCount > 0
            || cleanup.deletedUsageSourceCount > 0
            || cleanup.deletedUsageRecordCount > 0
            || cleanup.reconciledGroupCount > 0;
    } else if (directive.action === "migrate") {
        for (const prepared of preparedLegacy) {
            const mutation =
                await migrateConnectedServiceCredentialInTx(
                    params.tx,
                    prepared.mutation,
                    params.toMode,
                );
            if (mutation.status !== "written") {
                throw new ConnectedServicesAccountEncryptionMigrationConflictError(
                    `legacy_${mutation.status}`,
                );
            }
            changed = true;
        }

        for (const credential of directive.qualifiedCredentials) {
            const mutation =
                await migrateQualifiedConnectedServiceCredentialInTx(
                    params.tx,
                    {
                        accountId: params.accountId,
                        ref: credential.ref,
                        expectedCredentialRevision:
                            credential.expectedCredentialRevision,
                        expectedConfigurationRevision:
                            credential.expectedConfigurationRevision,
                        authenticationModeId:
                            credential.authenticationModeId,
                        content:
                            credential
                                .replacementCredentialContentEnvelope,
                        metadata: credential.metadata,
                    },
                    params.toMode,
                );
            if (mutation.status !== "written") {
                throw new ConnectedServicesAccountEncryptionMigrationConflictError(
                    `qualified_${mutation.status}`,
                );
            }
            if (
                credential.replacementConfigurationContentEnvelope
                && credential.expectedConfigurationRevision !== null
            ) {
                const configurationMutation =
                    await migrateQualifiedConnectedAccountConfigurationInTx(
                        params.tx,
                        {
                            accountId: params.accountId,
                            target: {
                                kind: "account",
                                ref: credential.ref,
                            },
                            expectedCredentialRevision:
                                mutation.credentialRevision,
                            expectedConfigurationRevision:
                                credential.expectedConfigurationRevision,
                            replacementContentEnvelope:
                                credential
                                    .replacementConfigurationContentEnvelope,
                        },
                        params.toMode,
                );
                if (configurationMutation.status !== "written") {
                    throw new ConnectedServicesAccountEncryptionMigrationConflictError(
                        `configuration_${configurationMutation.status}`,
                    );
                }
            }
            changed = true;
        }
    }

    const accountVersion =
        changed
            ? await recordConnectedServiceAccountProfileChange({
                tx: params.tx,
                accountId: params.accountId,
            })
            : null;
    return {
        status: "applied",
        changed,
        accountVersion,
    };
}
