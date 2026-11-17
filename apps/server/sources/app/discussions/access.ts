import { projectResourceGrantRows } from '@/app/teams/resourceGrantAccess';
import * as privacyKit from "privacy-kit";
import type { Prisma } from "@prisma/client";
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { DiscussionAnchorV1Schema, type DiscussionReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';
import { acquireArtifactPublicationLocksInTx, resolveArtifactAudienceInTx, resolveArtifactPublicationAdmissionIntent } from '@/app/artifacts/artifactAccessService';
import { resolveDiscussionDocTargetInTx } from './docPassages';
import type { ResourceContextStorageAdapter } from '@/app/session/access/sessionContextInjection';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol/storage/artifactStoredContent";
import { isActiveHomeAccountStatus } from "@happier-dev/protocol/home/governance";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { RECIPIENT_READINESS_SELECT } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { backgroundDeliveryAuthentication, resolveQualifiedSessionTeamIdsInTx, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { projectResourceRecipientEnvelope, resourceGrantRelationsSelect, resolveResourceGrantAccessFromFacts,
    resolveResourceGrantAudienceFromFacts, readResourceGrantPrincipalAudienceInTx, type ResourceGrantAccess, type ResourceGrantAccessFacts,
    type ResourceGrantStorageAdapter } from "@/app/teams/resourceGrantAccess";
import type { Tx } from "@/storage/inTx";
import { inReadSnapshot, TransactionReplayRequiredError } from '@/storage/inTx';
import { getDbProviderFromEnv, prismaRuntime as sql } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { discussionSqlName as name } from './readSql';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { DISCUSSION_DEFAULT_PAGE_SIZE_V1 } from '@happier-dev/protocol/discussions/api';
import { beforeAccountChangePublication } from '@/app/changes/markAccountChanged';
import { fenceSessionAccountCursorAudienceInTx, readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

import { resourceGrantArmWheres } from '@/app/teams/resourceGrantAccess';
import { resourceTeamShareScopeV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { qualifyTeamOperationAuthenticationInTx, resolveTeamActorContextInTx, type TeamActorContext } from '@/app/teams/actorContext';

type DiscussionMutationAudienceInput = Readonly<{
    discussionId: string; actorAccountId?: string; additionalAccountIds?: readonly string[];
    additionalSessionIds?: readonly string[]; includeParticipantSessions?: boolean;
    additionalGrantPrincipal?: PrincipalRefV1;
    includeDiscussionPublication?: boolean;
    append?: Readonly<{ replyTarget?: DiscussionReplyTargetV1 }>;
}>;

async function readDiscussionParticipantSessionIdsInTx(tx: Tx, input: DiscussionMutationAudienceInput) {
    if (!input.includeParticipantSessions) return [];
    const [participants, edges] = await Promise.all([
        tx.discussionParticipant.findMany({ where: { discussionId: input.discussionId, removedAt: null },
            select: { sessionId: true } }),
        tx.sessionFollowEdge.findMany({ where: { sourceDiscussionId: input.discussionId },
            select: { destinationSessionId: true } }),
    ]);
    return [...participants.flatMap(participant => participant.sessionId ? [participant.sessionId] : []),
        ...edges.map(edge => edge.destinationSessionId)];
}

/** One census serves both pre-attempt preparation and in-transaction admission. */
async function readDiscussionMutationAudienceInTx(tx: Tx, input: DiscussionMutationAudienceInput) {
    const discussion = await tx.discussion.findUnique({ where: { id: input.discussionId }, select: { ownerAccountId: true,
        ...(input.append ? { anchorV1: true } : {}) } });
    const source = input.append ? await resolveDiscussionDocTargetInTx(tx, { discussionId: input.discussionId,
        replyTarget: input.append.replyTarget }) : null;
    const artifactIds = source?.ok && source.value ? [source.value.ref.artifactId] : [];
    const anchor = input.append ? DiscussionAnchorV1Schema.safeParse(discussion?.anchorV1) : null;
    const sessionIds = [...new Set([
        ...await readDiscussionParticipantSessionIdsInTx(tx, input),
        ...input.additionalSessionIds ?? [],
        // Only committed quoted-source admission consumes this Session, never
        // an optional link. A missing source still permits independent chat.
        ...(anchor?.success && anchor.data.kind === 'session' && anchor.data.messageId ? [anchor.data.sessionId] : []),
    ])];
    const publicationAudience = [
        ...(input.includeDiscussionPublication === false ? [] : await resolveDiscussionAudienceInTx(tx, input.discussionId)),
        ...(discussion && input.additionalGrantPrincipal ? await readResourceGrantPrincipalAudienceInTx(tx, {
            ownerAccountId: discussion.ownerAccountId, principal: input.additionalGrantPrincipal,
        }) : []),
    ];
    const additionalAccountIds = [
        ...(discussion ? [discussion.ownerAccountId] : []),
        ...(input.actorAccountId ? [input.actorAccountId] : []),
        ...input.additionalAccountIds ?? [],
        ...publicationAudience,
    ];
    for (const artifactId of artifactIds) additionalAccountIds.push(...await resolveArtifactAudienceInTx(tx, artifactId));
    const audience = await readSessionAccountCursorAudienceInTx(tx, sessionIds, additionalAccountIds);
    return { ownerAccountId: discussion?.ownerAccountId, sessionIds, additionalAccountIds, artifactIds, audience };
}

async function fenceDiscussionMutationAudienceInTx(tx: Tx, input: DiscussionMutationAudienceInput,
    { ownerAccountId, sessionIds, additionalAccountIds, artifactIds, audience }: Awaited<ReturnType<typeof readDiscussionMutationAudienceInTx>>) {
    // Quoted Artifact admission must be selected before Session/resource locks;
    // asking for stronger quota admission later would replay every attempt.
    await fenceSessionAccountCursorAudienceInTx(tx, audience, sessionIds, additionalAccountIds, {
        intent: artifactIds.length > 0 ? resolveArtifactPublicationAdmissionIntent() : 'content',
    });
    const admittedAccounts = new Set(audience.accountIds);
    const admittedSessions = new Set(sessionIds);
    const admittedProjectionSessions = new Set(audience.projectionSessionIds);
    const validateCapturedAudience = async () => {
        const current = await readDiscussionMutationAudienceInTx(tx, input);
        if (current.ownerAccountId !== ownerAccountId
            || current.sessionIds.some(sessionId => !admittedSessions.has(sessionId))
            || current.audience.projectionSessionIds.some(sessionId => !admittedProjectionSessions.has(sessionId))
            || current.artifactIds.some(artifactId => !artifactIds.includes(artifactId))
            || current.audience.accountIds.some(accountId => !admittedAccounts.has(accountId))) {
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
    };
    await validateCapturedAudience();
    for (const artifactId of artifactIds) {
        await acquireArtifactPublicationLocksInTx(tx, artifactId, audience.accountIds, { intent: 'content' });
    }
    const provider = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    // Grants, lifecycle and append retry/sequence decisions share this parent.
    // SQLite already reserves its single writer before entering domain work.
    if (provider === 'postgres') {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Discussion" WHERE "id" = $1 FOR NO KEY UPDATE', input.discussionId);
    } else if (provider === 'mysql') {
        await tx.$queryRawUnsafe('SELECT `id` FROM `Discussion` WHERE `id` = ? FOR UPDATE', input.discussionId);
    }
    // An invite can commit while this attempt waits for the parent. Replay
    // before domain admission can discover and lock a new Session after it.
    await validateCapturedAudience();
    if (input.includeParticipantSessions) {
        // Fanout consumes the actual Follow destinations. A newly observed
        // Session must replay the complete cohort, never acquire a parent lock
        // after this mutation has already taken its child locks.
        beforeAccountChangePublication(tx, audience.accountIds, async client => {
            if ((await readDiscussionParticipantSessionIdsInTx(client, input)).some(sessionId => !admittedSessions.has(sessionId))) {
                throw new TransactionReplayRequiredError('transaction-account-audience-changed');
            }
        });
    }
}

/** Stabilize lifecycle and key authority before a Discussion mutation takes resource locks. */
export async function acquireDiscussionMutationAccountsInTx(tx: Tx, input: DiscussionMutationAudienceInput): Promise<void> {
    await fenceDiscussionMutationAudienceInTx(tx, input, await readDiscussionMutationAudienceInTx(tx, input));
}

/** Refresh outside each mutation attempt, then admit Accounts before any domain reads. */
export async function prepareDiscussionMutationAccounts(input: DiscussionMutationAudienceInput): Promise<(tx: Tx) => Promise<void>> {
    // SQLite already owns its single writer; retain its existing in-transaction census.
    if (getDbProviderFromEnv(process.env, 'postgres') === 'sqlite') {
        return tx => acquireDiscussionMutationAccountsInTx(tx, input);
    }
    const audience = await inReadSnapshot(tx => readDiscussionMutationAudienceInTx(tx, input));
    return tx => fenceDiscussionMutationAudienceInTx(tx, input, audience);
}

export type DiscussionStorageMode = "plain" | "e2ee";
export interface DiscussionContext {
    discussionId: string;
    ownerAccountId: string;
    storageMode: DiscussionStorageMode;
    access: ResourceGrantAccess;
    keyReadiness: boolean;
    dataEncryptionKey: string | null;
    /** Complete explicit entitlement audience when the response also projects Account actors. */
    audienceAccountIds?: readonly string[];
}

function discussionAccessFactsSelect(actorAccountId?: string) {
    const relations = resourceGrantRelationsSelect(actorAccountId);
    const memberships = relations.grants.select.team.select.memberships;
    const membershipSelect = { ...memberships.select, id: true } as const;
    return {
        id: true, ownerAccountId: true, encryptionMode: true,
        ownerAccount: { select: { ...RECIPIENT_READINESS_SELECT, status: true } },
        grants: { ...relations.grants, select: { ...relations.grants.select,
            team: { select: { ...relations.grants.select.team.select, id: true, authenticationPolicy: true,
                memberships: { ...memberships, select: membershipSelect },
            } },
            teamGroup: { select: { ...relations.grants.select.teamGroup.select, id: true, team: { select: {
                ...relations.grants.select.teamGroup.select.team.select, id: true, authenticationPolicy: true,
            } }, memberships: { ...relations.grants.select.teamGroup.select.memberships,
                select: { teamGroupId: true, teamMembershipId: true, teamMembership: { select: membershipSelect } } },
            } },
        } },
    } as const;
}

async function readDiscussionAccessFactsBatchInTx(tx: Tx, discussionIds: readonly string[], actorAccountId?: string) {
    return tx.discussion.findMany({ where: { id: { in: [...discussionIds] } }, select: discussionAccessFactsSelect(actorAccountId) })
        .then(rows => rows.map(row => ({ ...row, ...projectResourceGrantRows(row.grants) })));
}
type DiscussionAccessFacts = Awaited<ReturnType<typeof readDiscussionAccessFactsBatchInTx>>[number];

function discussionGrantFacts(row: DiscussionAccessFacts, qualifiedTeamIds?: ReadonlySet<string>): ResourceGrantAccessFacts {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.ownerAccount);
    return {
        ownerAccountId: row.ownerAccountId,
        encryptionMode: mode.status === "ready" && mode.mode === row.encryptionMode ? mode.mode : null,
        accountGrants: row.accountGrants,
        teamGrants: qualifiedTeamIds ? row.teamGrants.filter(grant => qualifiedTeamIds.has(grant.team.id)) : row.teamGrants,
        groupGrants: qualifiedTeamIds ? row.groupGrants.filter(grant => qualifiedTeamIds.has(grant.teamGroup.team.id)) : row.groupGrants,
    };
}

/** Structural grants are shared policy; request credentials qualify collective arms separately. */
export const discussionGrantStorageAdapter: ResourceGrantStorageAdapter = {
    async readAccessFactsBatchInTx(tx, discussionIds, actorAccountId) {
        const facts = new Map<string, ResourceGrantAccessFacts>();
        for (const ids of portableQueryChunks({ values: [...new Set(discussionIds)], bindingsPerValue: 1,
            fixedBindings: actorAccountId === undefined ? 0 : 3 })) {
            for (const row of await readDiscussionAccessFactsBatchInTx(tx, ids, actorAccountId)) facts.set(row.id, discussionGrantFacts(row));
        }
        return facts;
    },
    async readAccessFactsInTx(tx, discussionId, actorAccountId) {
        return (await discussionGrantStorageAdapter.readAccessFactsBatchInTx(tx, [discussionId], actorAccountId)).get(discussionId) ?? null;
    },
};

/** Content disclosure additionally consumes the real credential/participant admission owner. */
export const discussionContextStorageAdapter: ResourceContextStorageAdapter = {
    ...discussionGrantStorageAdapter,
    async resolveConfigurerAccessInTx(tx, input) {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.resourceId,
            accountId: input.actorAccountId, authentication: input.authentication });
        return context?.access ?? null;
    },
};

/** The validated initial roster is the new resource's audience before its atomic insert. */
export function newDiscussionContextStorageAdapter(input: Readonly<{
    resourceId: string; ownerAccountId: string; encryptionMode: DiscussionStorageMode;
    participantAccountIds: readonly string[];
}>): ResourceContextStorageAdapter {
    const facts: ResourceGrantAccessFacts = { ownerAccountId: input.ownerAccountId, encryptionMode: input.encryptionMode,
        accountGrants: input.participantAccountIds.map(accountId => ({ accountId, accessLevel: 'edit', account: { status: 'active' } })),
        teamGrants: [], groupGrants: [] };
    return {
        async readAccessFactsBatchInTx(_tx, resourceIds) {
            return new Map(resourceIds.includes(input.resourceId) ? [[input.resourceId, facts]] : []);
        },
        async readAccessFactsInTx(tx, resourceId, actorAccountId) {
            return (await this.readAccessFactsBatchInTx(tx, [resourceId], actorAccountId)).get(resourceId) ?? null;
        },
        async resolveConfigurerAccessInTx(_tx, request) {
            return request.resourceId === input.resourceId ? resolveResourceGrantAccessFromFacts(facts, request.actorAccountId) : null;
        },
    };
}

function teamsFromFacts(rows: readonly DiscussionAccessFacts[]) {
    return [...new Map(rows.flatMap(row => [
        ...row.teamGrants.map(grant => grant.team), ...row.groupGrants.map(grant => grant.teamGroup.team),
    ]).map(team => [team.id, team])).values()];
}

/** PAT resource ceilings cannot be widened from a Session or Machine to a Discussion. */
export async function isDiscussionAccountCredentialAdmittedInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; discussionId?: string;
}>): Promise<boolean> {
    if (!await isDiscussionCredentialCurrentInTx(tx, input)) return false;
    const principal = input.authentication.sessionRuntimePrincipal;
    if (!principal) return true;
    if (!input.discussionId) return false;
    return await tx.discussionParticipant.findUnique({ where: { discussionId_sessionId: {
        discussionId: input.discussionId, sessionId: principal.sessionId,
    } }, select: { sessionId: true, removedAt: true } }).then(row => row !== null && row.removedAt === null);
}

export async function isDiscussionCredentialCurrentInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    if (input.authentication.apiTokenGrant?.targets != null) return false;
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true, tokenEpoch: true } });
    if (!account || !isActiveHomeAccountStatus(account.status)
        || (input.authentication.tokenEpoch !== undefined && input.authentication.tokenEpoch !== account.tokenEpoch)) return false;
    const principal = input.authentication.sessionRuntimePrincipal;
    if (!principal) return true;
    if (principal.accountId !== input.accountId
        || !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, principal)) return false;
    return true;
}

/** One admission joins persisted mode, live grants, credentials and the caller's own key. */
export async function resolveDiscussionContextInTx(tx: Tx, params: Readonly<{
    discussionId: string; accountId: string; authentication: SessionAccessAuthentication;
    lockMembershipAuthority?: boolean;
    includeActorAudience?: boolean;
}>): Promise<DiscussionContext | null> {
    const contexts = await resolveDiscussionContextsInTx(tx, { ...params, discussionIds: [params.discussionId] });
    return contexts.get(params.discussionId) ?? null;
}

/** Lists and exact reads share one batched capture and the same grant/key projection. */
export async function resolveDiscussionContextsInTx(tx: Tx, params: Readonly<{
    discussionIds: readonly string[]; accountId: string; authentication: SessionAccessAuthentication;
    /** Prepared append holds its resource parents before locking authority rows. */
    lockMembershipAuthority?: boolean;
    includeActorAudience?: boolean;
    /** Selected-Team list admission already qualified this audience. */
    qualifiedTeamIds?: ReadonlySet<string>;
}>): Promise<ReadonlyMap<string, DiscussionContext>> {
    const contexts = new Map<string, DiscussionContext>();
    if (params.discussionIds.length === 0 || !await isDiscussionCredentialCurrentInTx(tx, params)) return contexts;
    const principal = params.authentication.sessionRuntimePrincipal;
    const readRows = () => tx.discussion.findMany({ where: { id: { in: [...params.discussionIds] } }, select: {
            ...discussionAccessFactsSelect(params.includeActorAudience ? undefined : params.accountId), dataEncryptionKey: true,
            keyEnvelopes: { where: { recipientAccountId: params.accountId }, select: {
                encryptedDataKey: true, recipientContentPublicKeyFingerprint: true,
            } },
            participants: { where: principal ? { sessionId: principal.sessionId, removedAt: null } : { sessionId: { in: [] } }, select: { sessionId: true } },
        } }).then(rows => rows.map(row => ({ ...row, ...projectResourceGrantRows(row.grants) })));
    let [rows, account] = await Promise.all([
        readRows(),
        tx.account.findUnique({ where: { id: params.accountId }, select: RECIPIENT_READINESS_SELECT }),
    ]);
    if (!account) return contexts;
    if (params.lockMembershipAuthority && resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres'
        && rows.some(row => row.teamGrants.length > 0 || row.groupGrants.length > 0)) {
        const teamIds = teamsFromFacts(rows).map(team => team.id).sort();
        const lockedMembers = teamIds.length ? await tx.$queryRawUnsafe<Array<{ id: string }>>(
            'SELECT "id" FROM "TeamMembership" WHERE "accountId" = $1 AND "teamId" = ANY($2::text[]) ORDER BY "id" FOR SHARE',
            params.accountId, teamIds,
        ) : [];
        const groupIds = [...new Set(rows.flatMap(row => row.groupGrants.map(grant => grant.teamGroup.id)))].sort();
        const lockedGroupMembers = groupIds.length ? await tx.$queryRawUnsafe<Array<{ teamGroupId: string; teamMembershipId: string }>>(
            'SELECT gm."teamGroupId", gm."teamMembershipId" FROM "TeamGroupMembership" gm JOIN "TeamMembership" m ON m."id" = gm."teamMembershipId" WHERE m."accountId" = $1 AND gm."teamGroupId" = ANY($2::text[]) ORDER BY gm."teamGroupId", gm."teamMembershipId" FOR SHARE OF gm',
            params.accountId, groupIds,
        ) : [];
        // A membership may have disappeared or changed status while SHARE
        // waited. Only freshly read facts can supply the access decision.
        rows = await readRows();
        const lockedMemberIds = new Set(lockedMembers.map(member => member.id));
        const lockedGroupKeys = new Set(lockedGroupMembers.map(member => JSON.stringify([member.teamGroupId, member.teamMembershipId])));
        if (rows.some(row => row.teamGrants.some(grant => grant.team.memberships.some(member => !lockedMemberIds.has(member.id)))
            || row.groupGrants.some(grant => grant.teamGroup.memberships.some(member => !lockedMemberIds.has(member.teamMembership.id)
                || !lockedGroupKeys.has(JSON.stringify([member.teamGroupId, member.teamMembershipId])))))) {
            // A newly created lifetime was never locked by this attempt.
            // Replay the prepared transaction rather than borrowing its access.
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
    }
    const qualified = params.qualifiedTeamIds ?? await resolveQualifiedSessionTeamIdsInTx(tx, { accountIds: [params.accountId],
        teams: teamsFromFacts(rows), authentication: params.authentication });
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
    for (const row of rows) {
        if (principal && row.participants.length === 0) continue;
        const access = resolveResourceGrantAccessFromFacts(discussionGrantFacts(row, qualified), params.accountId);
        if (!access?.encryptionMode) continue;
        const admittedAccess = principal && access.level !== "view" ? { ...access, level: "edit" as const } : access;
        const audienceAccountIds = params.includeActorAudience ? projectDiscussionAudienceFromFacts(row) : undefined;
        if (access.encryptionMode === "plain") {
            if (privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)) !== ARTIFACT_PLAIN_DATA_KEY_MARKER) continue;
            contexts.set(row.id, { discussionId: row.id, ownerAccountId: row.ownerAccountId, storageMode: "plain",
                access: admittedAccess, keyReadiness: true, dataEncryptionKey: null, ...(audienceAccountIds ? { audienceAccountIds } : {}) });
            continue;
        }
        const envelope = params.accountId === row.ownerAccountId && readiness.status === "available"
            ? { encryptedDataKey: row.dataEncryptionKey, recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint }
            : row.keyEnvelopes[0];
        const key = envelope ? projectResourceRecipientEnvelope(account, envelope, readiness) : null;
        contexts.set(row.id, { discussionId: row.id, ownerAccountId: row.ownerAccountId, storageMode: "e2ee", access: admittedAccess,
            keyReadiness: key !== null, dataEncryptionKey: key ? privacyKit.encodeBase64(key) : null,
            ...(audienceAccountIds ? { audienceAccountIds } : {}) });
    }
    return contexts;
}

