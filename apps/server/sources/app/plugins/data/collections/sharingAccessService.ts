import * as privacyKit from 'privacy-kit';
import { PluginCollectionProjectionV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { PluginCollectionSharingSetGrantRequestV1, PluginCollectionSharingRevokeGrantRequestV1,
    PluginCollectionSharingCensusRequestV1, PluginCollectionSharingCensusResponseV1, PluginCollectionSharingGrantsResponseV1,
    PluginCollectionSharingCommitKeysRequestV1, PluginCollectionSharingAddressV1 } from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import type { ResourceRecipientKeyEnvelopeInputV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { inTx, inReadSnapshot, type Tx } from '@/storage/inTx';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import { readPluginsFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { mayManageResourceGrants, projectResourceGrantRows, validateResourceGrantPrincipalInTx, readResourceGrantPrincipalAudienceInTx,
    projectResourceRecipientCensus, projectResourceRecipientCensusRow, projectResourceRecipientEnvelope,
    validateResourceRecipientEnvelopeCommit, validateResourceRecipientKeyEnvelopes, applyResourceRecipientKeyEnvelopesInTx } from '@/app/teams/resourceGrantAccess';
import { collectionRecipientEnvelopeStorageAdapter, resolveCollectionAudienceInTx, publishCollectionSharingChangedInTx } from './sharingStorage';
import { CollectionSharingError, collectionIdentityWhere, resolveCollectionSharingContextInTx, type CollectionSharingContext, type CollectionActorInput } from './sharingResourceService';
import { mutatePluginCollectionInTx } from './mutation';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';

async function readPrincipalGrant(tx: Tx, rowDbId: string, principal: PrincipalRefV1) {
    return principal.kind === 'account' ? tx.pluginCollectionGrant.findUnique({ where: { rowDbId_accountId: { rowDbId, accountId: principal.accountId } } })
        : principal.kind === 'team' ? tx.pluginCollectionGrant.findUnique({ where: { rowDbId_teamId: { rowDbId, teamId: principal.teamId } } })
            : tx.pluginCollectionGrant.findUnique({ where: { rowDbId_teamGroupId: { rowDbId, teamGroupId: principal.groupId } } });
}
async function lockMutation(tx: Tx, input: CollectionActorInput, principal?: PrincipalRefV1) {
    const row = await tx.pluginCollectionRow.findFirst({ where: collectionIdentityWhere(input), select: { id: true } });
    if (!row) throw new CollectionSharingError('collection_unavailable');
    const audience = await resolveCollectionAudienceInTx(tx, row.id);
    if (principal) audience.push(...await readResourceGrantPrincipalAudienceInTx(tx, { ownerAccountId: input.ownerAccountId, principal }));
    await acquireAccountChangePublicationLocksInTx(tx, [input.ownerAccountId, ...audience], { includeSingleAccount: true, intent: 'serializing' });
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.ownerAccountId, 'serializing');
    if (fence.status !== 'ready') throw new CollectionSharingError('collection_content_mode_mismatch');
    return resolveCollectionSharingContextInTx(tx, input);
}
function requireManage(context: CollectionSharingContext) {
    if (!mayManageResourceGrants(context.access)) throw new CollectionSharingError('collection_access_forbidden');
}
function address(input: PluginCollectionSharingAddressV1) {
    return { ownerAccountId: input.ownerAccountId, pluginId: input.pluginId, collectionId: input.collectionId, rowId: input.rowId };
}
export function listCollectionGrants(actorAccountId: string, input: PluginCollectionSharingAddressV1): Promise<PluginCollectionSharingGrantsResponseV1> {
    return inReadSnapshot(async tx => {
        const { row, access } = await resolveCollectionSharingContextInTx(tx, { ...input, actorAccountId });
        const grants = await tx.pluginCollectionGrant.findMany({ where: { rowDbId: row.id }, include: {
            team: { select: { name: true } }, teamGroup: { select: { name: true, teamId: true } },
        } });
        const { accountGrants: accounts, teamGrants: teams, groupGrants: groups } = projectResourceGrantRows(grants);
        return { ...address(input), access: access.level, grants: [
            ...accounts.map(grant => ({ principal: { kind: 'account' as const, accountId: grant.accountId }, accessLevel: grant.accessLevel,
                createdByAccountId: grant.createdByAccountId, createdAt: grant.createdAt.getTime(), display: { name: null } })),
            ...teams.map(grant => ({ principal: { kind: 'team' as const, teamId: grant.teamId }, accessLevel: grant.accessLevel,
                createdByAccountId: grant.createdByAccountId, createdAt: grant.createdAt.getTime(), display: { name: grant.team.name } })),
            ...groups.map(grant => ({ principal: { kind: 'group' as const, teamId: grant.teamGroup.teamId, groupId: grant.teamGroupId }, accessLevel: grant.accessLevel,
                createdByAccountId: grant.createdByAccountId, createdAt: grant.createdAt.getTime(), display: { name: grant.teamGroup.name } })),
        ] };
    });
}

/** Prospective audiences prepare recipient keys without creating a grant. */
export function readCollectionRecipientCensus(actorAccountId: string, input: PluginCollectionSharingCensusRequestV1): Promise<PluginCollectionSharingCensusResponseV1> {
    return inReadSnapshot(tx => readCollectionRecipientCensusInTx(tx, { ...input, actorAccountId }));
}

export async function readCollectionRecipientCensusInTx(tx: Tx, input: CollectionActorInput & Readonly<{ principal?: PrincipalRefV1 }>): Promise<PluginCollectionSharingCensusResponseV1> {
        const actorAccountId = input.actorAccountId;
        const context = await resolveCollectionSharingContextInTx(tx, { ...input, actorAccountId });
        const { row, access } = context;
        let additional: string[] = [];
        if (input.principal) {
            requireManage(context);
            const previous = await readPrincipalGrant(tx, row.id, input.principal);
            const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId, ownerAccountId: input.ownerAccountId,
                principal: input.principal, hasExistingGrant: previous !== null });
            if (error) throw new CollectionSharingError(`collection_${error}`);
            additional = await readResourceGrantPrincipalAudienceInTx(tx, { ownerAccountId: input.ownerAccountId, principal: input.principal });
        }
        const audience = [...new Set([...await resolveCollectionAudienceInTx(tx, row.id), ...additional])];
        const [accounts, envelopes] = await Promise.all([
            tx.account.findMany({ where: { id: { in: audience } }, select: RECIPIENT_READINESS_SELECT, orderBy: { id: 'asc' } }),
            tx.pluginCollectionKeyEnvelope.findMany({ where: { rowDbId: row.id } }),
        ]);
        const projectedAccounts = accounts.map(account => ({ account, readiness: deriveAccountRecipientEnvelopeReadinessFromRow(account) }));
        const owner = envelopes.find(envelope => envelope.recipientAccountId === input.ownerAccountId);
        const ownerKey = owner?.encryptedDataKey ?? new Uint8Array();
        const caller = accounts.find(account => account.id === actorAccountId);
        const callerEnvelope = envelopes.find(envelope => envelope.recipientAccountId === actorAccountId);
        const callerKey = caller && callerEnvelope ? projectResourceRecipientEnvelope(caller, callerEnvelope) : null;
        if (access.encryptionMode === 'e2ee' && !owner && access.level === 'owner') {
            return { ...address(input), access: access.level, encryptionMode: 'e2ee', dataEncryptionKey: null, callerDataEncryptionKey: null,
                recipients: projectedAccounts.map(({ account, readiness }) => projectResourceRecipientCensusRow({ access,
                    ownerDataEncryptionKey: ownerKey, account, readiness })) };
        }
        const result = projectResourceRecipientCensus({ access, ownerDataEncryptionKey: ownerKey,
            callerDataEncryptionKey: callerKey, accounts: projectedAccounts, envelopes });
        if (!result.ok) throw new CollectionSharingError('collection_content_unavailable');
        return { ...address(input), ...result.value };
}

