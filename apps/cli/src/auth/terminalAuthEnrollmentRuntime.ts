import {
  acquireHomeCarrierByPolicy,
  HomeCarrierPolicyError,
  resolveHomeCarrierPreferredTransport,
  readHomeApplicationCarrierEligibilityFromEnv,
  type HomeCarrierPreferredTransport,
} from '@happier-dev/cli-common/homeEnrollment';
import {
  classifyIrohHomeCarrierFailure,
  createNodeIrohHomeTunnelSession,
  readIrohRelayConfigFromEnv,
  type NodeIrohHomeTunnelSession,
} from '@happier-dev/iroh-native/node';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import { readHomeEnrollmentCarrierFailure, type HomeEnrollmentCarrierFailure } from '@happier-dev/protocol/ssh/commandFailure';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { borrowServerHttpRuntimeHomeTunnel } from '@/api/client/serverHttpBaseUrl';
import { observeServerFeaturesSnapshot, readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { TerminalAuthEnrollmentRuntime } from './terminalAuthEnrollmentClient';

export type AcquiredTerminalAuthEnrollmentRuntime =
  | Readonly<{
      ok: true;
      runtime: TerminalAuthEnrollmentRuntime;
      close(): Promise<void>;
    }>
  | Readonly<{
      ok: false;
      reason: 'unavailable' | 'fail_closed';
      error: unknown;
      carrierFailure: HomeEnrollmentCarrierFailure;
    }>;

type TerminalAuthEnrollmentRuntimeDeps = Readonly<{
  createSession(input: Readonly<{ keylessEndpoint: 'account_client'; relayPolicy?: 'automatic' | 'disabled'; relayUrls?: readonly string[] }>): Promise<NodeIrohHomeTunnelSession>;
  classifyFailure(error: unknown): Readonly<{ fallbackAllowed: boolean }>;
}>;

const DEFAULT_DEPS: TerminalAuthEnrollmentRuntimeDeps = {
  createSession: async (input) => await createNodeIrohHomeTunnelSession(input),
  classifyFailure: classifyIrohHomeCarrierFailure,
};

/**
 * Every credential-bearing caller receives its origin here, so a declared HTTPS
 * origin proves the descriptor's Home from public features before one can be sent.
 * An Iroh carrier needs no such read: its pinned EndpointId already proved the Home.
 */
async function readDeclaredHttpsHomeRefusal(
  runtimeOrigin: string,
  descriptor: HomeConnectionDescriptorV1,
  signal?: AbortSignal,
): Promise<HomeCarrierPolicyError | null> {
  const snapshot = await observeServerFeaturesSnapshot({
    serverUrl: runtimeOrigin,
    ...(signal ? { signal } : {}),
  });
  const identity = readServerIdentityIdFromFeaturesSnapshot(snapshot);
  if (identity === undefined) return Object.assign(new HomeCarrierPolicyError('unavailable', 'Declared HTTPS Home features are unavailable'),
    snapshot.status === 'error' ? { status: snapshot.httpStatus, authCategory: snapshot.reason === 'response_status' ? 'http_error'
      : snapshot.reason === 'timeout' ? 'deadline_elapsed' : snapshot.transportCategory ?? 'network_error' } : {});
  return identity === descriptor.homeServerIdentityId
    ? null
    : new HomeCarrierPolicyError('identity_mismatch', 'Declared HTTPS origin does not report the selected Home');
}

export async function acquireTerminalAuthEnrollmentRuntime(
  descriptorOrTarget: HomeConnectionDescriptorV1 | ResolvedHomeTarget,
  preferredTransportOrDeps: HomeCarrierPreferredTransport | TerminalAuthEnrollmentRuntimeDeps = DEFAULT_DEPS,
  signal?: AbortSignal,
): Promise<AcquiredTerminalAuthEnrollmentRuntime> {
  if ('descriptor' in descriptorOrTarget && !descriptorOrTarget.descriptor) {
    // Released URL-only profiles retain their explicitly selected HTTPS or
    // loopback destination. They gain no descriptor authority from this carrier.
    const target = descriptorOrTarget;
    return {
      ok: true,
      runtime: {
        runtimeOrigin: target.applicationUrl,
        carrier: 'https',
        authenticatedCredentialDestination: { kind: 'https', applicationUrl: target.applicationUrl },
      },
      close: async () => {},
    };
  }
  const descriptor = 'descriptor' in descriptorOrTarget
    ? descriptorOrTarget.descriptor!
    : descriptorOrTarget;
  const preferredTransport = typeof preferredTransportOrDeps === 'string'
    ? preferredTransportOrDeps
    : resolveHomeCarrierPreferredTransport(descriptor);
  const deps = typeof preferredTransportOrDeps === 'string' ? DEFAULT_DEPS : preferredTransportOrDeps;
  let session: NodeIrohHomeTunnelSession | null = null;
  let attemptedCarrier: HomeEnrollmentCarrierFailure['attemptedCarrier'] = 'none';
  let irohFailureReason: HomeEnrollmentCarrierFailure['reason'] | undefined;
  const shutdownCreatedSession = async (): Promise<void> => {
    const current = session;
    if (current) await current.shutdown();
  };
  const result = await acquireHomeCarrierByPolicy({
    applicationCarrierEligibility: readHomeApplicationCarrierEligibilityFromEnv(process.env),
    descriptor,
    preferredTransport,
    acquireIroh: async ({ descriptor: requestedDescriptor, endpoint }) => {
      attemptedCarrier = 'iroh';
      const borrowed = await borrowServerHttpRuntimeHomeTunnel(requestedDescriptor, signal);
      if (borrowed) return { ...borrowed, value: borrowed.runtimeOrigin };
      if (!session) {
        // A finite Account-client helper must never register the Machine's
        // persisted EndpointId, even when it runs in an independent process.
        const relayConfig = readIrohRelayConfigFromEnv(process.env);
        const createdSession = await deps.createSession({ keylessEndpoint: 'account_client', relayPolicy: relayConfig.relayPolicy,
          ...(relayConfig.relayPolicy !== 'disabled' && endpoint.relayUrls ? { relayUrls: endpoint.relayUrls } : {}) });
        session = createdSession;
      }
      const lease = await session.ensureHomeTunnel({
        descriptor: requestedDescriptor,
        ...(signal ? { signal } : {}),
      });
      return { ...lease, value: lease.runtimeOrigin };
    },
    classifyFailure: (error) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown';
      irohFailureReason = readHomeEnrollmentCarrierFailure({ attemptedCarrier: 'iroh', reason: code })?.reason ?? 'unknown';
      return deps.classifyFailure(error);
    },
  });

  if (result.kind === 'unavailable' || result.kind === 'fail_closed') {
    await shutdownCreatedSession().catch(() => undefined);
    const code = result.error && typeof result.error === 'object' && 'code' in result.error
      ? result.error.code : 'unknown';
    const carrierFailure: HomeEnrollmentCarrierFailure = readHomeEnrollmentCarrierFailure({ attemptedCarrier, reason: code })
      ?? { attemptedCarrier, reason: 'unknown' };
    return { ok: false, reason: result.kind, error: result.error, carrierFailure };
  }

  if (result.kind === 'https') {
    const irohAttempt = irohFailureReason ? { outcome: 'unavailable' as const, reason: irohFailureReason } : undefined;
    const refusal = await readDeclaredHttpsHomeRefusal(result.runtimeOrigin, descriptor, signal).catch(async (error: unknown) => {
      await shutdownCreatedSession().catch(() => undefined);
      throw error;
    });
    if (refusal) {
      await shutdownCreatedSession().catch(() => undefined);
      return {
        ok: false,
        reason: refusal.code === 'unavailable' ? 'unavailable' : 'fail_closed',
        error: refusal,
        carrierFailure: { attemptedCarrier: 'https', reason: refusal.code, ...(irohAttempt ? { irohAttempt } : {}) },
      };
    }
    return {
      ok: true,
      runtime: {
        runtimeOrigin: result.runtimeOrigin,
        carrier: 'https',
        ...(irohAttempt ? { irohAttempt } : {}),
        authenticatedCredentialDestination: {
          kind: 'https',
          applicationUrl: result.runtimeOrigin,
        },
      },
      close: shutdownCreatedSession,
    };
  }

  return {
    ok: true,
    runtime: {
      runtimeOrigin: result.carrier.value,
      carrier: 'iroh',
      authenticatedCredentialDestination: {
        kind: 'iroh',
        endpointId: result.carrier.endpointId,
      },
    },
    close: async () => {
      const outcomes = await Promise.allSettled([
        result.release(),
        shutdownCreatedSession(),
      ]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Failed to release the Home tunnel and shut down its native session.');
      }
    },
  };
}
