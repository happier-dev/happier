
/** Action identity leaf: schema modules and the registry share these constants. */
export const MACHINE_AGENT_ISOLATION_PREVIEW_ACTION_ID_V1 = 'machines.agentIsolation.preview' as const;
export const MACHINE_AGENT_ISOLATION_SET_ACTION_ID_V1 = 'machines.agentIsolation.set' as const;
export const MACHINE_AGENT_ISOLATION_ACTION_IDS = ['machines.agentIsolation.status', MACHINE_AGENT_ISOLATION_PREVIEW_ACTION_ID_V1, MACHINE_AGENT_ISOLATION_SET_ACTION_ID_V1] as const;