/** Account conversion consumes the common resource census without HTTP address extensions. */
export async function readCollectionResourceRecipientCensusInTx(tx: Tx, input: CollectionActorInput) {
    const census = await readCollectionRecipientCensusInTx(tx, input);
    return { ownerAccountId: census.ownerAccountId, access: census.access, encryptionMode: census.encryptionMode,
        dataEncryptionKey: census.dataEncryptionKey, callerDataEncryptionKey: census.callerDataEncryptionKey,
        recipients: census.recipients };
}

async function writeGrant(tx: Tx, input: PluginCollectionSharingSetGrantRequestV1, rowDbId: string, actorAccountId: string) {
    const { principal } = input;
    const data = { accessLevel: input.accessLevel, createdByAccountId: actorAccountId };
    if (principal.kind === 'account') await tx.pluginCollectionGrant.upsert({ where: { rowDbId_accountId: { rowDbId, accountId: principal.accountId } },
        create: { rowDbId, principalKind: 'account', accountId: principal.accountId, ...data }, update: data });
    else if (principal.kind === 'team') await tx.pluginCollectionGrant.upsert({ where: { rowDbId_teamId: { rowDbId, teamId: principal.teamId } },
        create: { rowDbId, principalKind: 'team', teamId: principal.teamId, ...data }, update: data });
    else await tx.pluginCollectionGrant.upsert({ where: { rowDbId_teamGroupId: { rowDbId, teamGroupId: principal.groupId } },
        create: { rowDbId, principalKind: 'group', teamGroupId: principal.groupId, ...data }, update: data });
}
function validEnvelopes(envelopes: readonly ResourceRecipientKeyEnvelopeInputV1[]) {
    if (!validateResourceRecipientKeyEnvelopes(envelopes)) throw new CollectionSharingError('collection_invalid_recipient_envelope');
}

