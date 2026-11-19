import {
    parsePrivateLabelStoredV1,
    projectPrivateLabelForRecipientV1,
    serializePrivateLabelStoredV1,
    validatePrivateLabelStoredForModeV1,
    type PrivateLabelReadV1,
    type PrivateLabelStoredV1,
} from "@happier-dev/protocol";
import { decodeBase64 } from "@happier-dev/protocol/crypto/base64";
import { type AccountEncryptionMigratePrivateLabelsDirectiveV1,
    type AccountEncryptionMigratePrivateLabelSourceV1,
    type AccountEncryptionMigratePrivateLabelInventoryV1 } from "@happier-dev/protocol/account/encryptionMigrate";
import { isDeepStrictEqual } from "node:util";

import {
    readRequiredResourceRecipientEnvelopeRejectionV1,
    readTargetOwnerRecipientEnvelopeRejectionV1,
    resolveSavedSecretAudienceAccountIdsInTx,
    RESOURCE_RECIPIENT_ACCOUNT_SELECT,
    type ResourceRecipientEnvelopeRow,
} from "@/app/encryption/savedSecretRecipientEnvelopeCensus";
import type { Tx } from "@/storage/inTx";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";

/** The persisted Account mode, rather than a caller's claimed mode, admits a label. */
export type AccountPrivateLabelModeV1 = "plain" | "e2ee";

export type AccountPrivateLabelReadResultV1 =
    | Readonly<{ kind: "available"; stored: PrivateLabelStoredV1; legacyPlaintext?: true }>
    | Readonly<{ kind: "invalid_stored_content" }>
    | Readonly<{ kind: "mode_mismatch" }>;

/** Raw historic labels remain readable until their next normal save. Current envelopes still follow persisted Account mode. */
export function readAccountPrivateLabelStoredV1(params: Readonly<{
    serialized: string;
    mode: AccountPrivateLabelModeV1;
}>): AccountPrivateLabelReadResultV1 {
    const parsed = parsePrivateLabelStoredV1(params.serialized, { allowLegacyPlaintext: true });
    if (parsed.kind === "invalid") return { kind: "invalid_stored_content" };
    if (parsed.kind === "legacy_plain") return { kind: "available", stored: parsed.stored, legacyPlaintext: true };
    return validatePrivateLabelStoredForModeV1({ mode: params.mode, stored: parsed.stored });
}

/** Project at most one envelope after the persisted owner mode has been checked. */
export function projectAccountPrivateLabelForRecipientV1(params: Readonly<{
    serialized: string;
    mode: AccountPrivateLabelModeV1;
    recipientAccountId: string;
}>): Readonly<{ kind: "available"; label: PrivateLabelReadV1 }>
    | Exclude<AccountPrivateLabelReadResultV1, Readonly<{ kind: "available" }>> {
    const stored = readAccountPrivateLabelStoredV1(params);
    if (stored.kind !== "available") return stored;
    return {
        kind: "available",
        label: projectPrivateLabelForRecipientV1({
            stored: stored.stored,
            ...(stored.legacyPlaintext === true ? { legacyPlaintext: true } : {}),
            recipientAccountId: params.recipientAccountId,
        }),
    };
}

export type AccountPrivateLabelWriteAdmissionV1 =
    | Readonly<{ kind: "available"; stored: PrivateLabelStoredV1 }>
    | Readonly<{ kind: "invalid_stored_content" }>
    | Readonly<{ kind: "mode_mismatch" }>
    | Readonly<{ kind: "recipient_envelope_rejected" }>;

/**
 * A client may create ciphertext, but the Account owner decides both the
 * encryption mode and the one-current-recipient envelope it accepts.
 */
export async function admitAccountPrivateLabelWriteInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        mode: AccountPrivateLabelModeV1;
        stored: unknown;
    }>,
): Promise<AccountPrivateLabelWriteAdmissionV1> {
    const validated = validatePrivateLabelStoredForModeV1({ mode: params.mode, stored: params.stored });
    if (validated.kind !== "available") return validated;
    if (validated.stored.content.t === "plain") return validated;

    let envelopes: readonly ResourceRecipientEnvelopeRow[];
    try {
        envelopes = validated.stored.recipients.map((recipient) => ({
            accountId: recipient.accountId,
            encryptedDataKey: decodeBase64(recipient.envelope.encryptedDataKey, "base64"),
            recipientContentPublicKeyFingerprint: recipient.envelope.recipientContentPublicKeyFingerprint,
        }));
    } catch {
        return { kind: "recipient_envelope_rejected" };
    }
    const expectedRecipientAccountIds = await resolveSavedSecretAudienceAccountIdsInTx(tx, {
        ownerAccountId: params.accountId,
        accountIds: [],
        teamIds: [],
        groupIds: [],
    });
    const recipients = await tx.account.findMany({
        where: { id: { in: [...expectedRecipientAccountIds] } },
        select: RESOURCE_RECIPIENT_ACCOUNT_SELECT,
    });
    const rejection = readRequiredResourceRecipientEnvelopeRejectionV1({
        expectedRecipientAccountIds,
        envelopes,
        recipientsById: new Map(recipients.map((recipient) => [recipient.id, recipient])),
    });
    return rejection === null ? validated : { kind: "recipient_envelope_rejected" };
}

