
/** Action identity leaf: schema modules and the registry share these constants. */
/**
 * Six genuine user intents for personal Machine Pools, carried by one Action family so hosts wire a
 * single `machinePoolAction` dependency instead of six.
 */
export const MACHINE_POOL_ACTION_IDS_V1 = [
  'machines.pools.list',
  'machines.pools.get',
  'machines.pools.create',
  'machines.pools.update',
  'machines.pools.delete',
  'machines.pools.resolve',
] as const;
