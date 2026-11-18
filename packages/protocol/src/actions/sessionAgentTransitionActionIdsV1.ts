
/** Action identity leaf: schema modules and the registry share these constants. */
export const SESSION_CONTINUATION_INSPECT_ACTION_ID_V1 = 'session.continuation.inspect' as const;
export const SESSION_AGENT_TRANSITION_ACTION_ID_V1 = 'session.agent.transition' as const;
export const SESSION_AGENT_TRANSITION_ACTION_IDS = [SESSION_CONTINUATION_INSPECT_ACTION_ID_V1, SESSION_AGENT_TRANSITION_ACTION_ID_V1] as const;