/**
 * Narrow ordinary ORM lists before paging; shared policy subsequently admits every row.
 * Keep this relation filter alongside discussionCandidateSql: Prisma cannot embed a
 * raw predicate in findMany, while attention/Doc/key-readiness queries need correlated
 * EXISTS inside SQL before their LIMIT. Resolving IDs first would add a query and an
 * inventory-sized IN list; translating arbitrary Prisma filters would add a second
 * query compiler. Both adapters only discover candidates; neither grants access.
 */
export function discussionCandidateWhere(accountId: string): Prisma.DiscussionWhereInput {
    return { OR: [
        { ownerAccountId: accountId },
        { grants: { some: { principalKind: 'account', accountId } } },
        { grants: { some: { principalKind: 'team', team: { memberships: { some: { accountId } } } } } },
        { grants: { some: { principalKind: 'group', teamGroup: { memberships: { some: { teamMembership: { accountId } } } } } } },
    ] };
}

/** Count and ordered pages share exact selected-Team grant admission, without
 * opening content or treating Team administration as Group membership.
 */
export async function readDiscussionTeamScopedIdsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; sharedWithTeamId: string; authentication: SessionAccessAuthentication;
    admittedTeamActor?: TeamActorContext;
}>) {
    const actor = input.admittedTeamActor ?? await resolveTeamActorContextInTx(tx, { actorAccountId: input.actorAccountId, teamId: input.sharedWithTeamId });
    if (!actor?.capabilities.viewTeam) return { ok: false as const, error: 'discussion_not_found' as const };
    const qualification = await qualifyTeamOperationAuthenticationInTx(tx, { context: actor,
        authenticationAuthority: input.authentication.authority, authenticationEvidence: input.authentication.authenticationEvidence,
        env: input.authentication.env });
    if (!qualification.ok) return qualification;
    const arms = resourceGrantArmWheres(input.actorAccountId, input.sharedWithTeamId);
    const independent = { OR: [{ ownerAccountId: input.actorAccountId }, { grants: { some: arms.account } }] };
    const [teams, groups] = await Promise.all([
        tx.discussionGrant.findMany({ where: { principalKind: 'team', teamId: input.sharedWithTeamId,
            OR: [arms.team, { discussion: independent }] }, select: { discussionId: true } }),
        tx.discussionGrant.findMany({ where: { principalKind: 'group', teamGroup: {
            teamId: input.sharedWithTeamId, archivedAt: null, team: { archivedAt: null },
        }, OR: [arms.group, { discussion: independent }] }, select: { discussionId: true } }),
    ]);
    const teamIds = new Set(teams.map(row => row.discussionId)), groupIds = new Set(groups.map(row => row.discussionId));
    const resourceIds = [...new Set([...teamIds, ...groupIds])];
    const shareScopes = new Map(resourceIds.map(id => [id,
        resourceTeamShareScopeV1({ team: teamIds.has(id), group: groupIds.has(id) })!]));
    return { ok: true as const, resourceIds, shareScopes };
}

