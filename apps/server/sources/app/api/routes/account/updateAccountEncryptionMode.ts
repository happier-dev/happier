import { inTx } from "@/storage/inTx";
import {
    acquireAccountEncryptionTransitionCoordinatorFenceInTx,
    finalizeAccountEncryptionTransitionCoordinatorInTx,
} from "@/app/encryption/accountEncryptionTransitionCoordinator";
import {
    deriveAccountEncryptionMigrationKeyFingerprints,
} from "@/app/encryption/accountEncryptionTransition";
import {
    migrateMachineAccountEncryptionInTx,
} from "@/app/machines/migrateMachineAccountEncryptionInTx";
import {
    migrateTodoAccountEncryptionInTx,
} from "@/app/kv/migrateTodoAccountEncryptionInTx";
import {
    migrateAutomationAccountEncryptionInTx,
} from "@/app/automations/automationCrudService";
import {
    migrateArtifactAccountEncryptionInTx,
} from "@/app/artifacts/artifactWriteService";
import {
    migrateConnectedServicesAccountEncryptionInTx,
} from "@/app/api/routes/connect/credentials/accountEncryptionMigration";
import {
    migrateSessionAccountEncryptionInTx,
} from "@/app/session/sessionWriteService";
import {
    classifyReviewCommentAccountEncryptionMigrationError,
    migrateReviewCommentAccountEncryptionInTx,
} from "@/app/reviews/comments/accountEncryptionMigration";
import {
    createReviewCommentAccountEncryptionMigrationPersistenceInTx,
} from "@/app/reviews/comments/accountEncryptionMigrationPersistence";
import {
    migrateSessionOrganizationAccountEncryptionInTx,
} from "@/app/session/organization/sessionOrganizationAccountEncryptionMigration";
import {
    assertAccountPetLibraryEmptyForEncryptionTransitionInTx,
} from "@/app/pets/accountPetEncryptionTransition";
import {
    assertPluginWebhookPayloadsEmptyForAccountEncryptionTransitionInTx,
} from "@/app/plugins/webhooks/accountEncryptionTransition";
import {
    inspectPluginAccountDataForEncryptionTransitionInTx,
} from "@/app/plugins/data/accountEncryptionTransitionCensus";
import {
    inspectAccountSettingsForEncryptionTransitionInTx,
} from "@/app/accountSettings/accountEncryptionTransitionCensus";

export type UpdateAccountEncryptionModeResult =
    | Readonly<{
        status: "updated";
        mode: "plain" | "e2ee";
        version: number;
        signingKeyFingerprint: string | null;
        contentKeyFingerprint: string | null;
        updatedAt: number;
    }>
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{ status: "invalid_public_key" }>
    | Readonly<{ status: "migration_required" }>
    | Readonly<{ status: "metadata_privacy_upgrade_required" }>;

class AccountEncryptionTransitionFinalizationRejectedError extends Error {
    constructor() {
        super("Account encryption transition finalization was refused");
        this.name = "AccountEncryptionTransitionFinalizationRejectedError";
    }
}

/**
 * Empty-only compatibility ingress for the PATCH shape retained from
 * remote-dev@fae505bdc6916b3c9fa7a67eac3c4c88df759e9b.
 *
 * The Account snapshot, every required domain inventory, and the mode update share
 * one serializable transaction. Non-empty transitions must use the canonical migrate
 * route. Remove this ingress when that predecessor PATCH direction is unsupported.
 */
