import { isIP } from 'node:net';
import { MachineFirewallTransitionFactsV1Schema, type MachineFirewallTransitionIntentV1,
  type MachineFirewallTransitionFactsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
export type { MachineFirewallTransitionFactsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineRecipeStepV1, MachineSetupStepObservationV1 } from './index.js';
import { readCaddyContainerFirewallExposures } from './nativeCaddy.js';

type Firewall = Extract<MachineRecipeStepV1, { kind: 'firewall' }>;
type NativeAvailable = Extract<MachineFirewallTransitionFactsV1, { status: 'available' }>;
type SshEndpoint = NativeAvailable['retainedSshEndpoints'][number];

/** The one boundary reader for native CHECK's extensible JSON facts. Presence
 * is already emitted from the SAME Snapshot as the SSH policy observation;
 * missing is never interpreted as a fresh firewall. No OS work happens here. */
export function readMachineFirewallTransitionFactsV1(observation: MachineSetupStepObservationV1): MachineFirewallTransitionFactsV1 {
  const raw = observation.facts.firewallTransition;
  let candidate: unknown = raw;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.status === 'available') {
    if (observation.status !== 'drifted' && observation.status !== 'satisfied')
      return { status: 'unavailable', requiredFact: 'nativeFirewall' };
    const digest = observation.facts.ownedTableDigest;
    if (digest !== null && (typeof digest !== 'string' || !digest))
      return { status: 'unavailable', requiredFact: 'ownedTableDigest' };
    candidate = { ...raw, ownedTable: digest === null ? 'absent' : 'present' };
  }
  const parsed = MachineFirewallTransitionFactsV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : { status: 'unavailable', requiredFact: 'firewallTransition' };
}

/** CHECK-only declaration to the existing native observer. This is never an
 * effect plan and must never be returned in the materialized APPLY list. */
export function createMachineFirewallTransitionObservationStepV1(intent: MachineFirewallTransitionIntentV1): Firewall {
  return { id: 'reachability-native-facts', kind: 'firewall', exposures: readCaddyContainerFirewallExposures(intent.caddy),
    rules: 'table inet happier\ndelete table inet happier\ntable inet happier {\n  chain input {\n    type filter hook input priority filter - 10; policy accept;\n  }\n}\n' };
}

export type MachineFirewallTransitionMaterializationV1 =
  | Readonly<{ status: 'ready'; steps: readonly [Firewall, Firewall] }>
  | Readonly<{ status: 'review_required'; reason: 'required_fact_unavailable' | 'plan_changed'; requiredFact?: string }>;

/** Sole pure lowering at P20, used by root CHECK and preauthorized Inspect.
 * No writer, admission, approval, native verifier or recovery state lives here.
 * The reviewed declarations are the bounds: native private-interface drift
 * returns a fresh review rather than widening a reviewed binding to public.
 * Broad INPUT denial is explicitly approved by Plan21 §3.7/PROGRAM §2.9;
 * it is not inferred from a service's default ingress. */
