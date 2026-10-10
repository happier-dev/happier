import type {
    AccountRemoteAlertPolicyV1,
    AccountSettingsStoredContentEnvelope,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    openPlainAccountSettingsDbValue,
    storePlainAccountSettingsDbValue,
} from "@/app/encryption/accountSettingsStorage";
import {
    buildAccountSettingsChangedUpdate,
    buildUpdateAccountUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

import { recordAccountSettingsSnapshotsForWrite } from "./accountSettingsHistoryRepository";
import { readProfileTransferControlInTx } from '@/app/account/profiles/profileTransferControl';
import { readProviderConnectionsRowInTx } from '@/app/account/providers/connectionRows';
import { readMcpServerCatalogRowInTx } from '@/app/account/mcp/serverRows';
import { readConnectedAccountCatalogRowInTx } from '@/app/account/connectedAccounts/configurationRows';
import { readConfiguredAgentCatalogRowInTx } from '@/app/account/agents/configuredAgentRows';
import { openAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';

/** Authoritative rows permit retained bytes or cleanup, never legacy root reseeding. */
function isAccountSettingsSourceRetainedOrRemoved(
    current: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>, key: string,
): boolean {
    return !Object.hasOwn(next, key)
        || (Object.hasOwn(current, key) && pluginJsonValuesEqual(current[key], next[key]));
}

export type AccountSettingsWriteInTxResult =
    | Readonly<{ status: "success"; version: number }>
    | Readonly<{ status: 'profile_transfer_mismatch'; currentRevision: number | 'absent' }>
    | Readonly<{
        status: "version_mismatch";
        currentVersion: number;
        currentSettings: string | null;
        currentContent: AccountSettingsStoredContentEnvelope | null;
    }>
    | Readonly<{
        status:
            | "account_not_found"
            | "storage_unavailable"
            | "plain_requires_v2"
            | "invalid_content";
    }>;

export type AccountSettingsWriteInTxInput = Readonly<{
    tx: Tx;
    accountId: string;
    expectedVersion: number;
    expectedProfileTransferRevision?: number | 'absent';
    next:
        | Readonly<{ kind: "v1"; settings: string | null }>
        | Readonly<{
            kind: "v2";
            content: AccountSettingsStoredContentEnvelope | null;
            remoteAlertPolicy?: AccountRemoteAlertPolicyV1 | null;
        }>;
}>;

/**
 * Applies one mode-fenced Account Settings CAS, history update, durable change,
 * and post-commit publication inside the caller's existing transaction.
 */
export async function writeAccountSettingsInTx(
    input: AccountSettingsWriteInTxInput,
): Promise<AccountSettingsWriteInTxResult> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(
        input.tx,
        input.accountId,
    );
    if (fence.status === "account_not_found") {
        return { status: "account_not_found" };
    }
    if (fence.status === "account_inconsistent") {
        return { status: "storage_unavailable" };
    }

    const currentAccount = fence.account;
    const profileTransferControl = await readProfileTransferControlInTx(input.tx, { accountId: input.accountId });
    if (profileTransferControl.status !== 'present' && profileTransferControl.status !== 'deleted'
        && profileTransferControl.status !== 'absent') return { status: 'storage_unavailable' };
    if (input.expectedProfileTransferRevision !== undefined) {
        const revision = profileTransferControl.status === 'absent' ? 'absent' : profileTransferControl.revision;
        if (revision !== input.expectedProfileTransferRevision) return { status: 'profile_transfer_mismatch', currentRevision: revision };
    }
    const mode = currentAccount.currentness.encryptionMode;
    if (input.next.kind === "v1" && mode === "plain") {
        return { status: "plain_requires_v2" };
    }
    if (
        input.next.kind === "v2"
        && input.next.content
        && input.next.content.t !== (mode === "plain" ? "plain" : "encrypted")
    ) {
        return { status: "invalid_content" };
    }

    const currentContent: AccountSettingsStoredContentEnvelope | null =
        mode === "plain"
            ? openPlainAccountSettingsDbValue({
                accountId: input.accountId,
                dbValue: currentAccount.settings,
            })
            : currentAccount.settings
                ? { t: "encrypted", c: currentAccount.settings }
                : null;
    if (currentAccount.settingsVersion !== input.expectedVersion) {
        return {
            status: "version_mismatch",
            currentVersion: currentAccount.settingsVersion,
            currentSettings: currentAccount.settings,
            currentContent,
        };
    }

    if (mode === 'plain' && input.next.kind === 'v2') {
        const currentSettings = currentContent?.t === 'plain' ? currentContent.v : {};
        const nextSettings = input.next.content?.t === 'plain' ? input.next.content.v : {};
        if (profileTransferControl.status === 'present' && profileTransferControl.envelope.t === 'plain'
            && profileTransferControl.envelope.v.phase === 'active'
            && (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'profiles')
                || !isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'secretBindingsByProfileId'))) {
            return { status: 'invalid_content' };
        }
        const acpSourceChanged = Object.hasOwn(currentSettings, 'acpCatalogSettingsV1') !== Object.hasOwn(nextSettings, 'acpCatalogSettingsV1')
            || (Object.hasOwn(currentSettings, 'acpCatalogSettingsV1')
                && !pluginJsonValuesEqual(currentSettings.acpCatalogSettingsV1, nextSettings.acpCatalogSettingsV1));
        if (acpSourceChanged) {
            const catalog = await readConfiguredAgentCatalogRowInTx(input.tx, { accountId: input.accountId });
            if (catalog.status !== 'present' && catalog.status !== 'deleted' && catalog.status !== 'absent') return { status: 'storage_unavailable' };
            if (catalog.status === 'present' && catalog.content.t === 'plain'
                && openAcpCatalogContentV1({ mode: 'plain', material: null, content: catalog.content }).status !== 'opened') return { status: 'invalid_content' };
            if (catalog.status !== 'absent' && !isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'acpCatalogSettingsV1')) {
                return { status: 'invalid_content' };
            }
        }
        if (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'providerSettingsV1')) {
            const catalog = await readProviderConnectionsRowInTx(input.tx, { accountId: input.accountId });
            if (catalog.status === 'present' || catalog.status === 'deleted') return { status: 'invalid_content' };
            if (catalog.status !== 'absent') return { status: 'storage_unavailable' };
        }
        if (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'mcpServersSettingsV1')) {
            const catalog = await readMcpServerCatalogRowInTx(input.tx, { accountId: input.accountId });
            if (catalog.status === 'present' || catalog.status === 'deleted') return { status: 'invalid_content' };
            if (catalog.status !== 'absent') return { status: 'storage_unavailable' };
        }
        if (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'connectedAccountServiceConfigurationsV1')) {
            const catalog = await readConnectedAccountCatalogRowInTx(input.tx, { accountId: input.accountId, key: 'configurations' });
            if (catalog.status === 'present' || catalog.status === 'deleted') return { status: 'invalid_content' };
            if (catalog.status !== 'absent') return { status: 'storage_unavailable' };
        }
        if (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'connectedAccountPurposeBindingsV1')) {
            const catalog = await readConnectedAccountCatalogRowInTx(input.tx, { accountId: input.accountId, key: 'purposes' });
            if (catalog.status === 'present' || catalog.status === 'deleted') return { status: 'invalid_content' };
            if (catalog.status !== 'absent') return { status: 'storage_unavailable' };
        }
    }

    const nextSettingsDbValue =
        input.next.kind === "v1"
            ? input.next.settings
            : mode === "plain"
                ? storePlainAccountSettingsDbValue({
                    accountId: input.accountId,
                    content: input.next.content,
                })
                : input.next.content?.t === "encrypted"
                    ? input.next.content.c
                    : null;
    const nextVersion = input.expectedVersion + 1;
    const remoteAlertPolicyWrite =
        input.next.kind === "v2"
        && input.next.remoteAlertPolicy !== undefined
            ? {
                remoteAlertPolicy:
                    input.next.remoteAlertPolicy === null
                        ? getActivePrismaRuntime().DbNull
                        : {
                            settingsVersion: nextVersion,
                            policy: input.next.remoteAlertPolicy,
                        } as Prisma.InputJsonValue,
            }
            : {};
    const updated = await input.tx.account.updateMany({
        where: {
            id: input.accountId,
            settingsVersion: input.expectedVersion,
        },
        data: {
            settings: nextSettingsDbValue,
            settingsVersion: nextVersion,
            updatedAt: new Date(),
            ...remoteAlertPolicyWrite,
        },
    });
    if (updated.count === 0) {
        const account = await input.tx.account.findUnique({
            where: { id: input.accountId },
            select: {
                settings: true,
                settingsVersion: true,
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        const refreshedCurrentness = account
            ? deriveAccountEncryptionCurrentnessFromRow(account)
            : null;
        if (refreshedCurrentness?.status === "inconsistent") {
            return { status: "storage_unavailable" };
        }
        const refreshedMode =
            refreshedCurrentness?.currentness.encryptionMode ?? mode;
        const refreshedContent: AccountSettingsStoredContentEnvelope | null =
            refreshedMode === "plain"
                ? openPlainAccountSettingsDbValue({
                    accountId: input.accountId,
                    dbValue: account?.settings ?? null,
                })
                : account?.settings
                    ? { t: "encrypted", c: account.settings }
                    : null;
        return {
            status: "version_mismatch",
            currentVersion: account?.settingsVersion ?? 0,
            currentSettings:
                input.next.kind === "v1"
                    ? account?.settings || null
                    : account?.settings ?? null,
            currentContent: refreshedContent,
        };
    }

    await recordAccountSettingsSnapshotsForWrite({
        tx: input.tx,
        previous: {
            accountId: input.accountId,
            version: input.expectedVersion,
            settingsDbValue: currentAccount.settings,
            encryptionMode: mode,
        },
        next: {
            accountId: input.accountId,
            version: nextVersion,
            settingsDbValue: nextSettingsDbValue,
            encryptionMode: mode,
        },
    });

    const cursor = await markAccountChanged(input.tx, {
        accountId: input.accountId,
        kind: "account",
        entityId: "self",
        hint: { settingsVersion: nextVersion },
    });

    afterTx(input.tx, () => {
        const settingsUpdate = input.next.kind === "v1"
            ? { settings: { value: input.next.settings, version: nextVersion } }
            : { settingsV2: { content: input.next.content, version: nextVersion } };
        eventRouter.emitUpdate({
            userId: input.accountId,
            payload: buildUpdateAccountUpdate(
                input.accountId,
                settingsUpdate,
                cursor,
                randomKeyNaked(12),
            ),
            recipientFilter: { type: "user-scoped-only" },
        });
        eventRouter.emitUpdate({
            userId: input.accountId,
            payload: buildAccountSettingsChangedUpdate(
                nextVersion,
                cursor,
                randomKeyNaked(12),
            ),
            recipientFilter: { type: "user-machine-scoped-only" },
        });
    });

    return { status: "success", version: nextVersion };
}
