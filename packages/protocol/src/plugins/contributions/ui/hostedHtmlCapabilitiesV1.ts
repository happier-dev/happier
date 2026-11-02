import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ActionIdSchema } from '../../../actions/actionIds.js';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import { CanonicalHttpOriginSchema } from '../../../http/canonicalHttpOrigin.js';
import {
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
  type PluginContributionIdentityV1,
} from '../../contributionIdentity.js';
import {
  PLUGIN_UI_CALLER_HOSTED_HTML_HOST_METHODS_V1,
  PluginUiHostMethodV1Schema,
  type PluginUiHostMethodV1,
} from '../../ui/hostApiDefinition.js';

/**
 * The declared authority a hosted-HTML document asks for.
 *
 * It is one grammar for two sources — an installed plugin renderer and a
 * caller-authored Session document — because the reviewing human, the
 * capability digest and the mounting host must all read the same request. It
 * declares only what is asked for: nothing here grants a method, resolves a
 * Resource/Action, or decides confirmation policy. Those stay with the Host API
 * negotiation owner and the canonical Actions resolver.
 */

/**
 * Exact normalized HTTPS origins only.
 *
 * The canonical origin rule supplies normalization (no credentials, path,
 * query, fragment or default port), and the literal host pattern supplies what
 * URL parsing alone does not refuse: `new URL('https://*.example.com')` parses
 * and round-trips, so a wildcard would otherwise reach `connect-src`. There is
 * deliberately no wildcard, port range or policy DSL — an approved egress
 * target is the exact string the frame may connect to.
 */
const UI_SURFACE_HTTPS_ORIGIN_PATTERN_V1 =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/u;

export const UiSurfaceNetworkOriginV1Schema = lazyZodSchema(() => z.string().check(z.superRefine((value, ctx) => {
  if (
    !UI_SURFACE_HTTPS_ORIGIN_PATTERN_V1.test(value)
    || !CanonicalHttpOriginSchema.safeParse(value).success
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected an exact canonical HTTPS origin without path, query, or credentials.',
    });
  }
})));
export type UiSurfaceNetworkOriginV1 = z.infer<typeof UiSurfaceNetworkOriginV1Schema>;

/** Resources are always the canonical qualified contribution identity. */
export const UiSurfaceResourceRequestV1Schema = asProtocolZod(PluginContributionIdentityV1Schema);
export type UiSurfaceResourceRequestV1 = PluginContributionIdentityV1;

/**
 * An Action request names either a closed host ActionSpec id or an exact
 * qualified contributed Action, mirroring how the mounted dispatcher already
 * classifies a reference. A by-value document has no declaring plugin, so a
 * bare contributed local id is deliberately not admissible here.
 */
export const UiSurfaceActionRequestV1Schema = lazyZodSchema(() => z.union([
  ActionIdSchema,
  asProtocolZod(PluginContributionIdentityV1Schema),
]));
export type UiSurfaceActionRequestV1 = z.infer<typeof UiSurfaceActionRequestV1Schema>;

const capabilityRequestFieldsV1 = () => z.strictObject({
  hostMethods: z.optional(z.array(PluginUiHostMethodV1Schema).check(z.maxLength(PluginUiHostMethodV1Schema.options.length))),
  resources: z.optional(z.array(UiSurfaceResourceRequestV1Schema)),
  actions: z.optional(z.array(UiSurfaceActionRequestV1Schema)),
  networkOrigins: z.optional(z.array(UiSurfaceNetworkOriginV1Schema)),
  network: z.optional(z.enum(['none', 'open'])),
});

function validateNetworkAlternativeV1(
  request: Readonly<{ network?: 'none' | 'open'; networkOrigins?: readonly string[] }>,
  context: z.core.$RefinementCtx,
): void {
  if (request.network !== undefined && (request.networkOrigins?.length ?? 0) > 0) {
    context.addIssue({ code: 'custom', path: ['networkOrigins'], message: 'Choose exact origins or an explicit network alternative.' });
  }
}

export type UiSurfaceCapabilityRequestV1 = z.infer<ReturnType<typeof capabilityRequestFieldsV1>>;
export const UiSurfaceCapabilityRequestV1Schema: z.ZodMiniType<UiSurfaceCapabilityRequestV1, UiSurfaceCapabilityRequestV1> = lazyZodSchema(() => capabilityRequestFieldsV1().check(z.superRefine(validateNetworkAlternativeV1)));

