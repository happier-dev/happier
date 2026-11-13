import * as privacyKit from 'privacy-kit';
import type { PluginCollectionSharingAddressV1, PluginCollectionSharingErrorV1, PluginCollectionSharingGetRequestV1,
    PluginCollectionSharingResourceV1, PluginCollectionSharingPutRequestV1, PluginCollectionSharingListRequestV1,
    PluginCollectionSharingListResponseV1 } from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import type { PluginCollectionContentEnvelopeV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { assertPluginCollectionContentEnvelopeForModeV1, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import type { Tx } from '@/storage/inTx';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { resolveResourceGrantAccessFromFacts, resolveReceivedResourceGrantWhere } from '@/app/teams/resourceGrantAccess';
import { collectionAccessFactsSelect, collectionGrantFacts } from './sharingStorage';
import { projectResourceRecipientEnvelope } from '@/app/teams/resourceGrantAccess';
import { RECIPIENT_READINESS_SELECT, type RecipientReadinessRow } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { materializeDirectCollectionRow, resolveCurrentContract } from './uiQuery';
import { mutatePluginCollectionInTx } from './mutation';
import { readPluginsFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { diagnosePluginCollectionReadRefusal } from './readRefusal';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';

export class CollectionSharingError extends Error {
    constructor(readonly code: PluginCollectionSharingErrorV1) { super(code); this.name = 'CollectionSharingError'; }
}
export type CollectionActorInput = PluginCollectionSharingAddressV1 & Readonly<{ actorAccountId: string }>;
export function collectionIdentityWhere(input: PluginCollectionSharingAddressV1) {
    return { accountId: input.ownerAccountId, pluginId: input.pluginId, collectionId: input.collectionId, rowId: input.rowId, deletedAt: null };
}
export function collectionSharingReadSelect(actorAccountId: string) {
    return { ...collectionAccessFactsSelect(actorAccountId), id: true, rowId: true, pluginId: true, collectionId: true,
        schemaVersion: true, contractDigest: true, revision: true, contentEnvelope: true,
        projections: { select: { fieldId: true, typedEncodedValue: true, rowRevision: true } },
        keyEnvelopes: { where: { recipientAccountId: actorAccountId }, select: {
            recipientAccountId: true, encryptedDataKey: true, recipientContentPublicKeyFingerprint: true,
        } } } as const;
}
export async function resolveCollectionSharingContextInTx(tx: Tx, input: CollectionActorInput) {
    const row = await tx.pluginCollectionRow.findFirst({ where: collectionIdentityWhere(input), select: collectionSharingReadSelect(input.actorAccountId) });
    const access = row && resolveResourceGrantAccessFromFacts(collectionGrantFacts(row), input.actorAccountId);
    if (!row || !access) throw new CollectionSharingError('collection_unavailable');
    if (!access.encryptionMode) throw new CollectionSharingError('collection_content_mode_mismatch');
    let content: PluginCollectionContentEnvelopeV1;
    try { content = assertPluginCollectionContentEnvelopeForModeV1(row.contentEnvelope, access.encryptionMode); }
    catch { throw new CollectionSharingError('collection_content_mode_mismatch'); }
    return { row, access, content };
}
export type CollectionSharingContext = Awaited<ReturnType<typeof resolveCollectionSharingContextInTx>>;

/** A grant is admitted before contract, body or revision disclosure. */
export async function readSharedCollectionResourceInTx(tx: Tx, input: CollectionActorInput & Readonly<{ request: PluginCollectionSharingGetRequestV1 }>,
    context?: Pick<CollectionSharingContext, 'row' | 'access'>, current?: Awaited<ReturnType<typeof resolveCurrentContract>>, caller?: RecipientReadinessRow | null): Promise<PluginCollectionSharingResourceV1> {
    const admitted = context ?? await resolveCollectionSharingContextInTx(tx, input);
    const { row, access } = admitted;
    const resolved = current ?? await resolveCurrentContract({ accountId: input.ownerAccountId, request: input.request }, tx);
    if (row.contractDigest !== resolved.storageContract.contractDigest || row.schemaVersion !== resolved.storageContract.schemaVersion) {
        throw diagnosePluginCollectionReadRefusal(new CollectionSharingError('collection_update_required'),
            'shared_row_writer_mismatch', input.request, resolved.storageContract);
    }
    const materialized = materializeDirectCollectionRow({ current: resolved, row });
    let encryptedDataKey: string | null = null;
    if (materialized.content.t === 'encrypted') {
        if (materialized.content.k !== 'collection') {
            if (access.level !== 'owner') throw new CollectionSharingError('collection_content_unavailable');
        } else {
            const account = caller === undefined ? await tx.account.findUnique({ where: { id: input.actorAccountId }, select: RECIPIENT_READINESS_SELECT }) : caller;
            const envelope = row.keyEnvelopes[0];
            const key = account && envelope && projectResourceRecipientEnvelope(account, envelope);
            if (!key) throw new CollectionSharingError('collection_content_unavailable');
            encryptedDataKey = privacyKit.encodeBase64(key);
        }
    }
    return { ownerAccountId: input.ownerAccountId, pluginId: input.pluginId, collectionId: input.collectionId,
        rowId: row.rowId, access: access.level, encryptionMode: access.encryptionMode!, encryptedDataKey,
        row: materialized };
}

export function readSharedCollectionResource(actorAccountId: string, request: PluginCollectionSharingGetRequestV1) {
    return inReadSnapshot(tx => readSharedCollectionResourceInTx(tx, { actorAccountId, ...request, request }));
}

/** All grantee edits enter the existing Collection writer, preserving CAS, projection, relations and quota. */
export function putSharedCollectionResource(actorAccountId: string, request: PluginCollectionSharingPutRequestV1, authentication: SessionAccessAuthentication) {
    return inTx(async tx => {
        const input = { actorAccountId, ...request };
        const context = await resolveCollectionSharingContextInTx(tx, input);
        if (context.access.level === 'view') throw new CollectionSharingError('collection_unavailable');
        const admitted = await readSharedCollectionResourceInTx(tx, { ...input, request: { ...request, readerContext: request.writerContext } }, context);
        const result = await mutatePluginCollectionInTx({ tx, accountId: request.ownerAccountId, actorAccountId,
            request: { pluginId: request.pluginId, collectionId: request.collectionId,
                writerContext: { schemaVersion: request.writerContext.schemaVersion, contractDigest: request.writerContext.contractDigest },
                operations: [{ kind: 'put', rowId: request.rowId, expectedRevision: request.expectedRevision, content: request.content, projection: request.projection }] },
            deployment: readPluginsFeatureEnv(process.env).collectionLimits, authentication });
        if (result.status !== 'updated') throw new CollectionSharingError('collection_revision_conflict');
        return { ...admitted, row: { rowId: request.rowId, revision: result.results[0]!.revision,
            content: request.content, projection: request.projection } };
    });
}

/** Cursor pages candidates at the shared grant owner; no ungranted body reaches a caller. */
export function listSharedCollectionResources(actorAccountId: string, request: PluginCollectionSharingListRequestV1): Promise<PluginCollectionSharingListResponseV1> {
    return inReadSnapshot(async tx => {
        if (request.cursor && !/^[A-Za-z0-9_-]+$/.test(request.cursor)) throw new CollectionSharingError('collection_cursor_invalid');
        const limit = request.limit ?? PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1;
        const received = await resolveReceivedResourceGrantWhere(actorAccountId, async grants => (await Promise.all([
            tx.pluginCollectionGrant.findMany({ where: { principalKind: 'account', ...grants.account }, select: { rowDbId: true } }),
            tx.pluginCollectionGrant.findMany({ where: { principalKind: 'team', ...grants.team }, select: { rowDbId: true } }),
            tx.pluginCollectionGrant.findMany({ where: { principalKind: 'group', ...grants.group }, select: { rowDbId: true } }),
        ])).map(rows => rows.map(row => row.rowDbId)));
        const rows = await tx.pluginCollectionRow.findMany({ where: { pluginId: request.pluginId, collectionId: request.collectionId,
            deletedAt: null, accountId: { not: actorAccountId }, ...(request.cursor ? { id: { gt: request.cursor } } : {}),
            AND: [received] }, select: collectionSharingReadSelect(actorAccountId), orderBy: { id: 'asc' }, take: limit + 1 });
        const page = rows.slice(0, limit);
        const caller = page.some(row => row.account.encryptionMode === 'e2ee')
            ? await tx.account.findUnique({ where: { id: actorAccountId }, select: RECIPIENT_READINESS_SELECT }) : null;
        const currentByOwner = new Map<string, Awaited<ReturnType<typeof resolveCurrentContract>>>();
        const resources: PluginCollectionSharingResourceV1[] = [];
        for (const row of page) {
            const access = resolveResourceGrantAccessFromFacts(collectionGrantFacts(row), actorAccountId);
            if (!access) continue;
            const address = { ownerAccountId: row.accountId, pluginId: row.pluginId, collectionId: row.collectionId, rowId: row.rowId };
            let current = currentByOwner.get(row.accountId);
            if (!current) {
                current = await resolveCurrentContract({ accountId: row.accountId, request: { ...address, readerContext: request.readerContext } }, tx);
                currentByOwner.set(row.accountId, current);
            }
            resources.push(await readSharedCollectionResourceInTx(tx, { actorAccountId, ...address,
                request: { ...address, readerContext: request.readerContext } }, { row, access }, current, caller));
        }
        return { resources, nextCursor: rows.length > limit ? page.at(-1)!.id : null };
    });
}
