import { ProviderBrokerActionOpenResponseV3Schema, SignedProviderBrokerActionRouteGrantV3Schema, type ProviderBrokerActionOpenResponseV3, type SignedProviderBrokerActionRouteGrantV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { providerBrokerActionRouteGrantExpectedBindingV3, verifyProviderBrokerActionRouteGrantV3 } from '../mediation/verifyProviderBrokerRouteGrantV1';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { z } from 'zod/mini';

import { encodeProviderBrokerAuthorityV1, encodeProviderBrokerAuthorityV2, IrohProviderBrokerHandshakeSchema, ProviderBrokerAdmissionFailureCodeV1Schema, ProviderBrokerOpenResponseV1Schema, ProviderBrokerAccountOpenResponseV2Schema, ProviderBrokerWatcherOpenResponseV1Schema, SignedProviderBrokerRouteGrantV1Schema, SignedProviderBrokerRouteGrantV2Schema, type SignedProviderBrokerRouteGrantV1, type SignedProviderBrokerRouteGrantV2, type ProviderBrokerAccountOpenResponseV2, type ProviderBrokerWatcherOpenResponseV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerOpenResponseV1 } from '@happier-dev/protocol';

import {
  MACHINE_ALPN,
  MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
  IrohError,
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
  type MachineCarrierFailureDiagnostic,
} from './machineCarrier';
import { PROVIDER_BROKER_PRIVATE_CLOSE_PATH, PROVIDER_BROKER_CLOSE_REQUEST_ID_HEADER } from '@/providers/broker/providerBrokerPrivateProtocol';
import { logger } from '@/ui/logger';
import { providerBrokerApplicationFailureBody, providerBrokerApplicationFailureHeaders, type SessionBrokerApplicationOutcomeRecorder } from '@/providers/broker/providerBrokerApplicationFailure';
import { SessionRuntimeTeamCredentialDenialDetailsV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { createSessionBrokerHttpObserver, SESSION_BROKER_OBSERVED_RESPONSE_HEADERS } from '@/providers/broker/sessionBrokerHttpObservation';

type BrokerReleasePhase = 'public_listener_withdrawal' | 'private_control_dial'
  | 'delete_dispatched' | 'response_received' | 'private_control_close';
type BrokerReleaseOutcome = 'released' | 'target_gone' | 'abandoned';
type BrokerReleaseReason = 'acknowledged' | 'target_endpoint_changed' | 'control_dial_failed'
  | 'delete_failed' | 'delete_rejected';
const diagnosticIdSchema = z.uuid();
const carrierAdmissionDiagnosticCodeSchema = z.union([
  ProviderBrokerAdmissionFailureCodeV1Schema,
  z.enum(['broker_consumer_closed', 'broker_fresh_handshake_unavailable', 'broker_binding_changed']),
]);

/** Diagnostic context stays in `cause`, which the existing cleanup logger
 * serializes. The original boundary exception (including its cause) survives. */
class ProviderBrokerReleaseError extends Error {
  readonly code?: string;
  constructor(context: Readonly<{ phase: BrokerReleasePhase; targetMachineId: string; requestId: string; error: unknown }>) {
    super(`Provider broker release failed during ${context.phase}`, { cause: context });
    this.name = 'ProviderBrokerReleaseError';
    if (context.error instanceof MachineCarrierError) this.code = context.error.code;
  }
}

export type ProviderBrokerMachineCarrierTunnel = Readonly<{
  localPort: number;
  localCapability: string;
  observedPath: 'direct' | 'relay' | 'unknown';
  retire(): Promise<void>;
  close(): Promise<void>;
  readFailureDiagnostic?(): Promise<MachineCarrierFailureDiagnostic | undefined>;
}>;
type BrokerOpenResponse = ProviderBrokerOpenResponseV1 | ProviderBrokerWatcherOpenResponseV1 | ProviderBrokerAccountOpenResponseV2 | ProviderBrokerActionOpenResponseV3;
const BrokerOpenResponseSchema = z.union([ProviderBrokerOpenResponseV1Schema, ProviderBrokerWatcherOpenResponseV1Schema, ProviderBrokerAccountOpenResponseV2Schema, ProviderBrokerActionOpenResponseV3Schema]);
type BrokerAuthority = SignedProviderBrokerRouteGrantV1 | SignedProviderBrokerRouteGrantV2 | SignedProviderBrokerActionRouteGrantV3;
function brokerAuthorityBinding(authority: BrokerAuthority) {
  if (authority.payload.v === 3) return providerBrokerActionRouteGrantExpectedBindingV3(SignedProviderBrokerActionRouteGrantV3Schema.parse(authority));
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
  beginSessionApplicationRequest?: (sessionId: string) => SessionBrokerApplicationOutcomeRecorder | undefined;
  /** Hands a Session's evidence its carrier's native failure stage, for a
   * request refused before stream admission and so before any outcome record. */
  observeSessionCarrierFailure?: (sessionId: string, read: () => Promise<MachineCarrierFailureDiagnostic | undefined>) => void;
}>): (request: Readonly<{
  brokerOpen: Extract<BrokerOpenResponse, { ok: true }>;
  refreshBrokerOpen?: (signal?: AbortSignal) => Promise<BrokerOpenResponse>;
  signal?: AbortSignal;
}>) => Promise<ProviderBrokerMachineCarrierTunnel> {
  return async ({ brokerOpen: brokerOpenInput, refreshBrokerOpen, signal }) => {
    signal?.throwIfAborted();
    const brokerOpen = BrokerOpenResponseSchema.parse(brokerOpenInput);
    if (!brokerOpen.ok) {
      throw new MachineCarrierError('broker_target_unavailable', 'Provider broker target is unavailable.');
    }
    const authority = brokerOpen.authority;
    const nowMs = (input.nowMs ?? Date.now)();
    const payload = authority.payload;
    const watcher = 'scope' in payload;
    if (
      payload.initiator.accountId !== input.accountId
      || payload.initiator.machineId !== input.localMachineId
      || payload.initiator.endpointId !== input.runtime.endpoint.endpointId
      || (payload.v === 2 && payload.homeId !== input.homeId)
    ) {
      throw new MachineCarrierError('broker_initiator_mismatch', 'Provider broker authority is not bound to this Machine.');
    }
    const verifyAuthority = (value: BrokerAuthority, now: number, expectedAuthority = authority) => {
      if (value.payload.v === 3) return verifyProviderBrokerActionRouteGrantV3({
        authority: value, trustRoots: input.resolveTrustRoots(), nowMs: now,
        expected: providerBrokerActionRouteGrantExpectedBindingV3(SignedProviderBrokerActionRouteGrantV3Schema.parse(expectedAuthority)),
        authenticatedRemoteEndpointId: input.runtime.endpoint.endpointId,
      });
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

    const endpoint = brokerOpen.target.endpoint;
    /** Withdrawal stops ordinary streams before any remote retirement work. */
    let releasing = false;

    const handshake = IrohProviderBrokerHandshakeSchema.parse({ v: payload.v, kind: 'provider_broker', authority });
    // Only Home's refusal recorded by this refresh path is superseded by a later
    // accepted refresh; a target application refusal is never erased by one.
    let homeRefreshRefusalRecorded = false;
    const readFreshHandshake = async () => {
        if (releasing) {
          throw new MachineCarrierError('broker_consumer_closed', 'Provider broker consumer has been withdrawn.');
        }
        signal?.throwIfAborted();
        if (!refreshBrokerOpen) {
          throw new MachineCarrierError('broker_fresh_handshake_unavailable', 'Fresh Provider broker admission is unavailable.');
        }
        const recordOutcome = !watcher && payload.v === 1 && payload.consumer.kind === 'session'
          ? input.beginSessionApplicationRequest?.(payload.consumer.sessionId) : undefined;
        const freshOpen = BrokerOpenResponseSchema.parse(await refreshBrokerOpen(signal));
        if (!freshOpen.ok) {
          signal?.throwIfAborted();
          const body = providerBrokerApplicationFailureBody(freshOpen, payload.v === 1 ? payload.resourceId : undefined);
          if (recordOutcome && payload.v === 1) {
            recordOutcome(SessionRuntimeTeamCredentialDenialDetailsV1Schema.parse({
              v: 1, resourceId: payload.resourceId, reasonCode: body.error.code,
              ...(body.error.usageLimit ? { usageLimit: body.error.usageLimit } : {}),
            }));
            homeRefreshRefusalRecorded = true;
          }
          else if (!watcher && payload.v === 1 && payload.consumer.kind === 'session') {
            try {
              logger.infoFile('[provider-broker-application]', { stage: 'evidence_capture',
                sessionId: payload.consumer.sessionId, turnId: null, pid: process.pid,
                outcome: 'skipped', reason: 'session_not_bound' });
            } catch { /* Diagnostics cannot change the carrier refusal. */ }
          }
          throw new MachineCarrierError(freshOpen.reasonCode, 'Provider broker authority refresh was rejected.', {
            kind: 'http_refusal',
            responseBody: JSON.stringify(body),
            responseHeaders: providerBrokerApplicationFailureHeaders(freshOpen),
          });
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
        // Home admitted this turn's stream again: its own earlier refusal of
        // the same turn no longer describes the binding.
        if (homeRefreshRefusalRecorded) {
          homeRefreshRefusalRecorded = false;
          recordOutcome?.(null);
        }
        return IrohProviderBrokerHandshakeSchema.parse({
          v: payload.v,
          kind: 'provider_broker',
          authority: freshAuthority,
        });
    };
    const refreshHandshake = async () => {
      const requestId = randomUUID();
      const consumerId = watcher ? payload.consumer.occurrenceId : payload.consumer.kind === 'session' ? payload.consumer.sessionId : payload.consumer.kind === 'execution_run' ? payload.consumer.executionRunId : payload.consumer.operationId;
      const record = (details: Readonly<{
        outcome: 'started' | 'accepted' | 'refused' | 'failed';
        grantId?: string;
        code?: z.infer<typeof carrierAdmissionDiagnosticCodeSchema> | 'transport_error';
      }>): void => {
        try {
          logger.infoFile('[provider-broker-application]', { stage: 'carrier_admission', requestId, consumerId, ...details });
        } catch { /* Diagnostics cannot change fresh authority or stream custody. */ }
      };
      record({ outcome: 'started' });
      try {
        const fresh = await readFreshHandshake();
        // Home-generated UUID links this stream to the target HTTP receipt.
        // Legacy/non-UUID identifiers are omitted rather than logging free text.
        const grantId = diagnosticIdSchema.safeParse(fresh.authority.payload.grantId);
        record({ outcome: 'accepted', ...(grantId.success ? { grantId: grantId.data } : {}) });
        return fresh;
      } catch (error) {
        const closedCode = carrierAdmissionDiagnosticCodeSchema.safeParse(error instanceof MachineCarrierError ? error.code : undefined);
        record({ outcome: closedCode.success ? 'refused' : 'failed', code: closedCode.success ? closedCode.data : 'transport_error' });
        throw error;
      }
    };
    const fixedAdmission = watcher || payload.v === 3 || payload.v === 2 && payload.consumer.kind === 'execution_run';
    // A signed Run open owns its admission until the existing grant expiry.
    // Sessions still refresh before dial and for each later carrier stream.
    let firstHandshake = fixedAdmission ? handshake : refreshBrokerOpen ? await refreshHandshake() : null;
    const sessionConsumerId = !watcher && payload.v === 1 && payload.consumer.kind === 'session' ? payload.consumer.sessionId : undefined;
    const transportInput: ProviderBrokerMachineCarrierTransportOpenInput = {
      alpn: MACHINE_ALPN,
      remoteEndpointId: payload.target.endpointId,
      flow: 'provider_broker',
      handshake: firstHandshake ?? handshake,
      ...(payload.v === 1 && sessionConsumerId && input.beginSessionApplicationRequest ? {
        observedResponseHeaders: SESSION_BROKER_OBSERVED_RESPONSE_HEADERS,
        httpObserver: createSessionBrokerHttpObserver({ resourceId: payload.resourceId,
          beginRequest: () => input.beginSessionApplicationRequest?.(sessionConsumerId),
        }),
      } : {}),
      handshakeProvider: async () => {
        if (fixedAdmission && firstHandshake) {
          if (releasing) throw new MachineCarrierError('broker_consumer_closed', 'Provider broker consumer has been withdrawn.');
          signal?.throwIfAborted();
          const verified = verifyAuthority(firstHandshake.authority, (input.nowMs ?? Date.now)());
          if (verified.valid) return firstHandshake;
          if (watcher || payload.v === 3 || verified.reasonCode !== 'grant_expired') {
            throw new MachineCarrierError(verified.reasonCode, 'Provider broker authority is no longer current.');
          }
          firstHandshake = await refreshHandshake();
          return firstHandshake;
        }
        if (!firstHandshake) return refreshHandshake();
        const first = firstHandshake;
        firstHandshake = null;
        if (releasing) throw new MachineCarrierError('broker_consumer_closed', 'Provider broker consumer has been withdrawn.');
        signal?.throwIfAborted();
        // Dial may have waited. A cached witness never bypasses expiry.
        const verified = verifyAuthority(first.authority, (input.nowMs ?? Date.now)());
        if (!verified.valid) throw new MachineCarrierError(verified.reasonCode, 'Provider broker authority is no longer current.');
        return first;
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
    const readFailureDiagnostic = tunnel.readFailureDiagnostic;
    if (readFailureDiagnostic && !watcher && payload.consumer.kind === 'session') {
      input.observeSessionCarrierFailure?.(payload.consumer.sessionId, readFailureDiagnostic);
    }
    let releaseSettled = false;
    let retireInFlight: Promise<void> | null = null;
    let closeInFlight: Promise<void> | null = null;
    const close = (): Promise<void> => {
      releasing = true;
      closeInFlight ??= tunnel.close().catch((error: unknown) => {
        closeInFlight = null;
        throw error;
      });
      return closeInFlight;
    };
    const retire = async (): Promise<void> => {
      if (releaseSettled) return;
      if (watcher || payload.v === 3) { await close(); releaseSettled = true; return; }
      releasing = true;
      const requestId = randomUUID();
      // This is the only release condition that must precede runner Stop.
      // Failed withdrawal retains the same closer for an explicit retry.
      try {
        await close();
      } catch (error) {
        throw new ProviderBrokerReleaseError({ phase: 'public_listener_withdrawal',
          targetMachineId: payload.target.machineId, requestId, error });
      }
      if (releaseSettled) return;
      retireInFlight ??= (async () => {
        let phase: BrokerReleasePhase = 'public_listener_withdrawal';
        const recordPhase = (next: BrokerReleasePhase): void => {
          phase = next;
          try {
            logger.infoFile('[provider-broker-release]', { phase, targetMachineId: payload.target.machineId, requestId });
          } catch {
            // Diagnostics cannot change retirement or resource custody.
          }
        };
        const recordFailure = (error: unknown): void => {
          try {
            logger.debug('[provider-broker-release] Boundary failure', new ProviderBrokerReleaseError({
              phase, targetMachineId: payload.target.machineId, requestId, error,
            }));
          } catch { /* Diagnostics cannot change retirement or resource custody. */ }
        };
        recordPhase('public_listener_withdrawal');
        let outcome: BrokerReleaseOutcome = 'abandoned';
        let reasonCode: BrokerReleaseReason = 'control_dial_failed';
        let control: Awaited<ReturnType<DaemonMachineIrohRuntime['openHttpTunnel']>> | null = null;
        // The existing native runtime owns this private control attempt and its
        // closer, including cancellation during endpoint shutdown. Remote cleanup
        // cannot keep a withdrawn consumer's runner alive.
        try {
          // Never reuse the published bearer listener for control work. The
          // retained signed authority identifies only the existing claim; V2
          // explicitly narrows this unpublished channel to release before the
          // target can read its catalog or acquire a consumer.
          const releaseHandshake = IrohProviderBrokerHandshakeSchema.parse({
            v: payload.v, kind: 'provider_broker', authority,
            ...(payload.v === 2 ? { intent: 'release' } : {}),
          });
          recordPhase('private_control_dial');
          control = await input.runtime.openHttpTunnel({
            alpn: MACHINE_ALPN, remoteEndpointId: payload.target.endpointId,
            flow: 'provider_broker', handshake: releaseHandshake,
            handshakeProvider: async () => releaseHandshake,
          }, endpoint);
          if (control.remoteEndpointId !== payload.target.endpointId) {
            outcome = 'target_gone';
            reasonCode = 'target_endpoint_changed';
            throw new MachineCarrierError('transport_identity_mismatch', 'Authenticated provider broker endpoint identity changed.');
          }
          recordPhase('delete_dispatched');
          reasonCode = 'delete_failed';
          const response = await fetchWithCredentialRedirectRefusal(
            `http://127.0.0.1:${control.localPort}${PROVIDER_BROKER_PRIVATE_CLOSE_PATH}`,
            {
              method: 'DELETE',
              headers: {
                authorization: `Bearer ${authority.payload.v === 2
                  ? encodeProviderBrokerAuthorityV2(SignedProviderBrokerRouteGrantV2Schema.parse(authority))
                  : encodeProviderBrokerAuthorityV1(SignedProviderBrokerRouteGrantV1Schema.parse(authority))}`,
                [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: control.localCapability,
                [PROVIDER_BROKER_CLOSE_REQUEST_ID_HEADER]: requestId,
                connection: 'close',
              },
            },
            input.fetchImpl,
            new Set([MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]),
          );
          recordPhase('response_received');
          if (response.status !== 204) {
            reasonCode = 'delete_rejected';
            throw new MachineCarrierError(
              'broker_close_rejected',
              'Provider broker target did not acknowledge stream retirement.',
            );
          }
          outcome = 'released';
          reasonCode = 'acknowledged';
        } catch (error) {
          // Native verifies the peer before publishing a local tunnel, so its
          // canonical identity refusal is the same proof as the check above.
          if (error instanceof IrohError && error.code === 'identity_mismatch') {
            outcome = 'target_gone';
            reasonCode = 'target_endpoint_changed';
          }
          recordFailure(error);
        } finally {
          if (control) {
            recordPhase('private_control_close');
            try {
              await control.close();
            } catch (error) {
              // Native runtime retains failed closers for its own shutdown.
              // A local control-handle failure cannot repeat remote retirement.
              recordFailure(error);
            }
          }
          // Home admits each effect and revalidates retained broker claims.
          // After withdrawal, remote cleanup is terminal even if unreachable;
          // neither a live runner Stop nor retained dead-runner cleanup redials.
          releaseSettled = true;
          try {
            logger.infoFile('[provider-broker-release]', { phase, targetMachineId: payload.target.machineId, requestId, outcome, reasonCode });
          } catch { /* Diagnostics cannot change the terminal outcome. */ }
        }
      })().finally(() => {
        retireInFlight = null;
      });
    };
    return {
      localPort: tunnel.localPort,
      localCapability: tunnel.localCapability,
      observedPath: tunnel.observedPath,
      readFailureDiagnostic: tunnel.readFailureDiagnostic,
      retire,
      close,
    };
  };
}
