import type {
    ExternalAgentObservationLinkEvidenceBatchV1,
    ExternalAgentObservationLinkKeyV1,
    ExternalAgentObservationReconcilePurposeV1,
    ExternalAgentObservationReconcileRequestV1,
    ExternalAgentObservationReconcileResultV1,
    ExternalAgentObservationResourceGroupingV1,
    ExternalAgentObservationResourceDescriptorOutcomeV1,
    ExternalAgentObservationResourceDescriptorV1,
    ExternalAgentObservationResourceKeyV1,
    ExternalAgentObservationWatchFileChangesV1,
} from '@happier-dev/protocol';

import type { AgentExternalSessionsResolvedIdentity } from './externalSessions.js';
import type { Disposable } from './lifecycle.js';

export type {
    ExternalAgentObservationLinkEvidenceBatchV1,
    ExternalAgentObservationLinkKeyV1,
    ExternalAgentObservationReconcilePurposeV1,
    ExternalAgentObservationReconcileRequestV1,
    ExternalAgentObservationReconcileResultV1,
    ExternalAgentObservationResourceGroupingV1,
    ExternalAgentObservationResourceDescriptorOutcomeV1,
    ExternalAgentObservationResourceDescriptorV1,
    ExternalAgentObservationResourceKeyV1,
    ExternalAgentObservationWatchFileChangesV1,
} from '@happier-dev/protocol';

export type AgentExternalSessionObservationDescribeResourceRequest =
    AgentExternalSessionsResolvedIdentity;

export type AgentExternalSessionObservationObserveResourceRequest = Readonly<{
    resourceKey: ExternalAgentObservationResourceKeyV1;
    signal: AbortSignal;
    emit(batch: ExternalAgentObservationLinkEvidenceBatchV1): void;
    requestReconcile(): void;
    requestTranscriptRefresh(linkKey: ExternalAgentObservationLinkKeyV1): void;
}>;

export type AgentExternalSessionObservationReconcileLink = Readonly<{
    linkKey: ExternalAgentObservationLinkKeyV1;
    linkedSource: AgentExternalSessionsResolvedIdentity;
}>;

export type AgentExternalSessionObservationReconcileResourceRequest = Readonly<{
    purpose: ExternalAgentObservationReconcilePurposeV1;
    resourceKey: ExternalAgentObservationResourceKeyV1;
    links: readonly AgentExternalSessionObservationReconcileLink[];
    signal: AbortSignal;
}>;

export type AgentExternalSessionObservationContribution = Readonly<{
    describeResource(
        request: AgentExternalSessionObservationDescribeResourceRequest,
    ): ExternalAgentObservationResourceGroupingV1;
    observeResource(
        request: AgentExternalSessionObservationObserveResourceRequest,
    ): Disposable | Promise<Disposable>;
    reconcileResource(
        request: AgentExternalSessionObservationReconcileResourceRequest,
    ): ExternalAgentObservationReconcileResultV1
        | Promise<ExternalAgentObservationReconcileResultV1>;
}>;
