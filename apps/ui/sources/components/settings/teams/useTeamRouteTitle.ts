import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { useTeamsDirectoryRow } from '@/hooks/teams/useTeamsDirectoryRow';
import { t } from '@/text';

import { resolveSelectedTeamAddress } from './collection/teamsCollection';

/**
 * The name a Team's own page goes by when another page points back to it (a phone sub-page's Back):
 * the Team's name as its page header says it — the Team once read, else the row the Teams directory
 * already holds, else the Teams title the header stands under while it waits. `null` for any path that
 * is not exactly a Team's page.
 */
export function useTeamRouteTitle(pathname: string | null): string | null {
  const normalized = pathname?.replace(/\/+$/, '') ?? '';
  const address = resolveSelectedTeamAddress(normalized);
  const isTeamPage =
    address !== null && normalized.split('/').filter(Boolean).length === 4;
  const binding = useTeamBinding(
    isTeamPage ? address.serverId : '',
    isTeamPage ? address.teamId : '',
  );
  const projection =
    binding.kind === 'bound'
      ? binding
      : binding.kind === 'resolving'
        ? binding.retained
        : undefined;
  const row = useTeamsDirectoryRow(
    projection?.scope ?? null,
    isTeamPage ? address.teamId : '',
  );
  if (!isTeamPage) return null;
  return (
    (projection?.state.kind === 'ready' ? projection.state.team.name : null) ??
    row?.name ??
    t('teams.title')
  );
}
