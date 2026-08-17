import type { PluginApi } from '@happier-dev/plugin-sdk';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
} from '@happier-dev/channels-protocol/v1';

import {
  acceptConversationStreamBaselineForInvocation,
  createConversationProviderObservationIngestHandler,
  retryConversationIngressForInvocation,
} from './ingress.js';
import { deliverConversationAutomationResultForInvocation } from './automationResultDelivery.js';
import { createIngressSupervisor } from './checkpointedPollSupervisor.js';
import { createConversationOutwardDeliverySupervisor } from './outwardDeliverySupervisor.js';
import {
  abandonConversationConnectionForInvocation,
  createConversationBindingForInvocation,
  createConversationPairingManagementHandlers,
  createConversationPairingManagerForActivation,
  createConversationConnectionForInvocation,
  transferConversationConnectionForInvocation,
  deleteConversationBindingForInvocation,
  deleteConversationConnectionForInvocation,
  reportConversationTransportFactForInvocation,
  rotateConversationBindingTargetForInvocation,
  retryConversationConnectionPollForInvocation,
  setConversationBindingEnabledForInvocation,
  setConversationConnectionEnabledForInvocation,
  prepareConversationConnectionForInvocation,
  readConversationBindingForInvocation,
  resolveConversationBindingForInvocation,
  resolveConversationDeliveryForInvocation,
  updateConversationBindingForInvocation,
  updateConversationConnectionForInvocation,
} from './management.js';
import {
  listConversationProviderConnectionsForInvocation,
  readConversationProviderConnectionForInvocation,
} from './reconciliation.js';
import { BINDINGS_RESOURCE_RUNTIME } from './bindingsResource.js';
import { CONNECTIONS_RESOURCE_RUNTIME } from './connectionsResource.js';
import { createConversationPairingResourceRuntime } from './pairingResource.js';
import {
  CHANNELS_TRANSCRIPT_ACTIVITIES_RESOURCE_ID,
  TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME,
} from './transcriptActivitiesResource.js';

/** Registers C2 setup, the normal management Resource, and caller-scoped reconciliation readers. */
export function activate(api: PluginApi) {
  const pairing = createConversationPairingManagerForActivation();
  const ingressSupervisor = createIngressSupervisor({ pairing });
  const outwardDeliverySupervisor = createConversationOutwardDeliverySupervisor();
  const pairingHandlers = createConversationPairingManagementHandlers(pairing);
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
    createConversationConnectionForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer,
    transferConversationConnectionForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
    prepareConversationConnectionForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate,
    updateConversationConnectionForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetEnabled,
    setConversationConnectionEnabledForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete,
    deleteConversationConnectionForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon,
    abandonConversationConnectionForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept,
    acceptConversationStreamBaselineForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry,
    retryConversationConnectionPollForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
    pairingHandlers.create,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize,
    pairingHandlers.finalize,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCancel,
    pairingHandlers.cancel,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead,
    readConversationBindingForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve,
    resolveConversationBindingForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
    createConversationBindingForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
    updateConversationBindingForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled,
    setConversationBindingEnabledForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete,
    deleteConversationBindingForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingTargetRotate,
    rotateConversationBindingTargetForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry,
    retryConversationIngressForInvocation,
  );
  api.actions.register(
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve,
    resolveConversationDeliveryForInvocation,
  );
  api.actions.register(
    CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest,
    createConversationProviderObservationIngestHandler(pairing),
  );
  api.actions.register(
    CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
    listConversationProviderConnectionsForInvocation,
  );
  api.actions.register(
    CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
    readConversationProviderConnectionForInvocation,
  );
  api.actions.register(
    CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
    reportConversationTransportFactForInvocation,
  );
  api.actions.register(
    CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.automationResultDeliver,
    deliverConversationAutomationResultForInvocation,
  );
  api.resources.registerDynamicResource('connections-v1', CONNECTIONS_RESOURCE_RUNTIME);
  api.resources.registerDynamicResource('bindings-v1', BINDINGS_RESOURCE_RUNTIME);
  api.resources.registerDynamicResource('pairing-v1', createConversationPairingResourceRuntime(pairing));
  api.resources.registerDynamicResource(
    CHANNELS_TRANSCRIPT_ACTIVITIES_RESOURCE_ID,
    TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME,
  );
  api.backgroundServices.register('ingress-supervisor', ingressSupervisor.run);
  api.backgroundServices.register('outward-delivery-supervisor', outwardDeliverySupervisor.run);
  return async () => {
    await outwardDeliverySupervisor.dispose();
    await ingressSupervisor.dispose();
    pairing.dispose();
  };
}
