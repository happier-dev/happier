import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AccessProviderRefV1Schema } from './accessProviderSelection.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
/** Native CIDRs only, not proxy matcher aliases or forwarded-header claims. */
export const MachinePrivateNetworkSourceRangesV1Schema = lazyZodSchema(() => z.array(z.union([
  // The portable plugin dialect supports patterns, not Zod's CIDR formats.
  // Reuse Zod's exact validators rather than introducing another CIDR parser.
  z.string().check(z.regex(z.regexes.cidrv4)), z.string().check(z.regex(z.regexes.cidrv6)),
])));
export type MachinePrivateNetworkSourceRangesV1 = z.infer<typeof MachinePrivateNetworkSourceRangesV1Schema>;
/**
 * Demand-only observation, not endpoint health or a desired Network resource.
 * P41 receives sourceRanges from the Environment's exact admitted observation
 * and network identity through its existing route/capability planning input.
 * Parsing this record does not admit that Environment or authorize a request.
 */
export const MachinePrivateNetworkObservationV1Schema = lazyZodSchema(() => z.strictObject({
  provider: AccessProviderRefV1Schema, networkIdentity: z.nullable(text()), displayName: z.nullable(text()),
  dnsName: z.nullable(text()), addresses: z.array(text()),
  state: z.enum(['ready', 'stopped', 'needsAuth', 'unavailable', 'unknown']),
  interfaceName: z.nullable(text()), sourceRanges: MachinePrivateNetworkSourceRangesV1Schema, magicDnsEnabled: z.nullable(z.boolean()),
}));
export type MachinePrivateNetworkObservationV1 = z.infer<typeof MachinePrivateNetworkObservationV1Schema>;
