import { isDeepStrictEqual } from 'node:util';
import * as privacyKit from 'privacy-kit';
import type { ResourceAccessLevelV1, ResourceCallerAccessV1, ResourceRecipientKeyEnvelopeInputV1,
    ResourceRecipientKeyEnvelopeCommitResponseV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { deriveAccountRecipientEnvelopeReadinessFromRow, type AccountRecipientEnvelopeReadiness,
    type AccountRecipientEnvelopeReadinessRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { projectRecipientContentKey, RECIPIENT_READINESS_SELECT, type RecipientReadinessRow } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import type { Tx } from '@/storage/inTx';
import type { AccountStatus, TeamMembershipStatus } from '@/storage/enums.generated';
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE, isEffectiveTeamMembership } from './memberships/effectiveMembership';
import { EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE, isEffectiveTeamGroupMembership } from './groups/effectiveGroupMembership';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';

type Member = Readonly<{ accountId: string; status: TeamMembershipStatus; account: Readonly<{ status: AccountStatus }> }>;

/** Resource adapters supply current storage facts; links and keys never supply grants. */
export interface ResourceGrantAccessFacts {
    ownerAccountId: string;
    encryptionMode: 'plain' | 'e2ee' | null;
    accountGrants: readonly Readonly<{ accountId: string; accessLevel: ResourceAccessLevelV1; account: Readonly<{ status: AccountStatus }> }>[];
    teamGrants: readonly Readonly<{ teamId?: string; accessLevel: ResourceAccessLevelV1; team: Readonly<{ archivedAt: Date | null; memberships: readonly Member[] }> }>[];
    groupGrants: readonly Readonly<{ accessLevel: ResourceAccessLevelV1; teamGroup: Readonly<{
        archivedAt: Date | null; team: Readonly<{ archivedAt: Date | null }>;
        memberships: readonly Readonly<{ teamMembership: Member }>[];
    }> }>[];
}

export interface ResourceGrantAccess {
    ownerAccountId: string;
    level: ResourceCallerAccessV1;
    encryptionMode: 'plain' | 'e2ee' | null;
}

export interface ResourceGrantStorageAdapter {
    readAccessFactsInTx(tx: Tx, resourceId: string, actorAccountId?: string): Promise<ResourceGrantAccessFacts | null>;
}

/** Common relation projection; resource identity and persisted mode remain adapter-owned. */
export function resourceGrantRelationsSelect(actorAccountId?: string) {
    const accountFilter = actorAccountId === undefined ? {} : { accountId: actorAccountId };
    return {
        accountGrants: { where: accountFilter, select: { accountId: true, accessLevel: true, account: { select: { status: true } } } },
        teamGrants: { select: { accessLevel: true, team: { select: {
            archivedAt: true, memberships: { where: accountFilter, select: { accountId: true, status: true, account: { select: { status: true } } } },
        } } } },
        groupGrants: { select: { accessLevel: true, teamGroup: { select: {
            archivedAt: true, team: { select: { archivedAt: true } },
            memberships: { where: { teamMembership: accountFilter }, select: { teamMembership: {
                select: { accountId: true, status: true, account: { select: { status: true } } },
            } } },
        } } } },
    } as const;
}

const accessRank = { view: 1, edit: 2, admin: 3, owner: 4 } as const;

/** Database projection of the same grant policy below, for candidate lists and aggregate counts.
 * The actor and lifecycle predicates must match the SAME membership row.
 * Resource adapters still own visibility and final private-content admission.
 */
export function resourceGrantAccessWhere(actorAccountId: string) {
    const member = { ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE, accountId: actorAccountId };
    return { OR: [
        { accountId: actorAccountId },
        { accountGrants: { some: { accountId: actorAccountId, account: { status: 'active' as const } } } },
        { teamGrants: { some: { team: { memberships: { some: member } } } } },
        { groupGrants: { some: { teamGroup: { memberships: { some: {
            ...EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE, teamMembership: member,
        } } } } } },
    ] };
}

/** SQL projection for bounded candidate queries that Prisma cannot express.
 * The resource adapter supplies its table names; `a` is the resource alias.
 * Readers still re-admit the captured content through the ordinary access owner.
 */
export function resourceGrantAccessSqlPredicate(input: Readonly<{
    actorAccountId: string; resourceTablePrefix: string; resourceIdColumn: string;
}>): ReturnType<typeof prismaRuntime.sql> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const mysql = provider === 'mysql';
    const sql = prismaRuntime.sql;
    const identifier = (name: string) => prismaRuntime.raw(mysql
        ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`);
    const column = (alias: string, name: string) => sql`${identifier(alias)}.${identifier(name)}`;
    const account = identifier('Account');
    const team = identifier('Team');
    const membership = identifier('TeamMembership');
    const member = EFFECTIVE_TEAM_MEMBERSHIP_WHERE;
    // PostgreSQL enum columns do not compare to Prisma's text parameters.
    const status = (value: AccountStatus | TeamMembershipStatus, enumName: 'AccountStatus' | 'TeamMembershipStatus') =>
        provider === 'postgres' || provider === 'pglite' ? sql`CAST(${value} AS ${identifier(enumName)})` : sql`${value}`;
    const activeAccount = status(member.account.status, 'AccountStatus');
    const activeMember = status(member.status, 'TeamMembershipStatus');
    const actor = input.actorAccountId;
    const resourceId = column('a', 'id');
    const memberMatches = sql`${column('m', 'accountId')} = ${actor}
        AND ${column('m', 'status')} = ${activeMember}
        AND ${column('c', 'status')} = ${activeAccount}
        AND ${column('t', 'archivedAt')} IS NULL`;
    return sql`(${column('a', 'accountId')} = ${actor}
        OR EXISTS (SELECT 1 FROM ${identifier(`${input.resourceTablePrefix}AccountGrant`)} g
            JOIN ${account} c ON ${column('c', 'id')} = ${column('g', 'accountId')}
            WHERE ${column('g', input.resourceIdColumn)} = ${resourceId}
            AND ${column('g', 'accountId')} = ${actor} AND ${column('c', 'status')} = ${activeAccount})
        OR EXISTS (SELECT 1 FROM ${identifier(`${input.resourceTablePrefix}TeamGrant`)} g
            JOIN ${membership} m ON ${column('m', 'teamId')} = ${column('g', 'teamId')}
            JOIN ${account} c ON ${column('c', 'id')} = ${column('m', 'accountId')}
            JOIN ${team} t ON ${column('t', 'id')} = ${column('m', 'teamId')}
            WHERE ${column('g', input.resourceIdColumn)} = ${resourceId} AND ${memberMatches})
        OR EXISTS (SELECT 1 FROM ${identifier(`${input.resourceTablePrefix}GroupGrant`)} g
            JOIN ${identifier('TeamGroup')} r ON ${column('r', 'id')} = ${column('g', 'teamGroupId')}
            JOIN ${identifier('TeamGroupMembership')} gm ON ${column('gm', 'teamGroupId')} = ${column('r', 'id')}
                AND ${column('gm', 'teamId')} = ${column('r', 'teamId')}
            JOIN ${membership} m ON ${column('m', 'id')} = ${column('gm', 'teamMembershipId')}
                AND ${column('m', 'teamId')} = ${column('gm', 'teamId')}
            JOIN ${account} c ON ${column('c', 'id')} = ${column('m', 'accountId')}
            JOIN ${team} t ON ${column('t', 'id')} = ${column('m', 'teamId')}
            WHERE ${column('g', input.resourceIdColumn)} = ${resourceId}
            AND ${column('r', 'archivedAt')} IS NULL AND ${memberMatches}))`;
}

/** Ownership or the highest live direct/Team/Group grant, independent of key readiness. */
export function resolveResourceGrantAccessFromFacts(row: ResourceGrantAccessFacts, actorAccountId: string): ResourceGrantAccess | null {
    const access = { ownerAccountId: row.ownerAccountId, encryptionMode: row.encryptionMode };
    if (row.ownerAccountId === actorAccountId) return { ...access, level: 'owner' };
    let level: ResourceCallerAccessV1 | null = null;
    const include = (candidate: ResourceAccessLevelV1) => {
        if (level === null || accessRank[candidate] > accessRank[level]) level = candidate;
    };
    for (const grant of row.accountGrants) {
        if (grant.accountId === actorAccountId && grant.account.status === 'active') include(grant.accessLevel);
    }
    for (const grant of row.teamGrants) {
        if (grant.team.memberships.some(member => member.accountId === actorAccountId && isEffectiveTeamMembership({
            accountStatus: member.account.status, membershipStatus: member.status, teamArchivedAt: grant.team.archivedAt,
        }))) include(grant.accessLevel);
    }
    for (const grant of row.groupGrants) {
        if (grant.teamGroup.memberships.some(({ teamMembership: member }) => member.accountId === actorAccountId && isEffectiveTeamGroupMembership({
            accountStatus: member.account.status, membershipStatus: member.status,
            teamArchivedAt: grant.teamGroup.team.archivedAt, groupArchivedAt: grant.teamGroup.archivedAt,
        }))) include(grant.accessLevel);
    }
    return level === null ? null : { ...access, level };
}

export function resolveResourceGrantAudienceFromFacts(row: ResourceGrantAccessFacts): string[] {
    const candidates = new Set([row.ownerAccountId, ...row.accountGrants.map(grant => grant.accountId),
        ...row.teamGrants.flatMap(grant => grant.team.memberships.map(member => member.accountId)),
        ...row.groupGrants.flatMap(grant => grant.teamGroup.memberships.map(member => member.teamMembership.accountId))]);
    return [...candidates].filter(accountId => resolveResourceGrantAccessFromFacts(row, accountId) !== null).sort();
}

export async function resolveResourceGrantAccessInTx(tx: Tx, adapter: ResourceGrantStorageAdapter,
    input: Readonly<{ resourceId: string; actorAccountId: string }>): Promise<ResourceGrantAccess | null> {
    const row = await adapter.readAccessFactsInTx(tx, input.resourceId, input.actorAccountId);
    return row ? resolveResourceGrantAccessFromFacts(row, input.actorAccountId) : null;
}

export async function resolveResourceGrantAudienceInTx(tx: Tx, adapter: ResourceGrantStorageAdapter, resourceId: string): Promise<string[]> {
    const row = await adapter.readAccessFactsInTx(tx, resourceId);
    return row ? resolveResourceGrantAudienceFromFacts(row) : [];
}

/** Read a prospective grant through the same live membership policy as a stored resource. */
export async function readResourceGrantPrincipalAudienceInTx(tx: Tx, input: Readonly<{
    ownerAccountId: string; principal: PrincipalRefV1;
}>): Promise<string[]> {
    const relations = resourceGrantRelationsSelect();
    const facts: ResourceGrantAccessFacts = { ownerAccountId: input.ownerAccountId, encryptionMode: null,
        accountGrants: [], teamGrants: [], groupGrants: [] };
    const principal = input.principal;
    if (principal.kind === 'account') {
        const account = await tx.account.findUnique({ where: { id: principal.accountId }, select: { status: true } });
        if (account) facts.accountGrants = [{ accountId: principal.accountId, accessLevel: 'view', account }];
    } else if (principal.kind === 'team') {
        const team = await tx.team.findUnique({ where: { id: principal.teamId }, select: relations.teamGrants.select.team.select });
        if (team) facts.teamGrants = [{ accessLevel: 'view', team }];
    } else {
        const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId },
            select: { ...relations.groupGrants.select.teamGroup.select, teamId: true } });
        if (group?.teamId === principal.teamId) facts.groupGrants = [{ accessLevel: 'view', teamGroup: group }];
    }
    return resolveResourceGrantAudienceFromFacts(facts);
}

/** Admins manage ordinary grants; assigning admin remains an owner operation. */
export function mayManageResourceGrants(access: ResourceGrantAccess, nextLevel?: ResourceAccessLevelV1): boolean {
    return access.level === 'owner' || (access.level === 'admin' && nextLevel !== 'admin');
}

/** Validate a grant's current principal without adding a membership or key authority. */
export async function validateResourceGrantPrincipalInTx(tx: Tx, ownerAccountId: string, principal: PrincipalRefV1):
    Promise<'owner_grant_invalid' | 'subject_not_found' | 'subject_ineligible' | null> {
    if (principal.kind === 'account') {
        if (principal.accountId === ownerAccountId) return 'owner_grant_invalid';
        const account = await tx.account.findUnique({ where: { id: principal.accountId }, select: { status: true } });
        return !account ? 'subject_not_found' : account.status !== 'active' ? 'subject_ineligible' : null;
    }
    if (principal.kind === 'team') {
        const team = await tx.team.findUnique({ where: { id: principal.teamId }, select: { archivedAt: true } });
        return !team ? 'subject_not_found' : team.archivedAt ? 'subject_ineligible' : null;
    }
    const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: {
        teamId: true, archivedAt: true, team: { select: { archivedAt: true } },
    } });
    return !group || group.teamId !== principal.teamId ? 'subject_not_found'
        : group.archivedAt || group.team.archivedAt ? 'subject_ineligible' : null;
}

export interface ResourceStoredRecipientEnvelope {
    encryptedDataKey: Uint8Array;
    recipientContentPublicKeyFingerprint: string;
}

/** A stored tuple is usable only with the recipient's current verified binding. */
export function projectResourceRecipientEnvelope(account: AccountRecipientEnvelopeReadinessRow, envelope: ResourceStoredRecipientEnvelope,
    readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account)): Uint8Array<ArrayBuffer> | null {
    return readiness.status === 'available'
        && readiness.binding.contentPublicKeyFingerprint === envelope.recipientContentPublicKeyFingerprint
        && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null
        ? new Uint8Array(envelope.encryptedDataKey) : null;
}

/** Shared content census; optional resource-specific key channels compose this projection. */
export function projectResourceRecipientCensusRow(input: Readonly<{
    access: ResourceGrantAccess;
    ownerDataEncryptionKey: Uint8Array;
    account: RecipientReadinessRow;
    readiness: AccountRecipientEnvelopeReadiness;
    envelope?: ResourceStoredRecipientEnvelope;
}>) {
    const { access, account, readiness, envelope } = input;
    const plain = access.encryptionMode === 'plain';
    const fingerprint = readiness.status === 'available' ? readiness.binding.contentPublicKeyFingerprint : null;
    const ownerEnvelope = !plain && account.id === access.ownerAccountId && fingerprint !== null
        && parseEncryptedDataKeyEnvelopeV1(input.ownerDataEncryptionKey) !== null;
    const current = !plain && envelope && fingerprint === envelope.recipientContentPublicKeyFingerprint
        && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null;
    return {
        recipientAccountId: account.id, contentKey: projectRecipientContentKey(account, readiness),
        contentPublicKeyFingerprint: fingerprint,
        encryptedDataKey: ownerEnvelope ? privacyKit.encodeBase64(new Uint8Array(input.ownerDataEncryptionKey))
            : current ? privacyKit.encodeBase64(new Uint8Array(envelope.encryptedDataKey)) : null,
        recipientContentPublicKeyFingerprint: ownerEnvelope ? fingerprint : envelope?.recipientContentPublicKeyFingerprint ?? null,
    };
}

/** Address-free census policy shared by resource-specific response adapters. */
export function projectResourceRecipientCensus(input: Readonly<{
    access: ResourceGrantAccess;
    ownerDataEncryptionKey: Uint8Array;
    callerDataEncryptionKey: Uint8Array | null;
    accounts: readonly Readonly<{ account: RecipientReadinessRow; readiness: AccountRecipientEnvelopeReadiness }>[];
    envelopes: readonly (ResourceStoredRecipientEnvelope & Readonly<{ recipientAccountId: string }>)[];
}>) {
    const { access } = input;
    if (!access.encryptionMode) return { ok: false, error: 'content_unavailable' } as const;
    const plain = access.encryptionMode === 'plain';
    const callerKey = plain ? null : access.level === 'owner' ? new Uint8Array(input.ownerDataEncryptionKey) : input.callerDataEncryptionKey;
    if (!plain && !callerKey) return { ok: false, error: 'content_unavailable' } as const;
    const byAccount = new Map(input.envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
    return { ok: true, value: {
        ownerAccountId: access.ownerAccountId, access: access.level, encryptionMode: access.encryptionMode,
        dataEncryptionKey: plain ? null : privacyKit.encodeBase64(new Uint8Array(input.ownerDataEncryptionKey)),
        callerDataEncryptionKey: callerKey ? privacyKit.encodeBase64(new Uint8Array(callerKey)) : null,
        recipients: input.accounts.map(({ account, readiness }) => projectResourceRecipientCensusRow({
            access, ownerDataEncryptionKey: input.ownerDataEncryptionKey, account, readiness, envelope: byAccount.get(account.id),
        })),
    } } as const;
}

/** Shared structural framing owner for both first-share and subsequent key commits. */
export function validateResourceRecipientKeyEnvelopes(envelopes: readonly ResourceRecipientKeyEnvelopeInputV1[]): boolean {
    return envelopes.every(envelope => parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(envelope.encryptedDataKey)) !== null);
}

/** Owner-key fence and structural envelope validation precede every resource commit. */
export function validateResourceRecipientEnvelopeCommit(input: Readonly<{
    ownerDataEncryptionKey: Uint8Array;
    expectedDataEncryptionKey: string;
    recipientKeyEnvelopes: readonly ResourceRecipientKeyEnvelopeInputV1[];
}>): 'data_key_changed' | 'invalid_recipient_envelope' | null {
    if (!isDeepStrictEqual(new Uint8Array(input.ownerDataEncryptionKey), privacyKit.decodeBase64(input.expectedDataEncryptionKey))) return 'data_key_changed';
    return validateResourceRecipientKeyEnvelopes(input.recipientKeyEnvelopes) ? null : 'invalid_recipient_envelope';
}

export interface ResourceRecipientEnvelopeStorageAdapter<Envelope extends ResourceRecipientKeyEnvelopeInputV1> extends ResourceGrantStorageAdapter {
    writeRecipientEnvelopeInTx(tx: Tx, resourceId: string, envelope: Envelope): Promise<void>;
    publishRecipientsChangedInTx(tx: Tx, resourceId: string, accountIds: readonly string[]): Promise<void>;
}

/** Fenced commits and Account transitions share the same live recipient admission. */
export async function applyResourceRecipientKeyEnvelopesInTx<Envelope extends ResourceRecipientKeyEnvelopeInputV1>(
    tx: Tx, adapter: ResourceRecipientEnvelopeStorageAdapter<Envelope>,
    input: Readonly<{ resourceId: string; recipientKeyEnvelopes: readonly Envelope[] }>,
): Promise<ResourceRecipientKeyEnvelopeCommitResponseV1> {
    const appliedRecipientAccountIds: string[] = [];
    const skippedRecipientAccountIds: string[] = [];
    const recipientIds = [...new Set(input.recipientKeyEnvelopes.map(envelope => envelope.recipientAccountId))];
    const accounts = recipientIds.length === 0 ? [] : await tx.account.findMany({
        where: { id: { in: recipientIds } }, select: RECIPIENT_READINESS_SELECT,
    });
    // Decisions share one in-transaction fact snapshot; subsequent grant removal is enforced by live resource reads.
    const facts = recipientIds.length === 0 ? null : await adapter.readAccessFactsInTx(tx, input.resourceId);
    const accountsById = new Map(accounts.map(account => [account.id, account]));
    for (const envelope of input.recipientKeyEnvelopes) {
        const account = accountsById.get(envelope.recipientAccountId);
        const access = facts ? resolveResourceGrantAccessFromFacts(facts, envelope.recipientAccountId) : null;
        const readiness = account ? deriveAccountRecipientEnvelopeReadinessFromRow(account) : null;
        if (!access || access.level === 'owner' || readiness?.status !== 'available'
            || readiness.binding.contentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint) {
            skippedRecipientAccountIds.push(envelope.recipientAccountId);
            continue;
        }
        await adapter.writeRecipientEnvelopeInTx(tx, input.resourceId, envelope);
        appliedRecipientAccountIds.push(envelope.recipientAccountId);
    }
    await adapter.publishRecipientsChangedInTx(tx, input.resourceId, appliedRecipientAccountIds);
    return { appliedRecipientAccountIds, skippedRecipientAccountIds };
}

function hasEffectiveTeamGrant(grant: ResourceGrantAccessFacts['teamGrants'][number], actorAccountId: string): boolean {
    return grant.team.memberships.some(member => member.accountId === actorAccountId && isEffectiveTeamMembership({
        accountStatus: member.account.status, membershipStatus: member.status, teamArchivedAt: grant.team.archivedAt,
    }));
}

/** The caller's direct Team audience, using the same membership policy as access admission. */

export function resolveResourceGrantTeamIdsFromFacts(row: ResourceGrantAccessFacts, actorAccountId: string): string[] {
    return row.teamGrants.flatMap(grant => grant.teamId !== undefined && hasEffectiveTeamGrant(grant, actorAccountId) ? [grant.teamId] : []);
}

/** Database projection of the same grant policy below, for candidate lists and aggregate counts.
 * The actor and lifecycle predicates must match the SAME membership row.
 * Resource adapters still own visibility and final private-content admission.
 */
