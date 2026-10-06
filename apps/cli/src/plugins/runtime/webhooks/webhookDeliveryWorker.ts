import { PluginWebhookActionInputV1Schema, PluginWebhookActionResultV1Schema, PluginWebhookDeliveryContentV1Schema } from '@happier-dev/protocol/plugins/webhooks/deliveryV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import type { PluginWebhookActionInputV1, PluginWebhookActionResultV1, PluginWebhookAutomationAdmissionUnresolvedV1, PluginWebhookClaimResultV1, PluginWebhookSettleResultV1 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  readCurrentPluginWebhookAutomationAdmissionUnresolvedV1,
  runWithPluginWebhookInvocationReferenceV1,
} from './pluginWebhookInvocationReference';

type DeliveryClaimV1 = Extract<PluginWebhookClaimResultV1, { kind: 'delivery' }>;
/**
 * The exact server-selected target is a claim fact, not a separate caller
 * input: the protocol claim response carries it, and renew/complete/fail
 * address work by that exact target. Deriving it here keeps the claim the
 * single decision-maker — a caller can no longer pass a diverging target.
 */
type ClaimTargetV1 = DeliveryClaimV1['target'];

/**
 * A handler is always cancelled before the active server lease can expire. The
 * server remains the lease owner; this client-side ceiling only bounds one
 * invocation and turns expiry into a typed retry result.
 */
export const PLUGIN_WEBHOOK_HANDLER_DEADLINE_MS_V1 = 90_000;

function resolveHandlerDeadlineMsV1(params: Readonly<{
  configuredMs: number | undefined;
  leaseExpiresAtMs: number;
  nowMs: number;
}>): number | null {
  const configuredMs = params.configuredMs ?? PLUGIN_WEBHOOK_HANDLER_DEADLINE_MS_V1;
  if (!Number.isSafeInteger(configuredMs) || configuredMs < 1) {
    throw new TypeError('Plugin webhook handler deadline must be a positive safe integer');
  }
  const remainingLeaseMs = params.leaseExpiresAtMs - params.nowMs;
  if (!Number.isSafeInteger(remainingLeaseMs) || remainingLeaseMs <= 1) return null;
  return Math.min(configuredMs, remainingLeaseMs - 1);
}

export type PluginWebhookDeliveryWorkerTransportV1 = Readonly<{
  renew(input: Readonly<{
    deliveryId: string;
    target: ClaimTargetV1;
    lease: Readonly<{ leaseId: string; revision: number }>;
    transition: 'executionStarted' | 'renew';
    signal?: AbortSignal;
  }>): Promise<Readonly<
    | { kind: 'renewed'; revision: number; expiresAtMs: number }
    | { kind: 'leaseLost' }
    | { kind: 'unavailable'; code: string }
  >>;
  complete(input: Readonly<{
    deliveryId: string;
    target: ClaimTargetV1;
    lease: Readonly<{ leaseId: string; revision: number }>;
    result: Readonly<{ kind: 'settled'; disposition: 'accepted' | 'ignored' }>;
    signal?: AbortSignal;
  }>): Promise<PluginWebhookSettleResultV1>;
  fail(input: Readonly<{
    deliveryId: string;
    target: ClaimTargetV1;
    lease: Readonly<{ leaseId: string; revision: number }>;
    result: Readonly<{ kind: 'retry' | 'deadLetter'; code: string }>;
    /** Host-derived only; public plugin Action results cannot author this. */
    automationAdmissionUnresolved?: PluginWebhookAutomationAdmissionUnresolvedV1;
    signal?: AbortSignal;
  }>): Promise<PluginWebhookSettleResultV1>;
}>;

function openContentV1(claim: DeliveryClaimV1, credentials: StoredCredentials) {
  if (claim.envelope.t === 'plain') return claim.envelope.v;
  const encryption = credentials.encryption;
  if (!encryption) return null;
  const secret = encryption.type === 'dataKey' ? encryption.machineKey : encryption.secret;
  const plaintext = openBoxBundle({
    bundle: decodeBase64(claim.envelope.c, 'base64'),
    recipientSecretKeyOrSeed: secret,
  });
  if (!plaintext) return null;
  try {
    return PluginWebhookDeliveryContentV1Schema.parse(JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
    ));
  } catch {
    return null;
  }
}

function buildActionInputV1(claim: DeliveryClaimV1, credentials: StoredCredentials): PluginWebhookActionInputV1 | null {
  const content = openContentV1(claim, credentials);
  if (!content) return null;
  return PluginWebhookActionInputV1Schema.parse({
    v: 1,
    endpoint: {
      webhookContribution: claim.endpoint.webhookContribution,
      sourceInstanceId: claim.endpoint.sourceInstanceId,
    },
    delivery: {
      deliveryId: claim.deliveryId,
      attempt: claim.attempt,
      replay: claim.replay,
      receivedAtMs: claim.receivedAtMs,
      providerDeliveryId: content.verified.providerDeliveryId,
    },
    request: {
      contentType: content.contentType,
      headers: content.headers,
      rawBodyBytes: content.rawBodyBytes,
      rawBodyBase64: content.rawBodyBase64,
    },
    verified: {
      verifier: content.verified.verifier,
      ...(content.verified.eventType ? { eventType: content.verified.eventType } : {}),
    },
  });
}

