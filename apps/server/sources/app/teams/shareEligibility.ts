import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';
import { AccountStatus, TeamMembershipStatus } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

export type ShareSubject = Readonly<PrincipalRefV1>;


export type ShareSubjectError =
  | 'subject_not_found'
  | 'subject_ineligible'
  | 'owner_grant_invalid'
  | 'self_grant_invalid';


export type ShareSubjectResolution =
  | Readonly<{ ok: true; subject: ShareSubject }>
  | Readonly<{ ok: false; error: ShareSubjectError }>;

/** Reject Account grant identities that can never be valid, even for an absent-row removal retry. */

export function validateShareAccountSubjectIdentity(
  params: Readonly<{
    actorAccountId: string;
    resourceOwnerAccountId: string;
    subjectAccountId: string;
  }>,
): Extract<
  ShareSubjectError,
  'owner_grant_invalid' | 'self_grant_invalid'
> | null {
  if (params.subjectAccountId === params.resourceOwnerAccountId)
    return 'owner_grant_invalid';
  if (params.subjectAccountId === params.actorAccountId)
    return 'self_grant_invalid';
  return null;
}

/**
 * Resolve a complete Account-subject set with the same decision as the
 * single-subject path, without turning audience size into an N+1 transaction
 * timeout. Results preserve input order and duplicates.
 */

export async function resolveShareAccountSubjectsInTx(
  tx: Tx,
  params: Readonly<{
    actorAccountId: string;
    resourceOwnerAccountId: string;
    subjectAccountIds: readonly string[];
    hasExistingGrant: boolean;
    removingExistingGrant?: boolean;
  }>,
): Promise<readonly ShareSubjectResolution[]> {
  const identityErrors = new Map<string, ShareSubjectError>();
  for (const subjectAccountId of params.subjectAccountIds) {
    const error = validateShareAccountSubjectIdentity({
      actorAccountId: params.actorAccountId,
      resourceOwnerAccountId: params.resourceOwnerAccountId,
      subjectAccountId,
    });
    if (error) identityErrors.set(subjectAccountId, error);
  }
  const candidateIds = [
    ...new Set(
      params.subjectAccountIds.filter((id) => !identityErrors.has(id)),
    ),
  ];
  const accounts = (
    await Promise.all(
      portableQueryChunks({
        values: candidateIds,
        bindingsPerValue: 1,
        fixedBindings: 1,
      }).map((ids) =>
        tx.account.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, status: true },
        }),
      ),
    )
  ).flat();
  const accountsById = new Map(
    accounts.map((account) => [account.id, account]),
  );
  const eligibleIds =
    params.removingExistingGrant ||
    params.hasExistingGrant ||
    candidateIds.length === 0
      ? new Set(candidateIds)
      : new Set(
          (
            await Promise.all(
              portableQueryChunks({
                values: candidateIds,
                bindingsPerValue: 1,
                fixedBindings: 10,
              }).map((ids) =>
                tx.account.findMany({
                  where: {
                    AND: [
                      { id: { in: [...ids] } },
                      buildShareEligibleAccountWhere(params.actorAccountId),
                    ],
                  },
                  select: { id: true },
                }),
              ),
            )
          )
            .flat()
            .map((account) => account.id),
        );

  return params.subjectAccountIds.map((accountId): ShareSubjectResolution => {
    const identityError = identityErrors.get(accountId);
    if (identityError) return { ok: false, error: identityError };
    const account = accountsById.get(accountId);
    if (!account) return { ok: false, error: 'subject_not_found' };
    if (params.removingExistingGrant)
      return { ok: true, subject: { kind: 'account', accountId } };
    if (
      account.status !== AccountStatus.active ||
      !eligibleIds.has(accountId)
    ) {
      return { ok: false, error: 'subject_ineligible' };
    }
    return { ok: true, subject: { kind: 'account', accountId } };
  });
}

/**
 * Accounts the actor may newly share with: accepted friends (the released source)
 * and active co-members of a current Team, because colleagues on the same Home
 * Team are exactly as legitimate. The collaboration directory projects the same
 * predicate so people pickers offer only these Accounts.
 */

export function buildShareEligibleAccountWhere(
  actorAccountId: string,
): Prisma.AccountWhereInput {
  return {
    id: { not: actorAccountId },
    status: AccountStatus.active,
    OR: [
      {
        RelationshipsFrom: {
          some: { toUserId: actorAccountId, status: 'friend' },
        },
      },
      {
        RelationshipsTo: {
          some: { fromUserId: actorAccountId, status: 'friend' },
        },
      },
      {
        teamMemberships: {
          some: {
            status: TeamMembershipStatus.active,
            team: {
              archivedAt: null,
              memberships: {
                some: {
                  accountId: actorAccountId,
                  status: TeamMembershipStatus.active,
                },
              },
            },
          },
        },
      },
    ],
  };
}

/**
 * Resolve and validate one grant subject inside the deciding transaction.
 *
 * Eligibility is re-proved here rather than at request admission because a
 * friendship, membership, Team, or Group can disappear between the picker's
 * suggestion and the commit.
 */
