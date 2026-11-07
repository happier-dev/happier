import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
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

type CurrentSessionRecipientParams = Readonly<{
  sessionIds: readonly string[];
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
    fixedBindings: 4,
  })) {
    const sessions = await tx.session.findMany({
      where: { id: { in: [...sessionIdChunk] } },
      select: {
        id: true,
        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        account: { select: { status: true } },
      },
    });
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
      const shares = await tx.sessionShare.findMany({
        where: {
          sessionId: { in: shareableSessionIds },
          ...(params.includeInactiveAccounts
            ? {}
            : { sharedWithUser: { status: 'active' as const } }),
        },
        select: { sessionId: true, sharedWithUserId: true },
      });
      for (const share of shares) {
        recipientsBySessionId.get(share.sessionId)?.add(share.sharedWithUserId);
      }
    }

    if (shareableSessionIds.length > 0 && isSessionCollaborationEnabled()) {
      teamGrants.push(...await tx.sessionTeamGrant.findMany({
        where: {
          sessionId: { in: shareableSessionIds },
          team: { archivedAt: null },
        },
        select: {
          sessionId: true,
          effectiveAt: true,
          teamId: true,
        },
      }));

      groupGrants.push(...await tx.sessionGroupGrant.findMany({
        where: {
          sessionId: { in: shareableSessionIds },
          teamGroup: { archivedAt: null, team: { archivedAt: null } },
        },
        select: {
          sessionId: true,
          effectiveAt: true,
          teamGroupId: true,
        },
      }));
    }
  }

  const membershipWhere = (includeGuests: boolean) => {
    const where = buildCurrentSessionAccessMembershipWhere(includeGuests);
    if (params.includeInactiveAccounts) delete where.account;
    return where;
  };
  // The same Team/Group can grant many Sessions. Fetch its current membership
  // once across all Session chunks, then apply each grant's individual horizon.
  const teamMemberships = new Map<string, Array<{ accountId: string; sessionAccessStartsAt: Date | null }>>();
  for (const teamIds of portableQueryChunks({ values: [...new Set(teamGrants.map(grant => grant.teamId))],
    bindingsPerValue: 1, fixedBindings: 4 })) {
    const memberships = await tx.teamMembership.findMany({
      where: { teamId: { in: [...teamIds] }, ...membershipWhere(false) },
      select: { teamId: true, accountId: true, sessionAccessStartsAt: true },
    });
    for (const membership of memberships) {
      const members = teamMemberships.get(membership.teamId) ?? [];
      members.push(membership);
      teamMemberships.set(membership.teamId, members);
    }
  }
  for (const grant of teamGrants) {
    const recipients = recipientsBySessionId.get(grant.sessionId);
    for (const membership of teamMemberships.get(grant.teamId) ?? []) {
      if (isGrantAfterMembershipHorizon(grant.effectiveAt, membership.sessionAccessStartsAt)) {
        recipients?.add(membership.accountId);
      }
    }
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
    for (const membership of groupMemberships.get(grant.teamGroupId) ?? []) {
      if (isGrantAfterMembershipHorizon(grant.effectiveAt, membership.sessionAccessStartsAt)) {
        recipients?.add(membership.teamMembership.accountId);
      }
    }
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
  params: Readonly<{ sessionId: string }>,
): Promise<string[]> {
  if (!params.sessionId) return [];
  const recipients =
    await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
      sessionIds: [params.sessionId],
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