/** First E2EE share commits canonical body CAS, owner/recipient wraps and grant together. */
export function setCollectionGrant(actorAccountId: string, input: PluginCollectionSharingSetGrantRequestV1, authentication: SessionAccessAuthentication) {
    return inTx(async tx => {
        const context = await lockMutation(tx, { ...input, actorAccountId }, input.principal);
        requireManage(context);
        const { row, access } = context;
        const previous = await readPrincipalGrant(tx, row.id, input.principal);
        const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId, ownerAccountId: input.ownerAccountId,
            principal: input.principal, hasExistingGrant: previous !== null });
        if (error) throw new CollectionSharingError(`collection_${error}`);
        if (row.revision !== input.expectedRevision) throw new CollectionSharingError('collection_revision_conflict');
        const promotion = input.promotion;
        if (promotion && input.recipientKeyEnvelopes) throw new CollectionSharingError('collection_invalid_recipient_envelope');
        const resource = context.content.t === 'encrypted' && context.content.k === 'collection';
        if (access.encryptionMode === 'plain' && (promotion || input.recipientKeyEnvelopes?.length)) throw new CollectionSharingError('collection_content_mode_mismatch');
        if (access.encryptionMode === 'e2ee' && !resource && !promotion) throw new CollectionSharingError('collection_promotion_required');
        const previousAudience = await resolveCollectionAudienceInTx(tx, row.id);
        if (promotion) {
            if (resource || promotion.content.t !== 'encrypted' || promotion.content.k !== 'collection'
                || promotion.ownerKeyEnvelope.recipientAccountId !== input.ownerAccountId) throw new CollectionSharingError('collection_invalid_recipient_envelope');
            if (promotion.expectedRevision !== input.expectedRevision) throw new CollectionSharingError('collection_revision_conflict');
            validEnvelopes([promotion.ownerKeyEnvelope, ...promotion.recipientKeyEnvelopes]);
            const owner = await tx.account.findUnique({ where: { id: input.ownerAccountId }, select: RECIPIENT_READINESS_SELECT });
            if (!owner || !projectResourceRecipientEnvelope(owner, { ...promotion.ownerKeyEnvelope,
                encryptedDataKey: privacyKit.decodeBase64(promotion.ownerKeyEnvelope.encryptedDataKey) })) throw new CollectionSharingError('collection_invalid_recipient_envelope');
            const projection = Object.fromEntries(row.projections.map(field => [field.fieldId, JSON.parse(field.typedEncodedValue) as unknown]));
            const result = await mutatePluginCollectionInTx({ tx, accountId: input.ownerAccountId,
                request: { pluginId: input.pluginId, collectionId: input.collectionId,
                    writerContext: { schemaVersion: row.schemaVersion, contractDigest: row.contractDigest },
                    operations: [{ kind: 'put', rowId: row.rowId, expectedRevision: input.expectedRevision, content: promotion.content,
                        projection: PluginCollectionProjectionV1Schema.parse(projection) }] },
                deployment: readPluginsFeatureEnv(process.env).collectionLimits, authentication, resourcePromotionRowId: row.rowId });
            if (result.status !== 'updated') throw new CollectionSharingError('collection_revision_conflict');
            await collectionRecipientEnvelopeStorageAdapter.writeRecipientEnvelopeInTx(tx, row.id, promotion.ownerKeyEnvelope);
        }
        const wraps = promotion?.recipientKeyEnvelopes ?? input.recipientKeyEnvelopes ?? [];
        validEnvelopes(wraps);
        const changed = previous?.accessLevel !== input.accessLevel;
        if (changed) await writeGrant(tx, input, row.id, actorAccountId);
        if (wraps.length) await applyResourceRecipientKeyEnvelopesInTx(tx, { ...collectionRecipientEnvelopeStorageAdapter,
            publishRecipientsChangedInTx: async () => {} }, { resourceId: row.id, recipientKeyEnvelopes: wraps });
        if (changed || promotion || wraps.length) await publishCollectionSharingChangedInTx(tx, row.id, previousAudience);
        return { changed: changed || Boolean(promotion) || wraps.length > 0 };
    });
}