export const UiSurfaceNetworkRequestV1Schema = lazyZodSchema(() => z.pick(capabilityRequestFieldsV1(), { network: true, networkOrigins: true }).check(z.superRefine(validateNetworkAlternativeV1)));
export type UiSurfaceNetworkRequestV1 = z.infer<typeof UiSurfaceNetworkRequestV1Schema>;

/**
 * The renderer arm's capability request.
 *
 * `requiredHostMethods` is already the one declared host-method vocabulary for
 * every renderer kind, so the renderer-level request carries only the fields it
 * does not own. Two host-method declarations on one renderer would be two
 * decision-makers for the same fact.
 */
export const PluginUiHostedHtmlRequestedCapabilitiesV1Schema = lazyZodSchema(() => z.omit(capabilityRequestFieldsV1(), { hostMethods: true }).check(z.superRefine(validateNetworkAlternativeV1)));
export type PluginUiHostedHtmlRequestedCapabilitiesV1 =
  z.infer<typeof PluginUiHostedHtmlRequestedCapabilitiesV1Schema>;

/**
 * The normalized request every consumer digests, reviews and intersects
 * against. Absent lists become empty ones so equal requests are structurally
 * equal, and each list is deduplicated and sorted so declaration order can
 * never change a fingerprint or force a re-review.
 */
export type NormalizedUiSurfaceCapabilityRequestV1 = Readonly<{
  hostMethods: readonly PluginUiHostMethodV1[];
  resources: readonly UiSurfaceResourceRequestV1[];
  actions: readonly UiSurfaceActionRequestV1[];
  network: 'none' | 'origins' | 'open';
  networkOrigins: readonly UiSurfaceNetworkOriginV1[];
}>;

/** Effective guest egress; empty exact-origin declarations normalize to none. */
export const UiSurfaceNetworkPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  network: z.enum(['none', 'origins', 'open']),
  networkOrigins: z.array(UiSurfaceNetworkOriginV1Schema),
}).check(z.superRefine((policy, context) => {
  if ((policy.network === 'origins') !== (policy.networkOrigins.length > 0)) {
    context.addIssue({ code: 'custom', path: ['networkOrigins'], message: 'Normalized origins exist only for the exact-origin policy.' });
  }
})));
export type UiSurfaceNetworkPolicyV1 = Readonly<{
  network: z.infer<typeof UiSurfaceNetworkPolicyV1Schema>['network'];
  networkOrigins: readonly UiSurfaceNetworkOriginV1[];
}>;

/** Installed renderers and instance overrides can only narrow an admitted ceiling. */
export function intersectUiSurfaceNetworkPoliciesV1(
  request: UiSurfaceNetworkPolicyV1,
  ceiling: UiSurfaceNetworkPolicyV1,
): UiSurfaceNetworkPolicyV1 {
  if (request.network === 'none' || ceiling.network === 'none') {
    return Object.freeze({ network: 'none', networkOrigins: Object.freeze([]) });
  }
  if (request.network === 'open') return ceiling;
  if (ceiling.network === 'open') return request;
  const networkOrigins = sortedUnique(request.networkOrigins.filter(origin => ceiling.networkOrigins.includes(origin)), origin => origin);
  return Object.freeze({ network: networkOrigins.length > 0 ? 'origins' : 'none', networkOrigins });
}

/** The one canonical string form of an Action request, used for order and identity. */
export function formatUiSurfaceActionRequestV1(request: UiSurfaceActionRequestV1): string {
  return typeof request === 'string' ? request : buildQualifiedPluginContributionKey(request);
}

function sortedUnique<TValue>(
  values: readonly TValue[],
  key: (value: TValue) => string,
): readonly TValue[] {
  const byKey = new Map<string, TValue>();
  for (const value of values) byKey.set(key(value), value);
  return Object.freeze([...byKey.entries()]
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
    .map(([, value]) => value));
}

/**
 * Parses and canonicalizes one request, or returns `null`.
 *
 * An invalid request never degrades into a partially salvaged one: a document
 * that asked for something the grammar refuses does not get to execute with the
 * remainder silently granted.
 */
