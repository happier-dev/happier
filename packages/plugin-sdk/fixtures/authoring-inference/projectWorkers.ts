import {
  isPluginActionApprovalRequestCreated,
  type ActionsService,
  type PluginActionInputById,
  type PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';

/** Compare against the observed entry, so this finite edit preserves service siblings. */
export async function configureProjectWorkers(actions: ActionsService,
  workspace: PluginActionInputById['projects.worker.preferences.get']['workspace'],
  next: PluginActionInputById['projects.worker.preferences.set']['next']) {
  const current = await actions.execute('projects.worker.preferences.get', { workspace });
  if (isPluginActionApprovalRequestCreated(current) || current.status !== 'ready') return current;
  return await actions.execute('projects.worker.preferences.set', {
    workspace, expectedRevision: current.revision,
    expected: current.provenance === 'default' ? { kind: 'absent' } : { kind: 'value', value: current.preference },
    next,
  });
}

export async function inspectProjectWorker(actions: ActionsService, input: PluginActionInputById['projects.worker.status']) {
  return await actions.execute('projects.worker.status', input);
}

/** Saving next-start placement never restarts or moves an existing service. */
export async function configureProjectServicePlacement(actions: ActionsService,
  input: PluginActionInputById['projects.service.placement.get'],
  value: PluginActionInputById['projects.service.placement.set']['value']) {
  const current = await actions.execute('projects.service.placement.get', input);
  if (isPluginActionApprovalRequestCreated(current) || current.status !== 'ready') return current;
  return await actions.execute('projects.service.placement.set', {
    ...input, expectedRevision: current.revision,
    expected: current.provenance === 'default' ? { kind: 'absent' } : { kind: 'value', value: current.placement },
    value,
  });
}

const preference = { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} } as const;
const get = { workspace: { serverId: 'home', refId: 'checkout' } } satisfies PluginActionInputById['projects.worker.preferences.get'];
const set = { ...get, expectedRevision: 'absent', expected: { kind: 'absent' }, next: preference } satisfies PluginActionInputById['projects.worker.preferences.set'];
const reset = { ...get, expectedRevision: 'absent', expected: { kind: 'absent' } } satisfies PluginActionInputById['projects.worker.preferences.reset'];
const policy = { serverId: 'home', machineId: 'machine', expectedMetadataVersion: 1,
  expectedPolicy: { accepting: true, runAtMost: null }, policy: { accepting: false, runAtMost: 2 } } satisfies PluginActionInputById['machines.worker.policy.set'];
const observed = { status: 'ready', preference, revision: 'absent', provenance: 'default' } satisfies PluginActionResultById['projects.worker.preferences.get'];
const status = { ...get, destination: { kind: 'machine', machineId: 'worker-a' }, purpose: 'finite',
  memoryDemand: { bytes: 1024, basis: { kind: 'declared' } } } satisfies PluginActionInputById['projects.worker.status'];
const advisory = { eligible: true, load: { kind: 'unknown' }, candidate: { serverId: 'home', machineId: 'worker-a' },
  explanation: 'load_unknown' } satisfies PluginActionResultById['projects.worker.status'];
const retired = { status: 'retired' } satisfies PluginActionResultById['projects.worker.copy.retire'];
function retireInput(expectedRelationship: PluginActionInputById['projects.worker.copy.retire']['expectedRelationship']) {
  return { ...get, machineId: 'worker-a', expectedRelationship } satisfies PluginActionInputById['projects.worker.copy.retire'];
}
void [get, set, reset, policy, observed, status, advisory, retired, retireInput];

// @ts-expect-error service placement belongs to its own Action, not the finite preference writer
const serviceWrite: PluginActionInputById['projects.worker.preferences.set'] = { ...set, next: { ...preference, services: {} } };
// @ts-expect-error policy outcomes remain typed owner observations rather than arbitrary JSON
const arbitraryResult: PluginActionResultById['machines.worker.policy.get'] = { status: 'ready', arbitrary: true };
// @ts-expect-error exact status is not a pool resolver
const poolStatus: PluginActionInputById['projects.worker.status'] = { ...status, destination: { kind: 'pool', poolId: 'pool' } };
// @ts-expect-error queue dependencies are not public advisory status data
const dependencyLeak: PluginActionResultById['projects.worker.status'] = { ...advisory, dependencies: [] };
void [serviceWrite, arbitraryResult, poolStatus, dependencyLeak];
