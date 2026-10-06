import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import type { HomeConnectionDescriptorV1, IrohEndpointDescriptorV1 } from '@happier-dev/protocol';

type HomeIrohEndpointDescriptorV1 = Extract<
  HomeConnectionDescriptorV1['endpoints'][number],
  { kind: 'iroh' }
>;

export type HomeCarrierPolicyFailureClassification = Readonly<{ fallbackAllowed: boolean }>;
export type HomeCarrierPreferredTransport = 'iroh' | 'https';
export type HomeCarrierAcquisitionMode = 'initial_selection' | 'pinned_recovery';
export type HomeApplicationCarrierEligibility = 'automatic' | 'standard_only';

export const HOME_CARRIER_POLICY_ENV_KEY = 'HAPPIER_HOME_CARRIER_POLICY';

/** Operator-local application carrier selection for CLI and daemon processes. */
export function readHomeApplicationCarrierEligibilityFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): HomeApplicationCarrierEligibility {
  const raw = String(env[HOME_CARRIER_POLICY_ENV_KEY] ?? '').trim().toLowerCase();
  if (!raw || raw === 'automatic') return 'automatic';
  if (raw === 'standard_only') return 'standard_only';
  throw new Error(`${HOME_CARRIER_POLICY_ENV_KEY} must be "automatic" or "standard_only"`);
}

/**
 * Canonical initial carrier preference for a normalized Home descriptor.
 * Acquisition, failure classification, and fallback remain owned by
 * acquireHomeCarrierByPolicy.
 */
export function resolveHomeCarrierPreferredTransport(
  descriptor: HomeConnectionDescriptorV1,
): HomeCarrierPreferredTransport {
  return descriptor.endpoints.some((endpoint) => endpoint.kind === 'iroh') ? 'iroh' : 'https';
}

export type HomeCarrierPolicyIrohLease<Value> = Readonly<{
  homeServerIdentityId: string;
  endpointId: string;
  status: 'ready' | 'degraded';
  value: Value;
  release(): Promise<void>;
}>;

export type HomeCarrierPolicyResult<Value> =
  | Readonly<{ kind: 'iroh'; carrier: HomeCarrierPolicyIrohLease<Value>; release(): Promise<void> }>
  | Readonly<{ kind: 'https'; runtimeOrigin: string }>
  | Readonly<{ kind: 'unavailable'; error: unknown }>
  | Readonly<{ kind: 'fail_closed'; error: unknown; fallbackAllowed: boolean }>;

export type HomeCarrierPolicyInput<Value> = Readonly<{
  mode: HomeCarrierAcquisitionMode;
  /** Missing legacy inputs retain the established automatic behavior. */
  applicationCarrierEligibility?: HomeApplicationCarrierEligibility;
  descriptor: HomeConnectionDescriptorV1;
  preferredTransport: HomeCarrierPreferredTransport;
  acquireIroh(input: Readonly<{
    descriptor: HomeConnectionDescriptorV1;
    endpoint: IrohEndpointDescriptorV1;
  }>): Promise<HomeCarrierPolicyIrohLease<Value>>;
  classifyFailure(error: unknown): HomeCarrierPolicyFailureClassification;
}>;

export class HomeCarrierPolicyError extends Error {
  readonly name = 'HomeCarrierPolicyError';