/** SQL projection of the same reachability prefilter for correlated/paged reads.
 * Neither adapter admits content: resolveDiscussionContextsInTx remains the authority.
 * The caller's Discussion table is aliased as d.
 */
export function discussionCandidateSql(accountId: string): Prisma.Sql {
    return sql.sql`(d.${name('ownerAccountId')} = ${accountId}
        OR EXISTS (SELECT 1 FROM ${name('DiscussionGrant')} g
            WHERE g.${name('discussionId')} = d.${name('id')} AND g.${name('accountId')} = ${accountId})
        OR EXISTS (SELECT 1 FROM ${name('DiscussionGrant')} g JOIN ${name('TeamMembership')} m ON m.${name('teamId')} = g.${name('teamId')}
            WHERE g.${name('discussionId')} = d.${name('id')} AND m.${name('accountId')} = ${accountId})
        OR EXISTS (SELECT 1 FROM ${name('DiscussionGrant')} g
            JOIN ${name('TeamGroupMembership')} gm ON gm.${name('teamGroupId')} = g.${name('teamGroupId')}
            JOIN ${name('TeamMembership')} m ON m.${name('id')} = gm.${name('teamMembershipId')}
            WHERE g.${name('discussionId')} = d.${name('id')} AND m.${name('accountId')} = ${accountId}))`;
}

