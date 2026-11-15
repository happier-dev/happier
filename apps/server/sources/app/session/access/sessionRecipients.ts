import { iterateResourceGrantPrincipalAccountIdsFromFacts, projectResourceGrantRows } from '@/app/teams/resourceGrantAccess';
import type { TeamRoleV1 } from '@happier-dev/protocol/teams';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { TEAM_PRINCIPAL_ROLES_V1 } from '@happier-dev/protocol/teams';
import {
  buildCurrentSessionAccessMembershipWhere,
  isGrantAfterMembershipHorizon,
  isSessionCollaborationEnabled,
} from './sessionAccess';
import { buildSessionReadableAccountWhereInTx } from './sessionAccessWhere';
import {
  isSessionTranscriptShareable,
  SESSION_TRANSCRIPT_PUBLICATION_SELECT,
  type SessionTranscriptPublicationFields,
} from '@/app/session/sessionTranscriptPublicationPolicy';

/** The Session facts the recipient census reads; an access projection row carries them. */
export type CurrentSessionRecipientSessionRow = Readonly<SessionTranscriptPublicationFields & {
  id: string;
  accountId: string;
  account: Readonly<{ status: string }>;
}>;

type CurrentSessionRecipientParams = Readonly<{
  sessionIds: readonly string[];
  /** Rows of these Sessions this transaction already read (after its Session lock); not read again. */
  sessions?: readonly CurrentSessionRecipientSessionRow[];
  /** Publication fences also cover grants that the pending write can expose. */
  includeUnpublishedGrants?: boolean;
  /** Account reactivation must wait behind a fence for its retained grant. */
  includeInactiveAccounts?: boolean;
}>;

/**
 * Resolve complete current structural recipients for several Sessions in one
 * transaction snapshot. The Session-id map is the batch form of the point
 * resolver below; it does not expose grant/membership topology to callers.
 */
export async function resolveCurrentSessionRecipientAccountIdsBySessionInTx(
  tx: Tx,
  params: CurrentSessionRecipientParams,
): Promise<ReadonlyMap<string, readonly string[]>> {
  return resolveCurrentSessionRecipientsInTx(tx, params);
}

async function resolveCurrentSessionRecipientsInTx(
  tx: Tx,
  params: CurrentSessionRecipientParams,
  onPublicationRead?: (publication: SessionTranscriptPublicationFields) => void,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const sessionIds = [...new Set(params.sessionIds.filter(Boolean))];
  const recipientsBySessionId = new Map<string, Set<string>>(
    sessionIds.map((sessionId) => [sessionId, new Set<string>()]),
  );
  if (sessionIds.length === 0) return new Map();
  const teamGrants: Array<{ sessionId: string; teamId: string; effectiveAt: Date }> = [];
  const groupGrants: Array<{ sessionId: string; teamGroupId: string; effectiveAt: Date }> = [];

  // Relation predicates and Prisma offset share the portable bind budget.
  for (const sessionIdChunk of portableQueryChunks({
    values: sessionIds,
    bindingsPerValue: 1,
    fixedBindings: 5,
  })) {
    const known = params.sessions?.filter(session => sessionIdChunk.includes(session.id)) ?? [];
    const unread = sessionIdChunk.filter(sessionId => !known.some(session => session.id === sessionId));
    const sessions: readonly CurrentSessionRecipientSessionRow[] = unread.length === 0 ? known : [...known, ...await tx.session.findMany({
      where: { id: { in: unread } },
      select: {
        id: true,
        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        account: { select: { status: true } },
      },
    })];
    const shareableSessionIds: string[] = [];
    for (const session of sessions) {
      onPublicationRead?.(session);
      if (
        params.includeInactiveAccounts ||
        session.account.status === 'active'
      ) {
        recipientsBySessionId.get(session.id)?.add(session.accountId);
      }
      if (
        params.includeUnpublishedGrants ||
        isSessionTranscriptShareable(session)
      )
        shareableSessionIds.push(session.id);
    }

    if (shareableSessionIds.length > 0) {
      const grants = await tx.sessionGrant.findMany({
        where: { sessionId: { in: shareableSessionIds }, OR: [
          { principalKind: 'account', ...(params.includeInactiveAccounts ? {} : { account: { status: 'active' as const } }) },
          ...(isSessionCollaborationEnabled() ? [
            { principalKind: 'team', team: { archivedAt: null } },
            { principalKind: 'group', teamGroup: { archivedAt: null, team: { archivedAt: null } } },
          ] : []),
        ] },
        select: { sessionId: true, principalKind: true, accountId: true, teamId: true, teamGroupId: true, effectiveAt: true },
      });
      const projected = projectResourceGrantRows(grants);
      for (const grant of projected.accountGrants) recipientsBySessionId.get(grant.sessionId)?.add(grant.accountId);
      teamGrants.push(...projected.teamGrants.map(grant => ({ sessionId: grant.sessionId, teamId: grant.teamId, effectiveAt: grant.effectiveAt! })));
      groupGrants.push(...projected.groupGrants.map(grant => ({ sessionId: grant.sessionId, teamGroupId: grant.teamGroupId, effectiveAt: grant.effectiveAt! })));
    }
  }

  const membershipWhere = (includeGuests: boolean) => {
    const where = buildCurrentSessionAccessMembershipWhere(includeGuests);
    if (params.includeInactiveAccounts) delete where.account;
    return where;
  };
  // The same Team/Group can grant many Sessions. Fetch its current membership
  // once across all Session chunks, then apply each grant's individual horizon.
  const teamMemberships = new Map<string, Array<{ accountId: string; role: TeamRoleV1; sessionAccessStartsAt: Date | null }>>();
  // Membership status, Account status and Prisma OFFSET accompany the role bindings.
  for (const teamIds of portableQueryChunks({ values: [...new Set(teamGrants.map(grant => grant.teamId))],
    bindingsPerValue: 1, fixedBindings: 3 + TEAM_PRINCIPAL_ROLES_V1.length })) {
    const memberships = await tx.teamMembership.findMany({
      where: { teamId: { in: [...teamIds] }, ...membershipWhere(false) },
      select: { teamId: true, accountId: true, role: true, sessionAccessStartsAt: true },
    });
    for (const membership of memberships) {
      const members = teamMemberships.get(membership.teamId) ?? [];
      members.push(membership);
      teamMemberships.set(membership.teamId, members);
    }
  }
  for (const grant of teamGrants) {
    const recipients = recipientsBySessionId.get(grant.sessionId);
    const principal = { kind: 'team' as const, memberships: (teamMemberships.get(grant.teamId) ?? []).map(member => ({
      accountId: member.accountId, role: member.role,
      effective: isGrantAfterMembershipHorizon(grant.effectiveAt, member.sessionAccessStartsAt),
    })) };
    for (const accountId of iterateResourceGrantPrincipalAccountIdsFromFacts(principal)) recipients?.add(accountId);
  }

  const groupMemberships = new Map<string, Array<{ sessionAccessStartsAt: Date | null; teamMembership: { accountId: string } }>>();
  for (const groupIds of portableQueryChunks({ values: [...new Set(groupGrants.map(grant => grant.teamGroupId))],
    bindingsPerValue: 1, fixedBindings: 4 })) {
    const memberships = await tx.teamGroupMembership.findMany({
      where: { teamGroupId: { in: [...groupIds] }, teamMembership: membershipWhere(true) },
      select: { teamGroupId: true, sessionAccessStartsAt: true, teamMembership: { select: { accountId: true } } },
    });
    for (const membership of memberships) {
      const members = groupMemberships.get(membership.teamGroupId) ?? [];
      members.push(membership);
      groupMemberships.set(membership.teamGroupId, members);
    }
  }
  for (const grant of groupGrants) {
    const recipients = recipientsBySessionId.get(grant.sessionId);
    const principal = { kind: 'group' as const, memberships: (groupMemberships.get(grant.teamGroupId) ?? []).map(member => ({
      accountId: member.teamMembership.accountId,
      effective: isGrantAfterMembershipHorizon(grant.effectiveAt, member.sessionAccessStartsAt),
    })) };
    for (const accountId of iterateResourceGrantPrincipalAccountIdsFromFacts(principal)) recipients?.add(accountId);
  }

  const result = new Map<string, readonly string[]>();
  for (const [sessionId, accountIds] of recipientsBySessionId) {
    result.set(sessionId, [...accountIds].sort());
  }
  return result;
}

