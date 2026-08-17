import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import { readTrackedSessionBrokerSelectionIdentity } from '@/daemon/connectedServices/broker/trackedSessionBrokerSelectionIdentity';

export const materializePiConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (
  params,
) => {
  const brokerSelectionIdentity = readTrackedSessionBrokerSelectionIdentity(params.input.tracked);
  return {
    ...params.baseSelection,
    ...(brokerSelectionIdentity ? { brokerSelectionIdentity } : {}),
  };
};
