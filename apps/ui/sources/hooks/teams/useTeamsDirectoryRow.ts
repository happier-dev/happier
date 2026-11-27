import * as React from 'react';
import type { TeamSummaryV1 } from '@happier-dev/protocol/teams';

import {
  createServerAccountScope,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
  readTeamsDirectoryRow,
  subscribeTeamsSnapshots,
} from '@/sync/store/teams/teamsSnapshots';

/**
 * One Team's row as the Teams directory already holds it (the row the rail draws), or `null` when this device has
 * not read it. It selects that one row: the reader renders again only when the row itself changes, never for the
 * rest of the directory. It does not observe the directory; the surfaces that list Teams do.
 */
export function useTeamsDirectoryRow(
  scope: ServerAccountScope | null | undefined,
  teamId: string,
): TeamSummaryV1 | null {
  const serverId = scope?.serverId ?? '';
  const accountId = scope?.accountId ?? '';
  const getSnapshot = React.useCallback(
    () =>
      readTeamsDirectoryRow(
        createServerAccountScope(serverId, accountId),
        teamId,
      ),
    [serverId, accountId, teamId],
  );
  const subscribe = React.useCallback((listener: () => void) => {
    const scope = createServerAccountScope(serverId, accountId);
    return subscribeTeamsSnapshots(listener, { scopes: scope ? [scope] : [], slices: ['directory'] });
  }, [serverId, accountId]);
  return React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
}
