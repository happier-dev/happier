import {
  acquireHomeCarrierByPolicy,
  resolveHomeCarrierPreferredTransport,
  readHomeApplicationCarrierEligibilityFromEnv,
  type HomeCarrierPreferredTransport,
} from '@happier-dev/cli-common/homeEnrollment';
import {
  classifyIrohHomeCarrierFailure,
  createNodeIrohHomeTunnelSession,
  type NodeIrohHomeTunnelSession,
} from '@happier-dev/iroh-native/node';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { borrowServerHttpRuntimeHomeTunnel } from '@/api/client/serverHttpBaseUrl';
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
    }>;

type TerminalAuthEnrollmentRuntimeDeps = Readonly<{
  createSession(input: Readonly<{ keylessEndpoint: 'account_client' }>): Promise<NodeIrohHomeTunnelSession>;
  classifyFailure(error: unknown): Readonly<{ fallbackAllowed: boolean }>;
}>;

const DEFAULT_DEPS: TerminalAuthEnrollmentRuntimeDeps = {
  createSession: async (input) => await createNodeIrohHomeTunnelSession(input),
  classifyFailure: classifyIrohHomeCarrierFailure,
};

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
  const shutdownCreatedSession = async (): Promise<void> => {
    const current = session;
    if (current) await current.shutdown();
  };
  const result = await acquireHomeCarrierByPolicy({
    mode: 'initial_selection',
    applicationCarrierEligibility: readHomeApplicationCarrierEligibilityFromEnv(process.env),
    descriptor,
    preferredTransport,
    acquireIroh: async ({ descriptor: requestedDescriptor }) => {
      const borrowed = await borrowServerHttpRuntimeHomeTunnel(requestedDescriptor, signal);
      if (borrowed) return { ...borrowed, value: borrowed.runtimeOrigin };
      if (!session) {
        // A finite Account-client helper must never register the Machine's
        // persisted EndpointId, even when it runs in an independent process.
        const createdSession = await deps.createSession({ keylessEndpoint: 'account_client' });
        session = createdSession;
      }
      const lease = await session.ensureHomeTunnel({
        descriptor: requestedDescriptor,
        ...(signal ? { signal } : {}),
      });
      return { ...lease, value: lease.runtimeOrigin };
    },
    classifyFailure: deps.classifyFailure,
  });

  if (result.kind === 'unavailable' || result.kind === 'fail_closed') {
    await shutdownCreatedSession().catch(() => undefined);
    return { ok: false, reason: result.kind, error: result.error };
  }

  if (result.kind === 'https') {
    return {
      ok: true,
      runtime: {
        runtimeOrigin: result.runtimeOrigin,
        carrier: 'https',
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
