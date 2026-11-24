import * as privacyKit from 'privacy-kit';
import type { Prisma } from '@prisma/client';
import type { PluginCollectionSharingAddressV1, PluginCollectionSharingErrorV1, PluginCollectionSharingGetRequestV1,
    PluginCollectionSharingResourceV1, PluginCollectionSharingPutRequestV1, PluginCollectionSharingListRequestV1,
    PluginCollectionSharingListResponseV1, PluginCollectionSharingIdentityV1 } from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import type { PluginCollectionContentEnvelopeV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { assertPluginCollectionContentEnvelopeForModeV1, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import type { Tx } from '@/storage/inTx';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { mergeResourceGrantArmPages, resolveResourceGrantAccessFromFacts, resourceGrantPageAccessArms } from '@/app/teams/resourceGrantAccess';
import { resolveGrantableTeamForActorInTx } from '@/app/teams/queries';
import { collectionAccessFactsSelect, collectionGrantFacts } from './sharingStorage';
import { projectResourceRecipientEnvelope } from '@/app/teams/resourceGrantAccess';
import { RECIPIENT_READINESS_SELECT, type RecipientReadinessRow } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { materializeDirectCollectionRow, readSharedCollectionIndexPageInTx, resolveCurrentContract } from './uiQuery';
import { mutatePluginCollectionInTx } from './mutation';
import { readPluginsFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { diagnosePluginCollectionReadRefusal } from './readRefusal';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resourceTeamShareScopeV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';

export class CollectionSharingError extends Error {
    constructor(readonly code: PluginCollectionSharingErrorV1) { super(code); this.name = 'CollectionSharingError'; }
}
export type CollectionActorInput = PluginCollectionSharingAddressV1 & Readonly<{ actorAccountId: string }>;
export function collectionIdentityWhere(input: PluginCollectionSharingAddressV1) {
    return { accountId: input.ownerAccountId, pluginId: input.pluginId, collectionId: input.collectionId, rowId: input.rowId, deletedAt: null };
}
export function collectionSharingReadSelect(actorAccountId: string, includeBody = true) {
    return { ...collectionAccessFactsSelect(actorAccountId), id: true, rowId: true, pluginId: true, collectionId: true,
        schemaVersion: true, contractDigest: true, revision: includeBody, contentEnvelope: includeBody,
        projections: includeBody ? { select: { fieldId: true, typedEncodedValue: true, rowRevision: true } } : false,
        keyEnvelopes: includeBody ? { where: { recipientAccountId: actorAccountId }, select: {
            recipientAccountId: true, encryptedDataKey: true, recipientContentPublicKeyFingerprint: true,
        } } : false } as const;
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

function assertCurrentCollectionSharingRow(
    row: Pick<CollectionSharingContext['row'], 'contractDigest' | 'schemaVersion'>,
    request: PluginCollectionSharingGetRequestV1,
    current: Awaited<ReturnType<typeof resolveCurrentContract>>,
) {
    if (row.contractDigest !== current.storageContract.contractDigest || row.schemaVersion !== current.storageContract.schemaVersion) {
        throw diagnosePluginCollectionReadRefusal(new CollectionSharingError('collection_update_required'),
            'shared_row_writer_mismatch', request, current.storageContract);
    }
}

/** A grant is admitted before contract, body or revision disclosure. */
export async function readSharedCollectionResourceInTx(tx: Tx, input: CollectionActorInput & Readonly<{ request: PluginCollectionSharingGetRequestV1 }>,
    context?: Pick<CollectionSharingContext, 'row' | 'access'>, current?: Awaited<ReturnType<typeof resolveCurrentContract>>, caller?: RecipientReadinessRow | null): Promise<PluginCollectionSharingResourceV1> {
    const admitted = context ?? await resolveCollectionSharingContextInTx(tx, input);
    const { row, access } = admitted;
    const resolved = current ?? await resolveCurrentContract({ accountId: input.ownerAccountId, request: input.request }, tx);
    assertCurrentCollectionSharingRow(row, input.request, resolved);
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

/** Counts and pages share the candidate access arms; scope is independent of read admission.
 * A selected Team is one arm bounded by its exact rows; otherwise each received grant arm
 * is its own index-servable query and callers merge them. */
async function sharedCollectionCandidatesInTx(tx: Tx, actorAccountId: string, sharedWithTeamId?: string): Promise<readonly Prisma.PluginCollectionRowWhereInput[]> {
    if (sharedWithTeamId && !await resolveGrantableTeamForActorInTx(tx, { actorAccountId, teamId: sharedWithTeamId })) {
        return [];
    }
    const access = resourceGrantPageAccessArms(actorAccountId, (arm, grantWhere): Prisma.PluginCollectionRowWhereInput =>
        ({ grants: { some: { principalKind: arm, ...grantWhere } } }));
    if (!sharedWithTeamId) return access.received.map(arm => ({ deletedAt: null, ...arm }));
    return [{
        deletedAt: null,
        grants: { some: { OR: [
            { principalKind: 'team', teamId: sharedWithTeamId },
            { principalKind: 'group', teamGroup: { teamId: sharedWithTeamId } },
        ] } },
        OR: [access.owned, ...access.received],
    }];
}

/** Existing Collection rows/grants own discovery; no declaration or inventory registry is read. */
export async function countTeamSharedCollectionsInTx(tx: Tx, input: Readonly<{ actorAccountId: string; sharedWithTeamId: string }>): Promise<Readonly<{
    ok: true; collections: readonly Readonly<{ collection: Pick<PluginCollectionSharingAddressV1, 'pluginId' | 'collectionId'>; count: number }>[];
}>> {
    // A selected Team is a single bounded arm.
    const [where] = await sharedCollectionCandidatesInTx(tx, input.actorAccountId, input.sharedWithTeamId);
    const rows = where ? await tx.pluginCollectionRow.groupBy({ by: ['pluginId', 'collectionId'], where, _count: { _all: true } }) : [];
    return { ok: true as const, collections: rows.map(row => ({ collection: { pluginId: row.pluginId, collectionId: row.collectionId }, count: row._count._all })) };
}

/** Cursor pages candidates at the shared grant owner; no ungranted body reaches a caller. */
export function listSharedCollectionResources(actorAccountId: string, request: PluginCollectionSharingListRequestV1): Promise<PluginCollectionSharingListResponseV1> {
    return inReadSnapshot(async tx => {
        if (request.cursor && !/^[A-Za-z0-9_-]+$/.test(request.cursor)) throw new CollectionSharingError('collection_cursor_invalid');
        if (request.query && (request.cursor !== undefined || request.limit !== undefined)) {
            throw new CollectionSharingError('collection_query_invalid');
        }
        const limit = request.query?.limit ?? request.limit ?? PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1;
        const includeBody = request.projection !== 'identity';
        const candidates = await sharedCollectionCandidatesInTx(tx, actorAccountId, request.sharedWithTeamId);
        const pageWhere = { pluginId: request.pluginId, collectionId: request.collectionId, ...(request.cursor ? { id: { gt: request.cursor } } : {}) };
        const indexPage = request.query && candidates.length > 0
            ? await readSharedCollectionIndexPageInTx({ tx, actorAccountId, request, query: request.query }) : null;
        // Several arms merge their page-sized keyset positions before one content read.
        const positions = indexPage ? indexPage.positions : candidates.length <= 1 ? null
            : mergeResourceGrantArmPages(await Promise.all(candidates.map(arm =>
                tx.pluginCollectionRow.findMany({ where: { ...pageWhere, AND: [arm] }, select: { id: true }, orderBy: { id: 'asc' }, take: limit + 1 }))),
            (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0, limit + 1);
        const scope = positions === null ? candidates[0] : positions.length ? { id: { in: positions.map(row => row.id) } } : undefined;
        const rows = scope ? await tx.pluginCollectionRow.findMany({ where: { ...pageWhere, AND: [scope] },
            select: collectionSharingReadSelect(actorAccountId, includeBody), orderBy: { id: 'asc' }, take: limit + 1 }) : [];
        const rowsById = indexPage && new Map(rows.map(row => [row.id, row]));
        const page = indexPage && rowsById ? indexPage.positions.map(position => {
            const row = rowsById.get(position.id);
            if (!row || (includeBody && row.revision !== position.rowRevision)) {
                throw new CollectionSharingError('collection_index_not_ready');
            }
            return row;
        }) : rows.slice(0, limit);
        const caller = includeBody && page.some(row => row.account.encryptionMode === 'e2ee')
            ? await tx.account.findUnique({ where: { id: actorAccountId }, select: RECIPIENT_READINESS_SELECT }) : null;
        const currentByOwner = new Map<string, Awaited<ReturnType<typeof resolveCurrentContract>>>();
        const resources: PluginCollectionSharingResourceV1[] = [];
        const identities: PluginCollectionSharingIdentityV1[] = [];
        for (const row of page) {
            const access = resolveResourceGrantAccessFromFacts(collectionGrantFacts(row), actorAccountId);
            if (!access) continue;
            const address = { ownerAccountId: row.accountId, pluginId: row.pluginId, collectionId: row.collectionId, rowId: row.rowId };
            const readRequest = { ...address, readerContext: request.readerContext };
            let current = currentByOwner.get(row.accountId);
            if (!current) {
                current = await resolveCurrentContract({ accountId: row.accountId, request: readRequest }, tx);
                currentByOwner.set(row.accountId, current);
            }
            const sharedWithTeamScope = request.sharedWithTeamId === undefined ? undefined : resourceTeamShareScopeV1(access.level === 'owner'
                ? {
                    team: row.grants.some(grant => grant.principalKind === 'team' && grant.teamId === request.sharedWithTeamId),
                    group: row.grants.some(grant => grant.principalKind === 'group' && grant.teamGroup?.teamId === request.sharedWithTeamId),
                } : {
                    team: access.matchedGrants.some(grant => grant.kind === 'team' && grant.teamId === request.sharedWithTeamId),
                    group: row.grants.some(grant => grant.principalKind === 'group' && grant.teamGroup?.teamId === request.sharedWithTeamId
                        && access.matchedGrants.some(matched => matched.kind === 'group' && matched.teamGroupId === grant.teamGroupId)),
                });
            const scopeField = sharedWithTeamScope === undefined ? {} : { sharedWithTeamScope };
            if (!includeBody) {
                assertCurrentCollectionSharingRow(row, readRequest, current);
                identities.push({ ownerAccountId: row.accountId, rowId: row.rowId, ...scopeField });
            } else {
                const resource = await readSharedCollectionResourceInTx(tx, { actorAccountId, ...address,
                    request: readRequest }, { row, access }, current, caller);
                resources.push({ ...resource, ...scopeField });
            }
        }
        const nextCursor = indexPage ? indexPage.nextCursor : rows.length > limit ? page.at(-1)!.id : null;
        return { resources, ...(!includeBody ? { identities } : {}), nextCursor };
    });
}
