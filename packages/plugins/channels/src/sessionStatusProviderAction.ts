import { ConversationDeliveryResultV1Schema, ConversationSessionStatusInputV1Schema } from '@happier-dev/channels-protocol/v1';
import type { ConversationSessionStatusInputV1 } from '@happier-dev/channels-protocol/v1';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { readCurrentProviderContributionForPersistedSelection } from './providerContributions.js';
import { getConversationConnectionExecutionRouting } from './connectionLifecycle.js';
import type { SessionStatusTarget } from './sessionStatusProjection.js';

/** The admitted binding/connection projection selects credentials and placement once. */
export async function publishSessionStatus(context: BackgroundServiceContext, target: SessionStatusTarget,
  status: ConversationSessionStatusInputV1['status'], providerMessageId?: string) {
  const { connection } = target;
  const provider = connection.providerAction;
  const contribution = await readCurrentProviderContributionForPersistedSelection({
    context: { targetedContributions: context.services.targetedContributions, signal: context.signal },
    providerPluginId: provider.providerPluginId, providerContributionSelection: provider.providerContributionSelection,
  });
  const operation = contribution.operations.sessionStatus;
  if (operation === undefined) return { kind: 'notReady', reason: 'unsupported' } as const;
  const request = ConversationSessionStatusInputV1Schema.parse({
    v: 1, connectionId: target.source.connectionId,
    providerConnectionKey: provider.providerConnectionKey, providerConfigVersion: provider.providerConfigVersion,
    providerConfig: provider.providerConfig, credentialRef: connection.credentialRef,
    endpoint: target.endpoint, status, ...(providerMessageId === undefined ? {} : { providerMessageId }),
  });
  const execution = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(operation, request, {
    signal: context.signal,
    expectedExecutionRouting: getConversationConnectionExecutionRouting(connection.transportOrigin, provider.providerPluginId),
  });
  return ConversationDeliveryResultV1Schema.parse(execution.result);
}
