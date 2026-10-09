import type { TransactionClient } from "@/storage/prisma";
import {
    AccountSettingsV2HistoryMutationRequestSchema,
    type AccountSettingsV2HistoryMutationRequest,
    type AccountSettingsV2HistoryMutationResponse,
} from "@happier-dev/protocol/account/settings/accountSettingsApiV2";
import { LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1, normalizeTransferredAccountSettingsHistoryV1 } from "@happier-dev/protocol/account/settings/accountSettingsHistoryRestoreV1";
import { listTransferredProfileIdsV1, PROFILE_TRANSFERRED_SOURCE_ROOTS_V1 } from "@happier-dev/protocol/profiles/read";
import { sameStrictJsonValue } from "@happier-dev/protocol/json/strictJsonValue";
import type { AccountSettingsStoredContentEnvelope } from "@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { readProfileTransferControlInTx } from "@/app/account/profiles/profileTransferControl";
import { validateSavedSecretHistoryTransferProofsInTx } from "@/app/account/savedSecrets/savedSecretResourceService";
import { readPromptLibraryRowInTx } from "@/app/account/prompts/promptLibraryRows";
import { PROMPT_LIBRARY_RETAINED_ROOTS_V1 } from "@happier-dev/protocol/prompts/library/promptLibraryCatalogV1";
import { PlainAccountSettingsStorageUnavailableError, storePlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";
import { readConnectedAccountCatalogRowInTx } from "@/app/account/connectedAccounts/configurationRows";
import { parseConnectedAccountCatalogMigrationContentV1 } from "@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1";
import { readProviderConnectionsRowInTx } from "@/app/account/providers/connectionRows";
import { parseProviderConnectionsMigrationContentV1 } from "@happier-dev/protocol/providers/connections/connectionRowsV1";
import { readMcpServerCatalogRowInTx } from "@/app/account/mcp/serverRows";
import { parseMcpServerCatalogMigrationContentV1 } from "@happier-dev/protocol/mcp/servers/serverRowsV1";
import { readConfiguredAgentCatalogRowInTx } from "@/app/account/agents/configuredAgentRows";
import { parseAcpCatalogMigrationContentV1 } from "@happier-dev/protocol/acp/catalog/catalogRowsV1";
import { readNotificationChannelCatalogInTx, notificationChannelCatalogRowDomain } from '@/app/account/notifications/channelRows';
import { readRemoteHostCatalogRowInTx } from '@/app/account/remoteHosts/remoteHostRows';
import { openRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { readConnectedPresentationRowInTx, readConnectedAcknowledgementsRowInTx } from '@/app/account/connectedAccounts/presentationRows';
import { CONNECTED_PRESENTATION_SOURCE_ROOTS_V1, CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1,
    openConnectedPresentationContentV1, openConnectedAcknowledgementsContentV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

import {
    ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES,
    resolveAccountSettingsHistoryLimitFromEnv,
} from "./accountSettingsHistoryConfig";
import {
    resolveAccountSettingsSnapshotContentKind,
    accountSettingsSnapshotToContent,
    type AccountSettingsSnapshotEncryptionMode,
} from "./accountSettingsHistoryContent";

export type AccountSettingsSnapshotInput = Readonly<{
    accountId: string;
    version: number;
    settingsDbValue: string | null;
    encryptionMode: AccountSettingsSnapshotEncryptionMode;
}>;

/** One exact retained version, serialized with Settings writers and Account mode transitions. */
export async function mutateAccountSettingsHistorySnapshotInTx(input: Readonly<{
    tx: TransactionClient;
    accountId: string;
    version: number;
    mutation: AccountSettingsV2HistoryMutationRequest;
}>): Promise<AccountSettingsV2HistoryMutationResponse> {
    const parsed = AccountSettingsV2HistoryMutationRequestSchema.safeParse(input.mutation);
    if (!parsed.success) return { status: "invalid_content" };
    const mutation = parsed.data;
    const fence = await acquireAccountEncryptionTransitionFenceInTx(input.tx, input.accountId);
    if (fence.status !== "ready") return { status: "storage_unavailable" };
    const expected = mutation.expectedEncryptionCurrentness;
    if (fence.account.settingsVersion !== mutation.expectedSettingsVersion
        || fence.account.currentness.encryptionMode !== expected.mode
        || fence.account.signingKeyFingerprint !== expected.signingKeyFingerprint
        || fence.account.contentKeyFingerprint !== expected.contentKeyFingerprint) return { status: "conflict" };
    const transfer = await readProfileTransferControlInTx(input.tx, { accountId: input.accountId });
    if (transfer.status !== "present" && transfer.status !== "deleted" && transfer.status !== "absent") {
        return { status: "storage_unavailable" };
    }
    if ((transfer.status === "absent" ? "absent" : transfer.revision) !== mutation.expectedProfileTransferRevision) {
        return { status: "conflict" };
    }
    const snapshot = await input.tx.accountSettingsSnapshot.findUnique({
        where: { accountId_version: { accountId: input.accountId, version: input.version } },
    });
    if (!snapshot) return { status: "not_found" };
    const where = { accountId: input.accountId, version: input.version,
        encryptionMode: snapshot.encryptionMode, settingsDbValue: snapshot.settingsDbValue };
    if (mutation.operation.kind === "purge") {
        const deleted = await input.tx.accountSettingsSnapshot.deleteMany({ where });
        return { status: deleted.count === 1 ? "applied" : "conflict" };
    }
    const operation = mutation.operation;
    // Profile transfer and prompt rows are distinct authorities. Shared stack
    // history is contracted by activated surface keys, never a whole-root claim.
    const profileRoots = new Set<string>(PROFILE_TRANSFERRED_SOURCE_ROOTS_V1);
    const promptKeys = operation.transferredPromptLibraryKeys ?? [];
    if (new Set(promptKeys).size !== promptKeys.length) return { status: "invalid_content" };
    const promptRoots = new Set<string>(promptKeys.filter(key => key !== "coding" && key !== "voice")
        .map(key => PROMPT_LIBRARY_RETAINED_ROOTS_V1[key]));
    const roleTransfers = operation.legacyRoleArtifactTransfers;
    const guidanceRoots = new Set<string>(roleTransfers === undefined ? [] : LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1);
    const claimedGuidanceRoots = operation.removedRoots.filter(root => guidanceRoots.has(root));
    const claimedProfileRoots = operation.removedRoots.filter(root => profileRoots.has(root));
    const claimsProfiles = claimedProfileRoots.length > 0;
    const privateRevisions = operation.transferredPrivateCatalogRevisions ?? {};
    const privateRoots = new Set<string>();
    if (Object.keys(privateRevisions).some(key => key !== "connectedConfigurations" && key !== "connectedPurposes" && key !== "notificationChannels" && key !== "remoteHosts"
        && key !== 'connectedPresentation' && key !== 'connectedAcknowledgements'
        && key !== "providerConnections" && key !== "mcp" && key !== "acp")) {
        return { status: "invalid_content" };
    }
    type PrivateHistoryRow = Readonly<{ status: string; revision?: number;
        content?: Readonly<{ t: "plain"; v: unknown }> | Readonly<{ t: "encrypted"; c: string }> }>;
    const admitPrivateRow = (root: string, expectedRevision: number, row: PrivateHistoryRow,
        admitsContent: (content: unknown) => boolean): AccountSettingsV2HistoryMutationResponse | null => {
        if (!operation.removedRoots.includes(root) || row.status === "absent" || row.status === "invalid-stored-content") {
            return { status: "invalid_content" };
        }
        if (row.status !== "present" && row.status !== "deleted") return { status: "storage_unavailable" };
        if (row.revision !== expectedRevision) return { status: "conflict" };
        if (row.status === "present" && (!row.content || !admitsContent(row.content))) {
            return { status: "invalid_content" };
        }
        privateRoots.add(root);
        return null;
    };
    if (privateRevisions.providerConnections !== undefined) {
        const refusal = admitPrivateRow("providerSettingsV1", privateRevisions.providerConnections,
            await readProviderConnectionsRowInTx(input.tx, { accountId: input.accountId }), content =>
                parseProviderConnectionsMigrationContentV1(content) !== null);
        if (refusal) return refusal;
    }
    if (privateRevisions.mcp !== undefined) {
        const refusal = admitPrivateRow("mcpServersSettingsV1", privateRevisions.mcp,
            await readMcpServerCatalogRowInTx(input.tx, { accountId: input.accountId }), content =>
                parseMcpServerCatalogMigrationContentV1(content) !== null);
        if (refusal) return refusal;
    }
    if (privateRevisions.acp !== undefined) {
        const refusal = admitPrivateRow("acpCatalogSettingsV1", privateRevisions.acp,
            await readConfiguredAgentCatalogRowInTx(input.tx, { accountId: input.accountId }), content =>
                parseAcpCatalogMigrationContentV1(content) !== null);
        if (refusal) return refusal;
    }
    for (const key of ["configurations", "purposes"] as const) {
        const expectedRevision = key === "configurations" ? privateRevisions.connectedConfigurations : privateRevisions.connectedPurposes;
        if (expectedRevision === undefined) continue;
        const root = key === "configurations" ? "connectedAccountServiceConfigurationsV1" : "connectedAccountPurposeBindingsV1";
        const row = await readConnectedAccountCatalogRowInTx(input.tx, { accountId: input.accountId, key });
        const refusal = admitPrivateRow(root, expectedRevision, row, content =>
            parseConnectedAccountCatalogMigrationContentV1(content, key) !== null);
        if (refusal) return refusal;
    }
    if (privateRevisions.remoteHosts !== undefined) {
        if (!operation.removedRoots.includes('remoteHostsV1')) return { status: 'invalid_content' };
        const row = await readRemoteHostCatalogRowInTx(input.tx, { accountId: input.accountId });
        if (row.status === 'absent' || row.status === 'invalid-stored-content') return { status: 'invalid_content' };
        if (row.status !== 'present' && row.status !== 'deleted') return { status: 'storage_unavailable' };
        if (row.revision !== privateRevisions.remoteHosts) return { status: 'conflict' };
        if (row.status === 'present' && row.content.t === 'plain' && openRemoteHostCatalogContentV1({
            content: row.content, mode: 'plain', material: null,
        }).status !== 'ready') return { status: 'invalid_content' };
        privateRoots.add('remoteHostsV1');
    }
    if (privateRevisions.notificationChannels !== undefined) {
        if (!operation.removedRoots.includes('notificationChannelsV1')) return { status: 'invalid_content' };
        const row = await readNotificationChannelCatalogInTx(input.tx, { accountId: input.accountId });
        if (row.status === 'absent' || row.status === 'invalid-stored-content') return { status: 'invalid_content' };
        if (row.status !== 'present' && row.status !== 'deleted') return { status: 'storage_unavailable' };
        if (row.revision !== privateRevisions.notificationChannels) return { status: 'conflict' };
        if (row.status === 'present' && notificationChannelCatalogRowDomain.parseMigrationStoredEnvelope(row.content) === null) {
            return { status: 'invalid_content' };
        }
        privateRoots.add('notificationChannelsV1');
    }
    if (privateRevisions.connectedPresentation !== undefined) {
        if (CONNECTED_PRESENTATION_SOURCE_ROOTS_V1.some(root => !operation.removedRoots.includes(root))) return { status: 'invalid_content' };
        const row = await readConnectedPresentationRowInTx(input.tx, { accountId: input.accountId });
        if (row.status === 'absent' || row.status === 'invalid-stored-content') return { status: 'invalid_content' };
        if (row.status !== 'present' && row.status !== 'deleted') return { status: 'storage_unavailable' };
        if (row.revision !== privateRevisions.connectedPresentation) return { status: 'conflict' };
        if (row.status === 'present' && row.content.t === 'plain' && openConnectedPresentationContentV1({
            content: row.content, mode: 'plain', material: null,
        }).status !== 'opened') return { status: 'invalid_content' };
        CONNECTED_PRESENTATION_SOURCE_ROOTS_V1.forEach(root => privateRoots.add(root));
    }
    if (privateRevisions.connectedAcknowledgements !== undefined) {
        if (CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1.some(root => !operation.removedRoots.includes(root))) return { status: 'invalid_content' };
        const row = await readConnectedAcknowledgementsRowInTx(input.tx, { accountId: input.accountId });
        if (row.status === 'absent' || row.status === 'invalid-stored-content') return { status: 'invalid_content' };
        if (row.status !== 'present' && row.status !== 'deleted') return { status: 'storage_unavailable' };
        if (row.revision !== privateRevisions.connectedAcknowledgements) return { status: 'conflict' };
        if (row.status === 'present' && row.content.t === 'plain' && openConnectedAcknowledgementsContentV1({
            content: row.content, mode: 'plain', material: null,
        }).status !== 'opened') return { status: 'invalid_content' };
        CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1.forEach(root => privateRoots.add(root));
    }
    if (operation.removedRoots.some(root => !profileRoots.has(root) && !promptRoots.has(root) && !guidanceRoots.has(root) && !privateRoots.has(root))
        || (claimsProfiles && (claimedProfileRoots.length !== profileRoots.size
            || new Set(claimedProfileRoots).size !== profileRoots.size))
        || (roleTransfers !== undefined && (claimedGuidanceRoots.length !== guidanceRoots.size
            || new Set(claimedGuidanceRoots).size !== guidanceRoots.size))
        || (!claimsProfiles && operation.transferredProfileIds !== undefined)) return { status: "invalid_content" };
    const retainedRoleIds = new Set<string>();
    for (const receipt of roleTransfers ?? []) {
        if (retainedRoleIds.has(receipt.artifactId)) return { status: "invalid_content" };
        retainedRoleIds.add(receipt.artifactId);
        const artifact = await input.tx.artifact.findUnique({ where: { id: receipt.artifactId },
            select: { accountId: true, headerVersion: true, bodyVersion: true, deletedAt: true } });
        if (artifact && artifact.accountId !== input.accountId) return { status: "invalid_content" };
        if (!artifact || artifact.deletedAt !== null || artifact.headerVersion !== receipt.expectedRevision.headerVersion
            || artifact.bodyVersion !== receipt.expectedRevision.bodyVersion) return { status: "conflict" };
    }
    for (const key of promptKeys) {
        const row = await readPromptLibraryRowInTx(input.tx, { accountId: input.accountId, key });
        if (row.status === "absent") return { status: "invalid_content" };
        if (row.status !== "present" && row.status !== "deleted") return { status: "storage_unavailable" };
    }
    let transferredProfileIds: readonly string[] | undefined;
    if (claimsProfiles) {
        if (transfer.status !== "present" || operation.transferredProfileIds === undefined) return { status: "invalid_content" };
        if (transfer.envelope.t === "plain") {
            if (transfer.envelope.v.phase !== "active") return { status: "invalid_content" };
            const actualIds = listTransferredProfileIdsV1(transfer.envelope.v);
            if (operation.transferredProfileIds.length !== actualIds.length
                || new Set(operation.transferredProfileIds).size !== actualIds.length
                || operation.transferredProfileIds.some(id => !actualIds.includes(id))) return { status: "invalid_content" };
            transferredProfileIds = actualIds;
        } else {
            // E2EE authority is opened by the captured Account client. Its
            // content-free claim is bound above to the exact sealed revision.
            transferredProfileIds = operation.transferredProfileIds;
        }
    }
    let current: AccountSettingsStoredContentEnvelope | null;
    try { current = accountSettingsSnapshotToContent(snapshot); }
    catch (error) {
        if (error instanceof PlainAccountSettingsStorageUnavailableError) return { status: "storage_unavailable" };
        throw error;
    }
    if (!sameStrictJsonValue(current, mutation.expectedContent)) return { status: "conflict" };
    const secretProof = await validateSavedSecretHistoryTransferProofsInTx(input.tx, {
        accountId: input.accountId, transfers: operation.savedSecretTransfers ?? [], recordedContent: current,
    });
    if (secretProof.status !== "ready") return { status: secretProof.status === "conflict" ? "conflict" : "invalid_content" };
    const next = mutation.operation.content;
    if (current?.t !== next?.t) return { status: "invalid_content" };
    if (current?.t === "plain" && next?.t === "plain") {
        const normalized = normalizeTransferredAccountSettingsHistoryV1(current.v, {
            activeTransferredRoots: operation.removedRoots,
            ...(transferredProfileIds === undefined ? {} : { activeTransferredProfileIds: transferredProfileIds }),
            activePromptLibraryKeys: promptKeys,
            savedSecretTransfers: operation.savedSecretTransfers,
            ...(roleTransfers === undefined ? {} : { legacyRoleArtifactTransfers: roleTransfers }),
        });
        if (normalized.status === "invalid" || !sameStrictJsonValue(normalized.raw, next.v)) return { status: "invalid_content" };
    }
    if (sameStrictJsonValue(current, next)) return { status: "unchanged" };
    // Opaque content cannot be compared semantically. A changed ciphertext still
    // needs an admitted destination domain; exact history CAS alone is not cleanup authority.
    if (current?.t === "encrypted" && !claimsProfiles && promptKeys.length === 0
        && (operation.savedSecretTransfers?.length ?? 0) === 0 && roleTransfers === undefined && privateRoots.size === 0) return { status: "invalid_content" };
    // Recorded mode, not the Account's current mode, owns retained snapshot storage.
    const settingsDbValue = next?.t === "plain" ? storePlainAccountSettingsDbValue({ accountId: input.accountId, content: next })
        : next?.t === "encrypted" ? next.c : null;
    const updated = await input.tx.accountSettingsSnapshot.updateMany({ where, data: {
        settingsDbValue, contentKind: resolveAccountSettingsSnapshotContentKind({ encryptionMode: snapshot.encryptionMode, settingsDbValue }),
    } });
    return { status: updated.count === 1 ? "applied" : "conflict" };
}

export async function recordAccountSettingsSnapshotsForWrite(params: Readonly<{
    tx: TransactionClient;
    previous: AccountSettingsSnapshotInput;
    next: AccountSettingsSnapshotInput;
    env?: NodeJS.ProcessEnv;
}>): Promise<void> {
    const limit = resolveAccountSettingsHistoryLimitFromEnv(params.env ?? process.env);
    if (limit === 0) {
        await params.tx.accountSettingsSnapshot.deleteMany({
            where: { accountId: params.next.accountId },
        });
        return;
    }

    await ensureAccountSettingsSnapshot(params.tx, params.previous);
    await ensureAccountSettingsSnapshot(params.tx, params.next);
    await pruneAccountSettingsSnapshots(params.tx, {
        accountId: params.next.accountId,
        limit,
    });
}

async function ensureAccountSettingsSnapshot(
    tx: TransactionClient,
    snapshot: AccountSettingsSnapshotInput,
): Promise<void> {
    await tx.accountSettingsSnapshot.upsert({
        where: {
            accountId_version: {
                accountId: snapshot.accountId,
                version: snapshot.version,
            },
        },
        create: {
            accountId: snapshot.accountId,
            version: snapshot.version,
            settingsDbValue: snapshot.settingsDbValue,
            encryptionMode: snapshot.encryptionMode,
            contentKind: resolveAccountSettingsSnapshotContentKind(snapshot),
        },
        update: {},
    });
}

async function pruneAccountSettingsSnapshots(
    tx: TransactionClient,
    params: Readonly<{ accountId: string; limit: number }>,
): Promise<void> {
    const snapshots = await tx.accountSettingsSnapshot.findMany({
        where: { accountId: params.accountId },
        orderBy: [
            { version: "desc" },
            { createdAt: "desc" },
        ],
        select: {
            id: true,
            settingsDbValue: true,
        },
    });
    const stale: string[] = [];
    let retainedCount = 0;
    let retainedBytes = 0;
    let pruningOlderSnapshots = false;
    for (const snapshot of snapshots) {
        const snapshotBytes = Buffer.byteLength(snapshot.settingsDbValue ?? "", "utf8");
        if (
            // Snapshots are newest first: once one cannot stay, retaining an older
            // row would create a hole instead of one contiguous newest suffix.
            pruningOlderSnapshots
            || retainedCount >= params.limit
            || retainedBytes + snapshotBytes > ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES
        ) {
            stale.push(snapshot.id);
            pruningOlderSnapshots = true;
            continue;
        }
        retainedCount += 1;
        retainedBytes += snapshotBytes;
    }
    if (stale.length === 0) return;

    await tx.accountSettingsSnapshot.deleteMany({
        where: {
            id: { in: stale },
        },
    });
}