export async function updateAccountEncryptionMode(params: Readonly<{
    accountId: string;
    mode: "plain" | "e2ee";
}>): Promise<UpdateAccountEncryptionModeResult> {
    try {
        return await inTx(async (tx) => {
        const fence =
            await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
                tx,
                params.accountId,
            );
        if (fence.status === "account_inconsistent") {
            return { status: "migration_required" };
        }
        if (fence.status !== "ready") return fence;
        const account = fence.account;

        if (
            account.currentness.encryptionMode === "plain"
            && params.mode === "e2ee"
        ) {
            // The legacy PATCH carries no possession proof. Only the canonical
            // migration route may attach or re-enable Account E2EE material.
            return { status: "migration_required" };
        }

        const hasSettings = typeof account.settings === "string" && account.settings.trim().length > 0;
        if (hasSettings) {
            return { status: "migration_required" };
        }
        const pluginDataCensus =
            await inspectPluginAccountDataForEncryptionTransitionInTx(
                tx,
                params.accountId,
            );
        if (pluginDataCensus.status === "account_not_found") {
            return { status: "account_not_found" };
        }
        if (
            pluginDataCensus.status === "nonempty"
            && (
                pluginDataCensus.accountStorage
                || pluginDataCensus.collections === "invalid_tombstone"
            )
        ) {
            return { status: "migration_required" };
        }
        const pluginSettingsCensus =
            await inspectAccountSettingsForEncryptionTransitionInTx(
                tx,
                params.accountId,
            );
        if (pluginSettingsCensus.status === "account_not_found") {
            return { status: "account_not_found" };
        }
        if (pluginSettingsCensus.status === "nonempty") {
            return { status: "migration_required" };
        }
        const sessionInventory =
            await migrateSessionAccountEncryptionInTx({
                tx,
                accountId: params.accountId,
                fromMode:
                    account.currentness.encryptionMode,
                toMode: params.mode,
                directive: { action: "assert_empty" },
            });
        if (sessionInventory.status !== "applied") {
            return {
                status:
                    "metadata_privacy_upgrade_required",
            };
        }
        const automationInventory =
            await migrateAutomationAccountEncryptionInTx({
                tx,
                accountId: params.accountId,
                toMode: params.mode,
                directive: { action: "assert_empty" },
            });
        if (
            automationInventory.status !== "applied"
        ) {
            return { status: "migration_required" };
        }
        const machineInventory =
            await migrateMachineAccountEncryptionInTx({
                tx,
                accountId: params.accountId,
                toMode: params.mode,
                directive: { action: "assert_empty" },
            });
        const todoInventory =
            await migrateTodoAccountEncryptionInTx({
                tx,
                accountId: params.accountId,
                fromMode: account.currentness.encryptionMode,
                toMode: params.mode,
                directive: { action: "assert_empty" },
            });
        const artifactInventory =
            await migrateArtifactAccountEncryptionInTx({
                tx,
                accountId: params.accountId,
                toMode: params.mode,
                directive: { action: "assert_empty" },
            });
        if (
            machineInventory.status !== "applied"
            || todoInventory.status !== "applied"
            || artifactInventory.status !== "applied"
        ) {
            return { status: "migration_required" };
        }

        if (
            params.mode === "e2ee"
            && account.currentness.contentPublicKeyFingerprint === null
        ) {
            return { status: "invalid_public_key" };
        }

        const connectedServicesInventory =
            await migrateConnectedServicesAccountEncryptionInTx({
                tx,
                accountId: params.accountId,
                currentMode:
                    account.currentness.encryptionMode,
                toMode: params.mode,
                directive: { action: "assert_empty" },
            });
        if (connectedServicesInventory.status !== "applied") {
            return { status: "migration_required" };
        }

        try {
            await migrateReviewCommentAccountEncryptionInTx({
                accountId: params.accountId,
                targetMode: params.mode,
                directive: { action: "assert_empty" },
                persistence:
                    createReviewCommentAccountEncryptionMigrationPersistenceInTx(
                        tx,
                    ),
            });
        } catch (error) {
            if (
                classifyReviewCommentAccountEncryptionMigrationError(error)
                !== null
            ) {
                return { status: "migration_required" };
            }
            throw error;
        }
        const sessionOrganizationInventory =
            await migrateSessionOrganizationAccountEncryptionInTx({
                tx,
                accountId: params.accountId,
                toMode: params.mode,
                directive: { action: "assert_empty" },
            });
        if (sessionOrganizationInventory.status !== "applied") {
            return { status: "migration_required" };
        }
        const petInventory =
            await assertAccountPetLibraryEmptyForEncryptionTransitionInTx(
                tx,
                params.accountId,
            );
        if (petInventory.status !== "empty") {
            return { status: "migration_required" };
        }
        const pluginWebhookInventory =
            await assertPluginWebhookPayloadsEmptyForAccountEncryptionTransitionInTx(
                tx,
                params.accountId,
            );
        if (pluginWebhookInventory.status !== "empty") {
            return { status: "migration_required" };
        }

        const finalized =
            await finalizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: params.accountId,
                fromMode: account.currentness.encryptionMode,
                toMode: params.mode,
                contentKey: { kind: "preserve" },
                accountChangeHint: { encryptionMode: params.mode },
            });
        if (finalized.status !== "applied") {
            // A concurrent Collection write can arrive after the early census.
            // Throw so every earlier participant mutation in this transaction
            // rolls back before the retained PATCH reports the refusal.
            throw new AccountEncryptionTransitionFinalizationRejectedError();
        }
        return {
            status: "updated",
            mode: finalized.mode,
            version: finalized.version,
            ...deriveAccountEncryptionMigrationKeyFingerprints({
                publicKey: account.publicKey,
                contentPublicKey:
                    account.currentness.contentPublicKey,
            }),
            updatedAt: finalized.updatedAt,
        };
        });
    } catch (error) {
        if (error instanceof AccountEncryptionTransitionFinalizationRejectedError) {
            return { status: "migration_required" };
        }
        throw error;
    }
}
