import '../../zodRuntimePolicy.js';
import { z } from 'zod';
import { z as mini } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DeploymentDomainCaddyFailureDetailsV1Schema } from '../../deployments/deploymentDomainCaddyFailureV1.js';
import { MachinePrivateNetworkObservationV1Schema } from '../../plugins/contributions/machinePrivateNetworks.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { PluginJsonSchemaV2Schema, type PluginJsonSchemaV2 } from '../../plugins/contributions/jsonSchema.js';

/** Moved without validation changes from machineRecipeV1. This leaf has no
 * recipe, posture or provider dependency, so both callers share one schema. */
const exposureFields = () => ({ requirementId: z.string().min(1), hostAddress: z.union([z.ipv4(), z.ipv6()]),
    hostPort: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']),
    containerPort: z.number().int().min(1).max(65535).optional() });
const privateExposure = () => z.object({ ...exposureFields(), exposure: z.literal('privateNetwork'),
  providerId: z.string().min(1), networkIdentity: z.string().min(1) }).strict();
export const MachineFirewallExposureV1Schema = lazyZodSchema(() => {
  return z.union([
    privateExposure(),
    z.object({ ...exposureFields(), exposure: z.enum(['public', 'loopback']) }).strict(),
  ]);
});

/** The same closed exposure grammar for cold recipe input declarations. */
export function getMachineFirewallExposureInputSchemaV1(): PluginJsonSchemaV2 {
  return PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(MachineFirewallExposureV1Schema, { target: 'draft-7' }));
}

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
/** Host-captured scope for the existing protected Caddy CHECK. */
export const MachineCaddyFirewallObservationInputV1Schema = lazyZodSchema(() => z.object({
  privateNetworks: z.array(MachinePrivateNetworkObservationV1Schema),
}).strict());
export type MachineCaddyFirewallObservationInputV1 = z.infer<typeof MachineCaddyFirewallObservationInputV1Schema>;
/** The same native Caddy observation is carried by the existing protected CHECK. */
export const MachineCaddyFirewallObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), bindings: MachineFirewallTransitionBindingsV1Schema }).strict(),
  z.object({ status: z.literal('unavailable'),
    reason: z.enum(['required_fact_unavailable', 'foreign_effect_conflict', 'private_scope_unenforceable']),
    details: z.optional(DeploymentDomainCaddyFailureDetailsV1Schema) }).strict(),
]));
export type MachineCaddyFirewallObservationV1 = z.infer<typeof MachineCaddyFirewallObservationV1Schema>;

/** An explicit private publication for one Environment. The native writer
 * retains other Environments; an empty list withdraws this Environment's permits. */
export const MachineFirewallPrivateWorkloadBindingsV1Schema = lazyZodSchema(() => z.object({
  environmentId: z.string().min(1),
  bindings: z.array(z.object({
    exposure: privateExposure(),
    interfaceName: z.string().min(1), sourceRanges: z.array(z.union([z.cidrv4(), z.cidrv6()])),
  }).strict()),
}).strict());
export type MachineFirewallPrivateWorkloadBindingsV1 = z.infer<typeof MachineFirewallPrivateWorkloadBindingsV1Schema>;

/** Reviewed SSH transition versus Domain reconciliation:
 * A retains every observed SSH endpoint exactly. preserveSsh keeps those same
 * scopes in FINAL, regardless of the declared posture. Only retainSsh
 * applies an explicitly reviewed publicSsh change: closed removes the retained
 * scopes, while open additionally ensures its scalar on a fresh firewall.
 * Protected native facts may be unknown until the one approved root CHECK. */
export const MachineFirewallTransitionIntentV1Schema = lazyZodSchema(() => mini.strictObject({
  v: mini.literal(1), kind: mini.enum(['retainSsh', 'preserveSsh']),
  caddy: MachineFirewallTransitionBindingsV1Schema,
  caddyObservation: mini.optional(MachineCaddyFirewallObservationInputV1Schema),
  privateWorkloadBindings: mini.optional(MachineFirewallPrivateWorkloadBindingsV1Schema),
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
      privateWorkloadBindings: z.array(MachineFirewallPrivateWorkloadBindingsV1Schema).optional(),
      caddy: MachineCaddyFirewallObservationV1Schema.optional(),
    }).strict(),
    z.object({ status: z.literal('unavailable'), requiredFact: name, remedy: name.optional(),
      caddy: MachineCaddyFirewallObservationV1Schema.optional() }).strict(),
  ]);
});
export type MachineFirewallTransitionFactsV1 = z.infer<typeof MachineFirewallTransitionFactsV1Schema>;
export const MachineFirewallReviewFactsV1Schema = lazyZodSchema(() => z.union([
  MachineFirewallTransitionFactsV1Schema,
  z.object({ status: z.literal('readWhenApproved') }).strict(),
]));
export type MachineFirewallReviewFactsV1 = z.infer<typeof MachineFirewallReviewFactsV1Schema>;
