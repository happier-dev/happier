/** Pure identifiers: imported by the Action id owner without schema/spec dependencies. */
export const MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1 = 'machines.reachability.configure' as const;
export const MACHINE_REACHABILITY_ACTION_IDS_V1 = [
  'machines.reachability.inspect', MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1,
] as const;
export type MachineReachabilityActionIdV1 = typeof MACHINE_REACHABILITY_ACTION_IDS_V1[number];