/** Preserve the requested Account-wide or exact Discussion incomplete fact without loading every ready resource.
 * SQL only selects structurally unusable envelope candidates; ordinary live
 * grant/credential/mode admission still decides whether any is visible.
 */
export async function hasDiscussionWithUnavailableKeyInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; discussionId?: string;
}>): Promise<boolean> {
    if (!await isDiscussionCredentialCurrentInTx(tx, input)) return false;
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: RECIPIENT_READINESS_SELECT });
    if (!account) return false;
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
    const envelopeShape = (column: Prisma.Sql) => sql.sql`(LENGTH(${column}) = ${ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES}
        AND SUBSTR(${column}, 1, 1) = ${new Uint8Array([ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE])})`;
    const ready = readiness.status === 'available' ? sql.sql`(
        (d.${name('ownerAccountId')} = ${input.accountId} AND ${envelopeShape(sql.sql`d.${name('dataEncryptionKey')}`)})
        OR (d.${name('ownerAccountId')} <> ${input.accountId} AND EXISTS (
            SELECT 1 FROM ${name('DiscussionKeyEnvelope')} k WHERE k.${name('discussionId')} = d.${name('id')}
            AND k.${name('recipientAccountId')} = ${input.accountId}
            AND k.${name('recipientContentPublicKeyFingerprint')} = ${readiness.binding.contentPublicKeyFingerprint}
            AND ${envelopeShape(sql.sql`k.${name('encryptedDataKey')}`)})))` : sql.sql`1 = 0`;
    let after: string | null = null;
    for (;;) {
        const rows: { id: string }[] = await tx.$queryRaw(sql.sql`SELECT d.${name('id')} AS id FROM ${name('Discussion')} d
            WHERE ${discussionCandidateSql(input.accountId)} AND d.${name('archivedAt')} IS NULL
            ${input.discussionId === undefined ? sql.empty : sql.sql`AND d.${name('id')} = ${input.discussionId}`}
            AND d.${name('encryptionMode')} = 'e2ee' AND NOT (${ready})
            ${after === null ? sql.empty : sql.sql`AND d.${name('id')} > ${after}`}
            ORDER BY d.${name('id')} ASC LIMIT ${DISCUSSION_DEFAULT_PAGE_SIZE_V1}`);
        if (!rows.length) return false;
        const contexts = await resolveDiscussionContextsInTx(tx, { ...input, discussionIds: rows.map(row => row.id) });
        if ([...contexts.values()].some(context => !context.keyReadiness)) return true;
        after = rows.at(-1)!.id;
    }
}

