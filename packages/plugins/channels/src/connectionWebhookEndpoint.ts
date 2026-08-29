import {
  isPluginError,
  PluginError,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
  PluginWebhookEndpointIdV1Schema,
  type PluginWebhookEndpointIdV1,
} from '@happier-dev/plugin-sdk/webhooks';
import type { ConversationConnectionCreateResultV1 } from '@happier-dev/channels-protocol/v1';
import {
  conversationConnectionWebhookSourceInstanceIdV1,
  ConversationConnectionCreateResultV1Schema,
} from '@happier-dev/channels-protocol/v1';

import { encodeUnpaddedBase64Url } from './privateRowIdentity.js';

/**
 * The one durable-push creation owner for the endpoint half of the journey.
 *
 * The core preallocates the final connection identity, mints one stable
 * generic ensure idempotency key per `endpointRequired` result, and proves
 * host-derived endpoint correspondence through the existing generic
 * `plugin.webhook.endpoint.checkCorrespondence` Action. The present-user UI
 * only relays these facts to `plugin.webhook.endpoint.ensure` and back; no
 * UI- or provider-asserted correspondence is ever accepted, no attempt
 * receipt or ledger is persisted, and an endpoint left unattached to a
 * connection remains `WH-OPERATIONS` lifecycle.
 *
 * The ensure key is core-minted and stable through the UI's retention of the
 * exact ensure input: response loss before the result caused no endpoint
 * effect, and response loss after it retries those same input bytes, so
 * nothing needs to be derived or stored to make the retry rejoin.
 */

/**
 * The one endpoint setup arm a present-user creation journey can complete:
 * the server mints the shared secret and discloses it once. The
 * shared-installation arm stays with its separately held producer, so no
 * provider-specific creation branch exists here. The endpointRequired result
 * schema is the shape authority for this constant.
 */
export const CONVERSATION_CONNECTION_WEBHOOK_ENDPOINT_ENSURE_SETUP_V1 = Object.freeze({
  kind: 'accountEndpointV1',
  credential: 'serverGenerated',
} as const);

/** The derived, never-persisted identity of one endpoint-ensure attempt. */
export type ConversationConnectionWebhookEndpointAttemptIdentity = Readonly<{
  sourceInstanceId: string;
  endpointEnsureIdempotencyKey: string;
}>;

/** The facts one endpoint-ensure attempt is bound to. */
export type ConversationConnectionWebhookEndpointAttemptFacts = Readonly<{
  connectionId: string;
  webhookContribution: Readonly<{ pluginId: string; localId: string }>;
  targetMaterialization: Readonly<{
    pluginId: string;
    machineId: string;
    materializationId: string;
  }>;
}>;

function webhookEndpointPluginError(code: string, message: string, retryable = false): PluginError {
  return new PluginError({ code, message, retryable });
}

