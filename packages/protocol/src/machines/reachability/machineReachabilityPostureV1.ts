import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachinePublicSshV1Schema } from '../setup/machineFirewallV1.js';
import { AccessProviderRefV1Schema, AccessProviderSelectionV1Schema, AccessProviderInboundPortV1Schema, AccessProviderHttpsConstraintsV1Schema, MachinePrivateNetworkObservationV1Schema } from '../../plugins/contributions/accessProviders.js';
export {
  AccessProviderRefV1Schema, type AccessProviderRefV1,
  MachinePrivateNetworkObservationV1Schema, type MachinePrivateNetworkObservationV1,
  MachinePrivateNetworkSourceRangesV1Schema, type MachinePrivateNetworkSourceRangesV1,
} from '../../plugins/contributions/accessProviders.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());
export const MachineReachabilityRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['providerConsole', 'tailscaleSsh', 'explicitSsh']), evidence: z.enum(['verified', 'userAttested']),
}));
export type MachineReachabilityRecoveryV1 = z.infer<typeof MachineReachabilityRecoveryV1Schema>;
export const MachineReachabilityPostureV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(),
  management: z.strictObject({
    providers: z.array(AccessProviderSelectionV1Schema),
    publicSsh: MachinePublicSshV1Schema,
    independentRecovery: z.optional(MachineReachabilityRecoveryV1Schema),
  }),
  defaultServiceIngress: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('provider'), selection: AccessProviderSelectionV1Schema }),
  ]),
}));
export type MachineReachabilityPostureV1 = z.infer<typeof MachineReachabilityPostureV1Schema>;

/** One versioned capability from the same demanded provider observation. */
export const MachineIngressRemedyV1Schema = lazyZodSchema(() => z.enum([
  'inspect', 'configure', 'authenticate', 'resolveConflict', 'chooseProvider',
]));
export type MachineIngressRemedyV1 = z.infer<typeof MachineIngressRemedyV1Schema>;
export const MachineIngressCapabilityV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(), provider: AccessProviderRefV1Schema,
  exposure: z.enum(['local', 'lan', 'privateNetwork', 'public']),
  inboundPorts: z.array(AccessProviderInboundPortV1Schema), https: z.optional(AccessProviderHttpsConstraintsV1Schema),
  state: z.enum(['ready', 'needsSetup', 'needsAuth', 'conflict', 'unavailable', 'unknown']), code: z.optional(text()),
  remedies: z.array(MachineIngressRemedyV1Schema).check(z.refine(values => new Set(values).size === values.length)),
}).check(z.refine(capability => capability.state === 'ready' ? capability.remedies.length === 0 : capability.remedies.length > 0,
  { message: 'Ready ingress has no setup remedy; other states carry an explicit remedy.' })));
export type MachineIngressCapabilityV1 = z.infer<typeof MachineIngressCapabilityV1Schema>;
export const MachineReachabilityObservationV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(),
  management: z.strictObject({
    daemon: z.enum(['ready', 'unavailable', 'unknown']),
    providers: z.array(z.strictObject({ provider: AccessProviderRefV1Schema,
      state: z.enum(['ready', 'stopped', 'needsAuth', 'unavailable', 'unknown']), code: z.optional(text()) })),
    publicSsh: z.enum(['open', 'closed', 'unknown']),
  }),
  privateNetworks: z.array(MachinePrivateNetworkObservationV1Schema), ingress: z.array(MachineIngressCapabilityV1Schema),
  recovery: z.optional(MachineReachabilityRecoveryV1Schema),
}));
export type MachineReachabilityObservationV1 = z.infer<typeof MachineReachabilityObservationV1Schema>;
