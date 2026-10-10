import type {
  TeamInvitationRowV1,
  TeamSummaryV1,
} from '@happier-dev/protocol/teams';

import { t } from '@/text';

import { resolveTeamInvitationPresentation } from './invitations/teamInvitationPresentation';
import {
  teamAcceptedSignInSummary,
  teamAdmissionModeLabel,
} from './teamPolicyPresentation';

/**
 * What each Team Overview row says before its chevron (DR-12, lab `tsOverview-A`): the current
 * value, from facts the Team projection and the destinations' own reads already carry. A count the
 * viewer may not read is absent from the projection, and its row falls back to what the destination
 * is for rather than inventing one.
 */
export function teamOverviewMembersSummary(team: TeamSummaryV1): string {
  const counts = team.counts;
  if (!counts) return t('teams.pages.members');
  if (counts.members <= 1 && team.viewerRole !== null)
    return t('teams.overview.summary.justYou');
  const people = t('teams.overview.summary.people', { count: counts.members });
  return counts.suspendedMembers > 0
    ? `${people} · ${t('teams.overview.summary.suspended', { count: counts.suspendedMembers })}`
    : people;
}

/** `directoryNames`: the directories that keep this Team's Groups in step, when the viewer can read them. */
export function teamOverviewGroupsSummary(
  team: TeamSummaryV1,
  directoryNames: readonly string[],
): string {
  const counts = team.counts;
  if (!counts) return t('teams.pages.groups');
  const groups =
    counts.groups === 0
      ? t('teams.overview.summary.noGroups')
      : t('teams.overview.summary.groups', { count: counts.groups });
  return directoryNames.length > 0 && counts.groups > 0
    ? `${groups} · ${t('teams.overview.summary.groupsDirectory', { directory: directoryNames.join(', ') })}`
    : groups;
}

/** `undelivered`: waiting invitations whose email did not arrive; trouble leads the line. */
export function teamOverviewInvitationsSummary(
  team: TeamSummaryV1,
  undelivered: number,
): string {
  const waiting = team.counts?.waitingInvitations ?? null;
  const summary =
    waiting === null
      ? t('teams.pages.invitations')
      : waiting === 0
        ? t('teams.overview.summary.noneWaiting')
        : t('teams.overview.summary.waiting', { count: waiting });
  return undelivered > 0
    ? `${t('teams.overview.summary.undelivered', { count: undelivered })} · ${summary}`
    : summary;
}

export function teamOverviewAuthenticationSummary(
  team: TeamSummaryV1,
  homeName: string,
  directoryNames: readonly string[],
): string {
  return [
    teamAcceptedSignInSummary(team.policy, homeName),
    teamAdmissionModeLabel(team.policy.admissionMode),
    ...directoryNames,
  ].join(' · ');
}

/** `count`: how many credentials are shared, or `null` while that cannot be said truthfully. */
export function teamOverviewCredentialsSummary(
  count: number | null,
  teamName: string,
): string {
  if (count === null) return t('teams.pages.credentials');
  return count === 0
    ? t('teams.overview.summary.credentialsNone')
    : t('teams.overview.summary.credentialsShared', { count, team: teamName });
}

export function teamOverviewSettingsSummary(team: TeamSummaryV1): string {
  const sessions =
    team.policy.sessionCreationPolicy === 'private_default'
      ? t('teams.overview.summary.sessionsPrivate')
      : team.policy.sessionCreationPolicy === 'team_default'
        ? t('teams.overview.summary.sessionsShared')
        : t('teams.overview.summary.sessionsAlwaysShared');
  const history =
    team.policy.defaultSessionHistoryAccess === 'all_existing'
      ? t('teams.overview.summary.historyEarlier')
      : t('teams.overview.summary.historyFromJoining');
  return `${sessions} · ${history}`;
}

export type TeamOverviewAttentionItem =
  | Readonly<{ kind: 'directory_failed'; sourceId: string; name: string }>
  | Readonly<{
      kind: 'invitation_undelivered';
      invitationId: string;
      recipient: string;
    }>;

/**
 * What needs the Team's managers (lab `tsOverview-T`): a directory that could not sync, then a
 * waiting invitation whose email did not arrive. Healthy is empty, and the section is not drawn.
 * Whether an email is undelivered is the invitation presenter's answer, not a second rule here.
 */
export function resolveTeamOverviewAttention(
  input: Readonly<{
    sources: readonly Readonly<{
      id: string;
      displayName: string;
      failed: boolean;
    }>[];
    invitations: readonly TeamInvitationRowV1[];
    now: number;
  }>,
): readonly TeamOverviewAttentionItem[] {
  const items: TeamOverviewAttentionItem[] = [];
  for (const source of input.sources) {
    if (source.failed)
      items.push({
        kind: 'directory_failed',
        sourceId: source.id,
        name: source.displayName,
      });
  }
  for (const invitation of input.invitations) {
    if (
      invitation.recipientEmailMask !== null &&
      resolveTeamInvitationPresentation(invitation, input.now).emailUndelivered
    )
      items.push({
        kind: 'invitation_undelivered',
        invitationId: invitation.id,
        recipient: invitation.recipientEmailMask,
      });
  }
  return items;
}
