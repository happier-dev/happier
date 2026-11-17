
/** Action identity leaf: schema modules and the registry share these constants. */
export const MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1 = 'machines.resources.outcomes.read' as const;
export const MACHINE_RESOURCES_ACTION_IDS = ['machines.resources.policy.get', 'machines.resources.policy.set', MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1] as const;
