import { migrateMachineAccountEncryptionInTx } from "@/app/machines/migrateMachineAccountEncryptionInTx";
import { inTx } from "@/storage/inTx";

export type UpdateAccountEncryptionModeResult =
    | Readonly<{ status: "updated"; mode: "plain" | "e2ee"; updatedAt: number }>
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{ status: "invalid_public_key" }>
    | Readonly<{ status: "migration_required" }>;

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
        const account = await tx.account.findUnique({
            where: { id: params.accountId },
            select: { publicKey: true, settings: true },
        });
        if (!account) return { status: "account_not_found" };

        const hasSettings = typeof account.settings === "string" && account.settings.trim().length > 0;
        const connectedServicesCount = await tx.serviceAccountToken.count({ where: { accountId: params.accountId } });
        const automationsCount = await tx.automation.count({ where: { accountId: params.accountId } });
        const machineMigration = await migrateMachineAccountEncryptionInTx({ tx, accountId: params.accountId, toMode: params.mode });
        if (hasSettings || connectedServicesCount > 0 || automationsCount > 0 || machineMigration !== "applied") {
            return { status: "migration_required" };
        }

        if (params.mode === "e2ee" && !account.publicKey) {
            return { status: "invalid_public_key" };
        }

        const updated = await tx.account.update({
            where: { id: params.accountId },
            data: { encryptionMode: params.mode, encryptionModeUpdatedAt: new Date() },
            select: { encryptionMode: true, encryptionModeUpdatedAt: true },
        });
        return {
            status: "updated",
            mode: updated.encryptionMode === "plain" ? "plain" : "e2ee",
            updatedAt: updated.encryptionModeUpdatedAt.getTime(),
        };
    });
}
