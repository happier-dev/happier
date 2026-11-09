import { resolveAccountRemoteAlertPolicyCurrentness, type AccountRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import type { Prisma } from "@prisma/client";

import { beforeAccountChangePublication, enqueueAccountChangePublication, markAccountChanged } from "@/app/changes/markAccountChanged";
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
import { reconcileMachineRecoveryNoticeRequestsInTx } from '@/app/activity/remoteAlerts/submitMachineRemoteAlerts';

/** Authoritative rows permit retained bytes or cleanup, never legacy root reseeding. */
function isAccountSettingsSourceRetainedOrRemoved(
    current: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>, key: string,
): boolean {
    return !Object.hasOwn(next, key)
        || (Object.hasOwn(current, key) && pluginJsonValuesEqual(current[key], next[key]));
}

export type AccountSettingsWriteInTxResult =
    | Readonly<{ status: "success"; version: number;
        remoteAlertPolicyStatus: ReturnType<typeof resolveAccountRemoteAlertPolicyCurrentness>['status'] }>
    | Readonly<{ status: 'profile_transfer_mismatch'; currentRevision: number | 'absent' }>
    | Readonly<{
        status: "version_mismatch";
        currentVersion: number;
        currentSettings: string | null;
        currentContent: AccountSettingsStoredContentEnvelope | null;
        remoteAlertPolicyStatus: ReturnType<typeof resolveAccountRemoteAlertPolicyCurrentness>['status'];
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

/** A final Settings CAS conflict must roll back every composed domain write. */
export class AccountSettingsPublicationConflict extends Error {
    constructor(readonly result: Exclude<AccountSettingsWriteInTxResult, { status: "success" }>) {
        super("Account Settings changed before terminal publication");
        this.name = "AccountSettingsPublicationConflict";
    }
}

function profileTransferAuthorityRejection(
    control: Awaited<ReturnType<typeof readProfileTransferControlInTx>>,
    expectedRevision: number | 'absent' | undefined,
): Readonly<{ status: 'storage_unavailable' }> | Readonly<{ status: 'profile_transfer_mismatch'; currentRevision: number | 'absent' }> | null {
    if (control.status !== 'present' && control.status !== 'deleted' && control.status !== 'absent') {
        return { status: 'storage_unavailable' };
    }
    const revision = control.status === 'absent' ? 'absent' : control.revision;
    return expectedRevision !== undefined && revision !== expectedRevision
        ? { status: 'profile_transfer_mismatch', currentRevision: revision } : null;
}

async function readAccountSettingsPublicationConflictInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; kind?: "v1" | "v2" }>,
): Promise<Extract<AccountSettingsWriteInTxResult, { status: "version_mismatch" }> | Readonly<{ status: "storage_unavailable" }>> {
    const account = await tx.account.findUnique({
        where: { id: input.accountId },
        select: {
            settings: true, settingsVersion: true, publicKey: true, encryptionMode: true,
            contentPublicKey: true, contentPublicKeySig: true, remoteAlertPolicy: true,
        },
    });
    const currentness = account ? deriveAccountEncryptionCurrentnessFromRow(account) : null;
    if (currentness?.status === "inconsistent") return { status: "storage_unavailable" };
    const currentContent: AccountSettingsStoredContentEnvelope | null = currentness?.currentness.encryptionMode === "plain"
        ? openPlainAccountSettingsDbValue({ accountId: input.accountId, dbValue: account?.settings ?? null })
        : account?.settings ? { t: "encrypted", c: account.settings } : null;
    return {
        status: "version_mismatch", currentVersion: account?.settingsVersion ?? 0,
        currentSettings: input.kind === "v1" ? account?.settings || null : account?.settings ?? null,
        currentContent,
        remoteAlertPolicyStatus: resolveAccountRemoteAlertPolicyCurrentness(account?.remoteAlertPolicy, account?.settingsVersion ?? 0).status,
    };
}

