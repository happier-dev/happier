import type { TeamMembershipV1 } from '@happier-dev/protocol/teams';

import type { AccountDisplayPresentation } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';

import { teamRoleLabel } from '../teamLabels';

/**
 * The one line under a member's name wherever the roster is listed — the Members page and the
 * Members rail (lab `tsMembers-A`/`P`): their role, "You" on the viewer's own row, what tells an
 * unnamed Account apart, and the directory that manages them, by its name.
 */
export function teamMemberRowSubtitle(
  membership: TeamMembershipV1,
  person: AccountDisplayPresentation,
  /** The membership's age, already formatted, where the row has room for it (the Members page). */
  joined?: string,
): string {
  return [
    teamRoleLabel(membership.role),
    person.viewer && person.named ? t('teams.members.you') : null,
    person.hint,
    membership.management.kind === 'native' ? null : membership.management.label,
    joined ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/**
 * What removing a member does, as lines for the confirmation (lab `tsMembers-X`): what ends, the
 * Groups they leave by name, and what stays. A Group list that was only partly read is never
 * presented as the whole of it.
 */
export function teamMemberRemovalLines(
  input: Readonly<{
    groupNames: readonly string[];
    /** More Groups exist than were read, or the list has not answered. */
    moreGroups: boolean;
  }>,
): readonly string[] {
  const lines = [t('teams.members.removal.ends')];
  if (input.groupNames.length > 0) {
    const groups = input.groupNames.join(', ');
    lines.push(
      input.moreGroups
        ? t('teams.members.removal.leavesGroupsAndMore', { groups })
        : t('teams.members.removal.leavesGroups', { groups }),
    );
  }
  lines.push(t('teams.members.removal.kept'));
  return lines;
}

/** `native`, or the id of a directory source that manages (or could manage) the membership. */
export type TeamMemberManagementChoiceId = string;

/**
 * Who can manage this membership (lab `tsMembers-D`): the source that manages it now first, then
 * the Team's other directory sources, then Happier. The managing source stays a choice even when the
 * sources could not be read, named as the membership itself names it.
 */
export function resolveTeamMemberManagementChoices(
  membership: TeamMembershipV1,
  sources: readonly Readonly<{ id: string; displayName: string }>[],
): Readonly<{
  selectedId: TeamMemberManagementChoiceId;
  options: readonly Readonly<{ id: TeamMemberManagementChoiceId; label: string }>[];
}> {
  const management = membership.management;
  // A membership a sign-in connection manages is not bound to a directory source; it is still
  // shown as the current choice, under an id no source can have.
  const bound =
    management.kind === 'native'
      ? null
      : {
          id:
            management.kind === 'directory_source'
              ? management.directorySourceId
              : `identity_connection:${management.identityConnectionId}`,
          label: management.label,
        };
  const options = [
    ...(bound ? [bound] : []),
    ...sources
      .filter((source) => source.id !== bound?.id)
      .map((source) => ({ id: source.id, label: source.displayName })),
    { id: 'native', label: t('teams.members.managementNative') },
  ];
  return { selectedId: bound?.id ?? 'native', options };
}