  constructor(
    readonly code: 'identity_mismatch' | 'invalid_preference' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

const retainedReleases = new Set<() => Promise<void>>();

export function createOwnedHomeCarrierRelease(
  releasePhysicalCarrier: () => Promise<void>,
): () => Promise<void> {
  let released = false;
  let inFlight: Promise<void> | null = null;
  let ownedRelease!: () => Promise<void>;
  ownedRelease = () => {
    if (released) return Promise.resolve();
    inFlight ??= releasePhysicalCarrier().then(
      () => {
        released = true;
        inFlight = null;
        retainedReleases.delete(ownedRelease);
      },
      (error: unknown) => {
        inFlight = null;
        retainedReleases.add(ownedRelease);
        throw error;
      },
    );
    return inFlight;
  };
  return ownedRelease;
}

export async function drainRetainedHomeCarrierReleases(): Promise<void> {
  await Promise.allSettled([...retainedReleases].map(async (release) => await release()));
}

/**
 * The descriptor-declared application origin this policy may carry bytes over.
 *
 * Approval follows the protocol's Home application-origin policy — HTTPS, or HTTP to a
 * loopback host (`HomeApplicationOriginV1Schema`) — rather than a stricter second rule here.
 * Requiring `https:` silently left every loopback-HTTP Home, which is the only shape a local
 * or self-hosted Home publishes, with no application carrier at all: enrollment against it
 * could never resolve a transport.
 *
 * A public HTTPS ingress still wins over a loopback entry regardless of declaration order,
 * because loopback reaches only the machine running this process; loopback is the last resort
 * for a Home that publishes no independent ingress. Loopback membership is the shared
 * predicate's call, so a plaintext origin on any other host stays refused outright.
 */
function resolveDescriptorApplicationOrigin(descriptor: HomeConnectionDescriptorV1): string | null {
  let loopbackOrigin: string | null = null;
  for (const endpoint of descriptor.endpoints) {
    if (endpoint.kind !== 'https') continue;
    let parsed: URL;
    try {
      parsed = new URL(endpoint.url);
    } catch {
      // Invalid descriptor values are normally rejected at the schema boundary;
      // this owner still refuses to manufacture a fallback from them.
      continue;
    }
    if (parsed.username || parsed.password) continue;
    const loopback = parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
    if (parsed.protocol !== 'https:' && !loopback) continue;
    parsed.search = '';
    parsed.hash = '';
    const origin = parsed.toString().replace(/\/+$/u, '');
    if (!loopback) return origin;
    loopbackOrigin ??= origin;
  }
  return loopbackOrigin;
}

/**
 * Platform-neutral carrier decision. Standard-only eligibility bypasses Iroh
 * and uses descriptor-declared HTTPS. Automatic eligibility attempts Iroh
 * first; during initial selection only, the injected classifier may authorize
 * independently trusted HTTPS. Recovery of a selected Iroh carrier stays
 * pinned to Iroh. Identity/readiness mismatch after acquisition is always
 * fail-closed and the physical lease remains in retryable cleanup custody.
 */
export async function acquireHomeCarrierByPolicy<Value>(
  input: HomeCarrierPolicyInput<Value>,
): Promise<HomeCarrierPolicyResult<Value>> {
  const expectedPreference = resolveHomeCarrierPreferredTransport(input.descriptor);
  if (input.preferredTransport !== expectedPreference) {
    return {
      kind: 'fail_closed',
      error: new HomeCarrierPolicyError(
        'invalid_preference',
        'Home target carrier preference does not match its descriptor',
      ),
      fallbackAllowed: false,
    };
  }
  const endpoint = input.descriptor.endpoints.find(
    (candidate): candidate is HomeIrohEndpointDescriptorV1 => candidate.kind === 'iroh',
  );
  const applicationOrigin = resolveDescriptorApplicationOrigin(input.descriptor);
  if (
    input.mode === 'pinned_recovery'
    && (input.applicationCarrierEligibility === 'standard_only' || !endpoint)
  ) {
    return {
      kind: 'fail_closed',
      error: new HomeCarrierPolicyError(
        'unavailable',
        'Pinned Iroh recovery cannot select an HTTPS carrier',
      ),
      fallbackAllowed: false,
    };
  }
  if (input.applicationCarrierEligibility === 'standard_only') {
    return applicationOrigin
      ? { kind: 'https', runtimeOrigin: applicationOrigin }
      : {
          kind: 'unavailable',
          error: new HomeCarrierPolicyError(
            'unavailable',
            'Home application carrier policy allows only a descriptor-declared application origin',
          ),
        };
  }
  if (!endpoint) {
    return applicationOrigin
      ? { kind: 'https', runtimeOrigin: applicationOrigin }
      : {
          kind: 'unavailable',
          error: new HomeCarrierPolicyError('unavailable', 'Home descriptor declares no eligible application endpoint'),
        };
  }

  try {
    const acquired = await input.acquireIroh({ descriptor: input.descriptor, endpoint });
    const release = createOwnedHomeCarrierRelease(acquired.release);
    if (
      acquired.status !== 'ready'
      || acquired.homeServerIdentityId !== input.descriptor.homeServerIdentityId
      || acquired.endpointId !== endpoint.endpointId
    ) {
      await release().catch(() => undefined);
      return {
        kind: 'fail_closed',
        error: new HomeCarrierPolicyError(
          'identity_mismatch',
          'Acquired Iroh carrier does not match the requested Home identity and EndpointId',
        ),
        fallbackAllowed: false,
      };
    }
    const carrier = { ...acquired, release };
    return { kind: 'iroh', carrier, release };
  } catch (error) {
    const classification = input.classifyFailure(error);
    if (input.mode === 'initial_selection' && classification.fallbackAllowed && applicationOrigin) {
      return { kind: 'https', runtimeOrigin: applicationOrigin };
    }
    return { kind: 'fail_closed', error, fallbackAllowed: classification.fallbackAllowed };
  }
}