/** Disclosure audiences describe entitlement, independently of one request's credentials. */
export async function resolveDiscussionAudiencesInTx(tx: Tx, discussionIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
    const ids = [...new Set(discussionIds)];
    const result = new Map<string, readonly string[]>(ids.map(id => [id, []]));
    if (ids.length === 0) return result;
    const rows: DiscussionAccessFacts[] = [];
    for (const chunk of portableQueryChunks({ values: ids, bindingsPerValue: 1 })) {
        rows.push(...await readDiscussionAccessFactsBatchInTx(tx, chunk));
    }
    for (const row of rows) {
        result.set(row.id, projectDiscussionAudienceFromFacts(row));
    }
    return result;
}

/** The single-resource seam delegates to the same bounded set-wise owner. */
export async function resolveDiscussionAudienceInTx(tx: Tx, discussionId: string): Promise<string[]> {
    const audiences = await resolveDiscussionAudiencesInTx(tx, [discussionId]);
    return [...audiences.get(discussionId) ?? []];
}

function projectDiscussionAudienceFromFacts(row: DiscussionAccessFacts): string[] {
    const facts = discussionGrantFacts(row);
    const candidates = facts.encryptionMode ? resolveResourceGrantAudienceFromFacts(facts) : [];
    // Grant/member facts already carry Account status. Ownership is the only
    // unconditional resource arm, so qualify it from the same selected row.
    return candidates.filter(accountId => accountId !== row.ownerAccountId
        || isActiveHomeAccountStatus(row.ownerAccount.status));
}

