import * as React from 'react';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { getStorage, readSessionOrganizationProjectionCached } from '@/sync/domains/state/storage';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { writeSessionOrganizationGroupOrder } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { parseToken } from '@/utils/auth/parseToken';
import { t } from '@/text';

import { treeRowId } from './drop-resolution/treeRowId';
import { createSessionListOrganizationActionAdapter, registerMountedSessionListOrganizationAction } from './drag/sessionListOrganizationAction';

/** The visible rail supplies one loaded pin view to the same organization adapter, even with its column closed. */
export function useSessionListRailOrganizationAction(serverIds: readonly string[]) {
  const homes = React.useRef(serverIds);
  homes.current = serverIds;
  React.useEffect(() => registerMountedSessionListOrganizationAction(createSessionListOrganizationActionAdapter((mutationScope) => {
    if (!homes.current.includes(mutationScope.serverId)) return null;
    const state = getStorage().getState();
    const serverId = mutationScope.serverId;
    const organization = readSessionOrganizationProjectionCached(state, serverId);
    const rows = readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId);
    const orderedKeys = organization.orderedPinSessionIds.map(sessionId => sessionAddressKey({ serverId, sessionId }));
    const addresses = Object.fromEntries(organization.orderedPinSessionIds.map((sessionId, index) => [orderedKeys[index]!, {
      itemKind: 'session' as const, serverId, sessionId,
    }]));
    return {
      scope: { serverId, accountId: parseToken(mutationScope.credentials.token) },
      latestItems: [],
      pinnedOrganization: {
        items: [
          { type: 'header' as const, headerKind: 'pinned' as const, title: t('sessionInfo.pinSession'), groupKey: PINNED_GROUP_KEY_V1, serverId },
          ...organization.orderedPinSessionIds.map(sessionId => ({ type: 'session' as const, sessionId, serverId,
            groupKind: 'pinned' as const, groupKey: PINNED_GROUP_KEY_V1, pinned: true })),
        ],
        railSessionRowIds: organization.railPinnedSessionIds
          .filter(sessionId => readSessionBotV1(rows?.[sessionId]?.metadata?.bot)?.kind === 'bot')
          .map(sessionId => treeRowId.session(serverId, sessionId)),
      },
      sessionFoldersV1: { v: 1, folders: [] },
      sessionListGroupOrderV1: { [PINNED_GROUP_KEY_V1]: orderedKeys },
      // This projection is personal pin order, not a date/project-sorted list view.
      manualSessionOrderingEnabled: true, sessionListOrderingModeV1: 'custom', now: Date.now,
      setSessionFoldersV1: async () => { throw new Error('unsupported_operation'); },
      setSessionFolderAssignment: async () => { throw new Error('unsupported_operation'); },
      setSessionListGroupOrderV1: next => writeSessionOrganizationGroupOrder({ scope: mutationScope, next, orderItemAddressByItemKey: addresses }),
    };
  }), 'rail'), []);
}
