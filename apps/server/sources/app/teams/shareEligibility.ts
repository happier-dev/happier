import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';
import { AccountStatus, TeamMembershipStatus } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { resolveGrantableTeamsForActorInTx } from '@/app/teams/queries';
import { resolveGrantableTeamGroupsForActorInTx } from '@/app/teams/groups/groupService';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

/**
 * The one share-eligibility rule for every shareable resource (Sessions, Machines,
 * Artifacts and Projects, Discussions, Saved Secrets, Project Sources): a new share
 * may name a friend, a teammate, or a Team (or one of its Groups) the sharer
 * belongs to. It decides admission of NEW shares only; an existing grant stays
 * editable and removable after the relationship ends, and is never swept.
 */
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
export async function resolveShareSubjectInTx(
  tx: Tx,
  params: Readonly<{
    actorAccountId: string;
    resourceOwnerAccountId: string;
    subject: ShareSubject;
    /** An existing grant may be edited or downgraded after discovery eligibility ends. */
    hasExistingGrant: boolean;
    /** Removal remains possible after the existing subject becomes inactive or archived. */
    removingExistingGrant?: boolean;
  }>,
): Promise<ShareSubjectResolution> {
  const [resolved] = await resolveShareSubjectsInTx(tx, {
    ...params,
    subjects: [params.subject],
  });
  return resolved?.eligibility ?? { ok: false, error: 'subject_not_found' };
}

/** Resolve roster subjects together, retaining the writer's distinct removal verdict. */
export async function resolveShareSubjectsInTx(
  tx: Tx,
  params: Readonly<{
    actorAccountId: string;
    resourceOwnerAccountId: string;
    subjects: readonly ShareSubject[];
    hasExistingGrant: boolean;
    removingExistingGrant?: boolean;
  }>,
): Promise<
  readonly Readonly<{
    eligibility: ShareSubjectResolution;
    removalEligibility: ShareSubjectResolution;
  }>[]
> {
  const accountIds = params.subjects.flatMap((subject) =>
    subject.kind === 'account' ? [subject.accountId] : [],
  );
  const accountResolutions = await resolveShareAccountSubjectsInTx(tx, {
    ...params,
    subjectAccountIds: accountIds,
  });
  const accountsById = new Map(
    accountIds.map((id, index) => [id, accountResolutions[index]!]),
  );
  const teamIds = [
    ...new Set(
      params.subjects.flatMap((subject) =>
        subject.kind === 'team' ? [subject.teamId] : [],
      ),
    ),
  ];
  const teams = (
    await Promise.all(
      portableQueryChunks({
        values: teamIds,
        bindingsPerValue: 1,
        fixedBindings: 1,
      }).map((ids) =>
        tx.team.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, archivedAt: true },
        }),
      ),
    )
  ).flat();
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const groupIds = [
    ...new Set(
      params.subjects.flatMap((subject) =>
        subject.kind === 'group' ? [subject.groupId] : [],
      ),
    ),
  ];
  const groups = (
    await Promise.all(
      portableQueryChunks({
        values: groupIds,
        bindingsPerValue: 1,
        fixedBindings: 1,
      }).map((ids) =>
        tx.teamGroup.findMany({
          where: { id: { in: [...ids] } },
          select: {
            id: true,
            teamId: true,
            archivedAt: true,
            team: { select: { archivedAt: true } },
          },
        }),
      ),
    )
  ).flat();
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const needsDiscovery =
    !params.removingExistingGrant && !params.hasExistingGrant;
  const grantableTeamIds = needsDiscovery
    ? await resolveGrantableTeamsForActorInTx(tx, {
        actorAccountId: params.actorAccountId,
        teamIds: [
          ...teamIds,
          ...params.subjects.flatMap((subject) =>
            subject.kind === 'group' ? [subject.teamId] : [],
          ),
        ],
      })
    : new Set<string>();
  const grantableGroups = needsDiscovery
    ? await resolveGrantableTeamGroupsForActorInTx(tx, {
        actorAccountId: params.actorAccountId,
        groups: params.subjects.flatMap((subject) =>
          subject.kind === 'group' ? [subject] : [],
        ),
        grantableTeamIds,
      })
    : new Map<string, never>();
  const results: {
    eligibility: ShareSubjectResolution;
    removalEligibility: ShareSubjectResolution;
  }[] = [];
  for (const subject of params.subjects) {
    let eligibility: ShareSubjectResolution;
    if (subject.kind === 'account') {
      eligibility = accountsById.get(subject.accountId) ?? {
        ok: false,
        error: 'subject_not_found',
      };
    } else if (subject.kind === 'team') {
      const team = teamsById.get(subject.teamId);
      if (!team) eligibility = { ok: false, error: 'subject_not_found' };
      else if (params.removingExistingGrant)
        eligibility = { ok: true, subject };
      else if (
        team.archivedAt !== null ||
        (!params.hasExistingGrant && !grantableTeamIds.has(subject.teamId))
      ) {
        eligibility = { ok: false, error: 'subject_ineligible' };
      } else eligibility = { ok: true, subject };
    } else {
      // The Group row owns its parent Team; never trust the caller's claim.
      const group = groupsById.get(subject.groupId);
      if (!group || group.teamId !== subject.teamId)
        eligibility = { ok: false, error: 'subject_not_found' };
      else if (params.removingExistingGrant)
        eligibility = { ok: true, subject };
      else if (
        group.archivedAt !== null ||
        group.team.archivedAt !== null ||
        (!params.hasExistingGrant &&
          grantableGroups.get(subject.groupId)?.teamId !== subject.teamId)
      ) {
        eligibility = { ok: false, error: 'subject_ineligible' };
      } else eligibility = { ok: true, subject };
    }
    // Ineligibility follows existence and identity validation. Removal skips
    // activity/discovery checks, but never missing or invalid identities.
    const removalEligibility: ShareSubjectResolution =
      eligibility.ok || eligibility.error === 'subject_ineligible'
        ? { ok: true, subject }
        : eligibility;
    results.push({ eligibility, removalEligibility });
  }
  return results;
}
