import { classifyIrohHomeCarrierFailure, IrohError } from '@happier-dev/iroh-native/node';
import {
  createManagedEndpointSupervisor,
  DEFAULT_MANAGED_CONNECTION_POLICY,
  type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import type { FeaturesResponse, HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import {
  acquireHomeCarrierByPolicy,
  readHomeApplicationCarrierEligibilityFromEnv,
  resolveDescriptorApplicationOrigin,
  type HomeApplicationCarrierEligibility,
} from '@happier-dev/cli-common/homeEnrollment';
import { assertResolvedHomeTargetIdentity, resolveHomeTarget, type ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';

import {
  createLoopbackHomeIdentityProbe,
  createLoopbackReadinessProbe,
} from '@/api/connection/createLoopbackReadinessProbe';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { resolveServerProfileApiUrl } from '@/configuration/serverSelection';
import { logger } from '@/ui/logger';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { configuration } from '@/configuration';
import {
  getServerProfile,
  setServerProfileEndpointsById,
  adoptServerProfileHomeConnectionDescriptor,
  refreshServerProfileHomeConnectionDescriptor,
  type ServerProfile,
} from '@/server/serverProfiles';

import type { DaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import { classifyDaemonHomeCarrierFailure, DaemonHomeReadinessError } from './failureClassification';
import { createHomeCarrierOrigin } from './homeCarrierOrigin';

type ProbeInput = Readonly<{
  serverUrl: string;
  token: string;
  expectedServerIdentityId: string;
  signal?: AbortSignal;
}>;

type IdentityProbeInput = Readonly<{
  serverUrl: string;
  expectedServerIdentityId: string;
  signal?: AbortSignal;
}>;

export type DaemonHomeTransport = Readonly<{
  carrier: 'standard' | 'iroh';
  observedPath: 'direct' | 'relay' | 'unknown';
  release(): Promise<void>;
  reacquire(): Promise<ReadinessProbeResult>;
  verifyAuthenticated(token: string): Promise<ReadinessProbeResult>;
}>;

const noRelease = async (): Promise<void> => undefined;

type DaemonHomeProfile = Pick<ServerProfile, 'serverUrl' | 'localServerUrl' | 'homeConnectionDescriptor' | 'homeConnectionDescriptorAuthority'> & Readonly<{ id?: string }>;

function withInvocationEndpoints(profile: ServerProfile): ServerProfile {
  // Configuration owns environment precedence. Retain the saved identity and
  // re-read ordinary endpoint edits on reconnect when no override was supplied.
  if (profile.id !== configuration.activeServerId
    || createServerUrlComparableKey(profile.serverUrl) !== createServerUrlComparableKey(configuration.serverUrl)) return profile;
  return {
    ...profile,
    ...(process.env.HAPPIER_LOCAL_SERVER_URL?.trim() ? { localServerUrl: configuration.apiServerUrl } : {}),
    ...(process.env.HAPPIER_WEBAPP_URL?.trim() ? { webappUrl: configuration.webappUrl } : {}),
  };
}

/** Retain the invocation's URL-only metadata before transport starts reading it.
 * Only authenticated publication may subsequently establish Home authority. */
export async function resolveCurrentDaemonHomeProfile(): Promise<ServerProfile> {
  const target = await resolveCurrentCliHomeTarget();
  if (target.profileId) return withInvocationEndpoints(await getServerProfile(target.profileId));
  return await setServerProfileEndpointsById({
    id: configuration.activeServerId,
    serverUrl: target.canonicalAuthUrl,
    localServerUrl: configuration.apiServerUrl,
    webappUrl: configuration.webappUrl,
  });
}

type PrepareDaemonHomeIrohTransportInput = Readonly<{
  runtime: DaemonMachineIrohRuntime | null;
  profile: DaemonHomeProfile;
  applicationCarrierEligibility?: HomeApplicationCarrierEligibility;
  token?: string;
  readProfile?: () => Promise<DaemonHomeProfile>;
  identityProbe?: (input: IdentityProbeInput) => Promise<ReadinessProbeResult>;
  probe?: (input: ProbeInput) => Promise<ReadinessProbeResult>;
  publishRuntimeOrigin?: (...args: Parameters<typeof publishServerHttpRuntimeOrigin>) => (() => void) | Promise<() => void>;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}>;

type ActiveDaemonHomeTransport = Omit<DaemonHomeTransport, 'reacquire'>;

function homeTransportFailureReadiness(error: unknown): ReadinessProbeResult {
  if (error instanceof DaemonHomeReadinessError) return error.probe;
  const classification = classifyIrohHomeCarrierFailure(error);
  return {
    status: classification.failureClass === 'identity-auth' || classification.failureClass === 'descriptor-integrity'
      ? 'auth_failed' : 'server_unreachable',
    errorMessage: error instanceof Error ? error.message : 'Home transport acquisition failed closed',
  };
}

async function waitForDaemonHomeReadiness(
  probe: () => Promise<ReadinessProbeResult>,
  signal?: AbortSignal,
): Promise<ReadinessProbeResult> {
  // Startup waits before publishing a verified origin or successor control state.
  // The existing endpoint owner supplies retry/backoff; reconnect already has
  // its own supervisor and continues to consume one-attempt probes below.
  const supervisor = createManagedEndpointSupervisor({
    ...DEFAULT_MANAGED_CONNECTION_POLICY,
    probeReadiness: probe,
    onStateChange: (state) => {
      if (state.phase === 'offline') {
        logger.warn('[DAEMON RUN] Waiting for verified Home transport', {
          status: state.lastProbe?.status,
          nextRetryAt: state.nextRetryAt,
        });
      }
    },
  });
  let unsubscribe = () => {};
  let onAbort = () => {};
  try {
    return await new Promise<ReadinessProbeResult>((resolve, reject) => {
      onAbort = () => resolve({ status: 'server_unreachable', errorMessage: 'Home transport is released' });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      unsubscribe = supervisor.subscribe((state) => {
        if (state.phase === 'online') resolve({ status: 'ready' });
        if (state.phase === 'auth_failed' && state.lastProbe) resolve(state.lastProbe);
      });
      void supervisor.start().catch(reject);
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    unsubscribe();
    await supervisor.stop();
  }
}

function withReacquisition(
  input: PrepareDaemonHomeIrohTransportInput,
  initial: ActiveDaemonHomeTransport,
  releaseOrigin: () => Promise<void>,
): DaemonHomeTransport {
  let active = initial;
  let activeRelease = initial.release;
  const pendingReleases = new Set([releaseOrigin, initial.release]);
  let released = false;
  let closing = false;
  let releaseInFlight: Promise<void> | null = null;
  let reacquireInFlight: Promise<ReadinessProbeResult> | null = null;
  let authenticatedToken = input.token;
  let acceptedDescriptorRevision = input.profile.homeConnectionDescriptor?.revision ?? null;
  const readinessCancellation = new AbortController();
  const readinessSignal = input.signal
    ? AbortSignal.any([input.signal, readinessCancellation.signal])
    : readinessCancellation.signal;
  async function reacquire(token = authenticatedToken): Promise<ReadinessProbeResult> {
    if (released || closing) return { status: 'server_unreachable', errorMessage: 'Home transport is released' };
    if (reacquireInFlight) return await reacquireInFlight;
    reacquireInFlight = (async (): Promise<ReadinessProbeResult> => {
      try {
        const currentProfile = await (input.readProfile ?? (async () => input.profile.id
          ? withInvocationEndpoints(await getServerProfile(input.profile.id))
          : input.profile))().catch((error: unknown) => {
          // A removed saved profile retires the target, rather than representing
          // an optional carrier outage that the reconnect supervisor can retry.
          throw new DaemonHomeReadinessError({ status: 'auth_failed',
            errorMessage: error instanceof Error ? error.message : 'Home profile is unavailable' });
        });
        if (active.carrier === 'iroh' && !currentProfile.homeConnectionDescriptor) {
          return {
            status: 'server_unreachable',
            errorMessage: 'Selected Iroh Home transport cannot be replaced without a current connection descriptor',
          };
        }
        const currentDescriptor = currentProfile.homeConnectionDescriptor;
        // A socket reconnect does not itself retire a healthy Home bridge.
        // Keep its publication while the same descriptor still serves it;
        // only a failed probe or a descriptor change needs a replacement.
        const sameIrohDescriptor = active.carrier === 'iroh'
          && currentDescriptor?.revision === acceptedDescriptorRevision;
        const relayOnlyRecovery = sameIrohDescriptor
          && Boolean(input.runtime?.endpoint?.relayUrls?.length)
          && currentDescriptor.endpoints.some((endpoint) => endpoint.kind === 'iroh'
            && Boolean(endpoint.relayUrls?.length && endpoint.directAddresses?.length));
        if (sameIrohDescriptor && token) {
          const currentReadiness = await active.verifyAuthenticated(token);
          if (currentReadiness.status === 'ready' || currentReadiness.status === 'auth_failed') return currentReadiness;
        }
        const replacement = await prepareDaemonHomeIrohTransportOnce(
          {
            ...input,
            ...(token ? { token } : {}),
            isCancelled: () => closing || released,
          },
          currentProfile,
          relayOnlyRecovery,
        );
        if (closing || released) {
          pendingReleases.add(replacement.release);
          await replacement.release();
          pendingReleases.delete(replacement.release);
          return { status: 'server_unreachable', errorMessage: 'Home transport is released' };
        }
        const predecessorRelease = activeRelease;
        active = replacement;
        activeRelease = replacement.release;
        acceptedDescriptorRevision = currentDescriptor?.revision ?? null;
        pendingReleases.add(activeRelease);
        try {
          await predecessorRelease();
          pendingReleases.delete(predecessorRelease);
        } catch {
          // Keep custody of a failed predecessor release for final teardown.
        }
        return { status: 'ready' };
      } catch (error) {
        if (closing || released) {
          return { status: 'server_unreachable', errorMessage: 'Home transport is released' };
        }
        return homeTransportFailureReadiness(error);
      }
    })().finally(() => {
      reacquireInFlight = null;
    });
    return await reacquireInFlight;
  }
  return {
    get carrier() {
      return active.carrier;
    },
    get observedPath() {
      return active.observedPath;
    },
    async release() {
      if (released) return;
      closing = true;
      readinessCancellation.abort();
      releaseInFlight ??= (async () => {
        await reacquireInFlight?.catch(() => undefined);
        const errors: unknown[] = [];
        for (const release of [...pendingReleases]) {
          try {
            await release();
            pendingReleases.delete(release);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Failed to release every daemon Home transport.');
        released = true;
      })().finally(() => {
        releaseInFlight = null;
      });
      return await releaseInFlight;
    },
    reacquire: () => reacquire(),
    async verifyAuthenticated(token) {
      if (released || closing) return { status: 'server_unreachable', errorMessage: 'Home transport is released' };
      const readiness = await waitForDaemonHomeReadiness(() => reacquire(token), readinessSignal);
      if (readiness.status === 'ready') authenticatedToken = token;
      return readiness;
    },
  };
}

async function defaultIdentityProbe(input: IdentityProbeInput): Promise<ReadinessProbeResult> {
  return await createLoopbackHomeIdentityProbe(input)();
}

async function defaultProbe(input: ProbeInput): Promise<ReadinessProbeResult> {
  return await createLoopbackReadinessProbe(input)();
}

async function prepareDaemonHomeIrohTransportOnce(
  input: PrepareDaemonHomeIrohTransportInput,
  profile: DaemonHomeProfile,
  relayOnlyRecovery = false,
  superviseReadiness = false,
): Promise<ActiveDaemonHomeTransport> {
  const descriptor = profile.homeConnectionDescriptor;
  let needsHomeBinding = !descriptor || profile.homeConnectionDescriptorAuthority === 'advisory';
  const observeHomeBinding = async (serverUrl: string, token: string) => {
    if (profile.id && needsHomeBinding) {
      const outcome = await refreshServerProfileHomeConnectionDescriptor({
        profileId: profile.id, serverUrl, token, signal: input.signal,
      });
      if (outcome !== 'unavailable') needsHomeBinding = false;
    }
  };
  if (!descriptor) {
    if (input.token) await observeHomeBinding(resolveServerProfileApiUrl(profile), input.token);
    return {
      carrier: 'standard',
      observedPath: 'unknown',
      release: noRelease,
      verifyAuthenticated: async token => {
        await observeHomeBinding(resolveServerProfileApiUrl(profile), token);
        return { status: 'ready' };
      },
    };
  }
  const resolvedTarget = await resolveHomeTarget({
    input: { kind: 'descriptor', descriptor, authority: 'current_connection' },
    readSavedProfile: async () => null,
  });
  const expectedHomeServerIdentityId = resolvedTarget.homeServerIdentityId;
  if (!expectedHomeServerIdentityId) throw new Error('Resolved daemon Home target has no stable identity');

  const probe = input.probe ?? (async (probeInput: ProbeInput) => await defaultProbe({ ...probeInput, signal: input.signal }));
  const identityProbe = input.identityProbe ?? (
    input.probe
      ? async ({ serverUrl, expectedServerIdentityId }: IdentityProbeInput) => await input.probe!({
        serverUrl,
        token: input.token ?? '',
        expectedServerIdentityId,
      })
      : async (probeInput: IdentityProbeInput) => await defaultIdentityProbe({ ...probeInput, signal: input.signal })
  );
  // A Home without an alternate carrier keeps its existing readiness wait.
  const checkIrohReadiness = async (check: () => Promise<ReadinessProbeResult>) => superviseReadiness
    ? await waitForDaemonHomeReadiness(check, input.signal)
    : await check();
  const publish = input.publishRuntimeOrigin ?? publishServerHttpRuntimeOrigin;
  const verifyAuthenticatedConnection = async (serverUrl: string, token: string) => {
    const readiness = await probe({ serverUrl, token, expectedServerIdentityId: expectedHomeServerIdentityId });
    if (readiness.status === 'ready') await observeHomeBinding(serverUrl, token);
    return readiness;
  };
  const activateTrustedFallback = async (serverUrl: string): Promise<ActiveDaemonHomeTransport> => {
    if (input.signal?.aborted || input.isCancelled?.()) {
      throw new DaemonHomeReadinessError({ status: 'server_unreachable', errorMessage: 'Home transport is released' });
    }
    const unpublish = await publish(serverUrl, 'https', undefined, profile.id ?? configuration.activeServerId);
    return {
      carrier: 'standard',
      observedPath: 'unknown',
      release: async () => unpublish(),
      verifyAuthenticated: async (token) => await verifyAuthenticatedConnection(serverUrl, token),
    };
  };
  const acquireNativeLease = async () => {
    const ensureHomeTunnel = input.runtime?.ensureHomeTunnel;
    if (!ensureHomeTunnel) {
      throw new IrohError('unavailable', 'Native Iroh Home transport is unavailable');
    }
    return await ensureHomeTunnel({ descriptor, ...(relayOnlyRecovery ? { relayOnly: true } : {}) });
  };
  const selection = await acquireHomeCarrierByPolicy({
    applicationCarrierEligibility: input.applicationCarrierEligibility
      ?? readHomeApplicationCarrierEligibilityFromEnv(process.env),
    descriptor,
    preferredTransport: resolvedTarget.preferredTransport,
    classifyFailure: classifyDaemonHomeCarrierFailure,
    acquireIroh: async ({ endpoint }) => {
      const nativeLease = await acquireNativeLease();
      try {
        const identityReadiness = await checkIrohReadiness(async () => await identityProbe({
          serverUrl: nativeLease.runtimeOrigin,
          expectedServerIdentityId: expectedHomeServerIdentityId,
        }));
        if (identityReadiness.status !== 'ready') {
          throw new DaemonHomeReadinessError({
            ...identityReadiness,
            errorMessage: `Iroh Home verification failed: ${identityReadiness.errorMessage ?? identityReadiness.status}`,
          });
        }
        if (input.token) {
          const token = input.token;
          const authenticatedReadiness = await checkIrohReadiness(
            async () => await verifyAuthenticatedConnection(nativeLease.runtimeOrigin, token),
          );
          if (authenticatedReadiness.status !== 'ready') {
            throw new DaemonHomeReadinessError({
              ...authenticatedReadiness,
              errorMessage: `Iroh Home verification failed: ${authenticatedReadiness.errorMessage ?? authenticatedReadiness.status}`,
            });
          }
        }
        if (input.signal?.aborted || input.isCancelled?.()) {
          throw new IrohError('cancelled', 'Home transport is released');
        }
        return {
          homeServerIdentityId: expectedHomeServerIdentityId,
          endpointId: endpoint.endpointId,
          status: 'ready' as const,
          value: nativeLease,
          release: nativeLease.release,
        };
      } catch (error) {
        await nativeLease.release().catch(() => undefined);
        throw error;
      }
    },
  });

  if (selection.kind === 'unavailable' || selection.kind === 'fail_closed') {
    throw selection.error;
  }
  if (selection.kind === 'https') {
    const runtimeOrigin = resolveServerProfileApiUrl(profile, {
      canonicalAuthUrl: descriptor.canonicalServerUrl,
      applicationUrl: selection.runtimeOrigin,
    });
    const standardReadiness = input.token
      ? await verifyAuthenticatedConnection(runtimeOrigin, input.token)
      : await identityProbe({
          serverUrl: runtimeOrigin,
          expectedServerIdentityId: expectedHomeServerIdentityId,
        });
    if (standardReadiness.status !== 'ready') {
      throw new DaemonHomeReadinessError({
        ...standardReadiness,
        errorMessage: `Trusted HTTPS Home verification failed: ${standardReadiness.errorMessage ?? standardReadiness.status}`,
      });
    }
    return await activateTrustedFallback(runtimeOrigin);
  }

  const nativeLease = selection.carrier.value;
  if (input.signal?.aborted || input.isCancelled?.()) {
    await selection.release();
    throw new DaemonHomeReadinessError({ status: 'server_unreachable', errorMessage: 'Home transport is released' });
  }
  let unpublish: () => void;
  try {
    unpublish = await publish(nativeLease.runtimeOrigin, 'iroh', {
      descriptor,
      acquire: async () => ({
        ...await acquireNativeLease(),
        homeServerIdentityId: selection.carrier.homeServerIdentityId,
        endpointId: selection.carrier.endpointId,
        status: 'ready',
      }),
    }, profile.id ?? configuration.activeServerId);
  } catch (error) {
    await selection.release();
    throw error;
  }
  let released = false;
  return {
    carrier: 'iroh',
    observedPath: nativeLease.observedPath,
    async release() {
      if (released) return;
      unpublish();
      await selection.release();
      released = true;
    },
    verifyAuthenticated: async (token) => await verifyAuthenticatedConnection(nativeLease.runtimeOrigin, token),
  };
}

export async function prepareDaemonHomeIrohTransport(
  input: PrepareDaemonHomeIrohTransportInput,
): Promise<DaemonHomeTransport> {
  let origin: Awaited<ReturnType<typeof createHomeCarrierOrigin>> | undefined;
  const releaseOrigin = async () => { await origin?.release(); };
  const publish = input.publishRuntimeOrigin ?? publishServerHttpRuntimeOrigin;
  const routedInput: PrepareDaemonHomeIrohTransportInput = {
    ...input,
    publishRuntimeOrigin: async (upstream, carrier, homeTunnelOwner, serverId) => {
      // Native leases each own an ephemeral listener. Keep one daemon-owned
      // origin once Iroh is selected, including a later verified HTTPS fallback.
      if (carrier === 'iroh') origin ??= await createHomeCarrierOrigin(upstream);
      origin?.setVerifiedUpstream(upstream);
      return await publish(origin?.origin ?? upstream, carrier, homeTunnelOwner, serverId);
    },
  };
  try {
    let initial!: ActiveDaemonHomeTransport;
    // Supervise acquisition, not one failed carrier: after a boot-time Iroh
    // outage, an unreachable declared origin must not strand startup on HTTPS.
    // The existing connection supervisor owns the only retry/backoff lifecycle.
    if (input.profile.homeConnectionDescriptor && resolveDescriptorApplicationOrigin(input.profile.homeConnectionDescriptor)) {
      let lastError: unknown;
      const readiness = await waitForDaemonHomeReadiness(async () => {
        try {
          initial = await prepareDaemonHomeIrohTransportOnce(routedInput, input.profile);
          return { status: 'ready' };
        } catch (error) {
          lastError = error;
          return homeTransportFailureReadiness(error);
        }
      }, input.signal);
      if (readiness.status !== 'ready') {
        if (readiness.status === 'auth_failed' && lastError) throw lastError;
        throw new DaemonHomeReadinessError(readiness);
      }
    } else {
      initial = await prepareDaemonHomeIrohTransportOnce(routedInput, input.profile, false, true);
    }
    return withReacquisition(
      routedInput,
      initial,
      releaseOrigin,
    );
  } catch (error) {
    await releaseOrigin();
    throw error;
  }
}

export async function applyDaemonHomeDescriptorRefresh(input: Readonly<{
  features: FeaturesResponse;
  homeTarget?: ResolvedHomeTarget;
  reconcileDescriptor?: (descriptor: HomeConnectionDescriptorV1) => Promise<Readonly<{
    outcome: 'updated' | 'unchanged' | 'stale';
  }>>;
  requestReconnect: () => Promise<void> | void;
}>): Promise<'ignored' | 'updated' | 'unchanged' | 'stale'> {
  const descriptor = input.features.homeConnectionDescriptor;
  if (!descriptor) return 'ignored';
  const observedIdentity = input.features.capabilities.serverIdentity.serverIdentityId;
  const resolvedTarget = await resolveHomeTarget({
    input: { kind: 'descriptor', descriptor, authority: 'current_connection' },
    readSavedProfile: async () => null,
  });
  assertResolvedHomeTargetIdentity(resolvedTarget, observedIdentity ?? '');
  // A daemon may start from its explicit URL before Stack materializes the
  // stable invocation profile. Keep an already bound profile fixed, but let a
  // captured manual target adopt that exact configured profile once it exists.
  const target = input.reconcileDescriptor
    ? null
    : input.homeTarget?.profileId
      ? input.homeTarget
      : await resolveCurrentCliHomeTarget();
  // An env-only invocation has no saved profile to mutate. In particular,
  // its descriptor must never be assigned to the user's focused Home.
  if (!input.reconcileDescriptor && !target?.profileId) return 'ignored';
  if (target) assertResolvedHomeTargetIdentity(target, observedIdentity ?? '');
  const reconciliation = await (
    input.reconcileDescriptor
    ?? (async (nextDescriptor) => await adoptServerProfileHomeConnectionDescriptor({
      descriptor: nextDescriptor,
      expectedProfileId: target!.profileId!,
      observation: 'exact',
    }))
  )(descriptor);
  if (reconciliation.outcome === 'updated') await input.requestReconnect();
  return reconciliation.outcome;
}
