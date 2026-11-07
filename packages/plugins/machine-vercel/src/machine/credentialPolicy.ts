import {
  defineProtocolArray, defineProtocolJsonValue, defineProtocolLiteral, defineProtocolObject,
  defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import type { MachineProvisionerNativeCredentialApplyInputV1, MachineProvisionerNativeCredentialBindingV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

type MaterializeHeaders = PluginInvocationContext['services']['machineProvisioners']['materializeNativeCredentialHeaders'];
type Rule = Readonly<{
  match: Readonly<{ path: Readonly<{ exact: string }>; method: readonly string[];
    headers: readonly Readonly<{ key: Readonly<{ exact: string }>; value: Readonly<{ exact: string }> }>[] }>;
  transform: readonly Readonly<{ headers: Readonly<Record<string, string>> }>[];
}>;
type Policy = Readonly<{ mode: 'allow-all' }> | Readonly<{ allow: Readonly<Record<string, readonly Rule[]>> }>;
type Result = Readonly<{ kind: 'ready'; policy: Policy }> | Readonly<{ kind: 'refused'; code: string }>;
const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1 });
const exact = defineProtocolObject({ exact: text }, closed);
const ownedMatch = defineProtocolObject({ path: exact, method: defineProtocolArray(text),
  headers: defineProtocolArray(defineProtocolObject({ key: exact, value: exact }, closed)) }, closed);
// SDK 3.9.0 commit 0fd6b326b429167f662b91fd423cdb76a1c0ca76:
// responses expose rule identity and header names, never the injected values.
const responsePolicy = defineProtocolObject({
  mode: defineProtocolUnion([defineProtocolLiteral('allow-all'), defineProtocolLiteral('custom')]),
  allowedDomains: defineProtocolArray(text).optional(),
  allowedCIDRs: defineProtocolArray(text).optional(), deniedCIDRs: defineProtocolArray(text).optional(),
  injectionRules: defineProtocolArray(defineProtocolObject({ domain: text, headerNames: defineProtocolArray(text).optional(),
    match: defineProtocolJsonValue().optional() }, closed)).optional(),
  forwardRules: defineProtocolArray(defineProtocolJsonValue()).optional(),
}, closed);
const sameSet = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length && new Set(actual).size === actual.length && actual.every(value => expected.includes(value));
function destinationFor(binding: MachineProvisionerNativeCredentialBindingV1) {
  try {
    const destination = new URL(binding.destination);
    return destination.protocol === 'https:' && !destination.port && !destination.username && !destination.password
      && !destination.hash && !destination.search && !destination.hostname.includes('*') ? destination : undefined;
  } catch { return undefined; }
}

export function credentialPolicyOwnership(value: unknown): 'owned' | 'conflict' | 'unknown' {
  const result = responsePolicy.safeParse(value);
  if (!result.success) return 'unknown';
  const policy = result.data;
  if (policy.mode !== 'allow-all' && !policy.allowedDomains?.includes('*')
    || policy.allowedCIDRs?.length || policy.deniedCIDRs?.length || policy.forwardRules?.length) return 'conflict';
  for (const rule of policy.injectionRules ?? []) {
    if (!rule.headerNames) return 'unknown';
    if (!rule.headerNames.some(name => name.toLowerCase() === 'x-happier-attribution')) return 'conflict';
  }
  return 'owned';
}

/** GET redacts injected values. Compare its published selectors and header
 * names with the admitted descriptors; never reconstruct private transforms. */
export function credentialPolicyMatches(value: unknown, bindings: readonly MachineProvisionerNativeCredentialBindingV1[]): boolean {
  const result = responsePolicy.safeParse(value);
  if (!result.success || credentialPolicyOwnership(value) !== 'owned') return false;
  const rules = result.data.injectionRules ?? [];
  if (rules.length !== bindings.reduce((count, binding) => count + binding.requests.length, 0)) return false;
  return bindings.every(binding => binding.requests.every(request => rules.some(rule => {
    const parsed = ownedMatch.safeParse(rule.match);
    if (!parsed.success || !rule.headerNames) return false;
    const match = parsed.data;
    const names = rule.headerNames.map(name => name.toLowerCase());
    const destination = destinationFor(binding);
    const expectedNames = [...new Set([binding.placeholder.header, 'host', ...(binding.attributionHeaders ?? []).map(header => header.name)].map(name => name.toLowerCase()))];
    return Boolean(destination && rule.domain.toLowerCase() === destination.hostname
      && match.path.exact === request.path && sameSet(match.method, request.methods)
      && match.headers.length === 1 && match.headers[0]!.key.exact.toLowerCase() === binding.placeholder.header.toLowerCase()
      && match.headers[0]!.value.exact === binding.placeholder.value && sameSet(names, expectedNames));
  })));
}

/** Encode complete admitted descriptors; never reconstruct secrets from GET. */
export async function encodeCredentialPolicy(input: MachineProvisionerNativeCredentialApplyInputV1,
  materializeHeaders: MaterializeHeaders): Promise<Result> {
  if (input.baseline.kind !== 'allow-all') return { kind: 'refused', code: 'vercel_egress_baseline_unsupported' };
  if (!input.bindings.length) return { kind: 'ready', policy: { mode: 'allow-all' } };
  const allow = new Map<string, Rule[]>([['*', []]]);
  try {
    for (const binding of input.bindings) {
      const destination = destinationFor(binding);
      if (!destination || !binding.requests.length) return { kind: 'refused', code: 'vercel_native_destination_unsupported' };
      const materialized = await materializeHeaders({ bindingKey: binding.bindingKey });
      if (!materialized.ok) return { kind: 'refused', code: materialized.code };
      const headers = new Headers(materialized.headers);
      if (!headers.has(binding.placeholder.header)) return { kind: 'refused', code: 'vercel_native_credential_unavailable' };
      for (const header of binding.attributionHeaders ?? []) headers.set(header.name, header.value);
      headers.set('host', destination.host);
      const transform = [{ headers: Object.fromEntries(headers.entries()) }];
      for (const request of binding.requests) {
        const rule = { match: { path: { exact: request.path }, method: request.methods,
          headers: [{ key: { exact: binding.placeholder.header }, value: { exact: binding.placeholder.value } }] }, transform };
        const siblings = allow.get(destination.hostname) ?? [];
        siblings.push(rule);
        allow.set(destination.hostname, siblings);
      }
    }
    return { kind: 'ready', policy: { allow: Object.fromEntries(allow) } };
  } catch { return { kind: 'refused', code: 'vercel_native_credential_unavailable' }; }
}
