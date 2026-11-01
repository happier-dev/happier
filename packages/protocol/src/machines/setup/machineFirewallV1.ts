import { z } from 'zod';
import { z as mini } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Moved without validation changes from machineRecipeV1. This leaf has no
 * recipe, posture or provider dependency, so both callers share one schema. */
export const MachineFirewallExposureV1Schema = lazyZodSchema(() => z.object({ requirementId: z.string().min(1), hostAddress: z.union([z.ipv4(), z.ipv6()]),
    hostPort: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']),
    containerPort: z.number().int().min(1).max(65535).optional(), exposure: z.enum(['public', 'privateNetwork', 'loopback']),
    providerId: z.string().min(1).optional(), networkIdentity: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
    if (value.exposure === 'privateNetwork' ? !value.providerId || !value.networkIdentity
        : value.providerId !== undefined || value.networkIdentity !== undefined) {
        context.addIssue({ code: 'custom', message: 'Only private exposure carries its exact provider/network identity' });
    }
}));

/** Moved without validation changes from machineReachabilityPostureV1. */
export const MachinePublicSshV1Schema = lazyZodSchema(() => mini.discriminatedUnion('kind', [
  mini.strictObject({ kind: mini.literal('closed') }),
  mini.strictObject({ kind: mini.literal('open'), port: mini.number().check(mini.int(), mini.minimum(1), mini.maximum(65_535)),
    sourceCidrs: mini.array(mini.union([mini.cidrv4(), mini.cidrv6()])).check(mini.minLength(1)) }),
]));

/** Canonical P20 declaration operands, shared by the reviewed reachability
 * basis and root CHECK. It contains neither guessed native facts nor rules. */
export const MachineFirewallTransitionBindingsV1Schema = lazyZodSchema(() => z.object({
  publicBindings: z.array(MachineFirewallExposureV1Schema).optional(),
  privateBinding: z.object({
    exposure: MachineFirewallExposureV1Schema, interfaceName: z.string().min(1),
    sourceRanges: z.array(z.union([z.cidrv4(), z.cidrv6()])),
  }).strict().optional(),
}).strict());
export type MachineFirewallTransitionBindingsV1 = z.infer<typeof MachineFirewallTransitionBindingsV1Schema>;

/** Plan21 owner decision 2026-10-30 22:33 UTC:
 * A retains every observed SSH endpoint exactly. FINAL closes those endpoints
 * only when explicitly reviewed closed; Keep retains them all. On a fresh
 * firewall only, the reviewed scalar additionally specifies what to ensure.
 * Protected native facts may be unknown until the one approved root CHECK. */
export const MachineFirewallTransitionIntentV1Schema = lazyZodSchema(() => mini.strictObject({
  v: mini.literal(1), kind: mini.literal('retainSsh'),
  caddy: MachineFirewallTransitionBindingsV1Schema,
  publicSsh: MachinePublicSshV1Schema,
}));
export type MachineFirewallTransitionIntentV1 = mini.infer<typeof MachineFirewallTransitionIntentV1Schema>;

/** One browser-safe shape for native CHECK facts, the shared boundary reader
 * and Inspect's protected-facts presentation. Native readiness is separate. */
export const MachineFirewallTransitionFactsV1Schema = lazyZodSchema(() => {
  const name = z.string().min(1);
  const address = z.union([z.ipv4(), z.ipv6()]);
  const endpoint = z.object({ interfaceName: name, hostAddress: address,
    port: z.number().int().min(1).max(65535), sourceCidrs: z.array(z.union([z.cidrv4(), z.cidrv6()])),
  }).strict().refine(value => value.sourceCidrs.every(source => source.includes(':') === value.hostAddress.includes(':')));
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), ownedTable: z.enum(['absent', 'present']), externalInterfaces: z.array(name),
      privateInterfaces: z.array(z.object({ providerId: name, networkIdentity: name, hostAddress: address, interfaceName: name }).strict()),
      retainedSshEndpoints: z.array(endpoint),
    }).strict(),
    z.object({ status: z.literal('unavailable'), requiredFact: name }).strict(),
  ]);
});
export type MachineFirewallTransitionFactsV1 = z.infer<typeof MachineFirewallTransitionFactsV1Schema>;
export const MachineFirewallReviewFactsV1Schema = lazyZodSchema(() => z.union([
  MachineFirewallTransitionFactsV1Schema,
  z.object({ status: z.literal('readWhenApproved') }).strict(),
]));
export type MachineFirewallReviewFactsV1 = z.infer<typeof MachineFirewallReviewFactsV1Schema>;
