import { isDeepStrictEqual } from "node:util";

import type { AccountSettingsStoredContentEnvelope } from "@happier-dev/protocol";

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import {
    openPlainAccountSettingsDbValue,
    storePlainAccountSettingsDbValue,
} from "@/app/encryption/accountSettingsStorage";
import type { Tx } from "@/storage/inTx";

import { recordAccountSettingsSnapshotsForWrite } from "./accountSettingsHistoryRepository";

export type AccountSettingsEncryptionMigrationResult =
    | Readonly<{ status: "applied"; settingsVersion: number }>
    | Readonly<{
        status:
            | "account_not_found"
            | "version_mismatch"
            | "inventory_changed";
    }>;

export type AccountSettingsEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>;

/**
 * Read-only exact Settings post-state matcher for Account-transition replay.
 */
export async function matchAccountSettingsEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        expectedSettingsVersion: number;
        replacementContent:
            AccountSettingsStoredContentEnvelope | null;
    }>,
): Promise<AccountSettingsEncryptionMigrationPostStateResult> {
    const current = await params.tx.account.findUnique({
        where: { id: params.accountId },
        select: {
            settings: true,
            settingsVersion: true,
        },
    });
    if (
        !current
        || current.settingsVersion
            !== params.expectedSettingsVersion + 1
    ) {
        return { status: "mismatch" };
    }

    if (params.toMode === "e2ee") {
        const expected =
            params.replacementContent?.t === "encrypted"
                ? params.replacementContent.c
                : params.replacementContent === null
                    ? null
                    : undefined;
        return {
            status:
                expected !== undefined
                && current.settings === expected
                    ? "matched"
                    : "mismatch",
        };
    }
    if (
        params.replacementContent !== null
        && params.replacementContent.t !== "plain"
    ) {
        return { status: "mismatch" };
    }
    try {
        const opened = openPlainAccountSettingsDbValue({
            accountId: params.accountId,
            dbValue: current.settings,
        });
        return {
            status: isDeepStrictEqual(
                opened,
                params.replacementContent,
            )
                ? "matched"
                : "mismatch",
        };
    } catch {
        return { status: "mismatch" };
    }
}

export async function migrateAccountSettingsEncryptionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    fromMode: "plain" | "e2ee";
    toMode: "plain" | "e2ee";
    expectedSettingsVersion: number;
    replacementContent: AccountSettingsStoredContentEnvelope | null;
}>): Promise<AccountSettingsEncryptionMigrationResult> {
    const current = await params.tx.account.findUnique({
        where: { id: params.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            settings: true,
            settingsVersion: true,
        },
    });
    if (!current) return { status: "account_not_found" };
    const mode =
        resolveEffectiveAccountEncryptionModeFromAccountRow(current);
    if (
        mode.status === "inconsistent"
        || mode.mode !== params.fromMode
    ) {
        return { status: "inventory_changed" };
    }
    if (current.settingsVersion !== params.expectedSettingsVersion) {
        return { status: "version_mismatch" };
    }

    // A migration replaces the representation of the same logical Settings
    // inventory. Null is therefore valid only when the fenced source was null.
    if ((current.settings === null) !== (params.replacementContent === null)) {
        return { status: "inventory_changed" };
    }
    if (
        params.replacementContent
        && (
            (params.toMode === "plain"
                && params.replacementContent.t !== "plain")
            || (params.toMode === "e2ee"
                && params.replacementContent.t !== "encrypted")
        )
    ) {
        return { status: "inventory_changed" };
    }

    const nextSettings =
        params.toMode === "plain"
            ? storePlainAccountSettingsDbValue({
                accountId: params.accountId,
                content: params.replacementContent,
            })
            : params.replacementContent?.t === "encrypted"
                ? params.replacementContent.c
                : null;
    const nextVersion = params.expectedSettingsVersion + 1;
    const updated = await params.tx.account.updateMany({
        where: {
            id: params.accountId,
            encryptionMode: params.fromMode,
            settingsVersion: params.expectedSettingsVersion,
        },
        data: {
            settings: nextSettings,
            settingsVersion: nextVersion,
            updatedAt: new Date(),
        },
    });
    if (updated.count !== 1) return { status: "inventory_changed" };

    await recordAccountSettingsSnapshotsForWrite({
        tx: params.tx,
        previous: {
            accountId: params.accountId,
            version: params.expectedSettingsVersion,
            settingsDbValue: current.settings,
            encryptionMode: params.fromMode,
        },
        next: {
            accountId: params.accountId,
            version: nextVersion,
            settingsDbValue: nextSettings,
            encryptionMode: params.toMode,
        },
    });

    return { status: "applied", settingsVersion: nextVersion };
}