function randomBase64Url(byteLength: number): string {
  if (globalThis.crypto?.getRandomValues === undefined) {
    throw webhookEndpointPluginError(
      'channels_connection_crypto_unavailable',
      'The runtime cannot generate a private durable-push endpoint ensure key.',
    );
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return encodeUnpaddedBase64Url(bytes);
}

/**
 * Mints the Channels-owned source instance for the preallocated connection and
 * one random bounded generic ensure idempotency key. Nothing is derived from
 * setup facts or persisted; the key is stable because the UI retains and
 * retries the exact returned ensure input for the same attempt.
 */
export function mintConversationConnectionWebhookEndpointAttemptIdentity(input: Readonly<{
  connectionId: string;
}>): ConversationConnectionWebhookEndpointAttemptIdentity {
  const sourceInstanceId = conversationConnectionWebhookSourceInstanceIdV1(input.connectionId);
  const endpointEnsureIdempotencyKey = `endpoint-attempt-${randomBase64Url(18)}`;
  return {
    sourceInstanceId,
    endpointEnsureIdempotencyKey,
  };
}

/**
 * Builds the strict `endpointRequired` result and enforces its one
 * cross-field invariant at this owner: the source instance must be exactly
 * the Channels derivation of the result's preallocated connection ID. The
 * composable protocol schema bounds each field; this runtime check is the
 * canonical cross-field enforcement, so a mismatched attempt can never
 * leave the core.
 */
export function buildConversationConnectionEndpointRequiredResult(input: Readonly<{
  attempt: ConversationConnectionWebhookEndpointAttemptIdentity;
  facts: ConversationConnectionWebhookEndpointAttemptFacts;
  webhookEndpointSetup: Readonly<{ kind: 'accountEndpointV1'; credential: 'serverGenerated' }>;
}>): Extract<ConversationConnectionCreateResultV1, Readonly<{ kind: 'endpointRequired' }>> {
  if (input.attempt.sourceInstanceId
    !== conversationConnectionWebhookSourceInstanceIdV1(input.facts.connectionId)) {
    throw webhookEndpointPluginError(
      'channels_connection_endpoint_source_instance_mismatch',
      'The durable-push source instance is not the derivation of its preallocated connection identity.',
    );
  }
  const result = ConversationConnectionCreateResultV1Schema.parse({
    kind: 'endpointRequired',
    connectionId: input.facts.connectionId,
    webhookContribution: { ...input.facts.webhookContribution },
    targetMaterialization: { ...input.facts.targetMaterialization },
    sourceInstanceId: input.attempt.sourceInstanceId,
    webhookEndpointSetup: { ...input.webhookEndpointSetup },
    webhookEndpointIdempotencyKey: input.attempt.endpointEnsureIdempotencyKey,
  });
  if (result.kind !== 'endpointRequired') {
    throw webhookEndpointPluginError(
      'channels_connection_endpoint_result_invalid',
      'The durable-push endpointRequired result did not parse as its own arm.',
    );
  }
  return result;
}

/** Admits a relayed endpoint identity through its one canonical owner parser. */
export function readCanonicalConversationWebhookEndpointId(
  value: string,
): PluginWebhookEndpointIdV1 {
  try {
    return PluginWebhookEndpointIdV1Schema.parse(value);
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_create_endpoint_id_invalid',
      message: 'The webhook endpoint continuation did not carry a canonical endpoint identity.',
    }, { cause });
  }
}

/**
 * Proves endpoint correspondence through the host-derived plugin-surface
 * check. Only a current `ready` result — same contribution, exact selected
 * materialization, source instance, and current eligible installation — may
 * admit the connection mutation; every other answer fails closed with zero
 * Channel write.
 */
export async function assertConversationConnectionWebhookEndpointCorrespondence(input: Readonly<{
  context: Pick<PluginInvocationContext, 'services' | 'signal'>;
  webhookEndpointId: PluginWebhookEndpointIdV1;
  webhookContribution: Readonly<{ pluginId: string; localId: string }>;
  targetMaterialization: Readonly<{
    pluginId: string;
    machineId: string;
    materializationId: string;
  }>;
  sourceInstanceId: string;
}>): Promise<void> {
  let result: PluginActionResultById['plugin.webhook.endpoint.checkCorrespondence'];
  try {
    result = await input.context.services.actions.execute(
      'plugin.webhook.endpoint.checkCorrespondence',
      {
        webhookEndpointId: input.webhookEndpointId,
        webhookContribution: { ...input.webhookContribution },
        targetMaterialization: { ...input.targetMaterialization },
        sourceInstanceId: input.sourceInstanceId,
        setup: { ...CONVERSATION_CONNECTION_WEBHOOK_ENDPOINT_ENSURE_SETUP_V1 },
      } satisfies PluginActionInputById['plugin.webhook.endpoint.checkCorrespondence'],
      { signal: input.context.signal },
    );
  } catch (cause) {
    if (input.context.signal.aborted) throw cause;
    if (isPluginError(cause)) throw cause;
    throw webhookEndpointPluginError(
      'channels_connection_endpoint_correspondence_unavailable',
      'Endpoint correspondence could not be verified for this durable-push connection.',
      true,
    );
  }
  if (result.kind !== 'ready' || result.webhookEndpointId !== input.webhookEndpointId) {
    throw webhookEndpointPluginError(
      'channels_connection_endpoint_correspondence_mismatch',
      'The ensured webhook endpoint does not correspond to this connection setup.',
    );
  }
}