/** Source transfers recheck their captured Settings version after terminal Account locking. */
export function validateAccountSettingsVersionAtPublicationInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; expectedVersion: number }>,
): void {
    beforeAccountChangePublication(tx, [input.accountId], async (publicationTx) => {
        const current = await readAccountSettingsPublicationConflictInTx(publicationTx, input);
        if (current.status !== "version_mismatch" || current.currentVersion !== input.expectedVersion) {
            throw new AccountSettingsPublicationConflict(current);
        }
    });
}

/**
 * Stages one mode-fenced Account Settings CAS for terminal publication after
 * domain resource writes. History is recorded only after that CAS succeeds.
 * The caller's inTx must commit before exposing success; a final version
 * conflict rolls the whole composed transaction back.
 */
export async function writeAccountSettingsInTx(
    input: AccountSettingsWriteInTxInput,
): Promise<AccountSettingsWriteInTxResult> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(
        input.tx,
        input.accountId,
        "content",
    );
    if (fence.status === "account_not_found") {
        return { status: "account_not_found" };
    }
    if (fence.status === "account_inconsistent") {
        return { status: "storage_unavailable" };
    }

    const currentAccount = fence.account;
    const profileTransferControl = await readProfileTransferControlInTx(input.tx, { accountId: input.accountId });
    const transferRejection = profileTransferAuthorityRejection(profileTransferControl, input.expectedProfileTransferRevision);
    if (transferRejection) return transferRejection;
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
        return readAccountSettingsPublicationConflictInTx(input.tx, { accountId: input.accountId });
    }

    const validateSourceAuthority = async (
        tx: Tx,
        control: Awaited<ReturnType<typeof readProfileTransferControlInTx>>,
    ): Promise<Readonly<{ status: 'invalid_content' | 'storage_unavailable' }> | null> => {
        if (mode === 'plain' && input.next.kind === 'v2') {
            const currentSettings = currentContent?.t === 'plain' ? currentContent.v : {};
            const nextSettings = input.next.content?.t === 'plain' ? input.next.content.v : {};
            if (control.status === 'present' && control.envelope.t === 'plain'
                && control.envelope.v.phase === 'active'
                && (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'profiles')
                    || !isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'secretBindingsByProfileId'))) {
                return { status: 'invalid_content' };
            }
            const acpSourceChanged = Object.hasOwn(currentSettings, 'acpCatalogSettingsV1') !== Object.hasOwn(nextSettings, 'acpCatalogSettingsV1')
                || (Object.hasOwn(currentSettings, 'acpCatalogSettingsV1')
                    && !pluginJsonValuesEqual(currentSettings.acpCatalogSettingsV1, nextSettings.acpCatalogSettingsV1));
            if (acpSourceChanged) {
                const catalog = await readConfiguredAgentCatalogRowInTx(tx, { accountId: input.accountId });
                if (catalog.status !== 'present' && catalog.status !== 'deleted' && catalog.status !== 'absent') return { status: 'storage_unavailable' };
                if (catalog.status === 'present' && catalog.content.t === 'plain'
                    && openAcpCatalogContentV1({ mode: 'plain', material: null, content: catalog.content }).status !== 'opened') return { status: 'invalid_content' };
                if (catalog.status !== 'absent' && !isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'acpCatalogSettingsV1')) {
                    return { status: 'invalid_content' };
                }
            }
            if (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'providerSettingsV1')) {
                const catalog = await readProviderConnectionsRowInTx(tx, { accountId: input.accountId });
                if (catalog.status === 'present' || catalog.status === 'deleted') return { status: 'invalid_content' };
                if (catalog.status !== 'absent') return { status: 'storage_unavailable' };
            }
            if (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'mcpServersSettingsV1')) {
                const catalog = await readMcpServerCatalogRowInTx(tx, { accountId: input.accountId });
                if (catalog.status === 'present' || catalog.status === 'deleted') return { status: 'invalid_content' };
                if (catalog.status !== 'absent') return { status: 'storage_unavailable' };
            }
            if (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'connectedAccountServiceConfigurationsV1')) {
                const catalog = await readConnectedAccountCatalogRowInTx(tx, { accountId: input.accountId, key: 'configurations' });
                if (catalog.status === 'present' || catalog.status === 'deleted') return { status: 'invalid_content' };
                if (catalog.status !== 'absent') return { status: 'storage_unavailable' };
            }
            if (!isAccountSettingsSourceRetainedOrRemoved(currentSettings, nextSettings, 'connectedAccountPurposeBindingsV1')) {
                const catalog = await readConnectedAccountCatalogRowInTx(tx, { accountId: input.accountId, key: 'purposes' });
                if (catalog.status === 'present' || catalog.status === 'deleted') return { status: 'invalid_content' };
                if (catalog.status !== 'absent') return { status: 'storage_unavailable' };
            }
        }
        return null;
    };
    const sourceRejection = await validateSourceAuthority(input.tx, profileTransferControl);
    if (sourceRejection) return sourceRejection;

    beforeAccountChangePublication(input.tx, [input.accountId], async (tx) => {
        const currentControl = await readProfileTransferControlInTx(tx, { accountId: input.accountId });
        const rejection = profileTransferAuthorityRejection(currentControl, input.expectedProfileTransferRevision)
            ?? await validateSourceAuthority(tx, currentControl);
        if (rejection) throw new AccountSettingsPublicationConflict(rejection);
    });

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
    const previousRemoteAlertPolicy = await input.tx.account.findUnique({
        where: { id: input.accountId }, select: { remoteAlertPolicy: true },
    });
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
    const remoteAlertPolicyStatus = resolveAccountRemoteAlertPolicyCurrentness(
        input.next.kind === 'v2' && input.next.remoteAlertPolicy !== undefined
            ? input.next.remoteAlertPolicy === null ? null : remoteAlertPolicyWrite.remoteAlertPolicy
            : previousRemoteAlertPolicy?.remoteAlertPolicy,
        nextVersion,
    ).status;
    enqueueAccountChangePublication(input.tx, [input.accountId], async (tx) => {
        const updated = await tx.account.updateMany({
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
            throw new AccountSettingsPublicationConflict(await readAccountSettingsPublicationConflictInTx(tx,
                { accountId: input.accountId, kind: input.next.kind }));
        }
        // Only the winning Account CAS may record its candidate N+1 history.
        // Keep history and pruning in this same transaction/publication order.
        await recordAccountSettingsSnapshotsForWrite({
            tx,
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
    });

    if (input.next.kind === 'v2' && input.next.remoteAlertPolicy !== undefined) {
        await reconcileMachineRecoveryNoticeRequestsInTx({ tx: input.tx, accountId: input.accountId,
            previousPolicy: previousRemoteAlertPolicy?.remoteAlertPolicy, nextPolicy: input.next.remoteAlertPolicy });
    }

    // Keep self: predecessor CLI 285ee7c5 apiMachine's changes reader ignores a
    // dedicated Settings key after missed live delivery. Narrow this identity
    // only once every supported reader honors that key during catch-up.
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
                { ...settingsUpdate, remoteAlertPolicyStatus },
                cursor.resolveCursor(),
                randomKeyNaked(12),
            ),
            recipientFilter: { type: "user-scoped-only" },
        });
        eventRouter.emitUpdate({
            userId: input.accountId,
            payload: buildAccountSettingsChangedUpdate(
                nextVersion,
                cursor.resolveCursor(),
                randomKeyNaked(12),
                remoteAlertPolicyStatus,
            ),
            recipientFilter: { type: "user-machine-scoped-only" },
        });
    });

    return { status: "success", version: nextVersion, remoteAlertPolicyStatus };
}
