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

const portPattern = '^(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$';
/** The guided Firewall form: the ports a person opens, as typed, and who may reach them. */
export const MachineFirewallOpenPortsV1Schema = lazyZodSchema(() => {
  const ports = z.array(z.string().regex(new RegExp(portPattern)));
  return z.object({ tcp: ports.min(1), udp: ports.optional(),
    from: z.array(z.union([z.cidrv4(), z.cidrv6()])).optional() }).strict();
});
export type MachineFirewallOpenPortsV1 = z.infer<typeof MachineFirewallOpenPortsV1Schema>;
type MachineFirewallExposureV1 = z.infer<typeof MachineFirewallExposureV1Schema>;

/** The open-ports input schema a recipe declares; the same grammar the renderer parses. */
export function getMachineFirewallOpenPortsInputSchemaV1(): PluginJsonSchemaV2 {
  return PluginJsonSchemaV2Schema.parse(zodSchemaToJsonSchemaObject(MachineFirewallOpenPortsV1Schema, { target: 'draft-7' }));
}

/**
 * The one lowering from opened ports to the owned table the native firewall owner stages verbatim. Rule shapes are
 * the reachability transition's own (established/loopback first, one permit per port and source, then the one
 * INPUT deny and the DNAT FORWARD deny that covers Docker-published ports), so nothing here is a second policy.
 * Exposures are the review's facts: each opened port is reachable from outside, from the listed sources or anywhere.
 */
export function renderMachineFirewallOpenPortsV1(value: unknown): Readonly<{ rules: string; exposures: MachineFirewallExposureV1[] }> {
  const open = MachineFirewallOpenPortsV1Schema.parse(value);
  const sorted = (ports: readonly string[] | undefined) => [...new Set((ports ?? []).map(Number))].sort((a, b) => a - b);
  const opened = [...sorted(open.tcp).map(port => ({ protocol: 'tcp' as const, port })),
    ...sorted(open.udp).map(port => ({ protocol: 'udp' as const, port }))];
  const sources = [...new Set(open.from ?? [])];
  const host = ['ct state established,related accept', 'iifname "lo" accept'];
  const forward = ['ct state established,related accept'];
  for (const { protocol, port } of opened) {
    if (sources.length === 0) for (const family of ['ipv4', 'ipv6']) {
      host.push(`meta nfproto ${family} ${protocol} dport ${port} accept`);
      forward.push(`meta l4proto ${protocol} meta nfproto ${family} ct original proto-dst ${port} accept`);
    }
    // The source expression already selects the family; nft drops a redundant nfproto selector.
    for (const source of sources) {
      const ip = source.includes(':') ? 'ip6' : 'ip';
      host.push(`${ip} saddr ${source} ${protocol} dport ${port} accept`);
      forward.push(`${ip} saddr ${source} meta l4proto ${protocol} ct original proto-dst ${port} accept`);
    }
  }
  host.push('ct state new drop');
  forward.push('ct state new ct direction original ct status dnat drop');
  const chain = (name: string, rules: readonly string[]) => `  chain ${name} {\n    type filter hook ${name} priority filter - 10; policy accept;\n${rules.map(rule => `    ${rule}\n`).join('')}  }\n`;
  return {
    rules: `table inet happier\ndelete table inet happier\ntable inet happier {\n${chain('input', host)}${chain('forward', forward)}}\n`,
    exposures: opened.map(({ protocol, port }) => ({ requirementId: `open-${protocol}-${port}`, hostAddress: '0.0.0.0',
      hostPort: port, protocol, exposure: 'public' as const })),
  };
}