export function materializeMachineFirewallTransitionV1(intent: MachineFirewallTransitionIntentV1,
  native: MachineFirewallTransitionFactsV1): MachineFirewallTransitionMaterializationV1 {
  if (native.status === 'unavailable') return { status: 'review_required', reason: 'required_fact_unavailable', requiredFact: native.requiredFact };
  const exposures = readCaddyContainerFirewallExposures(intent.caddy);
  if (intent.caddy.publicBindings?.some(exposure => exposure.exposure !== 'public'))
    return { status: 'review_required', reason: 'plan_changed' };
  const privateBinding = intent.caddy.privateBinding;
  if (privateBinding) {
    const { exposure, interfaceName, sourceRanges } = privateBinding;
    if (exposure.exposure !== 'privateNetwork' || !sourceRanges.length
      || ['0.0.0.0', '::'].includes(exposure.hostAddress)
      || !native.privateInterfaces.some(item => item.interfaceName === interfaceName && item.hostAddress === exposure.hostAddress
        && item.providerId === exposure.providerId && item.networkIdentity === exposure.networkIdentity)
      || !sourceRanges.some(source => isIP(source.split('/')[0]!) === isIP(exposure.hostAddress)))
      return { status: 'review_required', reason: 'plan_changed' };
  }
  // A public/private service allow on the SAME live SSH socket would defeat
  // FINAL closed or broaden Keep's exact native scope. This is contradictory
  // reviewed intent, not another permission check. Disjoint concrete addresses
  // and different families remain valid; no source-policy solver is needed.
  const overlapsAddress = (left: string, right: string) => {
    if (isIP(left) !== isIP(right)) return false;
    if (left === right || ['0.0.0.0', '::'].includes(left) || ['0.0.0.0', '::'].includes(right)) return true;
    return isIP(left) === 6 && new URL(`http://[${left}]`).hostname === new URL(`http://[${right}]`).hostname;
  };
  const bindings = [
    ...(intent.caddy.publicBindings ?? []).map(exposure => ({ exposure, interfaces: null })),
    ...(privateBinding ? [{ exposure: privateBinding.exposure, interfaces: [privateBinding.interfaceName] }] : []),
  ];
  const retained = native.retainedSshEndpoints;
  const final: SshEndpoint[] = intent.publicSsh.kind === 'closed' ? [] : [...retained];
  if (intent.publicSsh.kind === 'open' && native.ownedTable === 'absent') {
    for (const interfaceName of native.externalInterfaces) for (const family of [4, 6]) {
      const sourceCidrs = intent.publicSsh.sourceCidrs.filter(source => isIP(source.split('/')[0]!) === family);
      if (sourceCidrs.length) final.push({ interfaceName, hostAddress: family === 4 ? '0.0.0.0' : '::', port: intent.publicSsh.port, sourceCidrs });
    }
  }
  const sshScopes = intent.publicSsh.kind === 'open' ? final : retained;
  if (bindings.some(binding => binding.exposure.protocol === 'tcp' && sshScopes.some(endpoint =>
    binding.exposure.hostPort === endpoint.port && (!binding.interfaces || binding.interfaces.includes(endpoint.interfaceName))
      && overlapsAddress(binding.exposure.hostAddress, endpoint.hostAddress))))
    return { status: 'review_required', reason: 'plan_changed' };
  const render = (sshEndpoints: readonly SshEndpoint[]): Firewall => {
    const host = ['ct state established,related accept', 'iifname "lo" accept'];
    const forward = ['ct state established,related accept'];
    const permit = (exposure: (typeof exposures)[number], interfaceName?: string, source?: string) => {
      const family = isIP(exposure.hostAddress), ip = family === 4 ? 'ip' : 'ip6';
      const wildcard = exposure.hostAddress === '0.0.0.0' || exposure.hostAddress === '::';
      const arrived = `${interfaceName ? `iifname ${JSON.stringify(interfaceName)} ` : ''}${source ? `${ip} saddr ${source} ` : ''}`;
      const original = wildcard ? `meta nfproto ${family === 4 ? 'ipv4' : 'ipv6'}` : `ct original ${ip} daddr ${exposure.hostAddress}`;
      const destination = wildcard ? `meta nfproto ${family === 4 ? 'ipv4' : 'ipv6'}` : `${ip} daddr ${exposure.hostAddress}`;
      host.push(`${arrived}${destination} ${exposure.protocol} dport ${exposure.hostPort} accept`);
      forward.push(`${arrived}meta l4proto ${exposure.protocol} ${original} ct original proto-dst ${exposure.hostPort} accept`);
    };
    // Public is already the reviewed exposure intent. The default-route NIC
    // cannot redefine a concrete declared secondary-address binding as closed.
    for (const exposure of intent.caddy.publicBindings ?? []) permit(exposure);
    if (privateBinding) for (const source of privateBinding.sourceRanges) {
      if (isIP(source.split('/')[0]!) === isIP(privateBinding.exposure.hostAddress))
        permit(privateBinding.exposure, privateBinding.interfaceName, source);
    }
    for (const endpoint of sshEndpoints) for (const source of endpoint.sourceCidrs) {
      const family = isIP(endpoint.hostAddress), ip = family === 4 ? 'ip' : 'ip6';
      const wildcard = endpoint.hostAddress === '0.0.0.0' || endpoint.hostAddress === '::';
      const destination = wildcard ? `meta nfproto ${family === 4 ? 'ipv4' : 'ipv6'}` : `${ip} daddr ${endpoint.hostAddress}`;
      host.push(`iifname ${JSON.stringify(endpoint.interfaceName)} ${destination} ${ip} saddr ${source} tcp dport ${endpoint.port} accept`);
    }
    // Machine closure is not a list of interfaces believed to be public.
    // Established/loopback/declared permits precede this one INPUT deny.
    host.push('ct state new drop');
    // Supported Docker published-host traffic uses DNAT. Kernel connection
    // state remains correct across address changes/reboot without a retained
    // address projection. Ordinary source-NAT egress and direct inter-bridge
    // traffic do not match; no interface or host-address refresh is needed.
    forward.push('ct state new ct direction original ct status dnat drop');
    const chain = (name: string, rules: readonly string[]) => `  chain ${name} {\n    type filter hook ${name} priority filter - 10; policy accept;\n${rules.map(rule => `    ${rule}\n`).join('')}  }\n`;
    return { id: 'owned-firewall', kind: 'firewall', exposures,
      rules: `table inet happier\ndelete table inet happier\ntable inet happier {\n${chain('input', host)}${chain('forward', forward)}}\n` };
  };
  return { status: 'ready', steps: [render(retained), render(final)] };
}