export type AccountPrivateLabelMigrationResultV1 = Readonly<{
    status: "applied" | "migration_incomplete" | "invalid_content";
}>;

type AccountPrivateLabelMigrationSourceRowV1 = {
    [Entity in AccountEncryptionMigratePrivateLabelSourceV1["entity"]]:
        Omit<Extract<AccountEncryptionMigratePrivateLabelSourceV1, { entity: Entity }>, "label">
        & Readonly<{ serialized: string }>;
}[AccountEncryptionMigratePrivateLabelSourceV1["entity"]];

function accountPrivateLabelMigrationIdentity(
    value: Readonly<{ entity: string; field: string; id: string }>,
): string {
    return `${value.entity}:${value.field}:${value.id}`;
}

/** Inventory and mutation consume the same complete local Home census. */
async function readAccountPrivateLabelMigrationRowsInTx(
    tx: Tx,
    accountId: string,
): Promise<readonly AccountPrivateLabelMigrationSourceRowV1[]> {
    const [apiTokens, homes, personalPools] = await Promise.all([
        tx.accountApiToken.findMany({
            where: { accountId },
            select: { id: true, label: true },
        }),
        tx.accountHomeDirectoryEntry.findMany({
            where: { accountId },
            select: { homeServerIdentityId: true, label: true },
        }),
        tx.machinePool.findMany({
            where: { accountId, teamId: null },
            select: { id: true, name: true, description: true },
        }),
    ]);
    const poolRows = personalPools.flatMap((pool): AccountPrivateLabelMigrationSourceRowV1[] => {
        const rows: AccountPrivateLabelMigrationSourceRowV1[] = [];
        {
            rows.push({
                entity: "machine_pool",
                field: "name",
                id: pool.id,
                serialized: pool.name,
            });
        }
        if (pool.description !== null) {
            rows.push({
                entity: "machine_pool",
                field: "description",
                id: pool.id,
                serialized: pool.description,
            });
        }
        return rows;
    });
    return [
        ...apiTokens.map((row) => ({
            entity: "account_api_token" as const,
            field: "label" as const,
            id: row.id,
            serialized: row.label,
        })),
        // A bootstrap Home can exist before the person has Account key material.
        // Its empty column is the explicit absent-label representation, not text.
        ...homes
            .filter((row) => row.label !== "")
            .map((row) => ({
                entity: "account_directory_home" as const,
                field: "label" as const,
                id: row.homeServerIdentityId,
                serialized: row.label,
            })),
        ...poolRows,
    ];
}

export async function readAccountPrivateLabelMigrationInventoryInTx(
    tx: Tx,
    accountId: string,
): Promise<Readonly<{ kind: "available"; inventory: AccountEncryptionMigratePrivateLabelInventoryV1 }>
    | Readonly<{ kind: "encryption_unavailable" }>> {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: { encryptionMode: true } });
    const mode = account && resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    if (!mode || mode.status !== "ready") return { kind: "encryption_unavailable" };
    const items: AccountEncryptionMigratePrivateLabelSourceV1[] = [];
    for (const { serialized, ...identity } of await readAccountPrivateLabelMigrationRowsInTx(tx, accountId)) {
        const projection = projectAccountPrivateLabelForRecipientV1({
            serialized, mode: mode.mode, recipientAccountId: accountId,
        });
        if (projection.kind !== "available") return { kind: "encryption_unavailable" };
        items.push({ ...identity, label: projection.label });
    }
    return { kind: "available", inventory: { items } };
}

/**
 * Rewrites the census inside the incumbent Account mode transaction, binding
 * source projections and accepting E2EE only for the verified target key.
 */
export async function migrateAccountPrivateLabelsForModeInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        fromMode: AccountPrivateLabelModeV1;
        toMode: AccountPrivateLabelModeV1;
        ownerContentPublicKeyFingerprint: string | null;
        directive: AccountEncryptionMigratePrivateLabelsDirectiveV1 | undefined;
    }>,
): Promise<AccountPrivateLabelMigrationResultV1> {
    const sourceRows = await readAccountPrivateLabelMigrationRowsInTx(tx, input.accountId);
    const itemsByIdentity = new Map<string, AccountEncryptionMigratePrivateLabelsDirectiveV1["items"][number]>();
    for (const item of input.directive?.items ?? []) {
        const identity = accountPrivateLabelMigrationIdentity(item);
        if (itemsByIdentity.has(identity)) return { status: "migration_incomplete" };
        itemsByIdentity.set(identity, item);
    }
    if (
        itemsByIdentity.size !== sourceRows.length
        || sourceRows.some((row) => !itemsByIdentity.has(accountPrivateLabelMigrationIdentity(row)))
    ) {
        return { status: "migration_incomplete" };
    }

    const rewrites: Array<Readonly<{
        entity: AccountPrivateLabelMigrationSourceRowV1["entity"];
        field: AccountPrivateLabelMigrationSourceRowV1["field"];
        id: string;
        sourceSerialized: string;
        targetSerialized: string;
    }>> = [];
    for (const row of sourceRows) {
        const item = itemsByIdentity.get(accountPrivateLabelMigrationIdentity(row));
        if (!item) return { status: "migration_incomplete" };
        const source = readAccountPrivateLabelStoredV1({
            serialized: row.serialized,
            mode: input.fromMode,
        });
        if (source.kind !== "available") return { status: "invalid_content" };
        const expectedLabel = projectPrivateLabelForRecipientV1({
            stored: source.stored,
            ...(source.legacyPlaintext === true ? { legacyPlaintext: true } : {}),
            recipientAccountId: input.accountId,
        });
        if (!isDeepStrictEqual(expectedLabel, item.expectedLabel)) {
            return { status: "migration_incomplete" };
        }
        const target = validatePrivateLabelStoredForModeV1({
            mode: input.toMode,
            stored: item.label,
        });
        if (target.kind !== "available") return { status: "invalid_content" };
        if (target.stored.content.t === "encrypted") {
            let targetEnvelopes: readonly ResourceRecipientEnvelopeRow[];
            try {
                targetEnvelopes = target.stored.recipients.map((recipient) => ({
                    accountId: recipient.accountId,
                    encryptedDataKey: decodeBase64(
                        recipient.envelope.encryptedDataKey,
                        "base64",
                    ),
                    recipientContentPublicKeyFingerprint:
                        recipient.envelope.recipientContentPublicKeyFingerprint,
                }));
            } catch {
                return { status: "invalid_content" };
            }
            if (
                input.ownerContentPublicKeyFingerprint === null
                || readTargetOwnerRecipientEnvelopeRejectionV1({
                    ownerAccountId: input.accountId,
                    ownerContentPublicKeyFingerprint:
                        input.ownerContentPublicKeyFingerprint,
                    envelopes: targetEnvelopes,
                }) !== null
            ) return { status: "invalid_content" };
        }
        rewrites.push({
            entity: row.entity,
            field: row.field,
            id: row.id,
            sourceSerialized: row.serialized,
            targetSerialized: serializePrivateLabelStoredV1(target.stored),
        });
    }

    for (const rewrite of rewrites) {
        let result: Readonly<{ count: number }>;
        if (rewrite.entity === "account_api_token") {
            result = await tx.accountApiToken.updateMany({
                where: {
                    id: rewrite.id,
                    accountId: input.accountId,
                    label: rewrite.sourceSerialized,
                },
                data: { label: rewrite.targetSerialized },
            });
        } else if (rewrite.entity === "account_directory_home") {
            result = await tx.accountHomeDirectoryEntry.updateMany({
                where: {
                    accountId: input.accountId,
                    homeServerIdentityId: rewrite.id,
                    label: rewrite.sourceSerialized,
                },
                data: { label: rewrite.targetSerialized },
            });
        } else if (rewrite.field === "name") {
            result = await tx.machinePool.updateMany({
                where: {
                    id: rewrite.id,
                    accountId: input.accountId,
                    teamId: null,
                    name: rewrite.sourceSerialized,
                },
                data: { name: rewrite.targetSerialized },
            });
        } else {
            result = await tx.machinePool.updateMany({
                where: {
                    id: rewrite.id,
                    accountId: input.accountId,
                    teamId: null,
                    description: rewrite.sourceSerialized,
                },
                data: { description: rewrite.targetSerialized },
            });
        }
        if (result.count !== 1) return { status: "migration_incomplete" };
    }
    return { status: "applied" };
}
