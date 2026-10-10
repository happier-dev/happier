import type { TeamSummaryV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';

/**
 * What archiving a Team does, as lines for the confirmation (lab `tsSettings-X`): what is kept, the
 * one thing that does not come back — waiting invitation links, said only when there are some — and
 * the way back. Counts come from the Team projection; a viewer who cannot read them still gets the
 * same promises without numbers.
 */
export function teamArchiveConfirmationLines(
  team: TeamSummaryV1,
): readonly string[] {
  const counts = team.counts;
  const lines = [
    counts
      ? t('teams.archive.confirm.keptCounted', {
          members: counts.members,
          groups: counts.groups,
        })
      : t('teams.archive.confirm.kept'),
  ];
  const waiting = counts?.waitingInvitations ?? 0;
  if (waiting > 0) {
    lines.push(t('teams.archive.confirm.invitationsStop', { count: waiting }));
  }
  lines.push(t('teams.archive.confirm.restore'));
  return lines;
}