/** Access ends at the next request; old recipient wraps never admit a reader. */
export function revokeCollectionGrant(actorAccountId: string, input: PluginCollectionSharingRevokeGrantRequestV1) {
    return inTx(async tx => {
        const context = await lockMutation(tx, { ...input, actorAccountId });
        requireManage(context);
        const rowDbId = context.row.id;
        const audience = await resolveCollectionAudienceInTx(tx, rowDbId);
        const principal = input.principal;
        const removed = principal.kind === 'account'
            ? await tx.pluginCollectionGrant.deleteMany({ where: { rowDbId, accountId: principal.accountId } })
            : principal.kind === 'team' ? await tx.pluginCollectionGrant.deleteMany({ where: { rowDbId, teamId: principal.teamId } })
                : await tx.pluginCollectionGrant.deleteMany({ where: { rowDbId, teamGroupId: principal.groupId } });
        if (removed.count) await publishCollectionSharingChangedInTx(tx, rowDbId, audience);
        return { changed: removed.count > 0 };
    });
}

export function commitCollectionRecipientKeys(actorAccountId: string, input: PluginCollectionSharingCommitKeysRequestV1) {
    return inTx(async tx => {
        const context = await lockMutation(tx, { ...input, actorAccountId });
        if (context.access.level === 'view') throw new CollectionSharingError('collection_access_forbidden');
        if (context.access.encryptionMode !== 'e2ee') throw new CollectionSharingError('collection_content_mode_mismatch');
        const ownerEnvelope = await tx.pluginCollectionKeyEnvelope.findUnique({ where: { rowDbId_recipientAccountId: {
            rowDbId: context.row.id, recipientAccountId: input.ownerAccountId } } });
        if (!ownerEnvelope) throw new CollectionSharingError('collection_content_unavailable');
        const error = validateResourceRecipientEnvelopeCommit({ ownerDataEncryptionKey: ownerEnvelope.encryptedDataKey,
            expectedDataEncryptionKey: input.expectedDataEncryptionKey, recipientKeyEnvelopes: input.recipientKeyEnvelopes });
        if (error) throw new CollectionSharingError(error === 'data_key_changed' ? 'collection_revision_conflict' : 'collection_invalid_recipient_envelope');
        return applyResourceRecipientKeyEnvelopesInTx(tx, collectionRecipientEnvelopeStorageAdapter,
            { resourceId: context.row.id, recipientKeyEnvelopes: input.recipientKeyEnvelopes });
    });
}
