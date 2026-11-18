import * as React from 'react';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { selectSessionDisplayNameSource } from '@/sync/store/hooks';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { getSessionName } from '@/utils/sessions/sessionUtils';

/**
 * The display name of each frozen target, for the To list. One narrow selector over the target ids only, so a
 * streaming target never renders the composer (P03 ruling 18:22Z: no whole Session subscriptions).
 */
export function useBulkSessionTargetNames(
  targets: readonly ActionSessionAddressV1[],
): readonly string[] {
  const store = getStorage();
  const selector = React.useMemo(() => {
    let previous: readonly string[] = [];
    return (state: ReturnType<typeof store.getState>) => {
      const names = targets.map((target) => {
        // The sidebar row when held, else the hydrated record: the one display-name source every surface reads.
        const source = selectSessionDisplayNameSource(state, target.sessionId, target.serverId);
        return source ? getSessionName(source, target.serverId) : target.sessionId;
      });
      previous = retainDeep(previous, names);
      return previous;
    };
  }, [store, targets]);
  return store(selector, {
    sessions: targets.map((target) => target.sessionId),
    sessionListRowsByServerId: [...new Set(targets.map((target) => target.serverId))],
  });
}
