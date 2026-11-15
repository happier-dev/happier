import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';

export function selectChannelsSessionTitle(state: SessionStateV1) {
  return state.title;
}

/** Module-stable selector shared by the row consumer and the 2,000-Session owner measurement. */
export function selectChannelsConversationSessionState(state: SessionStateV1) {
  return {
    workStatus: state.workStatus,
    hasUnreadMessages: state.hasUnreadMessages,
    latestActivity: state.latestActivity ?? { kind: 'unavailable' as const },
  };
}

export type ChannelsConversationSessionState = ReturnType<typeof selectChannelsConversationSessionState>;

/**
 * A router thread row's projection: the conversation facts plus the Session title that names a thread
 * started before providers sent a subject. Module-stable, like the conversation selector.
 */
export function selectChannelsRouterThreadSessionState(state: SessionStateV1) {
  return { ...selectChannelsConversationSessionState(state), title: state.title };
}

export type ChannelsRouterThreadSessionState = ReturnType<typeof selectChannelsRouterThreadSessionState>;
