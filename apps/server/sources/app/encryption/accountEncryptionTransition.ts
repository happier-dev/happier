import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionCurrentness,
    type AccountEncryptionInconsistencyReason,
    type VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    resolveEffectiveAccountEncryptionModeFromAccountRow,
} from "@/app/encryption/accountEncryptionMode";
import {
    computeAccountEncryptionMigrateKeyFingerprintV1,
} from "@happier-dev/protocol";
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Tx } from "@/storage/inTx";

export type AccountEncryptionTransitionFenceResult =
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{
        status: "account_inconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>
    | Readonly<{
        status: "ready";
        account: Readonly<{
            version: number;
            publicKey: string | null;
            signingKeyFingerprint: string | null;
            contentKeyFingerprint: string | null;
            settings: string | null;
            settingsVersion: number;
            currentness: Readonly<AccountEncryptionCurrentness>;
        }>;
    }>;

export async function acquireAccountEncryptionTransitionFenceInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountEncryptionTransitionFenceResult> {
    try {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId);
    } catch (error) {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { status: "account_not_found" };
        }
        throw error;
    }
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
            seq: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
            settings: true,
            settingsVersion: true,
        },
    });
    if (!account) {
        return { status: "account_not_found" };
    }
    const currentness =
        deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status === "inconsistent") {
        return {
            status: "account_inconsistent",
            reason: currentness.reason,
        };
    }

    return {
        status: "ready",
        account: {
            version: account.seq,
            publicKey: account.publicKey,
            ...deriveAccountEncryptionMigrationKeyFingerprints(account),
            settings: account.settings,
            settingsVersion: account.settingsVersion,
            currentness: currentness.currentness,
        },
    };
}

export function deriveAccountEncryptionMigrationKeyFingerprints(
    account: Readonly<{
        publicKey: string | null;
        contentPublicKey: Uint8Array | null;
    }>,
): Readonly<{
    signingKeyFingerprint: string | null;
    contentKeyFingerprint: string | null;
}> {
    const signingPublicKey =
        typeof account.publicKey === "string"
        && account.publicKey.length === 64
        && /^[0-9a-f]+$/iu.test(account.publicKey)
            ? new Uint8Array(Buffer.from(account.publicKey, "hex"))
            : null;
    return {
        signingKeyFingerprint:
            signingPublicKey
                ? computeAccountEncryptionMigrateKeyFingerprintV1(
                    signingPublicKey,
                )
                : null,
        contentKeyFingerprint:
            account.contentPublicKey
                ? computeAccountEncryptionMigrateKeyFingerprintV1(
                    account.contentPublicKey,
                )
                : null,
    };
}

export async function applyAccountEncryptionTransitionInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        expectedVersion: number;
        toMode: "plain" | "e2ee";
        accountPublicKeyHex?: string;
        contentKey:
            | Readonly<{ kind: "preserve" }>
            | Readonly<{
                kind: "migration_replace";
                binding: VerifiedAccountContentKeyBinding;
            }>;
    }>,
): Promise<Readonly<{
    mode: "plain" | "e2ee";
    version: number;
    updatedAt: number;
}>> {
    const mutation = await tx.account.updateMany({
        where: {
            id: params.accountId,
            seq: params.expectedVersion,
        },
        data: {
            encryptionMode: params.toMode,
            encryptionModeUpdatedAt: new Date(),
            updatedAt: new Date(),
            ...(params.accountPublicKeyHex
                ? { publicKey: params.accountPublicKeyHex }
                : {}),
            ...(params.contentKey.kind === "migration_replace"
                ? {
                    contentPublicKey:
                        params.contentKey.binding.contentPublicKey,
                    contentPublicKeySig:
                        params.contentKey.binding
                            .contentPublicKeySignature,
                }
                : {}),
        },
    });
    if (mutation.count !== 1) {
        throw new Error(
            "Account encryption transition lost its Account currentness fence",
        );
    }
    const updated = await tx.account.findUniqueOrThrow({
        where: { id: params.accountId },
        select: {
            seq: true,
            encryptionMode: true,
            encryptionModeUpdatedAt: true,
        },
    });
    const mode =
        resolveEffectiveAccountEncryptionModeFromAccountRow(updated);
    if (mode.status === "inconsistent") {
        throw new Error(
            "Account encryption transition wrote an invalid persisted mode",
        );
    }
    return {
        mode: mode.mode,
        version: updated.seq,
        updatedAt: updated.encryptionModeUpdatedAt.getTime(),
    };
}
