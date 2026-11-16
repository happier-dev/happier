import { isDeepStrictEqual } from "node:util";

import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import {
    ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES,
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    type AccountEncryptionMigrateSettingsHistoryDirective,
    type AccountEncryptionMigrateSettingsHistoryInventoryPage,
} from '@happier-dev/protocol/account/encryptionMigrate';

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import {
    openPlainAccountSettingsDbValue,
    storePlainAccountSettingsDbValue,
} from "@/app/encryption/accountSettingsStorage";
import type { Tx } from "@/storage/inTx";
import { accountSettingsSnapshotToContent, encodeAccountSettingsSnapshotDbValue } from './accountSettingsHistoryContent';

/** Paged source envelopes for the existing client Settings re-seal path. Never opens E2EE content. */
export async function readAccountSettingsEncryptionMigrationInventoryInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    beforeVersion?: number;
}>): Promise<
    | Readonly<{ status: 'ready'; page: AccountEncryptionMigrateSettingsHistoryInventoryPage }>
    | Readonly<{ status: 'inventory_changed' | 'migration_too_large' }>
> {
    const account = await params.tx.account.findUnique({
        where: { id: params.accountId },
        select: { encryptionMode: true },
    });
    if (!account || (account.encryptionMode !== 'plain' && account.encryptionMode !== 'e2ee')) {
        return { status: 'inventory_changed' };
    }
    const rows = await params.tx.accountSettingsSnapshot.findMany({
        where: { accountId: params.accountId,
            ...(params.beforeVersion === undefined ? {} : { version: { lt: params.beforeVersion } }),
        },
        orderBy: { version: 'desc' },
        take: ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS + 1,
        select: { accountId: true, version: true, createdAt: true, encryptionMode: true, settingsDbValue: true, settingsDbValueBytes: true },
    });
    const items: AccountEncryptionMigrateSettingsHistoryInventoryPage['items'] = [];
    // Reuse the containing migration's real transport budget, including page framing.
    let bytes = Buffer.byteLength(JSON.stringify({ items: [], nextBeforeVersion: Number.MAX_SAFE_INTEGER }), 'utf8');
    for (const row of rows) {
        if (items.length === ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS) break;
        if (row.encryptionMode !== account.encryptionMode || (row.settingsDbValue === '' && row.settingsDbValueBytes == null)) {
            return { status: 'inventory_changed' };
        }
        let content: AccountSettingsStoredContentEnvelope | null;
        try { content = accountSettingsSnapshotToContent(row); }
        catch { return { status: 'inventory_changed' }; }
        const item: AccountEncryptionMigrateSettingsHistoryInventoryPage['items'][number] = { version: row.version, createdAt: row.createdAt.toISOString(),
            encryptionMode: account.encryptionMode, content };
        const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + (items.length ? 1 : 0);
        if (bytes + itemBytes > ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES) {
            if (items.length === 0) return { status: 'migration_too_large' };
            break;
        }
        items.push(item);
        bytes += itemBytes;
    }
    return { status: 'ready', page: { items,
        nextBeforeVersion: items.length < rows.length ? items[items.length - 1].version : null,
    } };
}

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
        history?: AccountEncryptionMigrateSettingsHistoryDirective;
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

    const snapshots = await params.tx.accountSettingsSnapshot.findMany({ where: { accountId: params.accountId } });
    const replacements = new Map(params.history?.items.map(item => [item.version, item]));
    if (snapshots.length !== replacements.size || snapshots.some(snapshot => {
        const replacement = replacements.get(snapshot.version);
        if (!replacement || snapshot.encryptionMode !== params.toMode || (snapshot.settingsDbValue === '' && snapshot.settingsDbValueBytes == null)
            || snapshot.contentKind !== (replacement.content?.t ?? 'empty')) return true;
        try { return !isDeepStrictEqual(accountSettingsSnapshotToContent(snapshot), replacement.content); }
        catch { return true; }
    })) return { status: 'mismatch' };

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
    history?: AccountEncryptionMigrateSettingsHistoryDirective;
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

    const snapshots = await params.tx.accountSettingsSnapshot.findMany({ where: { accountId: params.accountId } });
    const replacements = new Map(params.history?.items.map(item => [item.version, item]));
    if (snapshots.length !== replacements.size
        || replacements.size !== (params.history?.items.length ?? 0)) return { status: 'inventory_changed' };
    for (const snapshot of snapshots) {
        const replacement = replacements.get(snapshot.version);
        if (!replacement || snapshot.encryptionMode !== params.fromMode || (snapshot.settingsDbValue === '' && snapshot.settingsDbValueBytes == null)) {
            return { status: 'inventory_changed' };
        }
        let content: AccountSettingsStoredContentEnvelope | null;
        try { content = accountSettingsSnapshotToContent(snapshot); }
        catch { return { status: 'inventory_changed' }; }
        if (!isDeepStrictEqual(content, replacement.expectedContent)
            || (content === null) !== (replacement.content === null)
            || (replacement.content !== null && replacement.content.t !== (params.toMode === 'plain' ? 'plain' : 'encrypted'))) {
            return { status: 'inventory_changed' };
        }
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

    for (const snapshot of snapshots) {
        const replacement = replacements.get(snapshot.version)!;
        const settingsDbValue = params.toMode === 'plain'
            ? storePlainAccountSettingsDbValue({ accountId: params.accountId, content: replacement.content })
            : replacement.content?.t === 'encrypted' ? replacement.content.c : null;
        const rewritten = await params.tx.accountSettingsSnapshot.updateMany({
            where: { id: snapshot.id, accountId: params.accountId, version: snapshot.version,
                encryptionMode: snapshot.encryptionMode, settingsDbValue: snapshot.settingsDbValue, settingsDbValueBytes: snapshot.settingsDbValueBytes },
            data: { ...encodeAccountSettingsSnapshotDbValue({ encryptionMode: params.toMode, settingsDbValue }), encryptionMode: params.toMode,
                contentKind: replacement.content?.t ?? 'empty' },
        });
        // The caller aborts the containing Account transaction for any refusal.
        if (rewritten.count !== 1) return { status: 'inventory_changed' };
    }

    return { status: "applied", settingsVersion: nextVersion };
}
