/** Action identity leaf shared by the registry, schemas and consumers. */
export const MACHINE_ISOLATION_ACTION_IDS = ['machines.isolation.get', 'machines.isolation.set'] as const;
export const [MACHINE_ISOLATION_GET_ACTION_ID_V1, MACHINE_ISOLATION_SET_ACTION_ID_V1] = MACHINE_ISOLATION_ACTION_IDS;
