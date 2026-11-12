import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { admitDurablePushPluginEventObservationV1, PluginEventAutomationSetupResultV1Schema } from '@happier-dev/plugin-sdk/events';
import { decodePluginWebhookActionRawBody, PluginWebhookActionInputSchema,
  type PluginWebhookActionResult } from '@happier-dev/plugin-sdk/webhooks';
import { GitlabEventRepositorySchema, GitlabEventSetupInputSchema, GITLAB_WEBHOOK_CONTRIBUTION_ID,
  normalizeGitlabWebhookDelivery } from './events.js';
import { GITLAB_CONNECTED_ACCOUNT_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE, GITLAB_PLUGIN_ID } from './triage/contribution.js';
import { normalizeGitlabConfiguredBaseUrl } from './triage/origin.js';
import { buildGitlabProjectCollisionScope } from './triage/identity.js';
import { authorizeGitlabBoundAccount } from './triage/configuredInstance.js';
import { buildGitlabApiUrl, requestGitlabJson } from './triage/http/gitlabClient.js';
import { createGitlabHttpFetcher, readGitlabConnectedAccounts } from './triage/invocation.js';

/** One finite authenticated repository read, using the existing exact-account GitLab client. */
export async function setupGitlabRepositoryEvent(input: unknown, context: PluginInvocationContext) {
  const parsed = GitlabEventSetupInputSchema.safeParse(input);
  if (!parsed.success) throw new PluginError({ code: 'gitlab_setup_input_invalid', message: 'Choose a GitLab repository, deployment and exact Connected Account.' });
  const setup = parsed.data;
  const origin = normalizeGitlabConfiguredBaseUrl(setup.baseUrl);
  if (!origin || setup.credentialRef.service.pluginId !== GITLAB_PLUGIN_ID || setup.credentialRef.service.localId !== GITLAB_CONNECTED_ACCOUNT_ID
    || !/^[^/\s]+(?:\/[^/\s]+)+$/u.test(setup.repository)) {
    throw new PluginError({ code: 'gitlab_setup_input_invalid', message: 'Choose a GitLab repository, deployment and exact Connected Account.' });
  }
  const authorized = await authorizeGitlabBoundAccount({ instance: { binding: { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
    account: setup.credentialRef } }, origin, connectedAccounts: readGitlabConnectedAccounts(context), signal: context.signal,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }) });
  if (authorized.kind === 'failed') throw new PluginError({ code: 'gitlab_source_unavailable',
    message: 'The selected GitLab account cannot read this deployment.', details: { cause: authorized.failure.code } });
  const result = await requestGitlabJson({ invocation: authorized.resolved.invocation,
    url: buildGitlabApiUrl(origin, `/projects/${encodeURIComponent(setup.repository)}`),
    fetcher: createGitlabHttpFetcher(context), signal: context.signal, nowMs: Date.now() });
  if (result.kind === 'failed') throw new PluginError({ code: 'gitlab_source_unavailable',
    message: 'GitLab could not resolve the selected repository.', details: { cause: result.failure.code } });
  const body = result.response.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('id' in body)
    || typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id < 1 || !('path_with_namespace' in body)) {
    throw new PluginError({ code: 'gitlab_source_unavailable', message: 'GitLab returned an unsupported repository response.' });
  }
  const repository = GitlabEventRepositorySchema.parse({ repositoryId: String(body.id),
    nameWithOwner: body.path_with_namespace, baseUrl: origin.normalized });
  return PluginEventAutomationSetupResultV1Schema.parse({ v: 1,
    sourceInstanceId: buildGitlabProjectCollisionScope(origin, repository.repositoryId), sourceContractVersion: 1,
    sourceConfig: { v: 1, credentialRef: setup.credentialRef, repository }, displayLabel: repository.nameWithOwner,
    webhookDelivery: 'required',
  });
}

/** Host-authenticated bytes enter the existing Automation admission bridge exactly once. */
export async function receiveGitlabWebhook(rawInput: unknown, context: PluginInvocationContext): Promise<PluginWebhookActionResult> {
  context.signal.throwIfAborted();
  const caller = context.caller;
  if (context.surface !== 'plugin' || caller?.kind !== 'host' || caller.domain !== 'ingress'
    || caller.originSurface !== 'webhook' || caller.contribution.id !== GITLAB_WEBHOOK_CONTRIBUTION_ID
    || caller.contribution.qualifiedId !== `${GITLAB_PLUGIN_ID}/${GITLAB_WEBHOOK_CONTRIBUTION_ID}`) {
    return { kind: 'deadLetter', code: 'gitlab_webhook_caller_invalid' };
  }
  const parsed = PluginWebhookActionInputSchema.safeParse(rawInput);
  if (!parsed.success || parsed.data.verified.verifier !== 'gitlab_token_v1'
    || parsed.data.endpoint.webhookContribution.pluginId !== GITLAB_PLUGIN_ID
    || parsed.data.endpoint.webhookContribution.localId !== GITLAB_WEBHOOK_CONTRIBUTION_ID
    || parsed.data.endpoint.webhookEndpointId === undefined) return { kind: 'deadLetter', code: 'gitlab_payload_invalid' };
  const input = parsed.data;
  if (input.verified.eventType !== 'Push Hook' && input.verified.eventType !== 'Merge Request Hook') {
    return { kind: 'settled', disposition: 'ignored' };
  }
  let event: ReturnType<typeof normalizeGitlabWebhookDelivery>;
  try {
    const source = /^gitlab:([A-Za-z0-9_-]+):[1-9][0-9]*$/u.exec(input.endpoint.sourceInstanceId);
    if (!source) throw new TypeError('gitlab_payload_invalid');
    const baseUrl = new TextDecoder().decode(decodeBase64(source[1]!, 'base64url'));
    event = normalizeGitlabWebhookDelivery({ rawBody: decodePluginWebhookActionRawBody(input),
      eventType: input.verified.eventType, providerDeliveryId: input.delivery.providerDeliveryId,
      receivedAtMs: input.delivery.receivedAtMs, baseUrl });
  } catch (error) {
    context.signal.throwIfAborted();
    return { kind: 'deadLetter', code: 'gitlab_payload_invalid' };
  }
  if (!event || event.sourceInstanceId !== input.endpoint.sourceInstanceId) return { kind: 'settled', disposition: 'ignored' };
  const admitted = await admitDurablePushPluginEventObservationV1({ eventRef: event.eventRef,
    sourceInstanceId: event.sourceInstanceId, sourceContractVersion: 1, occurrenceId: event.occurrenceId,
    occurredAt: event.occurredAtMs, observationReceivedAt: input.delivery.receivedAtMs,
    observedDelta: input.delivery.attempt === 1 && input.delivery.replay === 0 ? 1 : 0, payload: event.payload,
  }, context, input.endpoint.webhookEndpointId!);
  if (admitted.kind === 'unsettled') return { kind: 'retry', code: 'gitlab.automation-unavailable' };
  return { kind: 'settled', disposition: admitted.admissions?.some(({ result }) => result.kind === 'admitted' || result.kind === 'rejoined') ? 'accepted' : 'ignored' };
}
