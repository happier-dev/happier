import { inTx } from "@/storage/inTx";
import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
} from "@/app/encryption/accountEncryptionTransition";

export type UpdateAccountEncryptionModeResult =
    | Readonly<{ status: "updated"; mode: "plain" | "e2ee"; updatedAt: number }>
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{ status: "invalid_public_key" }>
    | Readonly<{ status: "migration_required" }>
    | Readonly<{ status: "metadata_privacy_upgrade_required" }>;

/**
 * Changes the account encryption mode only when no mode-bound account content exists.
 *
 * The account snapshot, migration preconditions, and mode update share one serializable
 * transaction so a concurrent first content write cannot commit between the check and update.
 */
export async function updateAccountEncryptionMode(params: Readonly<{
    accountId: string;
    mode: "plain" | "e2ee";
}>): Promise<UpdateAccountEncryptionModeResult> {
    return await inTx(async (tx) => {
        const fence =
            await acquireAccountEncryptionTransitionFenceInTx(
                tx,
                params.accountId,
            );
        if (fence.status !== "ready") return fence;
        const account = fence.account;

        const hasSettings = typeof account.settings === "string" && account.settings.trim().length > 0;
        const connectedServicesCount = await tx.serviceAccountToken.count({ where: { accountId: params.accountId } });
        const automationsCount = await tx.automation.count({ where: { accountId: params.accountId } });
        if (hasSettings || connectedServicesCount > 0 || automationsCount > 0) {
            return { status: "migration_required" };
        }

        if (
            params.mode === "e2ee"
            && account.currentness.contentPublicKeyFingerprint === null
        ) {
            return { status: "invalid_public_key" };
        }

        const updated = await applyAccountEncryptionTransitionInTx(tx, {
            accountId: params.accountId,
            toMode: params.mode,
            contentKey: { kind: "preserve" },
        });
        return {
            status: "updated",
            mode: updated.mode,
            updatedAt: updated.updatedAt,
        };
    });
}
