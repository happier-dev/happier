import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  admitDurablePushPluginEventObservationV1,
  PluginEventAutomationHistoryGapResetActionInputV1Schema,
  PluginEventAutomationSetupResultV1Schema,
} from '@happier-dev/plugin-sdk/events';
import {
  decodePluginWebhookActionRawBody,
  PluginWebhookActionInputSchema,
  type PluginWebhookActionResult,
} from '@happier-dev/plugin-sdk/webhooks';

import { AZURE_DEVOPS_PLUGIN_ID } from './azureDevopsContracts.js';
import {
  AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION,
  AZURE_DEVOPS_WEBHOOK_CONTRIBUTION_ID,
  AzureDevOpsEventSetupInputSchema,
  AzureDevOpsEventSourceConfigSchema,
  buildAzureDevOpsEventSourceInstanceId,
  normalizeAzureDevOpsWebhookDelivery,
  readAzureDevOpsEventRepository,
} from './events.js';
import { AZURE_DEVOPS_CONNECTED_ACCOUNT_ID, AZURE_DEVOPS_TRIAGE_PURPOSE } from './triage/descriptor.js';
import { projectAzureSourceFailure } from './triage/failureProjection.js';
import { isAzureGuid } from './triage/identity.js';
import { toAzureTransport } from './triage/invocation.js';
import { authorizeClient } from './triage/operations.js';
import { normalizeAzureDevOpsBaseUrl } from './triage/origin.js';

export async function setupAzureDevOpsPullRequestEvent(input: unknown, context: PluginInvocationContext) {
  context.signal.throwIfAborted();
  const parsed = AzureDevOpsEventSetupInputSchema.safeParse(input);
  const setup = parsed.success ? parsed.data : null;
  const origin = setup === null ? null : normalizeAzureDevOpsBaseUrl(setup.baseUrl);
  if (setup === null || !origin?.ok || !isAzureGuid(setup.project) || !isAzureGuid(setup.repository)
    || setup.credentialRef.service.pluginId !== AZURE_DEVOPS_PLUGIN_ID
    || setup.credentialRef.service.localId !== AZURE_DEVOPS_CONNECTED_ACCOUNT_ID) {
    throw new PluginError({
      code: 'azure-devops/event-setup-input-invalid',
      message: 'Choose the exact Azure DevOps account and deployment, and enter the project and repository IDs.',
    });
  }
  const project = setup.project.trim().toLowerCase();
  const repositoryId = setup.repository.trim().toLowerCase();
  const sourceInstanceId = buildAzureDevOpsEventSourceInstanceId(origin.origin, repositoryId, setup.changes);
  if (sourceInstanceId === null) {
    throw new PluginError({
      code: 'azure-devops/event-source-address-unsupported',
      message: 'The Azure DevOps deployment and repository cannot be represented as a review target identity.',
    });
  }

  const { signal, services } = context;
  const authorized = await authorizeClient({
    services: {
      connectedAccounts: services.connectedAccounts,
      transport: toAzureTransport(services.http, signal),
      now: () => Date.now(),
    },
    instance: { binding: { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account: setup.credentialRef } },
    origin: origin.origin,
    signal,
  });
  signal.throwIfAborted();
  if (!authorized.ok) throw new PluginError({
    code: 'azure-devops/event-source-unavailable',
    message: 'The selected Azure DevOps account cannot read this deployment.',
    details: { cause: authorized.failure.code },
  });
  const response = await authorized.client.request({ route: { resource: 'repositories', project, repositoryId }, signal });
  signal.throwIfAborted();
  if (!response.ok) throw new PluginError({
    code: 'azure-devops/event-source-unavailable',
    message: 'Azure DevOps could not read the selected repository.',
    details: { cause: projectAzureSourceFailure(response.failure).code },
  });
  const repository = readAzureDevOpsEventRepository(response.body, origin.origin);
  if (repository?.id !== repositoryId || repository.projectId !== project) {
    throw new PluginError({
      code: 'azure-devops/event-repository-mismatch',
      message: 'Azure DevOps did not return the selected project and repository.',
    });
  }

  return PluginEventAutomationSetupResultV1Schema.parse({
    v: 1,
    sourceInstanceId,
    sourceContractVersion: AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION,
    sourceConfig: AzureDevOpsEventSourceConfigSchema.parse({
      v: AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION, credentialRef: setup.credentialRef, repository, changes: setup.changes,
    }),
    displayLabel: repository.nameWithOwner,
    webhookDelivery: 'required',
  });
}

export async function resetAzureDevOpsEventHistoryGap(input: unknown, context: PluginInvocationContext) {
  context.signal.throwIfAborted();
  PluginEventAutomationHistoryGapResetActionInputV1Schema.parse(input);
  // Durable webhook delivery recovery belongs to the host.
  return { kind: 'noHistoryGap' as const };
}

export async function receiveAzureDevOpsWebhook(
  rawInput: unknown,
  context: PluginInvocationContext,
): Promise<PluginWebhookActionResult> {
  context.signal.throwIfAborted();
  const caller = context.caller;
  if (context.surface !== 'plugin' || caller?.kind !== 'host' || caller.domain !== 'ingress'
    || caller.originSurface !== 'webhook' || caller.contribution.id !== AZURE_DEVOPS_WEBHOOK_CONTRIBUTION_ID
    || caller.contribution.qualifiedId !== `${AZURE_DEVOPS_PLUGIN_ID}/${AZURE_DEVOPS_WEBHOOK_CONTRIBUTION_ID}`) {
    return { kind: 'deadLetter', code: 'azure-devops.webhook-caller-invalid' };
  }
  const parsed = PluginWebhookActionInputSchema.safeParse(rawInput);
  if (!parsed.success) return { kind: 'deadLetter', code: 'azure-devops.webhook-input-invalid' };
  const { endpoint, delivery, verified } = parsed.data;
  if (verified.verifier !== 'capabilityUrl_v1' || endpoint.webhookEndpointId === undefined
    || endpoint.webhookContribution.pluginId !== AZURE_DEVOPS_PLUGIN_ID
    || endpoint.webhookContribution.localId !== AZURE_DEVOPS_WEBHOOK_CONTRIBUTION_ID) {
    return { kind: 'deadLetter', code: 'azure-devops.webhook-endpoint-invalid' };
  }
  let event: ReturnType<typeof normalizeAzureDevOpsWebhookDelivery>;
  try {
    event = normalizeAzureDevOpsWebhookDelivery(decodePluginWebhookActionRawBody(parsed.data), endpoint.sourceInstanceId);
  } catch {
    return { kind: 'deadLetter', code: 'azure-devops.webhook-payload-invalid' };
  }
  if (!event) return { kind: 'settled', disposition: 'ignored' };
  const admitted = await admitDurablePushPluginEventObservationV1({
    ...event,
    sourceInstanceId: endpoint.sourceInstanceId,
    sourceContractVersion: AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION,
    observationReceivedAt: delivery.receivedAtMs,
    observedDelta: delivery.attempt === 1 && delivery.replay === 0 ? 1 : 0,
  }, context, endpoint.webhookEndpointId);
  if (admitted.kind === 'unsettled') return { kind: 'retry', code: 'azure-devops.automation-unavailable' };
  const accepted = admitted.admissions?.some(({ result }) => result.kind === 'admitted' || result.kind === 'rejoined');
  return { kind: 'settled', disposition: accepted ? 'accepted' : 'ignored' };
}
