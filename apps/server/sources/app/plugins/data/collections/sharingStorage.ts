import * as privacyKit from 'privacy-kit';
import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { resourceGrantRelationsSelect, resolveResourceGrantAudienceInTx, resolveResourceGrantAudienceFromFacts,
    projectResourceRecipientEnvelope, type ResourceGrantAccessFacts, type ResourceGrantStorageAdapter,
    type ResourceRecipientEnvelopeStorageAdapter } from '@/app/teams/resourceGrantAccess';
import type { ResourceRecipientKeyEnvelopeInputV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { buildPluginDomainAccountChangeEntityId } from '@happier-dev/protocol/changes/pluginDomain';

export function collectionAccessFactsSelect(actorAccountId?: string) {
    return { accountId: true, account: { select: { encryptionMode: true } }, ...resourceGrantRelationsSelect(actorAccountId) } as const;
}
async function readFacts(tx: Tx, rowDbId: string, actorAccountId?: string) {
    return tx.pluginCollectionRow.findFirst({ where: { id: rowDbId, deletedAt: null }, select: collectionAccessFactsSelect(actorAccountId) });
}
export function collectionGrantFacts(row: NonNullable<Awaited<ReturnType<typeof readFacts>>>): ResourceGrantAccessFacts {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    return { ownerAccountId: row.accountId, encryptionMode: mode.status === 'ready' ? mode.mode : null,
        accountGrants: row.accountGrants, teamGrants: row.teamGrants, groupGrants: row.groupGrants };
}
export const collectionGrantStorageAdapter: ResourceGrantStorageAdapter = {
    async readAccessFactsInTx(tx, rowDbId, actorAccountId) {
        const row = await readFacts(tx, rowDbId, actorAccountId);
        return row ? collectionGrantFacts(row) : null;
    },
};
export async function resolveCollectionAudienceInTx(tx: Tx, rowDbId: string) {
    return resolveResourceGrantAudienceInTx(tx, collectionGrantStorageAdapter, rowDbId);
}

/** Entry admission reads only the sharing facts of rows this writer can change. */
export async function readCollectionSharingAudienceInTx(tx: Tx, where: Prisma.PluginCollectionRowWhereInput) {
    const rows = await tx.pluginCollectionRow.findMany({ where: { AND: [where,
        { OR: [{ accountGrants: { some: {} } }, { teamGrants: { some: {} } }, { groupGrants: { some: {} } }] }] },
        select: collectionAccessFactsSelect() });
    return [...new Set(rows.flatMap(row => resolveResourceGrantAudienceFromFacts(collectionGrantFacts(row))))];
}

/** Grant, body and recipient changes publish the same content-free row identity. */
export async function publishCollectionSharingChangedInTx(tx: Tx, rowDbId: string, additionalAccountIds: readonly string[] = [],
    options?: Readonly<{ ownerAlreadyPublished: boolean }>) {
    const row = await tx.pluginCollectionRow.findUnique({ where: { id: rowDbId }, select: {
        ...collectionAccessFactsSelect(), pluginId: true, collectionId: true, rowId: true, contractDigest: true, revision: true,
    } });
    if (!row) return;
    const audience = resolveResourceGrantAudienceFromFacts(collectionGrantFacts(row));
    const hint = { pluginDomain: 'dataCollection' as const, pluginId: row.pluginId, collectionId: row.collectionId,
        contractDigest: row.contractDigest, revision: row.revision, rowIds: [row.rowId] };
    const recipients = [...new Set([...audience, ...additionalAccountIds])]
        .filter(accountId => !options?.ownerAlreadyPublished || accountId !== row.accountId);
    await markAccountsChanged(tx, { kind: 'pluginDomain', accountIds: recipients,
        entityId: buildPluginDomainAccountChangeEntityId(hint), hint });
}

/** One metadata read per changed batch; private, unshared rows produce no audience work. */
export async function publishCollectionSharingRowsChangedInTx(tx: Tx, input: Readonly<{
    accountId: string; pluginId: string; collectionId: string; rowIds?: readonly string[];
}>) {
    if (input.rowIds?.length === 0) return;
    const rows = await tx.pluginCollectionRow.findMany({ where: { accountId: input.accountId, pluginId: input.pluginId,
        collectionId: input.collectionId, ...(input.rowIds ? { rowId: { in: [...input.rowIds] } } : {}),
        OR: [{ accountGrants: { some: {} } }, { teamGrants: { some: {} } }, { groupGrants: { some: {} } }] }, select: { id: true } });
    for (const row of rows) await publishCollectionSharingChangedInTx(tx, row.id, [], { ownerAlreadyPublished: true });
}

/** A logical deletion ends the audience and its keys in the same transaction. */
export async function endCollectionSharingInTx(tx: Tx, rowDbIds: readonly string[]) {
    if (!rowDbIds.length) return;
    const rows = await tx.pluginCollectionRow.findMany({ where: { id: { in: [...rowDbIds] }, OR: [
        { accountGrants: { some: {} } }, { teamGrants: { some: {} } }, { groupGrants: { some: {} } },
        { keyEnvelopes: { some: {} } },
    ] }, select: { id: true } });
    if (!rows.length) return;
    for (const row of rows) await publishCollectionSharingChangedInTx(tx, row.id, [], { ownerAlreadyPublished: true });
    const where = { rowDbId: { in: rows.map(row => row.id) } };
    await tx.pluginCollectionAccountGrant.deleteMany({ where });
    await tx.pluginCollectionTeamGrant.deleteMany({ where });
    await tx.pluginCollectionGroupGrant.deleteMany({ where });
    await tx.pluginCollectionKeyEnvelope.deleteMany({ where });
}
export const collectionRecipientEnvelopeStorageAdapter: ResourceRecipientEnvelopeStorageAdapter<ResourceRecipientKeyEnvelopeInputV1> = {
    ...collectionGrantStorageAdapter,
    async writeRecipientEnvelopeInTx(tx, rowDbId, envelope) {
        const data = { encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey),
            recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint };
        const identity = { rowDbId, recipientAccountId: envelope.recipientAccountId };
        await tx.pluginCollectionKeyEnvelope.upsert({ where: { rowDbId_recipientAccountId: identity },
            create: { ...identity, ...data }, update: data });
    },
    async publishRecipientsChangedInTx(tx, rowDbId, accountIds) {
        if (accountIds.length) await publishCollectionSharingChangedInTx(tx, rowDbId);
    },
};

/** One bounded lookup supplies the owner's verified recipient wraps for an ordinary get/query page. */
export async function readCollectionRecipientKeysInTx(tx: Tx, input: Readonly<{
    ownerAccountId: string; actorAccountId: string; pluginId: string; collectionId: string; rowIds: readonly string[];
}>) {
    if (!input.rowIds.length) return new Map<string, string>();
    const envelopes = await tx.pluginCollectionKeyEnvelope.findMany({ where: { recipientAccountId: input.actorAccountId,
        row: { accountId: input.ownerAccountId, pluginId: input.pluginId, collectionId: input.collectionId, rowId: { in: [...input.rowIds] } } },
        include: { row: { select: { rowId: true } } } });
    if (!envelopes.length) return new Map<string, string>();
    const account = await tx.account.findUnique({ where: { id: input.actorAccountId }, select: RECIPIENT_READINESS_SELECT });
    return new Map(envelopes.flatMap(envelope => {
        const key = account && projectResourceRecipientEnvelope(account, envelope);
        return key ? [[envelope.row.rowId, privacyKit.encodeBase64(key)] as const] : [];
    }));
}