export function normalizeUiSurfaceCapabilityRequestV1(
  input: unknown,
): NormalizedUiSurfaceCapabilityRequestV1 | null {
  // `undefined` means "declared nothing"; every other unparseable value,
  // including `null`, stays a rejected request rather than an empty grant.
  const parsed = UiSurfaceCapabilityRequestV1Schema.safeParse(input === undefined ? {} : input);
  if (!parsed.success) return null;
  return Object.freeze({
    hostMethods: sortedUnique(parsed.data.hostMethods ?? [], (method) => method),
    resources: sortedUnique(
      parsed.data.resources ?? [],
      (resource) => buildQualifiedPluginContributionKey(resource),
    ),
    actions: sortedUnique(parsed.data.actions ?? [], formatUiSurfaceActionRequestV1),
    network: parsed.data.network ?? ((parsed.data.networkOrigins?.length ?? 0) > 0 ? 'origins' : 'none'),
    networkOrigins: sortedUnique(parsed.data.networkOrigins ?? [], (origin) => origin),
  });
}

/**
 * Composes a hosted-HTML renderer's two declaration fields into one normalized
 * request. This is the sole reader: consumers must not re-derive the union of
 * `requiredHostMethods` and `requestedCapabilities` themselves.
 */
export function resolvePluginUiHostedHtmlCapabilityRequestV1(
  renderer: Readonly<{
    requiredHostMethods?: readonly PluginUiHostMethodV1[];
    requestedCapabilities?: PluginUiHostedHtmlRequestedCapabilitiesV1;
  }>,
): NormalizedUiSurfaceCapabilityRequestV1 | null {
  return normalizeUiSurfaceCapabilityRequestV1({
    ...(renderer.requestedCapabilities ?? {}),
    ...(renderer.requiredHostMethods === undefined
      ? {}
      : { hostMethods: renderer.requiredHostMethods }),
  });
}

export type UiSurfaceCapabilityAdmissionV1 =
  | Readonly<{
      kind: 'admitted';
      capabilities: NormalizedUiSurfaceCapabilityRequestV1;
      advertisedHostMethods: readonly PluginUiHostMethodV1[];
    }>
  | Readonly<{
      kind: 'rejected';
      code: 'capability_request_invalid' | 'host_method_outside_caller_ceiling';
    }>;

const CALLER_HOSTED_HTML_HOST_METHODS: ReadonlySet<string> = new Set(
  PLUGIN_UI_CALLER_HOSTED_HTML_HOST_METHODS_V1,
);

/**
 * Admits one caller-authored document's request against the closed ceiling.
 *
 * A method outside the ceiling is REJECTED rather than dropped, so an author
 * cannot discover the boundary by watching which of their requests silently
 * disappeared. As on installed-plugin surfaces, `context` is baseline
 * presentation and `watchContext` is its transport-supported push projection;
 * neither needs an authored request. Both are advertised when currently
 * admitted by the transport. Every other method stays the intersection of the
 * request and the currently admitted/approved set, so a broader host never
 * grants unrequested Actions, Resources or notifications. Network admission is
 * unchanged.
 *
 * The result is deliberately domain-free. Mapping a rejection to a Board, item
 * or Session outcome belongs to the consuming adapter, not to this parser.
 */
export function admitCallerAuthoredUiSurfaceCapabilitiesV1(
  input: Readonly<{
    request: unknown;
    admittedHostMethods: readonly PluginUiHostMethodV1[];
  }>,
): UiSurfaceCapabilityAdmissionV1 {
  const capabilities = normalizeUiSurfaceCapabilityRequestV1(input.request);
  if (!capabilities) {
    return Object.freeze({ kind: 'rejected', code: 'capability_request_invalid' } as const);
  }
  if (capabilities.hostMethods.some((method) => !CALLER_HOSTED_HTML_HOST_METHODS.has(method))) {
    return Object.freeze({
      kind: 'rejected',
      code: 'host_method_outside_caller_ceiling',
    } as const);
  }
  const admitted: ReadonlySet<string> = new Set(input.admittedHostMethods);
  return Object.freeze({
    kind: 'admitted',
    capabilities,
    advertisedHostMethods: Object.freeze(
      sortedUnique<PluginUiHostMethodV1>(
        [...capabilities.hostMethods, 'context', 'watchContext'],
        (method) => method,
      ).filter((method) => admitted.has(method)),
    ),
  } as const);
}

export function uiSurfaceNetworkAccessWidensV1(
  next: UiSurfaceNetworkRequestV1 | UiSurfaceNetworkPolicyV1,
  previous: UiSurfaceNetworkRequestV1 | UiSurfaceNetworkPolicyV1,
): boolean {
  if (next.network === 'none' || next.network !== 'open' && !next.networkOrigins?.length) return false;
  return previous.network !== 'open' && (next.network === 'open'
    || next.networkOrigins?.some(origin => !previous.networkOrigins?.includes(origin)) === true);
}
