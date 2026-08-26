// V1 is the only public Triage source-protocol epoch. There is no default,
// current, latest, legacy, or compatibility alias.
//
// Each schema published here is a `ProtocolComposableSchema`, whose public
// interface already carries its own `jsonSchema` projection, so a `*JsonSchema`
// alias adds no capability — only a second permanent name for one value. Three
// are published because a consumer needs the projection as a standalone value:
// the two Collection definitions in the Triage target and the detail-envelope
// projection a source mount asserts against. Everything else reads
// `Schema.jsonSchema`.
export * from './bounds.js';
export {
    TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1,
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1JsonSchema,
    TriageEntryRefV1Schema,
    TriageSourceEntryLocalRefV1Schema,
    TriageSourceInstanceIdV1Schema,
    TriageSourceInstanceRefV1Schema,
    TriageSourceWorkflowSubjectV1Schema,
} from './identity.js';
export type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageSourceEntryLocalRefV1,
    TriageSourceInstanceIdV1,
    TriageSourceInstanceRefV1,
    TriageSourceWorkflowSubjectV1,
} from './identity.js';

export {
    normalizeTriageSingleLineV1,
    projectTriageDisplayTextV1,
    truncateTriageUtf8V1,
} from './text.js';
export type { TriageBoundedTextV1 } from './text.js';

export {
    describeTriageSourceFailureV1,
    formatTriageCountV1,
    formatTriageTimestampV1,
    projectTriageDetailFieldTextV1,
    projectTriageDetailFieldsV1,
} from './presentation.js';
export type {
    TriageDetailFieldV1,
    TriageDetailFieldValueTextV1,
} from './presentation.js';

export {
    triagePagedPanelInitialState,
    triagePagedPanelReducer,
} from './pagedPanel.js';
export type {
    TriagePagedPanelEventV1,
    TriagePagedPanelPageV1,
    TriagePagedPanelStateV1,
} from './pagedPanel.js';

export {
    decodeTriagePagingTokenV1,
    encodeTriagePagingTokenV1,
} from './paging.js';

export { readTriageResponseHeaderV1 } from './httpHeaders.js';

export { TriageSourceFailureV1Schema } from './diagnostics.js';
export type { TriageSourceFailureV1 } from './diagnostics.js';

export {
    admitTriageSourceDescriptorV1,
    TriageSourceDescriptorV1Schema,
} from './descriptor.js';
export type {
    TriageSourceDescriptorAdmissionV1,
    TriageSourceDescriptorV1,
} from './descriptor.js';

export {
    TriageConfiguredSourceInstanceV1JsonSchema,
    TriageConfiguredSourceInstanceV1Schema,
    TriageListInstancesInputV1Schema,
    TriageListInstancesResultV1Schema,
    TriageSourceAccountBindingV1Schema,
    TriageSourceInstanceConfigurationV1Schema,
    TriageSourceInstanceDraftV1Schema,
    TriageSourceInstanceLocatorV1Schema,
} from './instances.js';
export type {
    TriageConfiguredSourceInstanceV1,
    TriageListInstancesInputV1,
    TriageListInstancesResultV1,
    TriageSourceAccountBindingV1,
    TriageSourceInstanceConfigurationV1,
    TriageSourceInstanceDraftV1,
    TriageSourceInstanceLocatorV1,
} from './instances.js';

export {
    TRIAGE_SOURCES_ADMINISTER_ACTION_ID_V1,
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
    TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
    TriageSourceAdministrationActionInputV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
} from './sourceAdministration.js';
export type {
    TriageSourceAdministrationActionInputV1,
    TriageSourceAdministrationActionResultV1,
} from './sourceAdministration.js';

export {
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_ID_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    TriageConfiguredSourceInstanceRecordV1Schema,
    TriageReadConfiguredSourceInstancesInputV1Schema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
} from './configuredInstances.js';
export type {
    TriageConfiguredSourceInstanceRecordV1,
    TriageReadConfiguredSourceInstancesInputV1,
    TriageReadConfiguredSourceInstancesResultV1,
} from './configuredInstances.js';

export {
    TriageEntryRepositoryRefV1Schema,
    TriageRowFactV1Schema,
    TriageRowFactValueV1Schema,
    TriageScanContinuationV1Schema,
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceObservationV1Schema,
    TriageSourceScanEvidenceV1Schema,
    TriageSourceScanObservationV1Schema,
    TriageSourceViewerFactsV1Schema,
} from './observations.js';
export type {
    TriageEntryRepositoryRefV1,
    TriageRowFactV1,
    TriageRowFactValueV1,
    TriageScanContinuationV1,
    TriageSourceEntrySnapshotV1,
    TriageSourceObservationV1,
    TriageSourceScanEvidenceV1,
    TriageSourceScanObservationV1,
    TriageSourceViewerFactsV1,
} from './observations.js';

export {
    TriageGetInputV1Schema,
    TriageGetResultV1Schema,
    TriageScanInputV1Schema,
    TriageScanResultV1Schema,
} from './operations.js';
export type {
    TriageGetInputV1,
    TriageGetResultV1,
    TriageScanInputV1,
    TriageScanResultV1,
} from './operations.js';

export {
    TriagePrepareReviewWorkspaceInputV1Schema,
    TriagePrepareReviewWorkspaceResultV1Schema,
    TriagePullRequestReviewRevisionV1Schema,
    TriageReviewWorkspaceCurrentnessV1Schema,
    TriageReviewWorkspaceObservedRevisionV1Schema,
    TriageSelectedWorkspaceScopeV1Schema,
} from './workspace.js';
export type {
    TriagePrepareReviewWorkspaceInputV1,
    TriagePrepareReviewWorkspaceResultV1,
    TriagePullRequestReviewRevisionV1,
    TriageReviewWorkspaceCurrentnessV1,
    TriageReviewWorkspaceObservedRevisionV1,
    TriageSelectedWorkspaceScopeV1,
} from './workspace.js';

export {
    TriageDetailSurfaceInputV1JsonSchema,
    TriageDetailSurfaceInputV1Schema,
    TriageLinkedSessionProjectionV1Schema,
} from './detail.js';
export type {
    TriageDetailSurfaceInputV1,
    TriageLinkedSessionProjectionV1,
} from './detail.js';

export {
    TriageSourcesContributionPointV1,
    TriageSourcesContributionProtocolV1,
} from './contribution.js';
