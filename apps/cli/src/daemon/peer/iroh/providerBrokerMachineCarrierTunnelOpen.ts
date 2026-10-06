import { isDeepStrictEqual } from 'node:util';

import { encodeProviderBrokerAuthorityV1, IrohProviderBrokerHandshakeV1Schema, ProviderBrokerOpenResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import type { ProviderBrokerOpenResponseV1 } from '@happier-dev/protocol';

import {
  MACHINE_ALPN,
  MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
} from '@happier-dev/iroh-native/node';
import {
  providerBrokerRouteGrantExpectedBindingV1 as authorityBinding,
  verifyProviderBrokerRouteGrantV1,
} from '../mediation/verifyProviderBrokerRouteGrantV1';
import type { DirectRouteGrantTrustRoot } from '../mediation/verifyRouteGrantSignature';
import type { DaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import {
  awaitMachineCarrierTunnelOpen,
  MachineCarrierError,
  type ProviderBrokerMachineCarrierTransportOpenInput,
} from './machineCarrier';
import { PROVIDER_BROKER_PRIVATE_CLOSE_PATH } from '@/providers/broker/providerBrokerPrivateProtocol';

type BrokerTunnel = Readonly<{
  localPort: number;
  localCapability: string;
  observedPath: 'direct' | 'relay' | 'unknown';
  retire(): Promise<void>;
  close(): Promise<void>;
}>;

/**
 * Opens the existing native HTTP machine/1 carrier for one Home-signed
 * Provider-broker authority. This is an initiator-only transport owner: it
 * does not mint grants, choose a target, resolve policy, or expose any target
 * service credential. The server route remains the authority for all of those
 * facts. Broker-open has already proved the persistent target and advertised
 * ingress capability before signing its exact EndpointId. This helper verifies
 * that signed witness, then proves the transport-observed EndpointId before
 * publishing the local listener; it needs no broad Machine-read authority.
 */
export function createProviderBrokerMachineCarrierTunnelOpen(input: Readonly<{
  accountId: string;
  localMachineId: string;
  runtime: Pick<DaemonMachineIrohRuntime, 'endpoint' | 'openHttpTunnel'>;
  resolveTrustRoots: () => readonly DirectRouteGrantTrustRoot[];
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
}>): (request: Readonly<{
  brokerOpen: Extract<ProviderBrokerOpenResponseV1, { ok: true }>;
  refreshBrokerOpen?: (signal?: AbortSignal) => Promise<ProviderBrokerOpenResponseV1>;
  signal?: AbortSignal;
}>) => Promise<BrokerTunnel> {
  return async ({ brokerOpen: brokerOpenInput, refreshBrokerOpen, signal }) => {
    signal?.throwIfAborted();
    const brokerOpen = ProviderBrokerOpenResponseV1Schema.parse(brokerOpenInput);
    if (!brokerOpen.ok) {
      throw new MachineCarrierError('broker_target_unavailable', 'Provider broker target is unavailable.');
    }
    const authority = brokerOpen.authority;
    const nowMs = (input.nowMs ?? Date.now)();
    const payload = authority.payload;
    if (
      payload.initiator.accountId !== input.accountId
      || payload.initiator.machineId !== input.localMachineId
      || payload.initiator.endpointId !== input.runtime.endpoint.endpointId
    ) {
      throw new MachineCarrierError('broker_initiator_mismatch', 'Provider broker authority is not bound to this Machine.');
    }
    const claimed = verifyProviderBrokerRouteGrantV1({
      authority,
      trustRoots: input.resolveTrustRoots(),
      nowMs,
      expected: authorityBinding(authority),
      // On the dialing side this is the native runtime's own authenticated
      // endpoint. The target independently observes the same identity during
      // the machine/1 handshake.
      authenticatedRemoteEndpointId: input.runtime.endpoint.endpointId,
    });
    if (!claimed.valid) throw new MachineCarrierError(claimed.reasonCode, 'Provider broker authority was rejected.');
    if (
      brokerOpen.target.custodianAccountId !== payload.target.custodianAccountId
      || brokerOpen.target.brokerMachineId !== payload.target.machineId
      || brokerOpen.target.endpointId !== payload.target.endpointId
    ) {
      throw new MachineCarrierError(
        'broker_target_endpoint_changed',
        'Provider broker open target does not match its signed route authority.',
      );
    }

    const currentAuthority = verifyProviderBrokerRouteGrantV1({
      authority,
      trustRoots: input.resolveTrustRoots(),
      nowMs: (input.nowMs ?? Date.now)(),
      expected: authorityBinding(authority),
      authenticatedRemoteEndpointId: input.runtime.endpoint.endpointId,
    });
    if (!currentAuthority.valid) {
      throw new MachineCarrierError(currentAuthority.reasonCode, 'Provider broker authority is no longer current.');
    }
    const endpoint = brokerOpen.target.endpoint;
    /** True once this tunnel is only being used to release its own claim. */
    let releasing = false;

    const handshake = IrohProviderBrokerHandshakeV1Schema.parse({ v: 1, kind: 'provider_broker', authority });
    const transportInput: ProviderBrokerMachineCarrierTransportOpenInput = {
      alpn: MACHINE_ALPN,
      remoteEndpointId: payload.target.endpointId,
      flow: 'provider_broker',
      handshake,
      handshakeProvider: async () => {
        if (releasing) {
          // Releasing a claim this operation already holds is not new request
          // work. It presents the authority the Home already granted for this
          // exact operation and target, so it needs no fresh inference
          // admission — which the Home would refuse precisely when the Session
          // or entitlement that ended is the reason we are releasing — and it
          // is not cancelled by the signal whose end caused the release.
          return IrohProviderBrokerHandshakeV1Schema.parse({
            v: 1,
            kind: 'provider_broker',
            authority,
          });
        }
        signal?.throwIfAborted();
        if (!refreshBrokerOpen) {
          throw new MachineCarrierError('broker_fresh_handshake_unavailable', 'Fresh Provider broker admission is unavailable.');
        }
        const freshOpen = ProviderBrokerOpenResponseV1Schema.parse(await refreshBrokerOpen(signal));
        if (!freshOpen.ok) {
          throw new MachineCarrierError(freshOpen.reasonCode, 'Provider broker authority refresh was rejected.');
        }
        const freshAuthority = freshOpen.authority;
        if (
          !isDeepStrictEqual(authorityBinding(freshAuthority), authorityBinding(authority))
          || freshOpen.target.custodianAccountId !== brokerOpen.target.custodianAccountId
          || freshOpen.target.brokerMachineId !== brokerOpen.target.brokerMachineId
          || freshOpen.target.endpointId !== brokerOpen.target.endpointId
        ) {
          throw new MachineCarrierError('broker_binding_changed', 'Provider broker binding changed while opening a new stream.');
        }
        const verified = verifyProviderBrokerRouteGrantV1({
          authority: freshAuthority,
          trustRoots: input.resolveTrustRoots(),
          nowMs: (input.nowMs ?? Date.now)(),
          expected: authorityBinding(authority),
          authenticatedRemoteEndpointId: input.runtime.endpoint.endpointId,
        });
        if (!verified.valid) {
          throw new MachineCarrierError(verified.reasonCode, 'Fresh Provider broker authority was rejected.');
        }
        signal?.throwIfAborted();
        return IrohProviderBrokerHandshakeV1Schema.parse({
          v: 1,
          kind: 'provider_broker',
          authority: freshAuthority,
        });
      },
    };
    const tunnel = await awaitMachineCarrierTunnelOpen(
      input.runtime.openHttpTunnel(transportInput, endpoint),
      signal,
    );
    if (tunnel.remoteEndpointId !== payload.target.endpointId) {
      await tunnel.close().catch(() => undefined);
      throw new MachineCarrierError('transport_identity_mismatch', 'Authenticated provider broker endpoint identity changed.');
    }
    try {
      signal?.throwIfAborted();
    } catch (error) {
      await tunnel.close().catch(() => undefined);
      throw error;
    }
    let retired = false;
    let retireInFlight: Promise<void> | null = null;
    const retire = (): Promise<void> => {
      if (retired) return Promise.resolve();
      releasing = true;
      retireInFlight ??= (async () => {
        const response = await (input.fetchImpl ?? fetch)(
          `http://127.0.0.1:${tunnel.localPort}${PROVIDER_BROKER_PRIVATE_CLOSE_PATH}`,
          {
            method: 'DELETE',
            headers: {
              authorization: `Bearer ${encodeProviderBrokerAuthorityV1(authority)}`,
              [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: tunnel.localCapability,
              connection: 'close',
            },
            redirect: 'error',
            signal: AbortSignal.timeout(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs),
          },
        );
        if (response.status !== 204) {
          throw new MachineCarrierError(
            'broker_close_rejected',
            'Provider broker target did not acknowledge stream retirement.',
          );
        }
        retired = true;
      })().finally(() => {
        retireInFlight = null;
      });
      return retireInFlight;
    };
    return {
      localPort: tunnel.localPort,
      localCapability: tunnel.localCapability,
      observedPath: tunnel.observedPath,
      retire,
      close: tunnel.close,
    };
  };
}