/**
 * Exact-detail demand for the existing recipient preparer. This is projected
 * only after the caller has opened the current Discussion key; unavailable
 * Account bindings are not actionable and therefore do not create demand.
 */
export async function isDiscussionRecipientKeyPreparationRequiredInTx(tx: Tx, input: Readonly<{
    discussionId: string; context: DiscussionContext;
}>): Promise<boolean> {
    if (input.context.storageMode !== 'e2ee' || !input.context.keyReadiness) return false;
    const audience = input.context.audienceAccountIds ?? await resolveDiscussionAudienceInTx(tx, input.discussionId);
    const recipientIds = audience.filter(accountId => accountId !== input.context.ownerAccountId);
    if (recipientIds.length === 0) return false;
    const [accounts, envelopes] = await Promise.all([
        tx.account.findMany({ where: { id: { in: recipientIds } }, select: RECIPIENT_READINESS_SELECT }),
        tx.discussionKeyEnvelope.findMany({ where: { discussionId: input.discussionId,
            recipientAccountId: { in: recipientIds } }, select: {
                recipientAccountId: true, encryptedDataKey: true, recipientContentPublicKeyFingerprint: true,
            } }),
    ]);
    const envelopesByAccountId = new Map(envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
    return accounts.some(account => {
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
        if (readiness.status !== 'available') return false;
        const envelope = envelopesByAccountId.get(account.id);
        return envelope === undefined || projectResourceRecipientEnvelope(account, envelope, readiness) === null;
    });
}

/** Set-wise admission serves mentions, private attention and grant-entry cursors. Keys are separate. */
export async function filterDiscussionsWithCurrentReadAccessInTx(tx: Tx, params: Readonly<{
    discussionIds: readonly string[]; accountIds: readonly string[]; authentication?: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const accountIds = [...new Set(params.accountIds)];
    const result = new Map(accountIds.map(accountId => [accountId, new Set<string>()]));
    if (accountIds.length === 0 || params.discussionIds.length === 0) return result;
    const authentication = params.authentication ?? backgroundDeliveryAuthentication();
    if (authentication.apiTokenGrant?.targets != null
        || ((authentication.authenticationEvidence?.length ?? 0) > 0 && accountIds.length !== 1)) return result;
    const principal = authentication.sessionRuntimePrincipal;
    if (principal && (accountIds.length !== 1 || accountIds[0] !== principal.accountId
        || !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, principal))) return result;
    const [rows, accounts] = await Promise.all([
        tx.discussion.findMany({ where: { id: { in: [...params.discussionIds] } }, select: {
            ...discussionAccessFactsSelect(),
            participants: { where: principal ? { sessionId: principal.sessionId, removedAt: null } : { sessionId: { in: [] } }, select: { sessionId: true } },
        } }).then(rows => rows.map(row => ({ ...row, ...projectResourceGrantRows(row.grants) }))),
        tx.account.findMany({ where: { id: { in: accountIds }, status: "active",
            ...(authentication.tokenEpoch === undefined ? {} : { tokenEpoch: authentication.tokenEpoch }) }, select: { id: true } }),
    ]);
    const qualified = await resolveQualifiedSessionTeamIdsInTx(tx, { accountIds, teams: teamsFromFacts(rows), authentication });
    for (const row of rows) {
        if (principal && row.participants.length === 0) continue;
        const facts = discussionGrantFacts(row, qualified);
        if (!facts.encryptionMode) continue;
        for (const account of accounts) {
            if (resolveResourceGrantAccessFromFacts(facts, account.id)) result.get(account.id)?.add(row.id);
        }
    }
    return result;
}

export async function filterAccountsWithCurrentDiscussionReadAccessInTx(tx: Tx, params: Readonly<{
    discussionId: string; accountIds: readonly string[]; authentication?: SessionAccessAuthentication;
}>): Promise<ReadonlySet<string>> {
    const result = await filterDiscussionsWithCurrentReadAccessInTx(tx, { ...params, discussionIds: [params.discussionId] });
    return new Set([...result].filter(([, ids]) => ids.has(params.discussionId)).map(([accountId]) => accountId));
}
