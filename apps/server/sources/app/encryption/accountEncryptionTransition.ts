import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionCurrentness,
    type VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Tx } from "@/storage/inTx";

export type AccountEncryptionTransitionFenceResult =
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{ status: "metadata_privacy_upgrade_required" }>
    | Readonly<{
        status: "ready";
        account: Readonly<{
            publicKey: string | null;
            settings: string | null;
            settingsVersion: number;
            currentness: Readonly<AccountEncryptionCurrentness>;
        }>;
    }>;

export async function acquireAccountEncryptionTransitionFenceInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountEncryptionTransitionFenceResult> {
    await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId);
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
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

    const sessionRequiringOwnerMetadataResealCount =
        await tx.session.count({
            where: {
                accountId,
                OR: [
                    { metadataLayoutVersion: { not: 0 } },
                    { ownerMetadata: { not: null } },
                ],
            },
            take: 1,
        });
    if (sessionRequiringOwnerMetadataResealCount > 0) {
        return { status: "metadata_privacy_upgrade_required" };
    }

    return {
        status: "ready",
        account: {
            publicKey: account.publicKey,
            settings: account.settings,
            settingsVersion: account.settingsVersion,
            currentness:
                deriveAccountEncryptionCurrentnessFromRow(account),
        },
    };
}

export async function applyAccountEncryptionTransitionInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        toMode: "plain" | "e2ee";
        accountPublicKeyHex?: string;
        settings?: Readonly<{
            value: string | null;
            version: number;
        }>;
        contentKey:
            | Readonly<{ kind: "preserve" }>
            | Readonly<{
                kind: "migration_replace";
                binding: VerifiedAccountContentKeyBinding;
            }>;
    }>,
): Promise<Readonly<{
    mode: "plain" | "e2ee";
    updatedAt: number;
}>> {
    const updated = await tx.account.update({
        where: { id: params.accountId },
        data: {
            encryptionMode: params.toMode,
            encryptionModeUpdatedAt: new Date(),
            updatedAt: new Date(),
            ...(params.accountPublicKeyHex
                ? { publicKey: params.accountPublicKeyHex }
                : {}),
            ...(params.settings
                ? {
                    settings: params.settings.value,
                    settingsVersion: params.settings.version,
                }
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
        select: {
            encryptionMode: true,
            encryptionModeUpdatedAt: true,
        },
    });
    return {
        mode: updated.encryptionMode === "plain" ? "plain" : "e2ee",
        updatedAt: updated.encryptionModeUpdatedAt.getTime(),
    };
}
