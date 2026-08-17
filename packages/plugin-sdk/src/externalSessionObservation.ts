/** @moduleRealm daemon */
import type {
    ExternalAgentObservationLinkEvidenceBatchV1 as ProtocolExternalAgentObservationLinkEvidenceBatchV1,
    ExternalAgentObservationLinkKeyV1 as ProtocolExternalAgentObservationLinkKeyV1,
    ExternalAgentObservationReconcilePurposeV1 as ProtocolExternalAgentObservationReconcilePurposeV1,
    ExternalAgentObservationReconcileRequestV1 as ProtocolExternalAgentObservationReconcileRequestV1,
    ExternalAgentObservationReconcileResultV1 as ProtocolExternalAgentObservationReconcileResultV1,
    ExternalAgentObservationResourceGroupingV1 as ProtocolExternalAgentObservationResourceGroupingV1,
    ExternalAgentObservationResourceDescriptorOutcomeV1 as ProtocolExternalAgentObservationResourceDescriptorOutcomeV1,
    ExternalAgentObservationResourceDescriptorV1 as ProtocolExternalAgentObservationResourceDescriptorV1,
    ExternalAgentObservationResourceKeyV1 as ProtocolExternalAgentObservationResourceKeyV1,
    ExternalAgentObservationWatchFileChangesV1 as ProtocolExternalAgentObservationWatchFileChangesV1,
} from '@happier-dev/protocol';

import type {
    AgentExternalSessionsManagedEndpointRead,
    AgentExternalSessionsResolvedIdentity,
} from './externalSessions.js';
import type { Disposable } from './lifecycle.js';

export type AgentExternalSessionObservationLinkEvidenceBatchV1 =
    ProtocolExternalAgentObservationLinkEvidenceBatchV1;
export type AgentExternalSessionObservationLinkKeyV1 =
    ProtocolExternalAgentObservationLinkKeyV1;
export type AgentExternalSessionObservationReconcilePurposeV1 =
    ProtocolExternalAgentObservationReconcilePurposeV1;
export type AgentExternalSessionObservationReconcileRequestV1 =
    ProtocolExternalAgentObservationReconcileRequestV1;
export type AgentExternalSessionObservationReconcileResultV1 =
    ProtocolExternalAgentObservationReconcileResultV1;
export type AgentExternalSessionObservationResourceGroupingV1 =
    ProtocolExternalAgentObservationResourceGroupingV1;
export type AgentExternalSessionObservationResourceDescriptorOutcomeV1 =
    ProtocolExternalAgentObservationResourceDescriptorOutcomeV1;
export type AgentExternalSessionObservationResourceDescriptorV1 =
    ProtocolExternalAgentObservationResourceDescriptorV1;
export type AgentExternalSessionObservationResourceKeyV1 =
    ProtocolExternalAgentObservationResourceKeyV1;
export type AgentExternalSessionObservationWatchFileChangesV1 =
    ProtocolExternalAgentObservationWatchFileChangesV1;

export type AgentExternalSessionObservationDescribeResourceRequest =
    AgentExternalSessionsResolvedIdentity;

export type AgentExternalSessionObservationObserveResourceRequest = Readonly<{
    resourceKey: AgentExternalSessionObservationResourceKeyV1;
    signal: AbortSignal;
    managedEndpointRead: AgentExternalSessionsManagedEndpointRead;
    emit(batch: AgentExternalSessionObservationLinkEvidenceBatchV1): void;
    requestReconcile(): void;
    requestTranscriptRefresh(linkKey: AgentExternalSessionObservationLinkKeyV1): void;
}>;

export type AgentExternalSessionObservationReconcileLink = Readonly<{
    linkKey: AgentExternalSessionObservationLinkKeyV1;
    linkedSource: AgentExternalSessionsResolvedIdentity;
}>;

export type AgentExternalSessionObservationReconcileResourceRequest = Readonly<{
    purpose: AgentExternalSessionObservationReconcilePurposeV1;
    resourceKey: AgentExternalSessionObservationResourceKeyV1;
    links: readonly AgentExternalSessionObservationReconcileLink[];
    signal: AbortSignal;
    managedEndpointRead: AgentExternalSessionsManagedEndpointRead;
}>;

export type AgentExternalSessionObservationContribution = Readonly<{
    describeResource(
        request: AgentExternalSessionObservationDescribeResourceRequest,
    ): AgentExternalSessionObservationResourceGroupingV1;
    observeResource(
        request: AgentExternalSessionObservationObserveResourceRequest,
    ): Disposable | Promise<Disposable>;
    reconcileResource(
        request: AgentExternalSessionObservationReconcileResourceRequest,
    ): AgentExternalSessionObservationReconcileResultV1
        | Promise<AgentExternalSessionObservationReconcileResultV1>;
}>;