/**
 * Executes one claimed delivery through the canonical named Action dispatcher.
 * Lease transition precedes plugin code, and settlement uses only the renewed
 * revision so a stale worker cannot complete a reassigned delivery.
 */
export async function processClaimedPluginWebhookDeliveryV1(params: Readonly<{
  claim: DeliveryClaimV1;
  credentials: StoredCredentials;
  transport: PluginWebhookDeliveryWorkerTransportV1;
  execute(
    actionId: string,
    input: PluginWebhookActionInputV1,
    options?: Readonly<{ signal?: AbortSignal; beforeHandlerInvocation: () => Promise<void> }>,
  ): Promise<PluginWebhookActionResultV1>;
  /** Test override; production uses the bounded V1 policy above. */
  handlerDeadlineMs?: number;
  /** Daemon lifecycle cancellation; the server lease remains the settlement authority. */
  signal?: AbortSignal;
}>): Promise<PluginWebhookSettleResultV1 | Readonly<{ kind: 'leaseLost' | 'unavailable'; code?: string }>> {
  const daemonStopped = () => ({ kind: 'unavailable' as const, code: 'daemon_stopped' });
  // One exact-target authority: the claim response carries it, and every
  // lease transition below addresses that same target.
  const target = params.claim.target;
  if (params.signal?.aborted) return daemonStopped();
  const input = buildActionInputV1(params.claim, params.credentials);
  if (!input) {
    if (params.signal?.aborted) return daemonStopped();
    return await params.transport.fail({
      deliveryId: params.claim.deliveryId,
      target,
      lease: { leaseId: params.claim.lease.leaseId, revision: params.claim.lease.revision },
      result: { kind: 'deadLetter', code: 'content_unavailable' },
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }
  let lease = {
    leaseId: params.claim.lease.leaseId,
    revision: params.claim.lease.revision,
    expiresAtMs: params.claim.lease.expiresAtMs,
  };
  let executionStarted = false;
  let stopRenewing = false;
  const renewalWindow: { wake: (() => void) | null } = { wake: null };
  let custodyFailure: Readonly<{ kind: 'leaseLost' | 'unavailable'; code?: string }> | null = null;
  const executionController = new AbortController();
  let renewalLoop: Promise<void> | null = null;
  const renewWhileExecuting = async () => {
    while (!stopRenewing) {
      const delayMs = Math.max(1, Math.floor((lease.expiresAtMs - Date.now()) / 2));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        renewalWindow.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      renewalWindow.wake = null;
      if (stopRenewing) return;
      let next: Awaited<ReturnType<PluginWebhookDeliveryWorkerTransportV1['renew']>>;
      try {
        next = await params.transport.renew({
          deliveryId: params.claim.deliveryId,
          target,
          lease: { leaseId: lease.leaseId, revision: lease.revision },
          transition: 'renew',
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } catch {
        if (params.signal?.aborted) {
          custodyFailure = daemonStopped();
          executionController.abort(new Error('plugin_webhook_daemon_stopped'));
          return;
        }
        // A transport/schema/proof failure cannot prove that this worker still owns the
        // server lease. Contain it in this loop, revoke the Action's live custody, and
        // leave the durable server recovery owner to make the next transition.
        custodyFailure = { kind: 'unavailable', code: 'delivery_lease_unavailable' };
        executionController.abort(new Error('plugin_webhook_lease_renewal_unavailable'));
        return;
      }
      if (next.kind !== 'renewed') {
        custodyFailure = next;
        executionController.abort(new Error('plugin_webhook_lease_lost'));
        return;
      }
      lease = { ...lease, revision: next.revision, expiresAtMs: next.expiresAtMs };
    }
  };
  const handlerDeadlineController = new AbortController();
  let handlerTimedOut = false;
  let handlerDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const handlerSignal = AbortSignal.any([
    executionController.signal,
    handlerDeadlineController.signal,
    ...(params.signal ? [params.signal] : []),
  ]);
  const beforeHandlerInvocation = async (): Promise<void> => {
    handlerSignal.throwIfAborted();
    let renewed: Awaited<ReturnType<PluginWebhookDeliveryWorkerTransportV1['renew']>>;
    try {
      renewed = await params.transport.renew({
        deliveryId: params.claim.deliveryId,
        target,
        lease: { leaseId: lease.leaseId, revision: lease.revision },
        transition: 'executionStarted',
        signal: handlerSignal,
      });
    } catch {
      custodyFailure = params.signal?.aborted
        ? daemonStopped()
        : { kind: 'unavailable', code: 'delivery_lease_unavailable' };
      throw new Error('plugin_webhook_execution_admission_unavailable');
    }
    if (renewed.kind !== 'renewed') {
      custodyFailure = renewed;
      throw new Error('plugin_webhook_execution_admission_refused');
    }
    lease = { ...lease, revision: renewed.revision, expiresAtMs: renewed.expiresAtMs };
    executionStarted = true;
    handlerSignal.throwIfAborted();
    const handlerDeadlineMs = resolveHandlerDeadlineMsV1({
      configuredMs: params.handlerDeadlineMs,
      leaseExpiresAtMs: lease.expiresAtMs,
      nowMs: Date.now(),
    });
    if (handlerDeadlineMs === null) {
      custodyFailure = { kind: 'leaseLost' };
      throw new Error('plugin_webhook_execution_lease_expired');
    }
    handlerDeadlineTimer = setTimeout(() => {
      handlerTimedOut = true;
      handlerDeadlineController.abort(new Error('plugin_webhook_handler_timeout'));
    }, handlerDeadlineMs);
    renewalLoop = renewWhileExecuting();
  };
  let result: PluginWebhookActionResultV1;
  let automationAdmissionUnresolved: PluginWebhookAutomationAdmissionUnresolvedV1 | null = null;
  /**
   * True only when the Action itself returned a schema-valid result. A thrown,
   * cancelled or timed-out handler leaves a host-derived retry marker, which is
   * not a result worth spending a final settlement attempt on.
   */
  let actionAuthoredResult = false;
  try {
    const executed = await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease: {
        v: 1,
        deliveryId: params.claim.deliveryId,
        endpoint: params.claim.endpoint,
        target,
      },
      readLease: () => custodyFailure || !executionStarted ? null : { leaseId: lease.leaseId, revision: lease.revision },
      signal: handlerSignal,
    }, async () => {
      const actionResult = PluginWebhookActionResultV1Schema.parse(await params.execute(
        `${params.claim.endpoint.webhookContribution.pluginId}/${params.claim.endpoint.handlerActionLocalId}`,
        input,
        { signal: handlerSignal, beforeHandlerInvocation },
      ));
      return {
        result: actionResult,
        automationAdmissionUnresolved: readCurrentPluginWebhookAutomationAdmissionUnresolvedV1(),
      };
    });
    result = executed.result;
    automationAdmissionUnresolved = executed.automationAdmissionUnresolved;
    actionAuthoredResult = true;
  } catch {
    result = { kind: 'retry', code: handlerTimedOut ? 'handler_timeout' : 'handler_error' };
  } finally {
    clearTimeout(handlerDeadlineTimer);
    stopRenewing = true;
    renewalWindow.wake?.();
    await renewalLoop;
  }
  if (params.signal?.aborted) return daemonStopped();
  // Pre-effect unavailability is not a handler retry. Leave the unstarted
  // claim with the server's existing lease-expiry/offline recovery owner.
  if (!executionStarted) return custodyFailure ?? { kind: 'unavailable', code: 'handler_unavailable' };
  if (handlerTimedOut) {
    result = { kind: 'retry', code: 'handler_timeout' };
    automationAdmissionUnresolved = null;
    actionAuthoredResult = false;
  }
  // The last lease the server acknowledged. Settlement addresses that exact
  // identity, so a reassigned or expired row is refused by its compare-and-set
  // rather than overwritten here.
  const settlementLease = { leaseId: lease.leaseId, revision: lease.revision };
  const settle = async (): Promise<PluginWebhookSettleResultV1> => (
    result.kind === 'settled'
      ? await params.transport.complete({
        deliveryId: params.claim.deliveryId,
        target,
        lease: settlementLease,
        result,
        ...(params.signal ? { signal: params.signal } : {}),
      })
      : await params.transport.fail({
        deliveryId: params.claim.deliveryId,
        target,
        lease: settlementLease,
        result,
        ...(result.kind === 'retry' && automationAdmissionUnresolved
          ? { automationAdmissionUnresolved }
          : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      })
  );
  if (!custodyFailure) return await settle();
  // Custody was questioned while the Action ran, but the Action still produced
  // its own result under `executionStartedAt`. A renewal refusal proves the
  // server would not *extend* this lease — for a retired plugin generation or
  // endpoint it never proves the lease already expired. Discarding the result
  // here strands the row until expiry and then re-runs the same delivery, so
  // make exactly one final attempt against the last acknowledged lease and let
  // the server's exact delivery/target/installation/lease/revision CAS decide.
  // No receipt, retry loop or extra state: refusal returns the same contained
  // custody answer this path has always returned.
  if (!actionAuthoredResult || lease.expiresAtMs <= Date.now()) return custodyFailure;
  try {
    return await settle();
  } catch {
    return custodyFailure;
  }
}
