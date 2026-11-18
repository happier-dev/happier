import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginEventAutomationSetupResultV1Schema, admitDurablePushPluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { decodePluginWebhookActionRawBody, PluginWebhookActionInputSchema, type PluginWebhookActionResult } from '@happier-dev/plugin-sdk/webhooks';
import { BITBUCKET_PLUGIN_ID } from './bitbucketContracts.js';
import { BitbucketEventRepositorySchema, BitbucketEventSetupInputSchema, BITBUCKET_WEBHOOK_CONTRIBUTION_ID,
  bitbucketRepositoryEventSourceId, normalizeBitbucketWebhookDelivery } from './events.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID } from './triage/source/descriptor.js';
import { createAuthorizedBitbucketClient } from './triage/source/authorization.js';
import { toBitbucketRuntime } from './triage/source/invocationAdmission.js';
import { readBitbucketBracedUuid, readBitbucketRepositoryKey } from './triage/identity.js';

/** Resolve one selected repository through the existing exact-account authorization owner. */
export async function setupBitbucketRepositoryEvent(input: unknown, context: PluginInvocationContext) {
  context.signal.throwIfAborted();
  const parsed = BitbucketEventSetupInputSchema.safeParse(input);
  if (!parsed.success) throw new PluginError({ code: 'bitbucket_setup_input_invalid', message: 'Choose a Bitbucket repository and exact Connected Account.' });
  const setup = parsed.data;
  const key = readBitbucketRepositoryKey(setup.repository);
  if (!key || setup.credentialRef.service.pluginId !== BITBUCKET_PLUGIN_ID
    || setup.credentialRef.service.localId !== BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID) {
    throw new PluginError({ code: 'bitbucket_setup_input_invalid', message: 'Choose a Bitbucket repository and exact Connected Account.' });
  }
  const authorized = await createAuthorizedBitbucketClient(toBitbucketRuntime(context), {
    purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, account: setup.credentialRef,
  });
  if (!authorized.ok) {
    context.signal.throwIfAborted();
    throw new PluginError({ code: 'bitbucket_source_unavailable', message: 'The selected Bitbucket account cannot read this repository.' });
  }
  const result = await authorized.client.requestJson({
    url: `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(key.workspaceSlug)}/${encodeURIComponent(key.repositorySlug)}`,
    signal: context.signal,
  });
  context.signal.throwIfAborted();
  const body = result.ok && result.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result.body : null;
  const uuid = body && 'uuid' in body ? readBitbucketBracedUuid(body.uuid) : null;
  const fullName = body && 'full_name' in body && typeof body.full_name === 'string' ? readBitbucketRepositoryKey(body.full_name) : null;
  if (!uuid || !fullName || fullName.repositoryKey !== key.repositoryKey) {
    throw new PluginError({ code: 'bitbucket_source_unavailable', message: 'Bitbucket could not resolve the selected repository.' });
  }
  const repository = BitbucketEventRepositorySchema.parse({ repositoryId: uuid.toLowerCase(), nameWithOwner: fullName.repositoryKey });
  return PluginEventAutomationSetupResultV1Schema.parse({ v: 1, sourceInstanceId: bitbucketRepositoryEventSourceId(repository.repositoryId),
    sourceContractVersion: 1, sourceConfig: { v: 1, credentialRef: setup.credentialRef, repository },
    displayLabel: `${repository.nameWithOwner} — configure Created, Pushed, Merged and Declined pull-request webhooks with the generated secret`,
    webhookDelivery: 'required',
  });
}

/** Signature verification stays at ingress; the provider owns only decoding and admission. */
export async function receiveBitbucketWebhook(rawInput: unknown, context: PluginInvocationContext): Promise<PluginWebhookActionResult> {
  context.signal.throwIfAborted();
  const caller = context.caller;
  if (context.surface !== 'plugin' || caller?.kind !== 'host' || caller.domain !== 'ingress'
    || caller.originSurface !== 'webhook' || caller.contribution.id !== BITBUCKET_WEBHOOK_CONTRIBUTION_ID
    || caller.contribution.qualifiedId !== `${BITBUCKET_PLUGIN_ID}/${BITBUCKET_WEBHOOK_CONTRIBUTION_ID}`) {
    return { kind: 'deadLetter', code: 'bitbucket_webhook_caller_invalid' };
  }
  const parsed = PluginWebhookActionInputSchema.safeParse(rawInput);
  if (!parsed.success || parsed.data.verified.verifier !== 'bitbucket_hmac_sha256_v1'
    || parsed.data.endpoint.webhookContribution.pluginId !== BITBUCKET_PLUGIN_ID
    || parsed.data.endpoint.webhookContribution.localId !== BITBUCKET_WEBHOOK_CONTRIBUTION_ID
    || parsed.data.endpoint.webhookEndpointId === undefined) return { kind: 'deadLetter', code: 'bitbucket_payload_invalid' };
  const input = parsed.data;
  let event: ReturnType<typeof normalizeBitbucketWebhookDelivery>;
  try {
    event = normalizeBitbucketWebhookDelivery({ rawBody: decodePluginWebhookActionRawBody(input),
      ...(input.verified.eventType === undefined ? {} : { eventType: input.verified.eventType }),
      providerDeliveryId: input.delivery.providerDeliveryId, receivedAtMs: input.delivery.receivedAtMs });
  } catch {
    context.signal.throwIfAborted();
    return { kind: 'deadLetter', code: 'bitbucket_payload_invalid' };
  }
  if (!event || event.sourceInstanceId !== input.endpoint.sourceInstanceId) return { kind: 'settled', disposition: 'ignored' };
  const admitted = await admitDurablePushPluginEventObservationV1({ eventRef: event.eventRef,
    sourceInstanceId: event.sourceInstanceId, sourceContractVersion: 1, occurrenceId: event.occurrenceId,
    occurredAt: event.occurredAtMs, observationReceivedAt: input.delivery.receivedAtMs,
    observedDelta: input.delivery.attempt === 1 && input.delivery.replay === 0 ? 1 : 0, payload: event.payload,
  }, context, input.endpoint.webhookEndpointId!);
  if (admitted.kind === 'unsettled') return { kind: 'retry', code: 'bitbucket.automation-unavailable' };
  return { kind: 'settled', disposition: admitted.admissions?.some(({ result }) => result.kind === 'admitted' || result.kind === 'rejoined') ? 'accepted' : 'ignored' };
}
