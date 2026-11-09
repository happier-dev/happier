import { MachineFirewallPrivateWorkloadBindingsV1Schema,
  type MachineFirewallPrivateWorkloadBindingsV1 } from '@happier-dev/protocol/machines/setup/machineFirewallV1';

const marker = '  # happier-private-workloads ';
export const nativeFirewallTransitionObservationStepId = 'reachability-native-facts';

/** Applied declarations stay with the root-owned policy they produced. This
 * is read only after the native owner proves saved/effective table agreement. */
export function readNativeFirewallPrivateWorkloads(rules: string): MachineFirewallPrivateWorkloadBindingsV1[] {
  const declarations = rules.split('\n').filter(line => line.startsWith(marker));
  if (!declarations.length) return [];
  if (declarations.length !== 1) throw new Error('Invalid private workload declarations');
  const parsed = MachineFirewallPrivateWorkloadBindingsV1Schema.array().parse(JSON.parse(declarations[0]!.slice(marker.length)));
  if (new Set(parsed.map(item => item.environmentId)).size !== parsed.length) throw new Error('Duplicate private workload Environment');
  return parsed;
}

export function renderNativeFirewallPrivateWorkloads(bindings: readonly MachineFirewallPrivateWorkloadBindingsV1[]): string {
  return bindings.length ? `${marker}${JSON.stringify(bindings)}\n` : '';
}

export function replaceNativeFirewallPrivateWorkloads(current: readonly MachineFirewallPrivateWorkloadBindingsV1[],
  selected: MachineFirewallPrivateWorkloadBindingsV1 | undefined): MachineFirewallPrivateWorkloadBindingsV1[] {
  if (!selected) return [...current];
  return [...current.filter(item => item.environmentId !== selected.environmentId), ...(selected.bindings.length ? [selected] : [])];
}
