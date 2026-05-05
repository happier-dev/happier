import { z } from 'zod';

export const PeerDirectPreferenceV1Schema = z.enum(['inherit', 'enabled', 'disabled']);
export type PeerDirectPreferenceV1 = z.infer<typeof PeerDirectPreferenceV1Schema>;

export const PeerMediationFlowKindV1Schema = z.enum([
  'bounded_transfer',
  'tcp_tunnel',
  'live_stream',
  'machine_rpc',
]);
export type PeerMediationFlowKindV1 = z.infer<typeof PeerMediationFlowKindV1Schema>;

const PeerDirectFlowPreferenceV1Schema = z.object({
  direct: PeerDirectPreferenceV1Schema.default('inherit'),
});

const PeerMediationFlowPreferencesV1Schema = z
  .object({
    bounded_transfer: PeerDirectFlowPreferenceV1Schema.optional(),
    tcp_tunnel: PeerDirectFlowPreferenceV1Schema.optional(),
    live_stream: PeerDirectFlowPreferenceV1Schema.optional(),
    machine_rpc: PeerDirectFlowPreferenceV1Schema.optional(),
  })
  .default({});

export const PeerMediationPreferencesV1Schema = z
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
  });

export type PeerMediationPreferencesV1 = z.infer<typeof PeerMediationPreferencesV1Schema>;

export const DEFAULT_PEER_MEDIATION_PREFERENCES_V1: PeerMediationPreferencesV1 = {
  v: 1,
  flows: {},
  byMachineId: {},
};