/** Reuse the publication facts already read by the current audience owner. */
export async function readCurrentSessionPublicationAudienceInTx(
  tx: Tx,
  params: Readonly<{ sessionId: string }>,
): Promise<Readonly<{
  publication: SessionTranscriptPublicationFields;
  recipientAccountIds: readonly string[];
}>> {
  // Match the publication policy's fail-closed missing-Session projection.
  let publication: SessionTranscriptPublicationFields = { currentStorageState: 'legacy_external_unknown' };
  const recipients = await resolveCurrentSessionRecipientsInTx(
    tx,
    { sessionIds: [params.sessionId] },
    row => { publication = row; },
  );
  return { publication, recipientAccountIds: recipients.get(params.sessionId) ?? [] };
}

/** Access recipients are synchronization targets, never notification interest. */
export async function resolveCurrentSessionRecipientAccountIdsInTx(
  tx: Tx,
  params: Readonly<{ sessionId: string; session?: CurrentSessionRecipientSessionRow }>,
): Promise<string[]> {
  if (!params.sessionId) return [];
  const recipients =
    await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
      sessionIds: [params.sessionId],
      ...(params.session ? { sessions: [params.session] } : {}),
    });
  return [...(recipients.get(params.sessionId) ?? [])];
}

/** The read-only fanout wrapper keeps the complete census in one current transaction. */
export async function resolveCurrentSessionRecipientAccountIds(
  params: Readonly<{ sessionId: string }>,
): Promise<string[]> {
  return inReadSnapshot((tx) =>
    resolveCurrentSessionRecipientAccountIdsInTx(tx, params),
  );
}

/**
 * Resolve the complete current structural audience, including grants whose
 * transcript is not yet publishable. Deletion/access-ended hints use it to
 * retire every retained row, and policy checks use it instead of interpreting
 * stored grant rows as if archived or expired sources were still effective.
 */
export async function resolveSessionGrantedAccountIdsInTx(
  tx: Tx,
  params: Readonly<{ sessionId: string }>,
): Promise<string[]> {
  if (!params.sessionId) return [];
  const where = await buildSessionReadableAccountWhereInTx({
    tx,
    sessionId: params.sessionId,
    includeUnpublishedGrants: true,
  });
  const rows = await tx.account.findMany({
    where,
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}
