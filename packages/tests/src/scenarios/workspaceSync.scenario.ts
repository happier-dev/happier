/**
 * Lane 09 Mutagen-replacement evidence inventory.
 *
 * The executable coordinator/broker seam is owned by Lane 08.  This file only
 * records the required release cases until that owner publishes its exact API
 * and state names; it deliberately does not emulate a sidecar or Iroh stream.
 */

export type WorkspaceSyncScenarioId =
  | 'F-MU-01'
  | 'F-MU-02'
  | 'F-MU-03'
  | 'F-MU-04'
  | 'F-MU-05'
  | 'F-MU-06';

export type WorkspaceSyncScenario = Readonly<{
  id: WorkspaceSyncScenarioId;
  name: string;
  status: 'blocked';
  blocker: Readonly<{
    code: 'missing_lane08_coordinator_contract';
    owner: 'Lane 08';
    detail: string;
    wakeCondition: string;
  }>;
}>;

const blocker = {
  code: 'missing_lane08_coordinator_contract' as const,
  owner: 'Lane 08' as const,
  detail: 'Lane 08 has not published the executable workspace-sync coordinator/broker contract and exact state names.',
  wakeCondition: 'Add the composed cases once Lane 08 publishes the coordinator/broker API and state vocabulary, consuming Lane 06 machine/1 for remote paths.',
};

export const workspaceSyncScenarios: readonly WorkspaceSyncScenario[] = [
  { id: 'F-MU-01', name: 'newEngineOneWay', status: 'blocked', blocker },
  { id: 'F-MU-02', name: 'crashRecovery', status: 'blocked', blocker },
  { id: 'F-MU-03', name: 'conflicts', status: 'blocked', blocker },
  { id: 'F-MU-04', name: 'oldEngineRetired', status: 'blocked', blocker },
  { id: 'F-MU-05', name: 'handoffFeatures', status: 'blocked', blocker },
  { id: 'F-MU-06', name: 'machineCarrier', status: 'blocked', blocker },
];
