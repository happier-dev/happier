/** Pure identifiers: imported by the Action id owner without schema/spec dependencies. */
export const MACHINE_REACHABILITY_ACTION_IDS_V1 = [
  'machines.reachability.inspect', 'machines.reachability.configure',
] as const;
export type MachineReachabilityActionIdV1 = typeof MACHINE_REACHABILITY_ACTION_IDS_V1[number];
