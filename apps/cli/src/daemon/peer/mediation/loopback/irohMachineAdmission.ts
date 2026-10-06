import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IrohEndpointIdV1Schema } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';
import { IrohMachineHandshakeV1Schema } from '@happier-dev/protocol/connectivity/iroh/machineHandshakeV1';
import { IrohProviderBrokerHandshakeV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { RunnerBrokerReadinessRequestV1Schema } from '@happier-dev/protocol/ephemeralRunner/brokerReadinessRequestV1';
import type { IrohMachineCarrierFlowV1, IrohMachineHandshakeV1, IrohProviderBrokerHandshakeV1, RunnerBrokerReadinessRequestV1 } from '@happier-dev/protocol';
import {
  IROH_MACHINE_ADMISSION_PATH,
  IROH_MACHINE_APPLICATION_CAPABILITY_HEADER,
  IROH_MACHINE_APPLICATION_PORT_HEADER,
  IROH_MACHINE_REMOTE_ENDPOINT_HEADER,
} from '@happier-dev/iroh-native/node';

import {
  verifyMachineCarrierHandshakeV1,
  type MachineCarrierRole,
} from '../../iroh/machineCarrier';
import {
  providerBrokerRouteGrantExpectedBindingV1,
  verifyProviderBrokerRouteGrantV1,
} from '../verifyProviderBrokerRouteGrantV1';
import type { DirectRouteGrantTrustRoot } from '../verifyDirectRouteGrant';
import {
  isFirstBytesLocalCapability,
  startFirstBytesLocalCapabilityProxy,
  type FirstBytesLocalCapabilityProxy,
} from './firstBytesLocalCapability';

/**
 * Explicit machine-Iroh admission configuration for the peer-mediation loopback app
 * (lane-06 I9). The admission route exists only while this config is supplied; the
 * native `happier/machine/1` acceptor POSTs the canonical handshake JSON to the fixed
 * admission path with the authenticated remote EndpointId header and admits a stream
 * only on a 2xx response echoing that exact header.
 */
export type PeerMediationLoopbackIrohMachineAdmissionOptions = Readonly<{
  /** Local Iroh endpoint identity bound into every admitted handshake. */
  localEndpointId: string;
  /** Local role of this side (`initiator` dials, `acceptor` listens). */
  role: MachineCarrierRole;
  /** Precise admitted carrier flows; a handshake flow outside this list fails closed. */
  allowedFlows: readonly IrohMachineCarrierFlowV1[];
  /** Current Home-published signing roots; resolved at admission so rotation needs no restart. */
  resolveTrustRoots?: () => readonly DirectRouteGrantTrustRoot[];
  /**
   * Selects the existing local application owner for this already-verified
   * stream. The peer never supplies a destination: native Rust accepts only
   * this trusted response port and always connects to 127.0.0.1.
   */
  resolveApplicationTarget: (input: Readonly<{
    handshake: IrohMachineHandshakeV1;
    authenticatedRemoteEndpointId: string;
    signal: AbortSignal;
  }>) => Readonly<{ port: number; localCapability?: string }> | null
    | Promise<Readonly<{ port: number; localCapability?: string }> | null>;
  /**
   * Provider-broker application admission is a separate authority from the
   * same-account machine grant. The callback is intentionally required for
   * this branch so the resource/Session owner can recheck current state before
   * exposing the local managed-provider port; a broker envelope alone never
   * selects a destination.
   */
  resolveProviderBrokerApplicationTarget?: (input: Readonly<{
    handshake: IrohProviderBrokerHandshakeV1;
    authenticatedRemoteEndpointId: string;
    localEndpointId: string;
    authority: IrohProviderBrokerHandshakeV1['authority'];
    signal: AbortSignal;
  }>) => Readonly<{ port: number; localCapability?: string }> | null
    | Promise<Readonly<{ port: number; localCapability?: string }> | null>;
  /** Activation-bound, non-inference application target. The resolver must
   * complete the Home currentness check before returning the fixed route. */
  resolveRunnerBrokerReadinessApplicationTarget?: (input: Readonly<{
    request: RunnerBrokerReadinessRequestV1;
    authenticatedRemoteEndpointId: string;
    localEndpointId: string;
    signal: AbortSignal;
  }>) => Readonly<{ port: number; localCapability?: string }> | null
    | Promise<Readonly<{ port: number; localCapability?: string }> | null>;
}>;

export type RegisterPeerMediationIrohMachineAdmissionRouteOptions = Readonly<{
  admission: PeerMediationLoopbackIrohMachineAdmissionOptions;
  accountId: string;
  machineId: string;
  trustRoots: readonly DirectRouteGrantTrustRoot[];
  nowMs: () => number;
}>;

/**
 * One stable rejection for every admission failure (missing/duplicate/malformed
 * header, malformed body, grant/proof/expiry/account/machine/endpoint/role/flow
 * mismatch): no reason codes, no secret detail, and no endpoint echo the native
 * acceptor could mistake for admission.
 */
const IROH_MACHINE_ADMISSION_REJECT_STATUS = 403;

async function resolveWhileAdmissionRequestIsOpen<T>(
  request: FastifyRequest,
  resolve: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const onAborted = () => abort.abort(new Error('iroh_machine_admission_client_closed'));
  request.raw.once('aborted', onAborted);
  request.raw.socket.once('close', onAborted);
  if (request.raw.aborted) onAborted();
  try {
    const value = await resolve(abort.signal);
    abort.signal.throwIfAborted();
    return value;
  } finally {
    request.raw.off('aborted', onAborted);
    request.raw.socket.off('close', onAborted);
  }
}

export function registerPeerMediationIrohMachineAdmissionRoute(
  app: FastifyInstance,
  options: RegisterPeerMediationIrohMachineAdmissionRouteOptions,
): void {
  const activeCapabilityProxies = new Set<FirstBytesLocalCapabilityProxy>();
  app.addHook('onClose', async () => {
    await Promise.all([...activeCapabilityProxies].map(async (proxy) => await proxy.close()));
    activeCapabilityProxies.clear();
  });
  const remoteEndpointHeaderName = IROH_MACHINE_REMOTE_ENDPOINT_HEADER.toLowerCase();
  app.post(IROH_MACHINE_ADMISSION_PATH, async (request, reply) => {
    // The Iroh transport supplies exactly one authenticated remote EndpointId. Node folds
    // duplicate header lines into one comma-separated value, which the strict endpoint
    // grammar (single 32-byte identity) rejects together with empty/malformed values.
    const headerValue = request.headers[remoteEndpointHeaderName];
    const headerValues = Array.isArray(headerValue) ? headerValue : [headerValue];
    const authenticatedRemoteEndpointId = headerValues.length === 1
      && typeof headerValues[0] === 'string'
      && IrohEndpointIdV1Schema.safeParse(headerValues[0]).success
      ? headerValues[0]
      : undefined;
    if (authenticatedRemoteEndpointId === undefined) {
      return reply.code(IROH_MACHINE_ADMISSION_REJECT_STATUS).send();
    }

    // The canonical handshake schema is the single wire definition; parsing it here gates
    // the admitted operation flow. The pure verifier below re-validates the same body
    // through that one schema, so there is no second handshake parser or grant verifier.
    const parsedHandshake = IrohMachineHandshakeV1Schema.safeParse(request.body);
    const parsedProviderBrokerHandshake = IrohProviderBrokerHandshakeV1Schema.safeParse(request.body);
    const parsedRunnerReadiness = RunnerBrokerReadinessRequestV1Schema.safeParse(request.body);
    const isProviderBroker = parsedProviderBrokerHandshake.success;
    if (
      (!parsedHandshake.success || !options.admission.allowedFlows.includes(parsedHandshake.data.flow))
      && (!isProviderBroker || options.admission.resolveProviderBrokerApplicationTarget === undefined)
      && (!parsedRunnerReadiness.success || options.admission.resolveRunnerBrokerReadinessApplicationTarget === undefined)
    ) return reply.code(IROH_MACHINE_ADMISSION_REJECT_STATUS).send();

    // Authorization stays purpose-owned below. Once verified, every purpose
    // shares the same target validation and cancellation-through-reply custody.
    const admitApplicationTarget = (
      resolveTarget: (signal: AbortSignal) => ReturnType<PeerMediationLoopbackIrohMachineAdmissionOptions['resolveApplicationTarget']>,
      finiteTransfer = false,
    ) => resolveWhileAdmissionRequestIsOpen(request, async (signal) => {
      const target = await resolveTarget(signal);
      if (
        !target
        || !Number.isInteger(target.port)
        || target.port < 1
        || target.port > 65_535
        || (finiteTransfer && target.localCapability !== undefined)
        || (target.localCapability !== undefined && !isFirstBytesLocalCapability(target.localCapability))
      ) return reply.code(IROH_MACHINE_ADMISSION_REJECT_STATUS).send();
      let applicationTarget = target;
      if (!finiteTransfer && applicationTarget.localCapability === undefined) {
        const proxy = await startFirstBytesLocalCapabilityProxy({
          targetPort: applicationTarget.port,
          abortSignalUntilClaimed: signal,
        });
        activeCapabilityProxies.add(proxy);
        void proxy.closed.finally(() => activeCapabilityProxies.delete(proxy));
        applicationTarget = { port: proxy.port, localCapability: proxy.localCapability };
      }
      signal.throwIfAborted();
      // Prepared finite transfers already own their listener admission. Other
      // applications keep their supplied or proxy-owned first-bytes capability.
      const response = reply.code(204)
        .header(IROH_MACHINE_REMOTE_ENDPOINT_HEADER, authenticatedRemoteEndpointId)
        .header(IROH_MACHINE_APPLICATION_PORT_HEADER, String(applicationTarget.port));
      if (applicationTarget.localCapability !== undefined) {
        response.header(IROH_MACHINE_APPLICATION_CAPABILITY_HEADER, applicationTarget.localCapability);
      }
      return response.send();
    });

    try {
      if (parsedRunnerReadiness.success) {
        const readiness = parsedRunnerReadiness.data;
        if (
          options.admission.role !== 'acceptor'
          || readiness.initiator.endpointId !== authenticatedRemoteEndpointId
          || readiness.target.machineId !== options.machineId
          || readiness.target.endpointId !== options.admission.localEndpointId
        ) return reply.code(IROH_MACHINE_ADMISSION_REJECT_STATUS).send();
        return await admitApplicationTarget((signal) => (
          options.admission.resolveRunnerBrokerReadinessApplicationTarget!({
            request: readiness,
            authenticatedRemoteEndpointId,
            localEndpointId: options.admission.localEndpointId,
            signal,
          })
        ));
      }
      if (isProviderBroker) {
        // The provider branch has no same-account `flow` or V2 proof. Its
        // callback is the canonical resource/consumer verifier and target
        // resolver; it must bind the transport identities before returning a
        // local managed-provider target.
        const providerHandshake = parsedProviderBrokerHandshake.data;
        if (
          options.admission.role !== 'acceptor'
          || providerHandshake.authority.payload.target.custodianAccountId !== options.accountId
          || providerHandshake.authority.payload.target.machineId !== options.machineId
          || providerHandshake.authority.payload.target.endpointId !== options.admission.localEndpointId
          || providerHandshake.authority.payload.initiator.endpointId !== authenticatedRemoteEndpointId
        ) return reply.code(IROH_MACHINE_ADMISSION_REJECT_STATUS).send();
        // The machine/1 transport identity check above is necessary but not
        // sufficient: the Home-signed cross-account authority must also be
        // authentic and bound to this exact transport. Reuse the broker grant
        // verifier here; the callback owns the mutable resource/consumer
        // decision and local application target selection. Expiry is also the
        // callback's decision: an expired authority may still open a stream
        // that can only release the exact claim it already holds (L10/04
        // §5.6, L10/11 A3), which cannot be told apart before the request.
        const verification = verifyProviderBrokerRouteGrantV1({
          authority: providerHandshake.authority,
          trustRoots: options.admission.resolveTrustRoots?.() ?? options.trustRoots,
          nowMs: options.nowMs(),
          enforceExpiry: false,
          expected: providerBrokerRouteGrantExpectedBindingV1(providerHandshake.authority),
          authenticatedRemoteEndpointId,
        });
        if (!verification.valid) return reply.code(IROH_MACHINE_ADMISSION_REJECT_STATUS).send();
        return await admitApplicationTarget((signal) => (
          options.admission.resolveProviderBrokerApplicationTarget!({
            handshake: providerHandshake,
            authenticatedRemoteEndpointId,
            localEndpointId: options.admission.localEndpointId,
            authority: verification.authority,
            signal,
          })
        ));
      }
      const verified = verifyMachineCarrierHandshakeV1({
        handshake: request.body,
        accountId: options.accountId,
        machineId: options.machineId,
        localEndpointId: options.admission.localEndpointId,
        role: options.admission.role,
        trustRoots: options.admission.resolveTrustRoots?.() ?? options.trustRoots,
        nowMs: options.nowMs(),
        authenticatedRemoteEndpointId,
      });
      return await admitApplicationTarget((signal) => (
        options.admission.resolveApplicationTarget({
          handshake: verified.handshake,
          authenticatedRemoteEndpointId: verified.remoteEndpointId,
          signal,
        })
      ), verified.handshake.flow === 'finite_transfer');
    } catch {
      return reply.code(IROH_MACHINE_ADMISSION_REJECT_STATUS).send();
    }
  });
}
