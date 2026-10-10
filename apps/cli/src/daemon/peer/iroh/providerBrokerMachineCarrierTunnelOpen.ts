import { isDeepStrictEqual } from 'node:util';

import { encodeProviderBrokerAuthorityV1, encodeProviderBrokerAuthorityV2, IrohProviderBrokerHandshakeSchema, ProviderBrokerOpenResponseV1Schema, ProviderBrokerAccountOpenResponseV2Schema, SignedProviderBrokerRouteGrantV1Schema, SignedProviderBrokerRouteGrantV2Schema, type SignedProviderBrokerRouteGrantV2, type ProviderBrokerAccountOpenResponseV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import type { ProviderBrokerOpenResponseV1 } from '@happier-dev/protocol';

import {
  MACHINE_ALPN,
  MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
} from '@happier-dev/iroh-native/node';
import {
  providerBrokerRouteGrantExpectedBindingV1 as authorityBinding,
  verifyProviderBrokerRouteGrantV1,
  providerBrokerRouteGrantExpectedBindingV2,
  verifyProviderBrokerRouteGrantV2,
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
type BrokerOpenResponse = ProviderBrokerOpenResponseV1 | ProviderBrokerAccountOpenResponseV2;
const BrokerOpenResponseSchema = ProviderBrokerOpenResponseV1Schema.or(ProviderBrokerAccountOpenResponseV2Schema);
type BrokerAuthority = Extract<ProviderBrokerOpenResponseV1, { ok: true }>['authority'] | SignedProviderBrokerRouteGrantV2;
function brokerAuthorityBinding(authority: BrokerAuthority) {
  return authority.payload.v === 2
    ? providerBrokerRouteGrantExpectedBindingV2(SignedProviderBrokerRouteGrantV2Schema.parse(authority))
    : authorityBinding(SignedProviderBrokerRouteGrantV1Schema.parse(authority));
}

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
  homeId?: string;
  localMachineId: string;
  runtime: Pick<DaemonMachineIrohRuntime, 'endpoint' | 'openHttpTunnel'>;
  resolveTrustRoots: () => readonly DirectRouteGrantTrustRoot[];
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
}>): (request: Readonly<{
  brokerOpen: Extract<BrokerOpenResponse, { ok: true }>;
  refreshBrokerOpen?: (signal?: AbortSignal) => Promise<BrokerOpenResponse>;
  signal?: AbortSignal;
}>) => Promise<BrokerTunnel> {
  return async ({ brokerOpen: brokerOpenInput, refreshBrokerOpen, signal }) => {
    signal?.throwIfAborted();
    const brokerOpen = BrokerOpenResponseSchema.parse(brokerOpenInput);
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
      || (payload.v === 2 && payload.homeId !== input.homeId)
    ) {
      throw new MachineCarrierError('broker_initiator_mismatch', 'Provider broker authority is not bound to this Machine.');
    }
    const verifyAuthority = (value: BrokerAuthority, now: number, expectedAuthority = authority) => {
      const personal = SignedProviderBrokerRouteGrantV2Schema.safeParse(value);
      return personal.success ? verifyProviderBrokerRouteGrantV2({
        authority: personal.data, trustRoots: input.resolveTrustRoots(), nowMs: now,
        expected: providerBrokerRouteGrantExpectedBindingV2(SignedProviderBrokerRouteGrantV2Schema.parse(expectedAuthority)),
        authenticatedRemoteEndpointId: input.runtime.endpoint.endpointId,
      }) : verifyProviderBrokerRouteGrantV1({
        authority: value, trustRoots: input.resolveTrustRoots(), nowMs: now,
        expected: authorityBinding(SignedProviderBrokerRouteGrantV1Schema.parse(expectedAuthority)),
        authenticatedRemoteEndpointId: input.runtime.endpoint.endpointId,
      });
    };
    const claimed = verifyAuthority(authority, nowMs);
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

    const currentAuthority = verifyAuthority(authority, (input.nowMs ?? Date.now)());
    if (!currentAuthority.valid) {
      throw new MachineCarrierError(currentAuthority.reasonCode, 'Provider broker authority is no longer current.');
    }
    const endpoint = brokerOpen.target.endpoint;
    /** Withdrawal stops ordinary streams before any remote retirement work. */
    let releasing = false;

    const handshake = IrohProviderBrokerHandshakeSchema.parse({ v: payload.v, kind: 'provider_broker', authority });
    const transportInput: ProviderBrokerMachineCarrierTransportOpenInput = {
      alpn: MACHINE_ALPN,
      remoteEndpointId: payload.target.endpointId,
      flow: 'provider_broker',
      handshake,
      handshakeProvider: async () => {
        if (releasing) {
          throw new MachineCarrierError('broker_consumer_closed', 'Provider broker consumer has been withdrawn.');
        }
        signal?.throwIfAborted();
        if (!refreshBrokerOpen) {
          throw new MachineCarrierError('broker_fresh_handshake_unavailable', 'Fresh Provider broker admission is unavailable.');
        }
        const freshOpen = BrokerOpenResponseSchema.parse(await refreshBrokerOpen(signal));
        if (!freshOpen.ok) {
          throw new MachineCarrierError(freshOpen.reasonCode, 'Provider broker authority refresh was rejected.');
        }
        const freshAuthority = freshOpen.authority;
        if (
          !isDeepStrictEqual(brokerAuthorityBinding(freshAuthority), brokerAuthorityBinding(authority))
          || freshOpen.target.custodianAccountId !== brokerOpen.target.custodianAccountId
          || freshOpen.target.brokerMachineId !== brokerOpen.target.brokerMachineId
          || freshOpen.target.endpointId !== brokerOpen.target.endpointId
        ) {
          throw new MachineCarrierError('broker_binding_changed', 'Provider broker binding changed while opening a new stream.');
        }
        const verified = verifyAuthority(freshAuthority, (input.nowMs ?? Date.now)());
        if (!verified.valid) {
          throw new MachineCarrierError(verified.reasonCode, 'Fresh Provider broker authority was rejected.');
        }
        signal?.throwIfAborted();
        return IrohProviderBrokerHandshakeSchema.parse({
          v: payload.v,
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
    let controlClose: (() => Promise<void>) | null = null;
    let closeInFlight: Promise<void> | null = null;
    const close = (): Promise<void> => {
      releasing = true;
      closeInFlight ??= tunnel.close().catch((error: unknown) => {
        closeInFlight = null;
        throw error;
      });
      return closeInFlight;
    };
    const retire = (): Promise<void> => {
      if (retired && !controlClose) return Promise.resolve();
      releasing = true;
      retireInFlight ??= (async () => {
        // Native release can fail after the target acknowledged retirement.
        // Retain that exact private handle until close succeeds; retrying it
        // must not repeat the DELETE or dial another control channel.
        if (controlClose) {
          await controlClose();
          controlClose = null;
        }
        if (retired) return;
        // Never reuse the published bearer listener for control work. The
        // retained signed authority identifies only the existing claim; V2
        // explicitly narrows this unpublished channel to release before the
        // target can read its catalog or acquire a consumer.
        await close();
        const releaseHandshake = IrohProviderBrokerHandshakeSchema.parse({
          v: payload.v, kind: 'provider_broker', authority,
          ...(payload.v === 2 ? { intent: 'release' } : {}),
        });
        const releaseSignal = AbortSignal.timeout(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs);
        const control = await awaitMachineCarrierTunnelOpen(input.runtime.openHttpTunnel({
          alpn: MACHINE_ALPN, remoteEndpointId: payload.target.endpointId,
          flow: 'provider_broker', handshake: releaseHandshake,
          handshakeProvider: async () => releaseHandshake,
        }, endpoint), releaseSignal);
        controlClose = control.close;
        try {
          if (control.remoteEndpointId !== payload.target.endpointId) {
            throw new MachineCarrierError('transport_identity_mismatch', 'Authenticated provider broker endpoint identity changed.');
          }
          const response = await (input.fetchImpl ?? fetch)(
            `http://127.0.0.1:${control.localPort}${PROVIDER_BROKER_PRIVATE_CLOSE_PATH}`,
            {
              method: 'DELETE',
              headers: {
                authorization: `Bearer ${authority.payload.v === 2
                  ? encodeProviderBrokerAuthorityV2(SignedProviderBrokerRouteGrantV2Schema.parse(authority))
                  : encodeProviderBrokerAuthorityV1(SignedProviderBrokerRouteGrantV1Schema.parse(authority))}`,
                [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: control.localCapability,
                connection: 'close',
              },
              redirect: 'error',
              signal: releaseSignal,
            },
          );
          if (response.status !== 204) {
            throw new MachineCarrierError(
              'broker_close_rejected',
              'Provider broker target did not acknowledge stream retirement.',
            );
          }
          retired = true;
        } finally {
          await controlClose();
          controlClose = null;
        }
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
      close,
    };
  };
}
