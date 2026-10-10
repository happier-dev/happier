import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const PeerDirectPreferenceV1Schema = lazyZodSchema(() => z.enum(['inherit', 'enabled', 'disabled']));
export type PeerDirectPreferenceV1 = z.infer<typeof PeerDirectPreferenceV1Schema>;

export const PeerMediationFlowKindV1Schema = lazyZodSchema(() => z.enum([
  'bounded_transfer',
  'tcp_tunnel',
  'live_stream',
  'machine_rpc',
]));
export type PeerMediationFlowKindV1 = z.infer<typeof PeerMediationFlowKindV1Schema>;

const PeerDirectFlowPreferenceV1Schema = lazyZodSchema(() => z.object({
  direct: PeerDirectPreferenceV1Schema.default('inherit'),
}));

const PeerMediationFlowPreferencesV1Schema = lazyZodSchema(() => z
  .object({
    bounded_transfer: PeerDirectFlowPreferenceV1Schema.optional(),
    tcp_tunnel: PeerDirectFlowPreferenceV1Schema.optional(),
    live_stream: PeerDirectFlowPreferenceV1Schema.optional(),
    machine_rpc: PeerDirectFlowPreferenceV1Schema.optional(),
  })
  .default({}));

export const PeerMediationPreferencesV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1).default(1),
    flows: PeerMediationFlowPreferencesV1Schema,
    byMachineId: z
      .record(
        z.string().min(1),
        z.object({
          flows: PeerMediationFlowPreferencesV1Schema,
        }),
      )
      .default({}),
  })
  .catch({
    v: 1,
    flows: {},
    byMachineId: {},
  }));

export type PeerMediationPreferencesV1 = z.infer<typeof PeerMediationPreferencesV1Schema>;

export const DEFAULT_PEER_MEDIATION_PREFERENCES_V1: PeerMediationPreferencesV1 = {
  v: 1,
  flows: {},
  byMachineId: {},
};

export type MachineDirectConnectionChoice = 'default' | 'direct' | 'relay';

const DIRECT_FLOW_KINDS = PeerMediationFlowKindV1Schema.options;

type FlowPreferences = PeerMediationPreferencesV1['flows'];

function flowsWith(direct: PeerDirectPreferenceV1): FlowPreferences {
    return Object.fromEntries(DIRECT_FLOW_KINDS.map((flow) => [flow, { direct }])) as FlowPreferences;
}

/** On unless a flow is turned off: untouched flows follow the product default, which connects directly. */
export function readDirectConnectionsEnabled(preferences: PeerMediationPreferencesV1): boolean {
    return DIRECT_FLOW_KINDS.every((flow) => preferences.flows[flow]?.direct !== 'disabled');
}

/** Off writes `disabled` for every flow; on returns every flow to the product default. */
export function withDirectConnectionsEnabled(
    preferences: PeerMediationPreferencesV1,
    enabled: boolean,
): PeerMediationPreferencesV1 {
    return { ...preferences, flows: enabled ? {} : flowsWith('disabled') };
}

export function readMachineDirectConnectionChoice(
    preferences: PeerMediationPreferencesV1,
    machineId: string,
): MachineDirectConnectionChoice {
    const flows = preferences.byMachineId[machineId]?.flows;
    if (!flows) return 'default';
    const values = DIRECT_FLOW_KINDS.map((flow) => flows[flow]?.direct ?? 'inherit');
    // Written only as a whole; a hand-edited mix reads as the stricter answer.
    if (values.includes('disabled')) return 'relay';
    if (values.includes('enabled')) return 'direct';
    return 'default';
}

export function withMachineDirectConnectionChoice(
    preferences: PeerMediationPreferencesV1,
    machineId: string,
    choice: MachineDirectConnectionChoice,
): PeerMediationPreferencesV1 {
    const { [machineId]: _previous, ...others } = preferences.byMachineId;
    if (choice === 'default') return { ...preferences, byMachineId: others };
    return {
        ...preferences,
        byMachineId: { ...others, [machineId]: { flows: flowsWith(choice === 'direct' ? 'enabled' : 'disabled') } },
    };
}
